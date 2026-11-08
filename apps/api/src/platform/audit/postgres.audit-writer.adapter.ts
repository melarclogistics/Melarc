import { sql } from 'drizzle-orm';

import type { AuditEventInput, AuditWriter } from '../auth/ports/audit-writer.port.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type { Metrics } from '../auth/ports/metrics.port.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import { auditEvent } from '../database/schema/audit.js';
import { securityContextOf, transactionOf } from '../database/transaction-handle.js';
import { buildAuditRecord, type AuditRecord } from './audit-record.js';

/**
 * The audit writer over PostgreSQL (S0.11; audit.md §2). `write` inserts one row of `audit_event` **in the caller's
 * transaction**, so the act and its record commit together or not at all.
 *
 * - **Fail closed.** The insert is a statement of the caller's transaction: if the row cannot be stored (a refusal by row-level
 *   security, a constraint, a lost connection) the statement fails, the error reaches the caller, and PostgreSQL has aborted the
 *   transaction, so the act that the event records cannot commit. An event this writer itself refuses (an unknown code, a field
 *   named for a secret, an address) fails before any statement is sent, so the writer aborts the transaction itself with a
 *   statement the server rejects. A caller that catches either error and carries on still gets no commit: the server answers
 *   the COMMIT of an aborted transaction with `ROLLBACK`, which `DatabaseService` reports as `TransactionRolledBackError`, never
 *   as success (correction F01; review of 10 October 2026). That holds for every event, enhanced or not; what the `enhanced`
 *   flag adds is its retention and export treatment (audit.md §3), and the alert on a blocked act (S0.68).
 * - **The actor, the surface and the correlation id are the transaction's.** They are read from the context the handle was made
 *   with, never from a caller (`audit-record.ts`; obligation OB-47): a `SYSTEM` transaction is the null actor.
 * - **The identifier and the time of the act come from the injected `Clock`** (a UUIDv7, time-ordered to the millisecond of that
 *   clock); the recording time is the database's `now()`, set by the column's default and not by this code.
 * - **Nothing is returned and nothing is read back.** The insert asks for no `RETURNING`, so it needs no `SELECT` on the row: a
 *   `SYSTEM` context inserts and cannot read (the registry gives it "INSERT only").
 *
 * The signed checkpoint chain, its independent storage and its monitoring are release gate G1 and are not here. What this writer
 * keeps for them is stable identifiers, the canonical serialisation version of every row, fields that never change, and a table
 * that is insert-only.
 */
export class PostgresAuditWriter implements AuditWriter {
  readonly #clock: Pick<Clock, 'now'>;
  readonly #metrics: Metrics | undefined;

  constructor(clock: Pick<Clock, 'now'>, metrics?: Metrics) {
    this.#clock = clock;
    this.#metrics = metrics;
  }

  async write(transaction: TransactionHandle, event: AuditEventInput): Promise<void> {
    try {
      await this.#insert(transaction, event);
    } catch (error) {
      // An enhanced act whose record cannot be written does not happen (audit.md section 6): that block is counted, for the alert
      // that exists for it (OBSERVABILITY_AND_RECOVERY.md section 3), and the failure goes on to the caller, whose transaction is
      // already lost. Counting touches no database and names neither the act nor the actor.
      if (event.enhanced) this.#metrics?.increment('audit_enhanced_write_failed_total');
      throw error;
    }
  }

  async #insert(transaction: TransactionHandle, event: AuditEventInput): Promise<void> {
    let record: AuditRecord;
    try {
      record = buildAuditRecord(
        event,
        securityContextOf(transaction),
        this.#clock.now(),
        randomUUIDv7(this.#clock),
      );
    } catch (error) {
      // The writer refused the event before any statement was sent, so the server knows nothing of it and the transaction is
      // still healthy: a caller that caught this error could commit the act with no record. The transaction is aborted here,
      // as a rejected insert would have aborted it.
      await this.#abort(transaction);
      throw error;
    }
    await transactionOf(transaction).insert(auditEvent).values({
      id: record.id,
      eventCode: record.eventCode,
      occurredAt: record.occurredAt,
      actorType: record.actorType,
      actorId: record.actorId,
      actorBundle: record.actorBundle,
      surfaceContext: record.surfaceContext,
      deviceContext: record.deviceContext,
      vendorOrganizationId: record.vendorOrganizationId,
      responsibleHubId: record.responsibleHubId,
      objectType: record.objectType,
      objectId: record.objectId,
      correlationId: record.correlationId,
      previousState: record.previousState,
      resultingState: record.resultingState,
      reasonCode: record.reasonCode,
      reasonLabel: record.reasonLabel,
      note: record.note,
      approvalId: record.approvalId,
      beforeAfter: record.beforeAfter,
      relatedIds: record.relatedIds,
      detail: record.detail,
      outcome: record.outcome,
      enhanced: record.enhanced,
      serialisationVersion: record.serialisationVersion,
    });
  }

  /**
   * Aborts the caller's transaction with a statement the server rejects (a cast that cannot succeed, which needs no privilege and
   * names no value of the event). The rejection is the point: PostgreSQL then answers the transaction's COMMIT with `ROLLBACK`,
   * which `DatabaseService` reports as `TransactionRolledBackError`. Its own failure is not the error to report, so it is not
   * raised; if even this statement could not be sent, the connection is gone and the commit cannot succeed either.
   */
  async #abort(transaction: TransactionHandle): Promise<void> {
    try {
      await transactionOf(transaction).execute(
        sql`select cast('the audit event was refused: this transaction must not commit' as integer)`,
      );
    } catch {
      // Expected: see above.
    }
  }
}
