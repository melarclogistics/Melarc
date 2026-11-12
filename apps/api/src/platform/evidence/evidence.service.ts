import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../auth/ports/audit-writer.port.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type { EvidenceStore, ObjectCapability } from '../auth/ports/evidence-store.port.js';
import type { IdempotencyStore } from '../auth/ports/idempotency-store.port.js';
import {
  authorizationForKey,
  type AuthorizedRequest,
} from '../authorization/authorized-request.js';
import type { OperationRunner } from '../authorization/operation-runner.js';
import { guardReasonIn } from '../database/database-failures.js';
import { createScopeProbe } from '../database/scope-probe.js';
import { timestampOf } from '../database/timestamps.js';
import { transactionOf } from '../database/transaction-handle.js';
import { isUuid } from '../database/transaction-context.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { isIdempotencyKey } from '../idempotency/idempotency-scope.js';
import { primaryHubOfStaff } from '../lookup/primary-hub.js';
import type { SettingsReader } from '../settings/settings-reader.js';
import { actsReadBy, actsWrittenBy, ownerActOf, type OwnerAct } from './evidence-owners.js';
import {
  EVIDENCE_COLUMNS,
  evidenceEtagOf,
  evidenceViewOf,
  type EvidenceRow,
  type EvidenceView,
} from './evidence-view.js';
import {
  CONTENT_TYPE_SIGNATURE,
  EVIDENCE_SETTINGS,
  SIGNATURE_BYTES,
  signatureOf,
} from './evidence-vocabulary.js';

const CREATE = 'createEvidence';

export interface EvidenceServiceOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly idempotency: IdempotencyStore;
  readonly store: EvidenceStore;
  readonly audit: AuditWriter;
  readonly settings: Pick<SettingsReader, 'integer' | 'list'>;
  readonly clock: Pick<Clock, 'now'>;
}

export interface EvidenceCreateBody {
  readonly owner_type: string;
  readonly owner_id: string;
  readonly purpose: string;
  readonly captured_at: string;
  readonly device_context?: Record<string, unknown>;
  readonly content_type: string;
  readonly byte_size: number;
  readonly checksum_sha256: string;
}

export interface EvidenceTicket {
  readonly evidence: EvidenceView;
  readonly upload: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expires_at: string;
  };
}

export interface EvidenceRetrieval {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expires_at: string;
}

/** The device context is the client's own note of the handset (the contract's open object); it is bounded so that a record cannot carry a document. */
const MAX_DEVICE_CONTEXT_CHARACTERS = 4096;

const denied = (): ApiException => ApiException.of(ErrorCode.PermissionDenied, 'Permission denied');
const notFound = (): ApiException => ApiException.of(ErrorCode.NotFound, 'Not found');
const invalid = (pointer: string, rule: string): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });

/** `application/pdf; charset=binary` is the type `application/pdf`: a parameter is not part of what the signature of the bytes is checked against. */
function contentTypeOf(declared: string): string {
  return (declared.split(';')[0] ?? '').trim().toLowerCase();
}

