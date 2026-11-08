import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import type { OutboxWriter } from '../platform/notifications/outbox-writer.js';
import { hubToday } from './pickup-hub-day.js';
import { pickupManifestEtagOf } from './pickup-manifest-etag.js';
import { loadManifest, requireCurrentManifest } from './pickup-manifest-loader.js';
import {
  MANIFEST_COLUMNS,
  STOP_COLUMNS,
  manifestViewOf,
  type PickupManifestRow,
  type PickupManifestView,
  type PickupStopRow,
  type PickupStopSummaryView,
  type SummaryLocationView,
} from './pickup-manifest-view.js';

export interface PickupManifestDispatchOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  /** The envelope of the rider's text, written beside the audit event so that it commits with the dispatch or not at all (S1.12; D-11). */
  readonly outbox: Pick<OutboxWriter, 'write'>;
}

export interface DispatchedManifest {
  readonly manifest: PickupManifestView;
  readonly etag: string;
}

/** What dispatch reads of the request of a stop: what the summary is made from, and the state that decides whether the stop may be sent. */
interface RequestFacts {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly sender_name: string;
  readonly declared_package_count: number;
  readonly resolved_pickup_location: unknown;
  readonly primary_phone: string;
}

interface RiderFacts {
  readonly id: string;
  readonly status: string;
  readonly primary_hub_id: string;
}

/** The ids of a list as the text of a `uuid[]` literal, each checked to be a lower-case UUID (an id read from a row is, and nothing else is let in). */
function uuidArray(ids: readonly string[]): string {
  if (
    !ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))
  ) {
    throw new TypeError('A request id is a lower-case UUID');
  }
  return `{${ids.join(',')}}`;
}

/**
 * The place a rider is sent to, from the request's resolved pickup location: the members of the contract's `Location` that are there, copied
 * one by one. The request is the authority for the address (it is non-null on every row and derived from the intent, never supplied by a client),
 * so one without an address is a broken row and not a summary to be made up.
 */
function summaryLocationOf(raw: unknown): SummaryLocationView {
  const place = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof place.address !== 'string' || place.address.trim() === '') {
    throw new Error('A request holds a resolved pickup location with an address');
  }
  return {
    address: place.address,
    ...(typeof place.landmark === 'string' ? { landmark: place.landmark } : {}),
    ...(typeof place.map_link === 'string' ? { map_link: place.map_link } : {}),
    ...(typeof place.latitude === 'number' ? { latitude: place.latitude } : {}),
    ...(typeof place.longitude === 'number' ? { longitude: place.longitude } : {}),
  };
}

/**
 * What a rider is shown for a stop, made from its request (the contract's `PickupStopSummary`; OB-S1-21, the Product Owner's decision of
 * 2 November 2026): the request's code as the reference, the sender's name as booked, the packages **as declared**, the place, and the primary
 * contact. **`location_note` is null**: the request has no pickup-instructions field yet, and the note is never made from the landmark or from a
 * location override. Nothing of the payer, the price, the destination, the one-package recipient or any other request of the run is read.
 */
export function pickupSummaryOf(request: RequestFacts): PickupStopSummaryView {
  return {
    reference: request.code,
    sender_display_name: request.sender_name,
    declared_package_count: request.declared_package_count,
    resolved_pickup_location: summaryLocationOf(request.resolved_pickup_location),
    location_note: null,
    contact_phone: request.primary_phone,
  };
}

