import type pg from 'pg';

import type { TestClient } from '../../../src/test-support/test-client.js';
import { arrangedFixedSession } from './http-sessions.js';
import type { IntegrationKit } from './integration.js';
import {
  insertManifest,
  insertStop,
  manifestRow,
  stopRow,
  type ManifestRow,
  type ManifestState,
  type StopRow,
  type StopState,
} from './manifests.js';
import { insertPickupRequest, pickupRequestRow } from './pickups.js';
import { insertRider, insertRiderDevice, riderRow } from './riders.js';
import { HUB_A } from './staff-routes.js';

/**
 * Runs arranged **as the administrator** for the tests of what a rider does with one (S1.22 onward: `startRun`, `arriveAtPickupStop`): a
 * rider of the hub with a real handset row and a live session credential, a manifest in the state the test needs on the day it needs, the
 * confirmed requests it holds (each committed to the rider as the assignment left it) and their stops. The acts that make a run
 * (`createPickupManifest`, `assignRider`, `dispatchManifest`) are tested through their routes in their own files; a day that has already
 * passed, or today, cannot be made through them on every day of the week, so the run is arranged here and the act under test is the route.
 */
export interface ArrangedRider {
  readonly id: string;
  /** The rider's bearer credential on the application under test. */
  readonly client: TestClient;
}

type Query = Pick<pg.Client, 'query'>;

/** A rider of the hub with a handset and a live session, as a sign-in leaves one. */
export async function arrangedRider(
  kit: IntegrationKit,
  admin: Query,
  hubId: string = HUB_A,
): Promise<ArrangedRider> {
  const row = await insertRider(admin, riderRow({ hubId }));
  const device = await insertRiderDevice(admin, row.id);
  const session = await arrangedFixedSession(kit, admin, 'RIDER', {
    principalId: row.id,
    registeredDeviceId: device.id,
  });
  return { id: row.id, client: kit.client.fork().bearer(session.token) };
}

export interface ArrangedStop {
  readonly id: string;
  readonly requestId: string;
  readonly requestCode: string;
  readonly sequence: number;
}

export interface ArrangedRun {
  readonly rider: ArrangedRider;
  readonly manifest: ManifestRow;
  readonly stops: readonly ArrangedStop[];
}

export interface ArrangeOptions {
  readonly vendorOrganizationId: string;
  readonly serviceDate: string;
  /** The state of the manifest. A draft has its rider and no summary; every other state has been dispatched. Default `DISPATCHED`. */
  readonly state?: ManifestState;
  /** Whether a `CANCELLED` manifest was dispatched before it was cancelled, which is what shows it to its rider. Default true. */
  readonly dispatchedBeforeCancel?: boolean;
  /** How many stops, in the order 1 to n. Default 2. */
  readonly stops?: number;
  /** The state of every stop. Default `PENDING`. */
  readonly stopState?: StopState;
  /** The state of each stop in order, where they differ (a run with a pickup the office has already cancelled); `stopState` for any beyond it. */
  readonly stopStates?: readonly StopState[];
  /** The rider, where the test has one that already holds a session; a new one is arranged otherwise. */
  readonly rider?: ArrangedRider;
  readonly hubId?: string;
  /** The attempt the requests of the run are at (a request keeps its attempt for ever); the first, where left out. */
  readonly attemptNumber?: number;
}

/** What a rider is shown for a stop (the contract's `PickupStopSummary`): a closed fixture that satisfies the stop's check. */
const summaryOf = (code: string): Record<string, unknown> => ({
  reference: code,
  sender_display_name: 'Fixture Sender',
  declared_package_count: 3,
  resolved_pickup_location: { address: 'Fixture shop, Osu' },
  location_note: null,
  contact_phone: '+233200000001',
});

/** A run: the rider, a manifest of the given state and day assigned to it, its confirmed requests (committed to the rider) and their stops. */
export async function arrangeRun(
  kit: IntegrationKit,
  admin: Query,
  options: ArrangeOptions,
): Promise<ArrangedRun> {
  const hubId = options.hubId ?? HUB_A;
  const state = options.state ?? 'DISPATCHED';
  const rider = options.rider ?? (await arrangedRider(kit, admin, hubId));
  const manifest = await insertManifest(
    admin,
    manifestRow(hubId, {
      state,
      serviceDate: options.serviceDate,
      assignedRiderId: rider.id,
      ...(state === 'CANCELLED'
        ? { dispatchedBeforeCancel: options.dispatchedBeforeCancel ?? true }
        : {}),
    }),
  );
  const stops: ArrangedStop[] = [];
  for (let at = 1; at <= (options.stops ?? 2); at += 1) {
    const request = await insertPickupRequest(
      admin,
      pickupRequestRow(options.vendorOrganizationId, hubId, {
        state: 'CONFIRMED',
        serviceDate: options.serviceDate,
        ...(options.attemptNumber === undefined ? {} : { attemptNumber: options.attemptNumber }),
      }),
    );
    // The commitment the assignment left: the request is committed to the rider while a stop holds it on a manifest that has one.
    await admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
      request.id,
    ]);
    // A run that has been dispatched carries the summary the dispatch gave each stop (a draft has none), written with the stop: the guard
    // of a stop lets only the dispatch key make it.
    const stop: StopRow = await insertStop(
      admin,
      stopRow(manifest, request.id, at, {
        state: options.stopStates?.[at - 1] ?? options.stopState ?? 'PENDING',
        ...(state === 'DRAFT' ? {} : { pickupSummary: summaryOf(request.code) }),
      }),
    );
    stops.push({ id: stop.id, requestId: request.id, requestCode: request.code, sequence: at });
  }
  return { rider, manifest, stops };
}
