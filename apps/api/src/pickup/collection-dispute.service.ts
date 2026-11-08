import { sql } from 'drizzle-orm';

import { noteRefusal, screenedNote } from '../platform/audit/audit-record.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { guardReasonIn, serverErrorIn } from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';

const OPERATION = 'disputeCollection';

export interface DisputesOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly idempotency: IdempotencyStore;
  /** The identifiers of the disputes are time-ordered, from the clock it is given, no more. */
  readonly clock: Pick<Clock, 'now'>;
}

export interface DisputeBody {
  readonly note: string;
}

/** The contract's `CollectionDispute`. */
export interface CollectionDisputeView {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly state: 'OPEN' | 'RESOLVED';
  readonly raised_by: string;
  readonly note: string;
  readonly created_at: string;
}

const iso = (value: unknown): string =>
  (value instanceof Date ? value : new Date(String(value))).toISOString();

const invalid = (rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer: '/note', rule }],
  });

const conflict = (rule: string, message: string): ApiException =>
  ApiException.of(ErrorCode.StateConflict, message, { rule });

/**
 * The answer a refusal of `melarc.dispute_collection` is, by the reason it states (`DETAIL reason=`, SQLSTATE 23514) or by the privilege it did not
 * find (42501: the stop is not this vendor's, answered as a stop that does not exist). `undefined` for anything else, which is a defect.
 */
function refusalOf(error: unknown): ApiException | undefined {
  const state = serverErrorIn(error)?.code;
  if (state === '42501') return ApiException.of(ErrorCode.NotFound, 'Not found');
  // The partial unique key of the open dispute is the backstop of the operation's own check.
  if (state === '23505')
    return conflict('dispute_open', 'A dispute of this collection is already open');
  if (state !== '23514') return undefined;
  switch (guardReasonIn(error)) {
    case 'REASON_REQUIRED':
      return ApiException.of(ErrorCode.ReasonRequired, 'A note is required', { rule: 'note' });
    case 'STOP_NOT_CLOSED':
      return conflict('stop_not_closed', 'Only a collection that has closed can be disputed');
    case 'DISPUTE_OPEN':
      return conflict('dispute_open', 'A dispute of this collection is already open');
    default:
      return undefined;
  }
}

/**
 * `disputeCollection` (S1.29; `pickup.collection.confirm`; `AC-SLICE-001-27`; domain-model.md section 6.19; state-machines.md section 6): the vendor, on
 * its own pickup, says the collection is not as the stop closed it. It raises a reconciliation item that Ops can read and sets the stop's handshake
 * `DISPUTED`, in one change (`melarc.dispute_collection`, migration `0071`). **It never reverses physical completion**: the stop stays `COLLECTED` or
 * `PARTIALLY_COLLECTED` and the manifest does not wait for it; the item is resolved by the detailed Ops reconciliation workflow that no operation
 * performs in `SLICE-001`.
 *
 * - **Whose**: the vendor organisation that owns the pickup; any other stop, and an id that matches nothing, is `NOT_FOUND`, the same.
 * - **When**: only after the stop has closed through its handshake (`STATE_CONFLICT`, `details.rule` `stop_not_closed`: a stop still being worked, a
 *   skipped one and a failed one have no collection to dispute; a failed stop has no dispute form by design, AC-SLICE-001-35); one open dispute per
 *   stop (`dispute_open`).
 * - **The note is the vendor's own words** and mandatory (`REASON_REQUIRED`); it is bounded as the ledger bounds a note and appears in the event of the
 *   dispute, which carries the actor and the note.
 * - **Idempotent**: a replay returns the original answer and raises no second item; another body under the same key is `IDEMPOTENCY_KEY_CONFLICT`.
 */
export class Disputes {
  readonly #options: DisputesOptions;

  constructor(options: DisputesOptions) {
    this.#options = options;
  }

  async raise(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    request: {
      readonly body: DisputeBody;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<{ readonly dispute: CollectionDisputeView }> {
    const { runner, idempotency, clock } = this.#options;
    if (authorized.session.principalType !== 'VENDOR') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const note = typeof request.body.note === 'string' ? request.body.note.trim() : '';
    if (note === '') {
      throw ApiException.of(ErrorCode.ReasonRequired, 'A note is required', { rule: 'note' });
    }
    const rule = noteRefusal(note);
    if (rule !== undefined) throw invalid(rule);
    // The event of the dispute is written by the database function, which carries the vendor's words into the append-only ledger as they are: it does not pass the audit
    // writer, whose screening removes a secret that travels inside a text (`token=...`, a credential in a URL). The note is screened here as the writer screens it, and the
    // screened text is what the item, the event and the answer all hold, so the ledger holds nothing the writer would not keep. (It is the writer's own screening, which
    // takes a word such as `Basic` or `Bearer` and the word after it for a credential: the ledger holds a note so written whatever route wrote it, and refusing it would
    // refuse an ordinary sentence.)
    const kept = screenedNote(note);
    if (kept === undefined) throw invalid('format');
    const vendorAccountId = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'VENDOR',
        principalId: vendorAccountId,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as {
          dispute: CollectionDisputeView;
        };
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW') {
        // A record that began and did not complete is a stranded one (OB-100): the command is not run again, and nothing is invented.
        throw new Error('An idempotency record of this command is stranded');
      }

      const id = randomUUIDv7(clock);
      let row: Record<string, unknown> | undefined;
      try {
        const rows = await tx.execute(
          sql`select * from melarc.dispute_collection(${id}::uuid, ${stopId}::uuid, ${kept})`,
        );
        row = rows.rows[0];
      } catch (error) {
        throw refusalOf(error) ?? error;
      }
      if (row === undefined) throw new Error('The dispute was not raised');

      const view: CollectionDisputeView = {
        id: String(row.out_id),
        pickup_stop_id: String(row.out_pickup_stop_id),
        state: row.out_state === 'RESOLVED' ? 'RESOLVED' : 'OPEN',
        raised_by: String(row.out_raised_by),
        note: String(row.out_note),
        created_at: iso(row.out_created_at),
      };
      const answer = { dispute: view };
      await idempotency.complete(handle, scope, {
        status: 201,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return answer;
    });
  }
}