/**
 * `dispatchManifest` (S1.21; `pickup.manifest.dispatch`; `AC-SLICE-001-13`; features/pickup/pickup-manifest.md sections 5.1 and 5.2;
 * state-machines.md section 4; the Product Owner's decisions of 29 October and 2 November 2026): Ops sends a `DRAFT` manifest out to the
 * rider it is given to. **Dispatch notifies; it does not start the run** (only the rider starts it, `startRun`), and it is the moment the stops
 * reach the rider, and no other rider: the rider's read of a manifest begins at `dispatched_at`.
 *
 * - **Who is judged, and in what order.** The guard has answered the key, the surface, the CSRF token and the existence of the manifest (a
 *   manifest of another hub is `HUB_SCOPE_VIOLATION`, one that does not exist `NOT_FOUND`); the interceptor, the header. Then, under the
 *   manifest's lock: the `ETag` (`STATE_CONFLICT`, so of two officers who hold the same token one wins); that the manifest is a draft
 *   (`STATE_CONFLICT`); **that its day has not passed on the hub's clock** (`STATE_CONFLICT`: a run whose day has passed is cancelled and its
 *   requests planned again with carry-over reasons, never sent out; the Product Owner, 2 November 2026); that it has a rider who is still `ACTIVE`
 *   and belongs to the manifest's hub (`RIDER_UNAVAILABLE`); that a stop is still to be worked (`MANIFEST_EMPTY`); and **that the request of every
 *   stop still to be worked is still confirmed** (`STATE_CONFLICT`, naming the stops): a cancelled request is never sent to a rider. The
 *   cancellation of a request resolves its stop itself, so that last judgement is a second safeguard, and a refused dispatch sends nothing,
 *   writes no envelope and leaves the manifest a draft. The serviceable-motorcycle check is not made (the owner's decision of 29 October 2026:
 *   SLICE-011); `NO_SERVICEABLE_MOTORCYCLE` stays declared.
 * - **What it writes**, in one transaction: the summary of each stop still to be worked (made from its request and kept on the stop, once);
 *   the manifest `DISPATCHED` with the moment of dispatch; `pickup.manifest.dispatched`; and the envelope of the rider's one run-level text
 *   (`RUN_DISPATCHED_RIDER`), which the lane of the worker relays. A stop already resolved (its request was cancelled) gets no summary: it is
 *   shown to the rider skipped, in its place.
 * - **Concurrency.** The manifest's lock puts two dispatches, or a dispatch and a cancellation of the manifest, in a line. A request cancelled
 *   at the same moment is serialised on its stop: if it wins, the stop is skipped and the dispatch is refused for it; if the dispatch wins, the
 *   request's cancellation then skips the stop of the dispatched run, which is the cancellation of a dispatched run the rider reads at once.
 */
export class PickupManifestDispatch {
  readonly #options: PickupManifestDispatchOptions;

  constructor(options: PickupManifestDispatchOptions) {
    this.#options = options;
  }

  async dispatch(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    request: { readonly ifMatch: string | undefined },
  ): Promise<DispatchedManifest> {
    const { runner, audit, outbox } = this.#options;
    if (authorized.session.principalType !== 'STAFF') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const loaded = await loadManifest(handle, id, { lock: true });
      if (loaded === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      requireCurrentManifest(request.ifMatch, loaded);
      if (loaded.row.state !== 'DRAFT') {
        throw ApiException.of(ErrorCode.StateConflict, 'Only a draft manifest is dispatched');
      }

      // The day is the hub's, from the database's instant. A run whose day has passed is not sent out: it is cancelled, and the requests
      // that are still to be collected are planned again, for a day that has not passed, each carried over for a stated reason.
      const today = await hubToday(handle);
      if (loaded.row.service_date < today) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The day of this run has passed: cancel it and plan its requests again',
          { rule: 'service_date_passed', service_date: loaded.row.service_date },
        );
      }

      // The rider, as they are now: `ACTIVE`, and belonging to the manifest's hub, which assignment checked and a status or a hub may have
      // changed since. What a grant lets the officer see of a rider is not what makes the rider eligible.
      const riderId = loaded.row.assigned_rider_id;
      if (riderId === null) {
        throw ApiException.of(
          ErrorCode.RiderUnavailable,
          'A manifest is dispatched to its rider, and this one has none',
        );
      }
      const riders = await tx.execute(
        sql`select id, status, primary_hub_id from rider_identity where id = ${riderId}::uuid`,
      );
      const rider = riders.rows[0] as unknown as RiderFacts | undefined;
      if (
        rider?.status !== 'ACTIVE' ||
        rider.primary_hub_id.toLowerCase() !== loaded.row.responsible_hub_id.toLowerCase()
      ) {
        throw ApiException.of(
          ErrorCode.RiderUnavailable,
          'The rider of this manifest cannot be sent it',
        );
      }

