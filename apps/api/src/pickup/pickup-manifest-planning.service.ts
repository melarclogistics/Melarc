import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { DatabaseTransaction } from '../platform/database/database.service.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import {
  loadManifest,
  requireCurrentManifest,
  type LoadedManifest,
} from './pickup-manifest-loader.js';
import { judgeStopOrder } from './pickup-manifest-order.js';
import {
  MANIFEST_COLUMNS,
  STOP_COLUMNS,
  manifestViewOf,
  type PickupManifestRow,
  type PickupManifestView,
  type PickupStopRow,
} from './pickup-manifest-view.js';
import { pickupManifestEtagOf } from './pickup-manifest-etag.js';
import { requiredNote } from '../platform/audit/required-note.js';

const ORDER = 'setManifestStopOrder';
const CANCEL = 'cancelPickupManifest';

/** The code of the skip a manifest's cancellation makes: the system's, never a code of the reason catalogue (as `REQUEST_CANCELLED` is). */
export const MANIFEST_CANCELLED = 'MANIFEST_CANCELLED';
const MANIFEST_CANCELLED_LABEL = 'Manifest cancelled';

export interface PickupManifestPlanningOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
}

export interface PlannedManifest {
  readonly manifest: PickupManifestView;
  readonly etag: string;
}

/** What a replay of a command answers: the representation and the token it was answered with, as they were. */
type StoredAnswer = PlannedManifest;

interface RiderFacts {
  readonly id: string;
  readonly status: string;
  readonly primary_hub_id: string;
}

const idempotencyKeyRefused = (): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
  });

/**
 * Planning a manifest before it goes out: `setManifestStopOrder`, `assignRider` and `cancelPickupManifest` (S1.21; `AC-SLICE-001-12`,
 * `-19`; features/pickup/pickup-manifest.md sections 5.1 and 5.2; state-machines.md sections 4 and 5; domain-model.md sections 6.3 and 6.4).
 * Each is a staff act on one manifest in a hub of the grant, under the manifest's lock and its `ETag`, which digests the stops: a client
 * that read the manifest before a request on it was cancelled, or before another officer reordered it, is `STATE_CONFLICT` and reads again.
 *
 * - **`setManifestStopOrder`** (`pickup.manifest.create`; `Idempotency-Key` and `If-Match`). The complete sequence of the stops of a `DRAFT`
 *   manifest, set in one statement; the sequence is a plan the rider may depart from, and no route is optimised (`pickup-manifest-order.ts`
 *   holds the rules of the list). Ordering stays open across the assignment of a rider and closes at dispatch. One
 *   `pickup.manifest.stops_ordered` for the act, once however many times it is sent.
 * - **`assignRider`** (`pickup.manifest.assign`; `If-Match`). Names a rider who is `ACTIVE` and belongs to the manifest's hub (the rider's
 *   `primary_hub_id`: the reach of the officer's grant is not the rider's eligibility, and the temporary assignment that could widen it is not
 *   built). A rider the caller cannot see, one that does not exist, one that is not active and one of another hub are one answer,
 *   `RIDER_UNAVAILABLE`; sets `assigned_rider_id`
 *   and `assigned_at`; and **marks every confirmed request the manifest holds as committed to a rider** (`rider_assigned`), which is the
 *   moment a vendor's own cancellation would close and the moment a cancellation by the office becomes a chargeable decision. The manifest
 *   stays `DRAFT`: assignment does not dispatch and does not start. The serviceable-motorcycle check is not made (the owner's decision of 29
 *   October 2026: SLICE-011). Assignment is of a `DRAFT` manifest; a rider is given a manifest that has been dispatched by the dispatch task,
 *   because that is the moment its stops reach a rider. Naming the rider the manifest already has changes nothing and writes nothing, and
 *   giving a draft another rider keeps the commitment: the claim is the same and the manifest still has a rider.
 * - **`cancelPickupManifest`** (`pickup.manifest.create`; `Idempotency-Key` and `If-Match`; a mandatory note). A `DRAFT` or `DISPATCHED`
 *   manifest becomes `CANCELLED` and **every claim it holds is released** (an explicit, authorized release: the requests that are still
 *   confirmed return to the pool). The stops still to be worked are skipped with the system's reason `MANIFEST_CANCELLED`; a stop already
 *   skipped (because its request was cancelled) keeps its reason and has its claim released. **The requests that are still confirmed lose
 *   their commitment in the same transaction** (`rider_assigned` is lowered), so that a request in the pool is no longer treated as one a
 *   rider holds; a request that was cancelled meanwhile is frozen and keeps the mark its cancellation was decided on, with its decision.
 *   A run that has started is `RUN_ALREADY_STARTED`, a completed or cancelled one `STATE_CONFLICT`. A rider the manifest was dispatched to
 *   still reads it, cancelled.
 *
 * **The commitment, and the order of the locks** (the Product Owner's decision of 2 November 2026, OB-S1-35). A request is committed to a
 * rider while a stop with no `released_at` holds it on a manifest that has a rider, and at no other time; `rider_assigned` is that fact, kept
 * on the request because the cancellation of a request reads the request it has locked, and a read of the stop and the manifest through
 * row-level security could hide the very claim in question. These two acts are the only ones that change what it is made of, and each moves the
 * mark in its own transaction (migration `0064` holds the same rule for every writer). The acts that meet on a request take their locks in one
 * order, **the manifest, then the requests it holds in the order of their ids, then their stops**, which is the order of the cancellation of a
 * request (the request, then its stop, and never the manifest): so the three of them, in any interleaving, wait for one another in a line and
 * never in a circle. The lock of the requests is taken before any stop is written, which is why it is a statement of its own.
 *
 * The audit of each is in the transaction of the act (`pickup.manifest.stops_ordered`, `.rider_assigned`, `.cancelled`, and one
 * `pickup.stop.skipped` for each stop the cancellation skips).
 */