/**
 * The three evidence operations (S1.11; domain-model.md 3.6; state-machines.md 17; SECURITY_DESIGN.md 14.10 and 14.18). **Evidence holds no authority of its own**
 * (`x-permission: owner`): a record is captured in the course of another act, so the permission each operation needs is the act's, found from the record's owner
 * (`evidence-owners.ts`) and asked of the session's own snapshot (`authorizationForKey`, as `getQueueSummary` does for each queue): the guard has authenticated and counted the
 * request and judged the surface, and **nothing runs before this service has found a grant of the act's key, or refused with `PERMISSION_DENIED`**; the transaction is then
 * opened under the context of that grant and no wider. An owner type with no act is denied, never defaulted.
 *
 * - **`create`** (step one of two): the owner's act decides who may declare a record; the record is judged (a type the settings allow, a size within the ceiling, a capture that
 *   is not in the future, a SHA-256), the owner is judged by the database (a stop the rider has arrived at, on a run in progress that is assigned to it) and the record is made
 *   `PENDING_UPLOAD` with the scope derived from its owner and the instants the database's own. The answer carries a **capability to upload that one object**: the store signs
 *   the type, the exact size and the hash, for the seconds the setting grants. A retry with the same `Idempotency-Key` is told the same, **made again from the row** (the
 *   capability is a pure function of the record, so none is kept anywhere).
 * - **`complete`** (step two): the platform looks at what the store holds at the key **outside any transaction** (a call to the store is never made inside one), and compares
 *   it with what was declared and with the signature of the declared type, judged on the bytes and never on a header the client chose. Only then is the record moved to `STORED`,
 *   under its lock, with the version the caller read. A mismatch leaves it `PENDING_UPLOAD` and is `VALIDATION_FAILED`. The malicious-content check is the owner's open item
 *   (OB-S1-05) and is not made here.
 * - **`retrieve`**: for the staff who hold the read permission of the subject, within the hubs of the grant (a record in another hub is `HUB_SCOPE_VIOLATION`, one that does not
 *   exist `NOT_FOUND`); a record that is not `STORED` is `EVIDENCE_NOT_STORED`. It writes no state and **keeps nothing**: the capability is returned to the one caller for five minutes
 *   and is in no log, metric, event or record.
 */
export class EvidenceService {
  readonly #options: EvidenceServiceOptions;
  readonly #probe = createScopeProbe({ evidence: { schema: 'public', table: 'evidence' } });

  constructor(options: EvidenceServiceOptions) {
    this.#options = options;
  }