      const toWork = loaded.stops.filter(
        (stop) => stop.state === 'PENDING' || stop.state === 'ARRIVED',
      );
      if (toWork.length === 0) {
        throw ApiException.of(
          ErrorCode.ManifestEmpty,
          'The manifest has no stop left to be worked',
        );
      }

      // The second safeguard: the request of every stop still to be worked is read now, under the manifest's lock, and a stop for a request
      // that is no longer confirmed refuses the dispatch, naming the stops. Nothing is sent and nothing is written.
      const read = await tx.execute(sql`
        select id, code, state, sender_name, declared_package_count, resolved_pickup_location, primary_phone
          from pickup_request
         where id = any(${uuidArray(toWork.map((stop) => stop.pickup_request_id.toLowerCase()))}::uuid[])`);
      const requests = new Map(
        (read.rows as unknown as RequestFacts[]).map((row) => [row.id.toLowerCase(), row] as const),
      );
      const lapsed = toWork.filter(
        (stop) => requests.get(stop.pickup_request_id.toLowerCase())?.state !== 'CONFIRMED',
      );
      if (lapsed.length > 0) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'A stop still to be worked is for a request that is no longer confirmed',
          { rule: 'request_not_confirmed', stops: lapsed.map((stop) => stop.id) },
        );
      }

      // The summary of each stop, made from its request and kept on the stop. The statement judges each stop as it is when it runs, so a
      // stop that a cancellation of its request skipped since it was read is not written, and the dispatch is refused for it.
      const summaries = toWork.map((stop) => {
        const facts = requests.get(stop.pickup_request_id.toLowerCase());
        if (facts === undefined) throw new Error('A request that was read is missing');
        return { stopId: stop.id.toLowerCase(), summary: pickupSummaryOf(facts) };
      });
      const written = await tx.execute(sql`
        update pickup_stop as stop set pickup_summary = given.summary
          from (values ${sql.join(
            summaries.map(
              (each) => sql`(${each.stopId}::uuid, ${JSON.stringify(each.summary)}::jsonb)`,
            ),
            sql`, `,
          )}) as given(id, summary)
         where stop.id = given.id and stop.pickup_manifest_id = ${loaded.row.id}::uuid
           and stop.state in ('PENDING', 'ARRIVED') and stop.pickup_summary is null
        returning stop.id`);
      if (written.rows.length !== toWork.length) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The manifest changed while it was being dispatched; read it again',
        );
      }

      const sent = await tx.execute(sql`
        update pickup_manifest set state = 'DISPATCHED', dispatched_at = now()
         where id = ${loaded.row.id}::uuid and state = 'DRAFT'
        returning ${MANIFEST_COLUMNS}`);
      const manifest = sent.rows[0] as unknown as PickupManifestRow | undefined;
      // Under the lock and having read the manifest as a draft, the update cannot miss it.
      if (manifest === undefined) throw new Error('A locked manifest was not dispatched');

      const stops = await tx.execute(sql`
        select ${STOP_COLUMNS} from pickup_stop where pickup_manifest_id = ${manifest.id}::uuid order by sequence, id`);
      const view = manifestViewOf(manifest, stops.rows as unknown as PickupStopRow[]);

      await audit.write(handle, {
        code: 'pickup.manifest.dispatched',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'PickupManifest', id: manifest.id },
        responsibleHubId: manifest.responsible_hub_id,
        previousState: 'DRAFT',
        resultingState: 'DISPATCHED',
        relatedIds: { rider_id: riderId },
        detail: { stops_dispatched: toWork.length },
      });
      // The envelope of the same act (S1.12; D-11): it commits with the dispatch or not at all, and its scope is the manifest's own, which the
      // database checks against the row just changed. The rider's text is the lane's; the stops are in the app, and a text holds none of them.
      await outbox.write(handle, {
        eventType: 'pickup.manifest.dispatched',
        aggregate: { type: 'PICKUP_MANIFEST', id: manifest.id },
        responsibleHubId: manifest.responsible_hub_id,
        operationId: 'dispatchManifest',
      });
      return { manifest: view, etag: pickupManifestEtagOf(view, manifest.version) };
    });
  }
}