export class PickupManifestPlanning {
  readonly #options: PickupManifestPlanningOptions;

  constructor(options: PickupManifestPlanningOptions) {
    this.#options = options;
  }

  async setStopOrder(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: { readonly ordered_stop_ids: readonly string[] };
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<PlannedManifest> {
    const { runner, audit, idempotency } = this.#options;
    const actor = this.#actor(authorized);
    if (!isIdempotencyKey(request.idempotencyKey)) throw idempotencyKeyRefused();
    const ordered = request.body.ordered_stop_ids.map((each) => each.toLowerCase());

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: actor,
        operationId: ORDER,
        key: request.idempotencyKey,
      } as const;
      const replay = await this.#begin(handle, scope, request.fingerprint);
      if (replay !== undefined) return replay;

      // The stops are locked with the manifest, in that order: an act that is resolving one of them (Ops's skip, the cancellation of its request) is
      // waited for, and what is judged below is the run as it is once that act has ended. A stop resolved meanwhile moves the manifest's token, so
      // the officer is told the draft has changed, as a serial order would tell them, and not met by the stop's guard.
      const loaded = await this.#lockedManifest(handle, id, { lockStops: true });
      requireCurrentManifest(request.ifMatch, loaded);
      if (loaded.row.state !== 'DRAFT') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a draft manifest is ordered');
      }
      const violations = judgeStopOrder({
        ordered,
        stops: loaded.stops.map((stop) => ({
          id: stop.id.toLowerCase(),
          sequence: stop.sequence,
          state: stop.state,
        })),
      });
      if (violations.length > 0) {
        throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
          violations,
        });
      }

      // The whole sequence in one statement: the unique key of the sequence is deferrable, so the stops may pass through a state in which two
      // share a number.
      await tx.execute(sql`
        update pickup_stop as stop set sequence = placed.sequence
          from (values ${sql.join(
            ordered.map((stopId, position) => sql`(${stopId}::uuid, ${position + 1}::int)`),
            sql`, `,
          )}) as placed(id, sequence)
         where stop.id = placed.id and stop.pickup_manifest_id = ${loaded.row.id}::uuid`);
      const answer = await this.#reread(handle, loaded.row);

      await audit.write(handle, {
        code: 'pickup.manifest.stops_ordered',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupManifest', id: loaded.row.id },
        responsibleHubId: loaded.row.responsible_hub_id,
        relatedIds: { ordered_stop_ids: ordered },
        detail: { stop_count: ordered.length },
      });
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer satisfies StoredAnswer)),
      });
      return answer;
    });
  }

  async assignRider(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: { readonly body: { readonly rider_id: string }; readonly ifMatch: string | undefined },
  ): Promise<PlannedManifest> {
    const { runner, audit } = this.#options;
    this.#actor(authorized);
    const riderId = request.body.rider_id.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const loaded = await this.#lockedManifest(handle, id);
      requireCurrentManifest(request.ifMatch, loaded);
      if (loaded.row.state !== 'DRAFT') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a draft manifest is given a rider');
      }

      // Whom the caller can see is row-level security's, and whom the manifest may be given to is not: the rider must be `ACTIVE` and belong to
      // the manifest's hub (`primary_hub_id`). The reach of the officer's grant establishes neither, and no temporary assignment to another hub
      // exists to say otherwise (`HubAssignment`, section 30.5, is not built). A rider outside the grant, one that does not exist, one that is
      // not active and one of another hub are one answer.
      const found = await tx.execute(
        sql`select id, status, primary_hub_id from rider_identity where id = ${riderId}::uuid`,
      );
      const rider = found.rows[0] as unknown as RiderFacts | undefined;
      if (
        rider?.status !== 'ACTIVE' ||
        rider.primary_hub_id.toLowerCase() !== loaded.row.responsible_hub_id.toLowerCase()
      ) {
        throw ApiException.of(ErrorCode.RiderUnavailable, 'That rider cannot be assigned');
      }
      if (loaded.row.assigned_rider_id?.toLowerCase() === riderId) {
        return { manifest: loaded.view, etag: loaded.etag };
      }

      const previous = loaded.row.assigned_rider_id;
      const updated = await tx.execute(sql`
        update pickup_manifest set assigned_rider_id = ${riderId}::uuid, assigned_at = now()
         where id = ${loaded.row.id}::uuid and state = 'DRAFT'
        returning ${MANIFEST_COLUMNS}`);
      const manifest = updated.rows[0] as unknown as PickupManifestRow | undefined;
      // Under the lock and having read the manifest in that state, the update cannot miss it.
      if (manifest === undefined) throw new Error('A locked manifest was not assigned');

      // The requests the manifest holds are now committed to a rider: the vendor's window and the cancellation charge read it, and nothing else
      // raises it. They are locked first, in the order of their ids (the order of every act that takes more than one), and then marked. A
      // request that is no longer confirmed is not marked (a cancelled request is frozen), and one already marked is left as it is.
      await this.#lockHeldRequests(tx, manifest.id);
      const marked = await tx.execute(sql`
        update pickup_request set rider_assigned = true
         where state = 'CONFIRMED' and rider_assigned = false
           and id in (select pickup_request_id from pickup_stop
                       where pickup_manifest_id = ${manifest.id}::uuid and released_at is null)
        returning id`);

      const stops = await tx.execute(sql`
        select ${STOP_COLUMNS} from pickup_stop where pickup_manifest_id = ${manifest.id}::uuid order by sequence, id`);
      const view = manifestViewOf(manifest, stops.rows as unknown as PickupStopRow[]);
      await audit.write(handle, {
        code: 'pickup.manifest.rider_assigned',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupManifest', id: manifest.id },
        responsibleHubId: manifest.responsible_hub_id,
        previousState: 'DRAFT',
        resultingState: 'DRAFT',
        relatedIds:
          previous === null
            ? { rider_id: riderId }
            : { rider_id: riderId, previous_rider_id: previous },
        detail: { requests_marked: marked.rows.length },
      });
      return { manifest: view, etag: pickupManifestEtagOf(view, manifest.version) };
    });
  }

  async cancel(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: {
      readonly body: { readonly note: string };
      readonly ifMatch: string | undefined;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<PlannedManifest> {
    const { runner, audit, idempotency } = this.#options;
    const actor = this.#actor(authorized);
    if (!isIdempotencyKey(request.idempotencyKey)) throw idempotencyKeyRefused();
    // A cancellation says why, in the operator's own words: blank is `REASON_REQUIRED`, and a note the ledger would not keep is refused.
    const note = requiredNote(request.body.note);

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'STAFF',
        principalId: actor,
        operationId: CANCEL,
        key: request.idempotencyKey,
      } as const;
      const replay = await this.#begin(handle, scope, request.fingerprint);
      if (replay !== undefined) return replay;

      const loaded = await this.#lockedManifest(handle, id);
      requireCurrentManifest(request.ifMatch, loaded);
      if (loaded.row.state === 'IN_PROGRESS') {
        throw ApiException.of(
          ErrorCode.RunAlreadyStarted,
          'The run has started; skip the stops or hand it over',
        );
      }
      if (loaded.row.state !== 'DRAFT' && loaded.row.state !== 'DISPATCHED') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'Only a draft or a dispatched manifest is cancelled',
        );
      }

      // The instant is the database's, read after the locks: a skip is stamped no earlier than anything that committed to a stop meanwhile.
      const instantRow = await tx.execute(sql`select clock_timestamp() as instant`);
      const raw = (instantRow.rows[0] as { instant: string | Date } | undefined)?.instant;
      if (raw === undefined) throw new Error('The database gave no time');
      const instant = (raw instanceof Date ? raw : new Date(raw)).toISOString();
      const snapshot = JSON.stringify({
        reason_code: MANIFEST_CANCELLED,
        label: MANIFEST_CANCELLED_LABEL,
        skipped_at: instant,
      });

      // The requests this manifest still holds are locked first, in the order of their ids, before any stop is written: the cancellation of a
      // request locks the request and then its stop, so a cancellation of the manifest that took the stop first and the request second would
      // be the other half of a deadlock. One that waits for a request here holds no stop, and the request's own cancellation finishes.
      await this.#lockHeldRequests(tx, loaded.row.id);

      // The stops still to be worked are skipped, with their claims released, and a stop already skipped (because its request was cancelled)
      // has only its claim released. Each statement judges the stops as they are when it runs, so a stop that a cancellation of its request
      // skipped since they were read is not skipped again, and the events below are written for the stops that were skipped here.
      const skipped = await tx.execute(sql`
        update pickup_stop
           set state = 'SKIPPED', resolved_at = ${instant}::timestamptz, skip_snapshot = ${snapshot}::jsonb, released_at = ${instant}::timestamptz
         where pickup_manifest_id = ${loaded.row.id}::uuid and state in ('PENDING', 'ARRIVED')
        returning id, pickup_request_id`);
      const toSkip = skipped.rows as unknown as { id: string; pickup_request_id: string }[];
      const released = await tx.execute(sql`
        update pickup_stop set released_at = ${instant}::timestamptz
         where pickup_manifest_id = ${loaded.row.id}::uuid and released_at is null
        returning id`);

      // The claims are released, so the requests that are still confirmed are committed to no rider: the mark goes with the claim that gave it,
      // in this transaction. Only the claims this act released are looked at (the instant is theirs alone), so a request that another manifest
      // has claimed since is never reached from here; one that was cancelled meanwhile is frozen and keeps what its cancellation was decided on.
      const ended = await tx.execute(sql`
        update pickup_request set rider_assigned = false
         where state = 'CONFIRMED' and rider_assigned
           and id in (select pickup_request_id from pickup_stop
                       where pickup_manifest_id = ${loaded.row.id}::uuid and released_at = ${instant}::timestamptz)
        returning id`);

      const cancelled = await tx.execute(sql`
        update pickup_manifest set state = 'CANCELLED'
         where id = ${loaded.row.id}::uuid and state = ${loaded.row.state}
        returning ${MANIFEST_COLUMNS}`);
      const manifest = cancelled.rows[0] as unknown as PickupManifestRow | undefined;
      if (manifest === undefined) throw new Error('A locked manifest was not cancelled');

      const stops = await tx.execute(sql`
        select ${STOP_COLUMNS} from pickup_stop where pickup_manifest_id = ${manifest.id}::uuid order by sequence, id`);
      const view = manifestViewOf(manifest, stops.rows as unknown as PickupStopRow[]);
      const answer = {
        manifest: view,
        etag: pickupManifestEtagOf(view, manifest.version),
      } satisfies StoredAnswer;

      await audit.write(handle, {
        code: 'pickup.manifest.cancelled',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupManifest', id: manifest.id },
        responsibleHubId: manifest.responsible_hub_id,
        previousState: loaded.row.state,
        resultingState: 'CANCELLED',
        note,
        detail: {
          stops_skipped: toSkip.length,
          claims_released: toSkip.length + released.rows.length,
          commitments_ended: ended.rows.length,
        },
      });
      for (const stop of toSkip) {
        await audit.write(handle, {
          code: 'pickup.stop.skipped',
          enhanced: false,
          outcome: 'SUCCEEDED',
          object: { type: 'PickupStop', id: stop.id },
          responsibleHubId: manifest.responsible_hub_id,
          // Before the run starts a stop can only be pending: arrival needs a started run.
          previousState: 'PENDING',
          resultingState: 'SKIPPED',
          reason: { code: MANIFEST_CANCELLED, label: MANIFEST_CANCELLED_LABEL },
          relatedIds: {
            pickup_request_id: stop.pickup_request_id,
            pickup_manifest_id: manifest.id,
          },
          detail: { cause: 'MANIFEST_CANCELLATION' },
        });
      }
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return answer;
    });
  }

  /**
   * The requests this manifest holds by a claim that is not released and that are still confirmed, locked in the order of their ids. A request
   * that is not confirmed is not locked (a cancelled request is frozen, and this act writes nothing to it), and one whose cancellation commits
   * while this waits is left out when the statement judges it again.
   */
  async #lockHeldRequests(tx: DatabaseTransaction, manifestId: string): Promise<void> {
    await tx.execute(sql`
      select r.id from pickup_request as r
       where r.state = 'CONFIRMED'
         and r.id in (select pickup_request_id from pickup_stop where pickup_manifest_id = ${manifestId}::uuid and released_at is null)
       order by r.id
         for update of r`);
  }

  #actor(authorized: AuthorizedRequest): string {
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    return authorized.session.principalId;
  }

  /** The command's idempotency record: a replay answers as it was answered, a different request under the key is refused. */
  async #begin(
    handle: TransactionHandle,
    scope: {
      readonly principalType: 'STAFF';
      readonly principalId: string;
      readonly operationId: string;
      readonly key: string;
    },
    fingerprint: string,
  ): Promise<PlannedManifest | undefined> {
    const begun = await this.#options.idempotency.begin(handle, scope, fingerprint);
    if (begun.outcome === 'REPLAY') {
      return JSON.parse(Buffer.from(begun.response.body).toString('utf8')) as StoredAnswer;
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

  /** The manifest and its stops under their locks. A manifest the caller cannot see is not found (the guard has told a foreign hub's apart). */
  async #lockedManifest(
    handle: TransactionHandle,
    id: string,
    options: { readonly lockStops?: boolean } = {},
  ): Promise<LoadedManifest> {
    const loaded = await loadManifest(handle, id, { lock: true, ...options });
    if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
    return loaded;
  }

  async #reread(handle: TransactionHandle, row: PickupManifestRow): Promise<PlannedManifest> {
    const stops = await transactionOf(handle).execute(sql`
      select ${STOP_COLUMNS} from pickup_stop where pickup_manifest_id = ${row.id}::uuid order by sequence, id`);
    const view = manifestViewOf(row, stops.rows as unknown as PickupStopRow[]);
    return { manifest: view, etag: pickupManifestEtagOf(view, row.version) };
  }
}
