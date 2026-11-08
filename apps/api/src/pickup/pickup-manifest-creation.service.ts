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
import type { ReasonValidator, ValidatedReason } from '../platform/settings/reason-validator.js';
import { hubToday } from './pickup-hub-day.js';
import { hubCodeOf, operationalCode } from './operational-code.js';
import {
  carryoverSnapshotOf,
  judgeCarryover,
  noteOf,
  type CarryoverEntry,
  type CarryoverSnapshot,
} from './pickup-manifest-carryover.js';
import {
  assessRequests,
  type BodyViolation,
  type RequestFacts,
} from './pickup-manifest-eligibility.js';
import { pickupManifestEtagOf } from './pickup-manifest-etag.js';
import {
  MANIFEST_COLUMNS,
  STOP_COLUMNS,
  manifestViewOf,
  type PickupManifestRow,
  type PickupManifestView,
  type PickupStopRow,
} from './pickup-manifest-view.js';
import { validatedReason } from './pickup-reason-validation.js';
import { pickupReasonRequest } from './pickup-vocabulary.js';

const OPERATION = 'createPickupManifest';
const CODE_ATTEMPTS = 8;

/** The body of `createPickupManifest` as the contract's schema has validated it (the interceptor ran before this). */
export interface CreateManifestBody {
  readonly pickup_request_ids: readonly string[];
  readonly service_date: string;
  /** The reason for each request promised for an earlier day than `service_date`, and for no other. */
  readonly carryover?: readonly CarryoverEntry[];
}

export interface PickupManifestCreationOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  readonly clock: Clock;
}

export interface CreatedManifest {
  readonly manifest: PickupManifestView;
  readonly etag: string;
}

const refused = (violations: readonly BodyViolation[]): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', { violations });

/** `ALREADY_MANIFESTED`, naming the places (in the list the client sent) of the requests that are claimed. */
const alreadyManifested = (ids: readonly string[], taken: ReadonlySet<string>): ApiException =>
  ApiException.of(ErrorCode.AlreadyManifested, 'A request is already on a manifest', {
    violations: ids.flatMap((id, position) =>
      taken.has(id)
        ? [
            {
              in: 'body',
              pointer: `/pickup_request_ids/${String(position)}`,
              rule: 'already_manifested',
            },
          ]
        : [],
    ),
  });

/** The request ids as a PostgreSQL array literal: the schema has held each to a UUID, and this holds it again before it is text in a statement. */
function uuidList(ids: readonly string[]): string {
  if (
    !ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
  ) {
    throw new TypeError('A request id is a lower-case UUID');
  }
  return `{${ids.join(',')}}`;
}

/** What the caller can see of the requests it names, keyed by lower-case id (row-level security decides what that is). */
async function requestsSeen(
  handle: TransactionHandle,
  ids: readonly string[],
): Promise<Map<string, RequestFacts>> {
  const found = await transactionOf(handle).execute(sql`
    select id, state, responsible_hub_id, scheduled_service_date::text as scheduled_service_date, cutoff_exception_state
      from pickup_request where id = any(${uuidList(ids)}::uuid[])`);
  return new Map(
    (found.rows as unknown as RequestFacts[]).map((row) => [row.id.toLowerCase(), row] as const),
  );
}