  /** The session's grant of the key of an act, or a refusal: the permission every operation of this service rests on. */
  #grantFor(
    authorized: AuthorizedRequest,
    side: 'write' | 'read',
    act: OwnerAct,
  ): AuthorizedRequest {
    const who = act[side];
    if (authorized.session.principalType !== who.principal) throw denied();
    const decision = authorizationForKey(authorized, who.key);
    if (decision === undefined) throw denied();
    return decision;
  }

  /** The acts the session could be acting for, each with the decision of its key: the session's, in the order of the acts. */
  #decisionsOf(
    authorized: AuthorizedRequest,
    side: 'write' | 'read',
  ): readonly { readonly act: OwnerAct; readonly decision: AuthorizedRequest }[] {
    const acts =
      side === 'write'
        ? actsWrittenBy(authorized.session.principalType)
        : actsReadBy(authorized.session.principalType);
    const found: { act: OwnerAct; decision: AuthorizedRequest }[] = [];
    for (const act of acts) {
      const decision = authorizationForKey(authorized, act[side].key);
      if (decision !== undefined) found.push({ act, decision });
    }
    if (found.length === 0) throw denied();
    return found;
  }

  /** The capability to upload one record's object, made from the row alone, so that a retry makes the same one. */
  #uploadTicketOf(row: EvidenceRow): EvidenceTicket {
    const capability: ObjectCapability = this.#options.store.presignUpload({
      key: row.storage_ref,
      contentType: row.content_type,
      byteSize: row.byte_size,
      checksumSha256: row.checksum_sha256,
      issuedAt: timestampOf(row.created_at),
      ttlSeconds: row.upload_ttl_seconds,
    });
    return {
      evidence: evidenceViewOf(row),
      upload: {
        method: capability.method,
        url: capability.url,
        headers: capability.headers,
        expires_at: capability.expiresAt.toISOString(),
      },
    };
  }

  async create(
    authorized: AuthorizedRequest,
    correlationId: string,
    request: {
      readonly body: EvidenceCreateBody;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<{ readonly ticket: EvidenceTicket; readonly etag: string }> {
    const { body } = request;
    // The permission comes first and costs the database nothing: a caller without the act's key learns nothing of the schema.
    const act = ownerActOf(body.owner_type);
    if (act === undefined) throw denied();
    const decision = this.#grantFor(authorized, 'write', act);
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    if (!(act.purposes as readonly string[]).includes(body.purpose)) {
      throw invalid('/purpose', 'enum');
    }
    // A capture in the future is refused by the evidence guard, on the database's clock, which is the one authority for it.
    const capturedAt = new Date(body.captured_at);
    if (Number.isNaN(capturedAt.getTime())) throw invalid('/captured_at', 'format');
    const checksum = body.checksum_sha256.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(checksum)) throw invalid('/checksum_sha256', 'pattern');
    const contentType = contentTypeOf(body.content_type);
    if (!/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/.test(contentType)) {
      throw invalid('/content_type', 'format');
    }
    if (!Number.isSafeInteger(body.byte_size) || body.byte_size < 1) {
      throw invalid('/byte_size', 'minimum');
    }
    const deviceContext = body.device_context ?? null;
    const deviceText = deviceContext === null ? null : JSON.stringify(deviceContext);
    if (deviceText !== null && deviceText.length > MAX_DEVICE_CONTEXT_CHARACTERS) {
      throw invalid('/device_context', 'maxLength');
    }
    const principalId = authorized.session.principalId.toLowerCase();

    return this.#options.runner.mutate(decision, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: authorized.session.principalType,
        principalId,
        operationId: CREATE,
        key: request.idempotencyKey,
      } as const;
      const begun = await this.#options.idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        // Only the record's identifier was kept; the capability is made again from the row.
        const kept = JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as {
          evidence_id: string;
        };
        const again = await tx.execute(
          sql`select ${EVIDENCE_COLUMNS} from evidence where id = ${kept.evidence_id}::uuid`,
        );
        const row = again.rows[0] as unknown as EvidenceRow | undefined;
        if (row === undefined) throw notFound();
        const view = evidenceViewOf(row);
        return { ticket: this.#uploadTicketOf(row), etag: evidenceEtagOf(view, row.version) };
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

      // The platform's limits are settings with no default: a missing one is the platform's failure, and never an assumed value.
      const { settings } = this.#options;
      const maxBytes = await settings.integer(handle, EVIDENCE_SETTINGS.maxBytes);
      const allowed = await settings.list(handle, EVIDENCE_SETTINGS.allowedMimeTypes);
      const ttlMinutes = await settings.integer(handle, EVIDENCE_SETTINGS.uploadTtlMinutes);
      if (!allowed.includes(contentType) || !(contentType in CONTENT_TYPE_SIGNATURE)) {
        throw invalid('/content_type', 'enum');
      }
      if (body.byte_size > maxBytes) throw invalid('/byte_size', 'maximum');

      await this.#requireOwnerReady(tx, act, body.owner_id);

      const id = randomUUIDv7(this.#options.clock);
      const storageRef = `ev/${randomBytes(16).toString('hex')}`;
      let inserted;
      try {
        inserted = await tx.execute(sql`
          insert into evidence (
            id, owner_type, owner_id, purpose, captured_at, captured_by_actor, captured_by_principal_type, device_context, storage_ref,
            access_rule, retention_policy, content_type, byte_size, checksum_sha256, upload_ttl_seconds, upload_expires_at
          ) values (
            ${id}::uuid, ${body.owner_type}, ${body.owner_id}::uuid, ${body.purpose}, ${capturedAt.toISOString()}::timestamptz,
            ${principalId}::uuid, ${authorized.session.principalType}, ${deviceText}::jsonb, ${storageRef},
            ${act.accessRule}, ${act.retentionPolicy}, ${contentType}, ${body.byte_size}, ${checksum}, ${ttlMinutes * 60}, now()
          ) returning ${EVIDENCE_COLUMNS}`);
      } catch (error) {
        // The guard repeats what the application judged (the moment of a capture, the owner); the statement is aborted, so nothing more is asked of the database.
        if (guardReasonIn(error) === 'VALIDATION_FAILED') throw invalid('/captured_at', 'future');
        throw error;
      }
      const row = inserted.rows[0] as unknown as EvidenceRow | undefined;
      if (row === undefined) throw new Error('A declared evidence record was not returned');
      const ticket = this.#uploadTicketOf(row);
      await this.#options.idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify({ evidence_id: row.id })),
      });
      return { ticket, etag: evidenceEtagOf(ticket.evidence, row.version) };
    });
  }

  /**
   * Whether the record the evidence is about is one the caller may declare evidence for **now**, told apart as the contract's `createEvidence` does: no such record (or one that is not the
   * caller's) is `NOT_FOUND`, the same for both, and a record in the wrong state is `STATE_CONFLICT`. The database repeats the rule for every writer (the evidence guard).
   */
  async #requireOwnerReady(
    tx: ReturnType<typeof transactionOf>,
    act: OwnerAct,
    ownerId: string,
  ): Promise<void> {
    if (act.ownerType !== 'PICKUP_STOP') throw denied();
    if (!isUuid(ownerId)) throw notFound();
    const found = await tx.execute(sql`
      select s.state as stop_state, m.state as run_state
        from pickup_stop as s join pickup_manifest as m on m.id = s.pickup_manifest_id
       where s.id = ${ownerId}::uuid`);
    const row = found.rows[0] as unknown as { stop_state: string; run_state: string } | undefined;
    if (row === undefined) throw notFound();
    if (row.run_state !== 'IN_PROGRESS') {
      throw ApiException.of(ErrorCode.StateConflict, 'The run is not in progress', {
        rule: 'run_not_in_progress',
      });
    }
    if (row.stop_state !== 'ARRIVED') {
      throw ApiException.of(ErrorCode.StateConflict, 'The rider has not arrived at this stop', {
        rule: 'stop_not_arrived',
      });
    }
  }

  async complete(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: { readonly ifMatch: string | undefined },
  ): Promise<{ readonly evidence: EvidenceView; readonly etag: string }> {
    const writers = this.#decisionsOf(authorized, 'write');
    if (!isUuid(id)) throw notFound();

    // 1. Look at the record (a short transaction), under the key of each act the session could be completing for.
    let looked:
      | {
          readonly row: EvidenceRow;
          readonly decision: AuthorizedRequest;
          readonly closed: boolean;
        }
      | undefined;
    for (const { act, decision } of writers) {
      const found = await this.#options.runner.mutate(decision, correlationId, async (handle) => {
        const result = await transactionOf(handle).execute(sql`
          select ${EVIDENCE_COLUMNS}, clock_timestamp() >= upload_expires_at as window_closed
            from evidence where id = ${id}::uuid and owner_type = ${act.ownerType}`);
        return result.rows[0] as unknown as (EvidenceRow & { window_closed: boolean }) | undefined;
      });
      if (found !== undefined) {
        looked = { row: found, decision, closed: found.window_closed };
        break;
      }
    }
    // The record of another rider, of another act and one that does not exist are one answer.
    if (looked === undefined) throw notFound();
    const { row, decision } = looked;
    const view = evidenceViewOf(row);
    if (request.ifMatch !== evidenceEtagOf(view, row.version)) {
      throw ApiException.of(ErrorCode.StateConflict, 'The evidence has changed since it was read');
    }
    if (row.state === 'STORED') return { evidence: view, etag: evidenceEtagOf(view, row.version) };
    if (row.state === 'EXPIRED' || looked.closed) {
      throw ApiException.of(ErrorCode.EvidenceUploadExpired, 'The upload window has passed');
    }

    // 2. Look at what the store holds, outside any transaction, and judge it against what was declared.
    const facts = await this.#options.store.inspect(row.storage_ref, SIGNATURE_BYTES);
    const fail = (rule: string): ApiException =>
      new ApiException(
        ErrorCode.ValidationFailed,
        400,
        'The uploaded object is not the one declared',
        {
          violations: [{ in: 'body', pointer: '/object', rule }],
        },
      );
    if (facts === undefined) throw fail('missing');
    if (facts.byteSize !== row.byte_size) throw fail('byte_size');
    if (facts.checksumSha256 !== row.checksum_sha256) throw fail('checksum');
    if (facts.contentType !== undefined && contentTypeOf(facts.contentType) !== row.content_type) {
      throw fail('content_type');
    }
    // The bytes decide the type (GBT-N14): a declared image/jpeg whose bytes are not a JPEG is refused on the signature.
    const kind = signatureOf(facts.head);
    if (kind === undefined || CONTENT_TYPE_SIGNATURE[row.content_type] !== kind) {
      throw fail('signature');
    }

    // 3. Store the record under its lock, as the version the caller read.
    return this.#options.runner.mutate(decision, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      let moved;
      try {
        moved = await tx.execute(sql`
          update evidence set state = 'STORED', validated_signature = ${kind}
           where id = ${id}::uuid and state = 'PENDING_UPLOAD' and version = ${row.version}
          returning ${EVIDENCE_COLUMNS}`);
      } catch (error) {
        const reason = guardReasonIn(error);
        if (reason === 'EVIDENCE_UPLOAD_EXPIRED') {
          throw ApiException.of(ErrorCode.EvidenceUploadExpired, 'The upload window has passed');
        }
        if (reason === 'STATE_CONFLICT') {
          throw ApiException.of(
            ErrorCode.StateConflict,
            'The evidence has changed since it was read',
          );
        }
        throw error;
      }
      const stored = moved.rows[0] as unknown as EvidenceRow | undefined;
      if (stored === undefined) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The evidence has changed since it was read',
        );
      }
      const storedView = evidenceViewOf(stored);
      return { evidence: storedView, etag: evidenceEtagOf(storedView, stored.version) };
    });
  }

  async retrieve(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<EvidenceRetrieval> {
    const readers = this.#decisionsOf(authorized, 'read');
    if (!isUuid(id)) throw notFound();
    // Staff of a hub that holds the read key of one act: for the owner types this build supports there is one.
    const [first] = readers;
    if (first === undefined) throw denied();
    const { act, decision } = first;
    return this.#options.runner.mutate(decision, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const result = await tx.execute(sql`
        select ${EVIDENCE_COLUMNS}, (select pg_catalog.date_trunc('second', pg_catalog.clock_timestamp())) as issued_at
          from evidence where id = ${id}::uuid and owner_type = ${act.ownerType}`);
      const row = result.rows[0] as unknown as (EvidenceRow & { issued_at: string }) | undefined;
      if (row === undefined) {
        // Row-level security hides a record outside the grant exactly as it hides one that does not exist; staff are told which (SECURITY_DESIGN.md 14.4b).
        const hub = await this.#probe(tx, 'evidence', id);
        throw hub === undefined
          ? notFound()
          : ApiException.of(
              ErrorCode.HubScopeViolation,
              'That record is in a hub you do not reach',
            );
      }
      if (row.state !== 'STORED') {
        throw ApiException.of(ErrorCode.EvidenceNotStored, 'The evidence is not stored');
      }
      const ttlMinutes = await this.#options.settings.integer(
        handle,
        EVIDENCE_SETTINGS.retrievalTtlMinutes,
      );
      // A look at a record in a hub that is not the actor's own is a crossing, audited as every staff read is (audit.md 5.4). The capability itself is in no event.
      const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
      if (row.responsible_hub_id !== null && row.responsible_hub_id !== baseline) {
        await this.#options.audit.write(handle, {
          code: 'auth.hub_boundary.crossed',
          enhanced: true,
          outcome: 'SUCCEEDED',
          object: { type: 'Evidence', id: row.id },
          responsibleHubId: row.responsible_hub_id,
        });
      }
      const capability = this.#options.store.presignRetrieval({
        key: row.storage_ref,
        issuedAt: timestampOf(row.issued_at),
        ttlSeconds: ttlMinutes * 60,
      });
      return {
        method: capability.method,
        url: capability.url,
        headers: capability.headers,
        expires_at: capability.expiresAt.toISOString(),
      };
    });
  }
}
