import { sql } from 'drizzle-orm';

import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import type { ConfigurationReader } from '../platform/settings/configuration-reader.js';
import {
  attemptLimitOf,
  hasExtensionOfItsOwn,
  permitsAnotherAttempt,
  refusalReleasedFor,
  refusedCollectionOf,
} from './attempt-ceiling.js';
import { requiredNote } from '../platform/audit/required-note.js';
import { pickupRequestEtagOf } from './pickup-request-etag.js';
import { loadRequest, requireCurrent } from './pickup-request-loader.js';
import {
  REQUEST_COLUMNS,
  viewOf,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

const EXTEND = 'extendPickupAttempts';
const ESCALATE = 'escalatePickupRequest';
const EXTEND_KEY = 'pickup.attempt.extend';
const ESCALATE_KEY = 'pickup.failure.resolve';

/** The body of `extendPickupAttempts` as the contract's schema has validated it (the interceptor ran before this): a reason, no ceiling. */
export interface ExtensionBody {
  readonly reason: string;
}

/** The body of `escalatePickupRequest`: a note, and no resolution. */
export interface EscalationBody {
  readonly note: string;
}

export interface PickupRequestChainOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly configuration: Pick<ConfigurationReader, 'forHub'>;
  /** The clock of the identifier of an extension. */
  readonly clock: Clock;
}

export interface ChainedRequest {
  readonly request: PickupRequestView;
  readonly etag: string;
}

/** What a replay of the command answers: the representation and the token it was answered with, as they were. */
interface StoredAnswer {
  readonly etag: string;
  readonly request: PickupRequestView;
}

/** The facts of a command of the chain: who acts, which command, under which key and fingerprint. */
interface Command<Body> {
  readonly body: Body;
  readonly ifMatch: string | undefined;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
}

/**
 * `extendPickupAttempts` and `escalatePickupRequest` (S1.18; `AC-SLICE-001-06`, `-07`, `-33` to `-35` as far as the failure is S1.28's;
 * pickup-request.md section 5.2; pickup-failure.md sections 5 and 13; state-machines.md section 3; `MSC-DEC-116`). Both are commands on a
 * request that sits `CONFIRMED` in the chain: each is read, locked and compared with `If-Match` under the lock (two members of the office who
 * read one request are put in a line), is made once however many times it is sent (`Idempotency-Key`), and is one enhanced audit event,
 * because each overrides the course the request would take (section 38.5).
 *
 * **`extendPickupAttempts`** (`pickup.attempt.extend`: hub Senior Ops and Platform Admin; a reason and no ceiling). It permits **one** further
 * attempt of a request that cannot go on without it (`attempt-ceiling.ts` says what it reaches, and that this reading is provisional): a
 * record of its own (actor, reason, moment, the ceiling before and after; never changed or removed) that the request then carries. A request
 * that can go on, one that is not confirmed, a hub whose cap is unset or invalid (no ceiling applies) and one already extended for this attempt
 * are `STATE_CONFLICT`. The hub's configuration is read before the transaction, as the confirmation reads it.
 *
 * **`escalatePickupRequest`** (`pickup.failure.resolve`: Ops, Senior Ops and Platform Admin; a note). The terminal Ops resolution of a failed
 * request: it records the moment once (`escalated_at`) and nothing else changes (the request can still be cancelled; a Senior Ops extension
 * still opens a further attempt). The actor, the trigger and the note are in the audit event. **A failure can be recorded now (`reportPickupFailure`, S1.28), but a
 * request still need not have failed to be escalated**: a confirmed one that was not escalated is escalable. The narrowing to a failed stop and the
 * scheduled backstop that records `trigger: BACKSTOP` are the rest of S1.28 and are not built (OB-S1-66).
 */
export class PickupRequestChain {
  readonly #options: PickupRequestChainOptions;

  constructor(options: PickupRequestChainOptions) {
    this.#options = options;
  }