/**
 * `createPickupManifest` (S1.20; `pickup.manifest.create`; `AC-SLICE-001-11`; features/pickup/pickup-manifest.md sections 4 and 5;
 * domain-model.md sections 6.3 and 6.4; the Product Owner's decisions of 29 October and 1 November 2026, plan section 11): Ops builds a
 * `DRAFT` manifest from confirmed requests that are on no manifest, each becoming a stop.
 *
 * - **Who is judged, and in what order.** The guard has answered the key, the surface and the CSRF token, and the interceptor the schema.
 *   Before the transaction, from the request alone: the idempotency key's form (the size of the list, one to 64, is the schema's). Then the transaction:
 *   **the idempotency of the command**, then the requests the caller can **see** (a request of a hub it does not reach, and one that does
 *   not exist, are one answer, `not_available`, and are never told apart from one that is claimed), then the rules of the manifest
 *   (`pickup-manifest-eligibility.ts`: one hub, `CONFIRMED`, not awaiting its cutoff review, the manifest's day), reported together as one
 *   `VALIDATION_FAILED`, and only then **the claim**: `ALREADY_MANIFESTED` is answered about requests the caller was shown.
 * - **The service date is the day the run is worked, and a request's date is its promise.** The manifest's day is an operating day that has
 *   not passed on the hub's clock; a request may go on a manifest for the day it was promised or a later one (carried over, and late against
 *   its promise: the promise is never rewritten), and never an earlier one. A new promise is a cancellation and a rebooking, or a
 *   reschedule, never an edit of a manifest (`pickup-manifest-eligibility.ts`).
 * - **A request carried over is carried over for a reason, given for it.** For each request promised for an earlier day than the manifest's,
 *   `carryover` holds one entry with a reason of the `PICKUP_CARRYOVER` domain (and a note where the reason asks for one). Old work is never
 *   refused for its age and never carried over silently: an entry missing for a carried-over request is `REASON_REQUIRED`, a reason the
 *   catalogue does not hold active is `REASON_NOT_ACTIVE` (so, until the Product Owner's codes are seeded, a manifest of overdue work
 *   cannot be made), and an entry for a request that is not carried over, is not listed or is repeated is `VALIDATION_FAILED`
 *   (`pickup-manifest-carryover.ts`). Judged after the requests are known to be eligible and before anything is written; each reason is
 *   kept on its stop as the actor saw it (`carryover_snapshot`) and changes no more.
 * - **The claim is the database's, and judged in one place.** A stop with no `released_at` claims its request, and the partial unique index
 *   lets one claim win when two Ops users overlap: the second waits for the first and, if the first committed, is refused whole. The
 *   insert of the stops is where a held claim is found, whether it was committed long ago or while this creation waited; nothing reads
 *   the claims beforehand, because a read through row-level security could disagree with the index, which is the rule. The stops are
 *   inserted in the order of the request ids, whatever order the client names them in, so that two overlapping creations queue on the
 *   same request first and never wait for each other. A claim that is lost leaves nothing behind: the manifest and its stops are one
 *   transaction.
 * - **The requests are judged again once their stops hold them.** Inserting a stop takes the key-share lock of its request's row (the
 *   foreign key), which an act that locks the request to change it (`for update`, as the cancellation does) must wait for, and which waits
 *   for that act if it came first. The statement that follows therefore sees whatever such an act committed, and a request cancelled in
 *   that window is refused here and not manifested. An act that does not lock the request first is not held by this.
 * - **The server derives everything that is not the client's to say**: the code, the hub (the requests'), the state (`DRAFT`), the
 *   stops' order (the order the ids were named in, until the ordering of S1.21 changes it) and the actor. No rider is assigned.
 * - **The audit records the membership and the order** (`pickup.manifest.created`) in the transaction of the act. A creation records no
 *   crossing of a hub boundary (as the booking does not): the hub of the event is the manifest's.
 */
export class PickupManifestCreation {
  readonly #options: PickupManifestCreationOptions;

  constructor(options: PickupManifestCreationOptions) {
    this.#options = options;
  }

