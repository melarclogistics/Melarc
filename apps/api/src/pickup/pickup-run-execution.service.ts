import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { hubToday } from './pickup-hub-day.js';
import { pickupManifestEtagOf } from './pickup-manifest-etag.js';
import { loadManifest, requireCurrentManifest } from './pickup-manifest-loader.js';
import {
  MANIFEST_COLUMNS,
  STOP_COLUMNS,
  manifestViewOf,
  stopViewOf,
  type PickupManifestRow,
  type PickupManifestView,
  type PickupStopRow,
  type PickupStopView,
} from './pickup-manifest-view.js';
import { pickupStopEtagOf } from './pickup-stop-etag.js';

export interface PickupRunExecutionOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly idempotency: IdempotencyStore;
}

export interface StartedRun {
  readonly manifest: PickupManifestView;
  readonly etag: string;
}

export interface ArrivedStop {
  readonly stop: PickupStopView;
  readonly etag: string;
}

/** A stop as the arrival reads and returns it: the columns of a read, the version its token is made of, and the hub its event is about. */
interface ArrivalRow extends PickupStopRow {
  readonly version: number;
  readonly responsible_hub_id: string;
}

/** What is kept of an arrival so that a retry with the same key is answered with it, byte for byte. */
interface StoredArrival {
  readonly etag: string;
  readonly stop: PickupStopView;
}

const OPERATION = 'arriveAtPickupStop';

/**
 * The refusal of a rider who acts on work that is not theirs (`AC-SLICE-001-14` and `-80`; errors-and-enums.md: a rider who **acts** on
 * unassigned work is told `NOT_ASSIGNED_RIDER`, and one who **looks it up** is told `NOT_FOUND`). A rider's context shows it the runs and the
 * stops assigned to it and dispatched, and no other, so a colleague's run, a draft, a run cancelled before it went out and an id that matches
 * nothing are the same to the rider's transaction, and are **one answer, in one place**: nothing here says which of the four it was.
 */
const notTheRidersWork = (): ApiException =>
  ApiException.of(ErrorCode.NotAssignedRider, 'This is not work assigned to you');

/**
 * `startRun` and `arriveAtPickupStop` (S1.22; `pickup.run.execute`; `AC-SLICE-001-14`, `-16` and `-80`; features/pickup/pickup-manifest.md;
 * state-machines.md sections 4 and 5; the Product Owner's decisions of 29 October and 2 November 2026, OB-S1-31): the two acts of the rider on
 * a run, the first of the rider's that write anything but its own sign-out.
 *
 * **Both acts are the rider's alone, on work assigned to it.** A rider's context shows it the manifests assigned to it and dispatched, and their
 * stops, through row-level security; the policies of migration `0065` let it change a dispatched manifest of its own to `IN_PROGRESS` and a
 * stop of its own to `ARRIVED`, and its guards hold both moves for every writer. What the rider is not shown it cannot lock, so a run or a
 * stop that is not the rider's (a colleague's, a draft's, one that does not exist) is `NOT_ASSIGNED_RIDER`, the same in each case.
 *
 * - **`startRun`** is judged under the manifest's lock, in this order: that the run is the rider's (`NOT_ASSIGNED_RIDER`); the `ETag` of the run
 *   as it is now with its stops (`STATE_CONFLICT`: the rider read an older run, which a cancelled pickup or an Ops change makes of it, and
 *   reads it again); that the run is dispatched (`STATE_CONFLICT`); and **that its day is today on the hub's clock** (`STATE_CONFLICT`,
 *   `details.rule` `service_date_not_reached` before it and `service_date_passed` after it has passed; OB-S1-31: dispatch is publication and
 *   the start is the day); and **that a stop of it is still to be worked** (`MANIFEST_EMPTY`, the declared error that the dispatch answers a
 *   manifest with nothing to send: a run whose every pickup was cancelled or resolved stays dispatched for Ops to cancel unstarted,
 *   OB-S1-39). It writes the state and the moment of the
 *   start of the manifest, **and nothing else**: "all the work of the run moves
 *   to the active context in one change" is that one row, because a stop is worked when its manifest is in progress and no stop is written.
 *   A run that has started goes on past midnight and is not touched by the day ending.
 * - **`arriveAtPickupStop`** is a stop `PENDING` becoming `ARRIVED` with the moment, in any order. It is judged under the stop's lock: that
 *   the stop is the rider's (`NOT_ASSIGNED_RIDER`); that its run has started (`MANIFEST_NOT_STARTED` for a run that is only dispatched,
 *   `STATE_CONFLICT` for one that is over); and that the stop is still to be worked (`STATE_CONFLICT`: a stop skipped because its request was
 *   cancelled is never arrived at from an outdated screen). **A retry is not a second arrival**: the `Idempotency-Key` replays the answer, and
 *   another key on a stop already arrived at is `STATE_CONFLICT`. **It locks the stop alone**, which is the whole of the order of locks for the
 *   acts on one request (the request, then its stop, and never the manifest): the rider does not read the request (the registry), the
 *   cancellation of a request locks the request and then the stop, and an arrival that waits for the stop only ever waits forward, so the two
 *   in any interleaving end as one serial order would. A request cancelled before the arrival has its stop skipped in the cancellation's own
 *   transaction, and that state, not a read of the request, is what refuses the arrival. **The database holds that for every writer**
 *   (migration `0065`): a cancelled request never coexists with a stop that is still to be worked (a constraint checked at the end of the
 *   transaction, so the office's cancellation stays one immediate step), and an arrival that commits first is kept by the cancellation that
 *   follows it, which skips the stop and keeps the moment (the guard of the stop holds that key to the skip).
 *
 * Neither act writes or reads a request: the vendor's window to cancel closed at the assignment (`AC-SLICE-001-12`), and the request's
 * representation does not change when its stop is arrived at. Each writes one event in the rider's name.
 */
