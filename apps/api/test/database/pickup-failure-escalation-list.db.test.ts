import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { FailureBackstop } from '../../src/platform/delivery/backstop/failure-backstop.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangedRider, type ArrangedRider } from './support/runs.js';
import { buildService, type BuiltService } from './support/service.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * Who escalated a failure (S1.30; section 17.3 makes it mandatory on the failure queue; `AC-SLICE-001-34`): `listPickupFailures` carries `escalation`, read from the audit event of the
 * escalation by the same statement as the rest of the item, in the caller's own hub scope. Against a real PostgreSQL and the real application, with the backstop run as the worker's own login:
 *
 * - **nothing** for a failure whose request was not escalated;
 * - **a person** for an officer's escalation (`escalatePickupRequest`), with neither a threshold nor a wait, because that event records none;
 * - **the backstop** for the scheduled escalation, with the threshold of the hub's `stale_failure_backstop_hours` and how long the failure had waited, as its event recorded them;
 * - **unknown** for a request that carries the moment of an escalation and has no event for it, which the page says plainly and does not turn into a person.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let rider: ArrangedRider;
let ops: Actor;
let work: BuiltService;
let backstop: FailureBackstop;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  rider = await arrangedRider(routes.kit, routes.admin, HUB_A);
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  work = buildService(routes.database, { poolMax: 4, login: WORKER_RUNTIME_ROLE });
  backstop = new FailureBackstop({ database: work.service, clock: new SystemClock() });
}, 180_000);

afterAll(async () => {
  await work.close();
  await routes.stop();
});

/** Runs a statement with the triggers off (the way the existing tests age a row), in a transaction of its own. */
async function withoutGuards(statement: string, values: unknown[] = []): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(statement, values);
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** One finished run to hold the failed stops of this file. */
let runId: string | undefined;
let nextPlace = 1;

interface Failure {
  readonly requestId: string;
  readonly stopId: string;
}

/** A confirmed request of the vendor with a stop that failed `hoursAgo` hours ago, on a run that has finished. */
async function failure(hoursAgo: number): Promise<Failure> {
  runId ??= (
    await insertManifest(
      routes.admin,
      manifestRow(HUB_A, {
        state: 'COMPLETED',
        serviceDate: days.today,
        assignedRiderId: rider.id,
      }),
    )
  ).id;
  const request = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendor.row.organizationId, HUB_A, {
      state: 'CONFIRMED',
      serviceDate: days.today,
    }),
  );
  const stop = await insertStop(
    routes.admin,
    stopRow({ id: runId, hubId: HUB_A }, request.id, nextPlace, { state: 'FAILED' }),
  );
  nextPlace += 1;
  // The failure as a rider's report leaves it (the fixture's own snapshot has no label or attribution, which the queue's items require): a category, a reason as the catalogue held it and a note.
  await withoutGuards(
    `update pickup_stop
        set resolved_at = clock_timestamp() - make_interval(hours => $2::int), failure_category = 'PARCEL_NOT_READY',
            failure_reason_snapshot = jsonb_build_object('reason_code', 'PARCELS_NOT_PACKED', 'label', 'Parcels not packed', 'attribution', 'CUSTOMER',
                                                         'note', 'The parcels were not packed when the rider came')
      where id = $1`,
    [stop.id, hoursAgo],
  );
  return { requestId: request.id, stopId: stop.id };
}

interface Escalation {
  readonly by: string;
  readonly threshold_hours: number | null;
  readonly waited_seconds: number | null;
}
interface Item {
  readonly pickup_stop_id: string;
  readonly escalated_at: string | null;
  readonly escalation: Escalation | null;
}

async function itemOf(stopId: string): Promise<Item> {
  const response = await ops.client.get(`${API}/pickup-failures?open=true&page_size=100`);
  expect(response.status, response.text).toBe(200);
  const found = (response.json() as { items: Item[] }).items.find(
    (item) => item.pickup_stop_id === stopId,
  );
  if (found === undefined) throw new Error('the failure is not in the queue');
  return found;
}

/** An officer's escalation of the request, the way the Ops Portal makes it. */
async function escalateByHand(requestId: string): Promise<void> {
  const read = await ops.client.get(`${API}/pickup-requests/${requestId}`);
  const response = await ops.client.post(
    `${API}/pickup-requests/${requestId}/escalate`,
    { note: 'The vendor asked for a Senior Ops decision' },
    {
      origin: OPS,
      headers: { 'If-Match': read.header('etag') ?? '', 'Idempotency-Key': randomUUID() },
    },
  );
  expect(response.status, response.text).toBeLessThan(300);
}

describe('who escalated a failure, on the failure queue (S1.30, section 17.3)', () => {
  // Break caught: an escalation member drawn for a request that was never escalated, or missing from an item that has none (the contract requires it, `null`).
  it('says nothing of a failure that was not escalated', async () => {
    const waiting = await failure(1);
    const item = await itemOf(waiting.stopId);
    expect(item.escalated_at).toBeNull();
    expect(item.escalation).toBeNull();
  });

  // Break caught: an officer's escalation shown as the backstop's (or as nothing), or a threshold and a wait made up for an event that records none.
  it('says a person escalated what an officer escalated, and states no threshold and no wait for it', async () => {
    const mine = await failure(2);
    await escalateByHand(mine.requestId);
    const item = await itemOf(mine.stopId);
    expect(typeof item.escalated_at).toBe('string');
    expect(item.escalation).toEqual({ by: 'PERSON', threshold_hours: null, waited_seconds: null });
  });

  // Break caught: the backstop's escalation shown as a person's, its threshold read from anywhere but the event (the setting as it stands now, not as it was when the backstop judged),
  // or the wait taken from the time of the read and not from the event.
  it('says the backstop escalated what it escalated, with the threshold it judged by and the wait it had reached', async () => {
    const stale = await failure(25);
    const report = await backstop.runOnce();
    expect(report.escalated).toBeGreaterThanOrEqual(1);
    const item = await itemOf(stale.stopId);
    expect(typeof item.escalated_at).toBe('string');
    expect(item.escalation?.by).toBe('BACKSTOP');
    expect(item.escalation?.threshold_hours).toBe(24);
    // The wait is the one the backstop's event recorded: 25 hours and a few seconds, and it does not grow while the item sits in the queue.
    const waited = item.escalation?.waited_seconds ?? 0;
    expect(waited).toBeGreaterThanOrEqual(25 * 3600);
    expect(waited).toBeLessThan(25 * 3600 + 300);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await itemOf(stale.stopId)).escalation?.waited_seconds).toBe(waited);
  });

  // Break caught: a request that carries the moment of an escalation and no event read as a person's act, which would put a name that nobody earned on a decision.
  it('says it does not know who where the ledger holds no event for the escalation', async () => {
    const odd = await failure(3);
    await withoutGuards(
      `update pickup_request set escalated_at = clock_timestamp() where id = $1`,
      [odd.requestId],
    );
    const item = await itemOf(odd.stopId);
    expect(typeof item.escalated_at).toBe('string');
    expect(item.escalation).toEqual({ by: 'UNKNOWN', threshold_hours: null, waited_seconds: null });
  });
});