  async extend(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    command: Command<ExtensionBody>,
  ): Promise<ChainedRequest> {
    const { runner, audit, idempotency, configuration, clock } = this.#options;
    const actor = staffOf(authorized);
    requireKey(command.idempotencyKey);
    const reason = requiredNote(command.body.reason, '/reason');

    // The hub is found in a short transaction of its own (the platform allows one connection to a request), the configuration is read next,
    // and the extending transaction re-checks that the hub is the same.
    const hubId = await runner.mutate(authorized, correlationId, async (handle) => {
      const found = await transactionOf(handle).execute(
        sql`select responsible_hub_id from pickup_request where id = ${id}::uuid`,
      );
      return (found.rows[0] as { responsible_hub_id: string } | undefined)?.responsible_hub_id;
    });
    if (hubId === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    const config = await configuration.forHub(hubId);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = scopeOf(actor, EXTEND, command.idempotencyKey);
      const replay = await begin(idempotency, handle, scope, command.fingerprint);
      if (replay !== undefined) return replay;

      const loaded = await loadRequest(handle, id, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const { row } = loaded;
      if (row.responsible_hub_id.toLowerCase() !== config.hubId.toLowerCase()) {
        // The request moved to another hub between the two transactions (a reassignment): nothing was written, and the command is sent again.
        throw new Error('The hub of the request changed while it was being extended');
      }
      requireCurrent(command.ifMatch, loaded);
      if (row.state !== 'CONFIRMED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'Only a confirmed request has an attempt to extend',
        );
      }
      // What holds the request back: the ceiling (the cap, or the ceiling of an earlier extension) and, apart from it, the restriction a refused collection puts on it
      // (escalation-only, AC-SLICE-001-33). The extension lifts what is there to lift and says which: a ceiling it did not lift is no ceiling it records, and the
      // request's own attempt is never written down as the ceiling in force before.
      const limit = await attemptLimitOf(tx, config, row);
      const ceilingBlocks =
        limit.kind === 'SET' && !permitsAnotherAttempt(limit, row.attempt_number);
      const restricted =
        (await refusedCollectionOf(tx, id)) && !(await refusalReleasedFor(tx, row));
      if (!ceilingBlocks && !restricted) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          limit.kind === 'UNAVAILABLE'
            ? 'No attempt ceiling applies to this hub and nothing restricts the request: there is nothing to extend'
            : 'The request can make another attempt: there is nothing to extend',
        );
      }
      // A request has at most one extension of its own (the table's unique key): one that stood in the way twice would need two.
      if (await hasExtensionOfItsOwn(tx, row)) {
        throw ApiException.of(ErrorCode.StateConflict, 'The request was extended already');
      }

      const extensionId = randomUUIDv7(clock);
      const ceilingBefore = ceilingBlocks ? limit.ceiling : null;
      const ceilingAfter = ceilingBlocks ? row.attempt_number + 1 : null;
      await tx.execute(sql`
        insert into pickup_attempt_extension (id, pickup_request_id, ceiling_before, ceiling_after, releases_refused_collection, extended_by, reason)
        values (${extensionId}::uuid, ${id}::uuid, ${ceilingBefore}, ${ceilingAfter}, ${restricted}, ${actor}::uuid, ${reason})`);
      const updated = await tx.execute(sql`
        update pickup_request set attempt_extension_id = ${extensionId}::uuid
         where id = ${id}::uuid and state = 'CONFIRMED'
        returning ${REQUEST_COLUMNS}`);
      const extended = updated.rows[0] as unknown as PickupRequestRow | undefined;
      // Under the lock and having read the row as confirmed, the update cannot miss it.
      if (extended === undefined) throw new Error('A locked confirmed request was not extended');