export class PickupRunExecution {
  readonly #options: PickupRunExecutionOptions;

  constructor(options: PickupRunExecutionOptions) {
    this.#options = options;
  }

  async start(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: { readonly ifMatch: string | undefined },
  ): Promise<StartedRun> {
    const { runner, audit } = this.#options;
    if (authorized.session.principalType !== 'RIDER') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    const riderId = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      // The stops are locked with the manifest (in that order): an act that is resolving one of them, the cancellation of its request or Ops's
      // skip, is waited for, and what is judged below is the run as it is once that act has ended. Without it a run could be started past a
      // pickup that is being resolved, with nothing left to work and nothing to complete it.
      const loaded = await loadManifest(handle, id, { lock: true, lockStops: true });
      if (loaded === undefined) throw notTheRidersWork();
      requireCurrentManifest(request.ifMatch, loaded);
      if (loaded.row.state !== 'DISPATCHED') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a dispatched run is started');
      }

      // The day is the hub's, from the database's instant: a run is started on its own day, not before it and not once it has passed.
      const today = await hubToday(handle);
      if (loaded.row.service_date > today) {
        throw ApiException.of(ErrorCode.StateConflict, 'The day of this run has not come', {
          rule: 'service_date_not_reached',
          service_date: loaded.row.service_date,
        });
      }
      if (loaded.row.service_date < today) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The day of this run has passed: it is cancelled and its pickups are planned again',
          { rule: 'service_date_passed', service_date: loaded.row.service_date },
        );
      }

      // A run with nothing left to work is not started (OB-S1-39; the Product Owner's review of 2 November 2026): every pickup of it has been
      // cancelled or resolved, and nothing would complete a run started so. It stays dispatched, and Ops cancels it unstarted. The stops are read
      // after the manifest's lock was won, and a cancellation that commits after that read is a cancellation after the start: the run goes out with
      // the pickups it had, and the cancellation of the last of them is a stop turning terminal in a run in progress (S1.23).
      const toWork = loaded.stops.filter(
        (stop) => stop.state === 'PENDING' || stop.state === 'ARRIVED',
      ).length;
      if (toWork === 0) {
        throw ApiException.of(
          ErrorCode.ManifestEmpty,
          'There is no pickup left to work on this run: it is not started',
        );
      }
      // The lock first, and then the instant: the start is stamped no earlier than anything that committed to the run while this waited.
      const started = await tx.execute(sql`
        update pickup_manifest set state = 'IN_PROGRESS', started_at = clock_timestamp()
         where id = ${loaded.row.id}::uuid and state = 'DISPATCHED'
        returning ${MANIFEST_COLUMNS}`);
      const manifest = started.rows[0] as unknown as PickupManifestRow | undefined;
      // Under the lock and having read the manifest as dispatched, the update cannot miss it.
      if (manifest === undefined) throw new Error('A locked dispatched manifest was not started');

      // The stops are read again as the run now is: none was written, and the representation carries the token of the run that has started.
      const stopRows = await tx.execute(sql`
        select ${STOP_COLUMNS} from pickup_stop where pickup_manifest_id = ${manifest.id}::uuid order by sequence, id`);
      const view = manifestViewOf(manifest, stopRows.rows as unknown as PickupStopRow[]);

      await audit.write(handle, {
        code: 'pickup.manifest.started',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupManifest', id: manifest.id },
        responsibleHubId: manifest.responsible_hub_id,
        previousState: 'DISPATCHED',
        resultingState: 'IN_PROGRESS',
        relatedIds: { rider_id: riderId },
        detail: { stops_to_work: toWork },
      });
      return { manifest: view, etag: pickupManifestEtagOf(view, manifest.version) };
    });
  }

  async arrive(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: { readonly idempotencyKey: string; readonly fingerprint: string },
  ): Promise<ArrivedStop> {
    const { runner, audit, idempotency } = this.#options;
    if (authorized.session.principalType !== 'RIDER') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'header', pointer: 'Idempotency-Key', rule: 'format' }],
      });
    }
    const riderId = authorized.session.principalId.toLowerCase();

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const scope = {
        principalType: 'RIDER',
        principalId: riderId,
        operationId: OPERATION,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        const stored = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as StoredArrival;
        return { stop: stored.stop, etag: stored.etag };
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

      // The stop, under its lock. A rider is shown the stops of its own dispatched runs and no other, so a stop that comes back is the rider's.
      const found = await tx.execute(sql`
        select ${STOP_COLUMNS}, version, responsible_hub_id from pickup_stop where id = ${id}::uuid for update`);
      const stop = found.rows[0] as unknown as ArrivalRow | undefined;
      if (stop === undefined) throw notTheRidersWork();

      // The run it is on, as the rider sees it. It is read and not locked: the stop's own state is the barrier against the acts that
      // change a stop, and a run that is in progress cannot leave that state while one of its stops is still to be worked (the manifest's
      // guard refuses a completion with a stop still to be worked, whoever writes it).
      const runs = await tx.execute(
        sql`select state from pickup_manifest where id = ${stop.pickup_manifest_id}::uuid`,
      );
      const run = runs.rows[0] as unknown as { state: string } | undefined;
      if (run === undefined) throw notTheRidersWork();
      if (run.state === 'DISPATCHED') {
        throw ApiException.of(ErrorCode.ManifestNotStarted, 'The run has not been started');
      }
      if (run.state !== 'IN_PROGRESS') {
        throw ApiException.of(ErrorCode.StateConflict, 'The run is over');
      }
      if (stop.state !== 'PENDING') {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The stop is not waiting for the rider: it has been worked or skipped',
        );
      }

      // The lock first, and then the instant: the arrival is stamped no earlier than anything that committed to the stop while this waited.
      const arrived = await tx.execute(sql`
        update pickup_stop set state = 'ARRIVED', arrived_at = clock_timestamp()
         where id = ${stop.id}::uuid and state = 'PENDING'
        returning ${STOP_COLUMNS}, version, responsible_hub_id`);
      const row = arrived.rows[0] as unknown as ArrivalRow | undefined;
      // Under the lock and having read the stop as pending, the update cannot miss it.
      if (row === undefined) throw new Error('A locked pending stop was not arrived at');

      await audit.write(handle, {
        code: 'pickup.stop.arrived',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupStop', id: row.id },
        responsibleHubId: row.responsible_hub_id,
        previousState: 'PENDING',
        resultingState: 'ARRIVED',
        relatedIds: {
          pickup_manifest_id: row.pickup_manifest_id,
          pickup_request_id: row.pickup_request_id,
          rider_id: riderId,
        },
      });

      const view = stopViewOf(row);
      const etag = pickupStopEtagOf(view, row.version);
      const answer: StoredArrival = { etag, stop: view };
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(answer)),
      });
      return { stop: view, etag };
    });
  }
}