  async create(
    authorized: AuthorizedRequest,
    correlationId: string,
    request: {
      readonly body: CreateManifestBody;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<CreatedManifest> {
    const { runner, audit, idempotency, clock } = this.#options;
    const { body } = request;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const actor = authorized.session.principalId;
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const named = body.pickup_request_ids;
    const ids = named.map((id) => id.toLowerCase());

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: actor,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        const stored = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as PickupManifestView;
        // The replay is the original answer, and so is its ETag: a new manifest has version one.
        return { manifest: stored, etag: pickupManifestEtagOf(stored, 1) };
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

      // 1. What the caller can see, and the rules of the manifest over it (its day is judged against today on the hub's clock).
      const today = await hubToday(handle);
      const assessed = assessRequests({
        ids: named,
        serviceDate: body.service_date,
        today,
        found: await requestsSeen(handle, ids),
      });
      if (assessed.violations.length > 0) throw refused(assessed.violations);
      const hubId = assessed.hubId;
      if (hubId === undefined) throw new Error('A manifest was assessed without a hub');
      const carryover = await this.#carryoverOf(handle, ids, assessed.carriedOver, body.carryover);

      // 2. The manifest.
      const hub = await tx.execute(sql`select name from hub where id = ${hubId}::uuid`);
      const hubName = (hub.rows[0] as { name: string } | undefined)?.name;
      if (hubName === undefined) throw new Error('The hub of a manifest could not be read');
      const hubCode = hubCodeOf(hubName);
      const manifestId = randomUUIDv7(clock);
      let manifest: PickupManifestRow | undefined;
      for (let attempt = 0; attempt < CODE_ATTEMPTS && manifest === undefined; attempt += 1) {
        const inserted = await tx.execute(sql`
          insert into pickup_manifest (id, code, responsible_hub_id, service_date, created_by)
          values (${manifestId}::uuid, ${operationalCode(hubCode, 'MF')}, ${hubId}::uuid, ${body.service_date}::date, ${actor}::uuid)
          on conflict (code) do nothing
          returning ${MANIFEST_COLUMNS}`);
        manifest = inserted.rows[0] as unknown as PickupManifestRow | undefined;
      }
      if (manifest === undefined) throw new Error('No unused operational code could be drawn');

      // 3. The stops, and with them the claim: the sequence is the order named, the insertion order is the order of the ids (see above).
      const stops = ids
        .map((requestId, position) => ({
          id: randomUUIDv7(clock),
          requestId,
          sequence: position + 1,
        }))
        .toSorted((a, b) => (a.requestId < b.requestId ? -1 : 1));
      const placed = await tx.execute(sql`
        insert into pickup_stop (id, pickup_manifest_id, pickup_request_id, responsible_hub_id, sequence, carryover_snapshot)
        values ${sql.join(
          stops.map((stop) => {
            const snapshot = carryover.get(stop.requestId);
            return sql`(${stop.id}::uuid, ${manifestId}::uuid, ${stop.requestId}::uuid, ${hubId}::uuid, ${stop.sequence}, ${snapshot === undefined ? null : JSON.stringify(snapshot)}::jsonb)`;
          }),
          sql`, `,
        )}
        on conflict (pickup_request_id) where released_at is null do nothing
        returning ${STOP_COLUMNS}`);
      const stopRows = placed.rows as unknown as PickupStopRow[];
      // A claim that is held, by a manifest committed before this one began or by a creation that committed while this one waited for the
      // index: the request got no stop, the refusal is whole and the manifest goes with it.
      const stopped = new Set(stopRows.map((stop) => stop.pickup_request_id.toLowerCase()));
      const lost = new Set(ids.filter((id) => !stopped.has(id)));
      if (lost.size > 0) throw alreadyManifested(ids, lost);

      // 4. The requests again, now that their stops hold them (see above).
      const again = assessRequests({
        ids: named,
        serviceDate: body.service_date,
        today,
        found: await requestsSeen(handle, ids),
      });
      if (again.violations.length > 0) throw refused(again.violations);
      // The reasons were asked for the requests that were overdue a moment ago. A request keeps its promise, so the same requests are carried
      // over now; if a promise was changed in the window, the stops written above name the wrong requests as carried over (or leave one out),
      // so the creation is refused at the places of the requests whose standing changed, and nothing is kept.
      const changed = ids.flatMap((id, position) =>
        assessed.carriedOver.includes(id) === again.carriedOver.includes(id)
          ? []
          : [
              {
                in: 'body' as const,
                pointer: `/pickup_request_ids/${String(position)}`,
                rule: 'promise_changed',
              },
            ],
      );
      if (changed.length > 0) throw refused(changed);

      const view = manifestViewOf(manifest, stopRows);
      await audit.write(handle, {
        code: 'pickup.manifest.created',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupManifest', id: manifestId },
        responsibleHubId: hubId,
        resultingState: 'DRAFT',
        relatedIds: { pickup_request_ids: ids },
        // How many of its requests were promised for an earlier day and are carried over (derivable from the dates, and recorded so that the
        // decision to carry work over is visible in the trail of the act that made it).
        detail: { stop_count: ids.length, carried_over_count: assessed.carriedOver.length },
      });
      await idempotency.complete(handle, scope, {
        status: 201,
        body: new TextEncoder().encode(JSON.stringify(view)),
      });
      return { manifest: view, etag: pickupManifestEtagOf(view, manifest.version) };
    });
  }

  /**
   * What each carried-over request keeps of the reason it was carried over for, by lower-case request id; none for a request on its own
   * day. The entries are judged for their structure first (`VALIDATION_FAILED`), then a carried-over request with no entry is
   * `REASON_REQUIRED`, then each reason is put to the catalogue in the order the entries were written, and the first the catalogue
   * refuses is the answer, with the place of its entry. A reason is read once for every code and every kind of note it is given with.
   */
  async #carryoverOf(
    handle: TransactionHandle,
    ids: readonly string[],
    carriedOver: readonly string[],
    entries: readonly CarryoverEntry[] | undefined,
  ): Promise<ReadonlyMap<string, CarryoverSnapshot>> {
    const judged = judgeCarryover({ ids, carriedOver, entries });
    if (judged.violations.length > 0) throw refused(judged.violations);
    if (judged.missing.length > 0) {
      throw ApiException.of(
        ErrorCode.ReasonRequired,
        'A reason is required for each request carried over to a later day',
        {
          violations: judged.missing.map((position) => ({
            in: 'body',
            pointer: `/pickup_request_ids/${String(position)}`,
            rule: 'carryover_reason_required',
          })),
        },
      );
    }

    const snapshots = new Map<string, CarryoverSnapshot>();
    const decided = new Map<string, ValidatedReason>();
    for (const [id, { position, entry }] of judged.entries) {
      const note = noteOf(entry);
      const kind = `${entry.reason_code}\u0000${note === undefined ? 'bare' : 'noted'}`;
      let reason = decided.get(kind);
      if (reason === undefined) {
        reason = await validatedReason(
          this.#options.reasons,
          handle,
          pickupReasonRequest(OPERATION, entry.reason_code, note),
          {
            violations: [{ in: 'body', pointer: `/carryover/${String(position)}`, rule: 'reason' }],
          },
        );
        decided.set(kind, reason);
      }
      snapshots.set(id, carryoverSnapshotOf(reason, note));
    }
    return snapshots;
  }
}