      await audit.write(handle, {
        code: 'pickup.attempt.extended',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: extended.responsible_hub_id,
        ...(extended.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: extended.vendor_organization_id }),
        previousState: 'CONFIRMED',
        resultingState: 'CONFIRMED',
        note: reason,
        beforeAfter: {
          attempt_extension_id: { before: row.attempt_extension_id, after: extensionId },
          ...(ceilingBlocks
            ? { attempt_ceiling: { before: ceilingBefore, after: ceilingAfter } }
            : {}),
          ...(restricted
            ? {
                refused_collection_restriction: {
                  before: 'ESCALATION_ONLY',
                  after: 'RELEASED_FOR_ONE_ATTEMPT',
                },
              }
            : {}),
        },
        relatedIds: { attempt_extension_id: extensionId },
        detail: {
          permission: EXTEND_KEY,
          lifts_attempt_ceiling: ceilingBlocks,
          releases_refused_collection: restricted,
        },
      });
      return finish(idempotency, handle, scope, extended, loaded.view.one_package_exception);
    });
  }

  async escalate(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    command: Command<EscalationBody>,
  ): Promise<ChainedRequest> {
    const { runner, audit, idempotency } = this.#options;
    const actor = staffOf(authorized);
    requireKey(command.idempotencyKey);
    const note = requiredNote(command.body.note);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = scopeOf(actor, ESCALATE, command.idempotencyKey);
      const replay = await begin(idempotency, handle, scope, command.fingerprint);
      if (replay !== undefined) return replay;

      const loaded = await loadRequest(handle, id, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      requireCurrent(command.ifMatch, loaded);
      const { row } = loaded;
      if (row.state !== 'CONFIRMED') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a confirmed request is escalated');
      }
      if (row.escalated_at !== null) {
        throw ApiException.of(ErrorCode.StateConflict, 'The request was escalated already');
      }

      const updated = await tx.execute(sql`
        update pickup_request set escalated_at = clock_timestamp()
         where id = ${id}::uuid and state = 'CONFIRMED' and escalated_at is null
        returning ${REQUEST_COLUMNS}`);
      const escalated = updated.rows[0] as unknown as PickupRequestRow | undefined;
      // Under the lock and having read the row as confirmed and not escalated, the update cannot miss it.
      if (escalated === undefined) throw new Error('A locked confirmed request was not escalated');
      const view = viewOf(escalated, { exception: loaded.view.one_package_exception });

      await audit.write(handle, {
        code: 'pickup.request.escalated',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupRequest', id },
        responsibleHubId: escalated.responsible_hub_id,
        ...(escalated.vendor_organization_id === null
          ? {}
          : { vendorOrganizationId: escalated.vendor_organization_id }),
        previousState: 'CONFIRMED',
        resultingState: 'CONFIRMED',
        note,
        beforeAfter: { escalated_at: { before: null, after: view.escalated_at } },
        // The trigger is the actor's own act; the scheduled backstop of S1.28 records BACKSTOP and no actor.
        detail: { trigger: 'OPS', permission: ESCALATE_KEY },
      });
      return finish(idempotency, handle, scope, escalated, loaded.view.one_package_exception);
    });
  }
}

/** The staff member who acts: both commands are the office's, and a vendor or a rider is refused by the guard before this runs. */
function staffOf(authorized: AuthorizedRequest): string {
  if (authorized.session.principalType !== 'STAFF') {
    throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
  }
  return authorized.session.principalId;
}

function requireKey(key: string): void {
  if (!isIdempotencyKey(key)) {
    throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
      violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
    });
  }
}

const scopeOf = (actor: string, operationId: string, key: string) =>
  ({ principalType: 'STAFF', principalId: actor, operationId, key }) as const;

type Scope = ReturnType<typeof scopeOf>;
type Handle = TransactionHandle;

/** Begins the command under its key: the original answer for a replay, a refusal for another body, `undefined` for a new command. */
async function begin(
  idempotency: IdempotencyStore,
  handle: Handle,
  scope: Scope,
  fingerprint: string,
): Promise<ChainedRequest | undefined> {
  const begun = await idempotency.begin(handle, scope, fingerprint);
  if (begun.outcome === 'REPLAY') {
    const stored = JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as StoredAnswer;
    return { request: stored.request, etag: stored.etag };
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
  return undefined;
}

/** The answer of the command: the request as it now is and its token, kept for a replay. */
async function finish(
  idempotency: IdempotencyStore,
  handle: Handle,
  scope: Scope,
  row: PickupRequestRow,
  exception: PickupRequestView['one_package_exception'],
): Promise<ChainedRequest> {
  const view = viewOf(row, { exception });
  const etag = pickupRequestEtagOf(view, row.version);
  const answer: StoredAnswer = { etag, request: view };
  await idempotency.complete(handle, scope, {
    status: 200,
    body: new TextEncoder().encode(JSON.stringify(answer)),
  });
  return { request: view, etag };
}
