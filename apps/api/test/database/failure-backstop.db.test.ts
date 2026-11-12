import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDeliveryWorkerRuntime } from '../../src/delivery-worker-runtime.js';
import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  API_RUNTIME_ROLE,
  WORKER_PICKUP_BACKSTOP_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import {
  FailureBackstop,
  failureBackstopTask,
} from '../../src/platform/delivery/backstop/failure-backstop.js';
import { loadWorkerConfig } from '../../src/platform/delivery/worker/worker-config.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { freePort } from '../support/api-process.js';
import {
  insertManifest,
  insertStop,
  manifestRow,
  stopRow,
  type StopState,
} from './support/manifests.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertPickupRequest, pickupRequestRow, type PickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRider } from './support/runs.js';
import { buildService, type BuiltService } from './support/service.js';
import { seedHubConfiguration } from './support/seeded.js';
import { systemContext } from './support/rls-fixture.js';
import { clientFor } from './support/test-database.js';
import { API, HUB_A, HUB_B, OPS, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.28, the failure backstop (AC-SLICE-001-34; the Product Owner's decision D-A1 of 11 November 2026; migration 0084) against a real PostgreSQL, as the worker's own login:
 *
 * - **the function** (`melarc.failure_backstop_escalate`) escalates a request whose stop failed and that has sat undecided longer than its hub's `stale_failure_backstop_hours`,
 *   once, in the transaction that records the enhanced event with its trigger, and leaves alone what is fresh, decided, cancelled, already escalated or no failure at all;
 * - **a hub it cannot judge** (the value missing, or not a whole number of hours from 1 to 8760) is told and nothing of it is escalated;
 * - **the capability** is a barrier: the role holds the `EXECUTE` of the function and no privilege on a table, and no other login or capability reaches it;
 * - **the guard** of the request holds the rule for every writer: the moment is recorded only for a confirmed request that has a stop that failed, and the backstop writes nothing
 *   but the moment;
 * - **the lane** runs in the worker's runtime, as one of its periodic tasks, on the cadence it is configured with, and its health is served by the private metrics endpoint.
 *
 * The aged rows are arranged with the guards off for the one statement that ages them (the way the existing tests age a stop), as the plan's evidence says.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let work: BuiltService;
let rider: ArrangedRider;
let ops: Actor;
let backstop: FailureBackstop;
const clock = new SystemClock();

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  rider = await arrangedRider(routes.kit, routes.admin, HUB_A);
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  work = buildService(routes.database, { poolMax: 4, login: WORKER_RUNTIME_ROLE });
  backstop = new FailureBackstop({ database: work.service, clock });
}, 180_000);

afterAll(async () => {
  await work.close();
  await routes.stop();
});

/** One finished run to hold the stops, for each hub. */
const runs = new Map<string, { id: string; hubId: string; next: number }>();

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

interface Failure {
  readonly requestId: string;
  readonly stopId: string;
}

/**
 * A request of the first vendor in `hubId` with a stop of the state given (a failed one unless the test says otherwise) that was resolved `hoursAgo` hours ago, on a run that has
 * finished. The request is confirmed unless the test says otherwise.
 */
async function failure(
  over: {
    readonly hubId?: string;
    readonly hoursAgo?: number;
    readonly request?: Partial<PickupRequestRow>;
    readonly stopState?: StopState;
  } = {},
): Promise<Failure> {
  const hubId = over.hubId ?? HUB_A;
  let run = runs.get(hubId);
  if (run === undefined) {
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(hubId, {
        state: 'COMPLETED',
        serviceDate: days.today,
        assignedRiderId: (hubId === HUB_A
          ? rider
          : await arrangedRider(routes.kit, routes.admin, hubId)
        ).id,
      }),
    );
    run = { id: manifest.id, hubId, next: 1 };
    runs.set(hubId, run);
  }
  const request = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendor.row.organizationId, hubId, {
      state: 'CONFIRMED',
      serviceDate: days.today,
      ...over.request,
    }),
  );
  const state = over.stopState ?? 'FAILED';
  const stop = await insertStop(
    routes.admin,
    stopRow({ id: run.id, hubId }, request.id, run.next, { state }),
  );
  run.next += 1;
  if (state === 'FAILED' || state === 'COLLECTED' || state === 'SKIPPED') {
    await withoutGuards(
      `update pickup_stop set resolved_at = clock_timestamp() - make_interval(hours => $2::int) where id = $1`,
      [stop.id, over.hoursAgo ?? 25],
    );
  }
  return { requestId: request.id, stopId: stop.id };
}

/** Several failures, arranged one after the other (they share a run, and the places in its order). */
async function several(
  count: number,
  over: Parameters<typeof failure>[0] = {},
): Promise<Failure[]> {
  const made: Failure[] = [];
  for (let each = 0; each < count; each += 1) made.push(await failure(over));
  return made;
}

/** Puts every request that is waiting for the backstop out of its reach, so that a test counts only what it arranged. */
async function settle(): Promise<void> {
  await withoutGuards(
    `update pickup_request set escalated_at = clock_timestamp()
      where state = 'CONFIRMED' and escalated_at is null
        and id in (select pickup_request_id from pickup_stop where state = 'FAILED')`,
  );
}

interface RequestRow {
  readonly state: string;
  readonly escalated_at: Date | null;
  readonly version: number;
}
const requestOf = async (id: string): Promise<RequestRow> => {
  const [row] = await routes.rows<RequestRow>(
    `select state, escalated_at, version from pickup_request where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such request');
  return row;
};

interface EventRow {
  readonly event_code: string;
  readonly occurred_at: Date;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly surface_context: string;
  readonly enhanced: boolean;
  readonly outcome: string;
  readonly object_type: string;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly note: string | null;
  readonly before_after: { escalated_at: { before: string | null; after: string } };
  readonly related_ids: { pickup_stop_id: string };
  readonly detail: { trigger: string; threshold_hours: number; waited_seconds: number };
  readonly correlation_id: string;
  readonly serialisation_version: number;
}
const eventsOf = (id: string): Promise<EventRow[]> =>
  routes.rows<EventRow>(
    `select event_code, occurred_at, actor_type, actor_id, surface_context, enhanced, outcome, object_type, responsible_hub_id, vendor_organization_id,
            previous_state, resulting_state, note, before_after, related_ids, detail, correlation_id, serialisation_version
       from audit_event where event_code = 'pickup.request.escalated' and object_id = $1 order by recorded_at, id`,
    [id],
  );

const sqlstateOf = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
};

/** The refusal of the function itself (its own message), which a missing EXECUTE ("permission denied for function") is not. */
const refusalOfTheFunction = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
    return undefined;
  } catch (error) {
    const refused = serverErrorIn(error);
    return refused?.code === '42501' && refused.message.includes('permission denied')
      ? 'permission denied'
      : refused?.message;
  }
};

/** The value in force of the hub's threshold, set for a test: the row is changed with the triggers off and put back after. */
async function withThreshold(
  hubId: string,
  value: string | undefined,
  during: () => Promise<void>,
): Promise<void> {
  const [held] = await routes.rows<{ value: unknown }>(
    `select value from hub_setting where hub_id = $1 and setting_key = 'stale_failure_backstop_hours' and scope_ref = ''`,
    [hubId],
  );
  await withoutGuards(
    `delete from hub_setting where hub_id = $1 and setting_key = 'stale_failure_backstop_hours' and scope_ref = ''`,
    [hubId],
  );
  if (value !== undefined) {
    await withoutGuards(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
       values (gen_random_uuid(), $1, 'stale_failure_backstop_hours', '', 1, $2::jsonb, 'hours', clock_timestamp() - interval '1 day', '5eed0000-0000-4000-8000-0000000000e1')`,
      [hubId, value],
    );
  }
  try {
    await during();
  } finally {
    await withoutGuards(
      `delete from hub_setting where hub_id = $1 and setting_key = 'stale_failure_backstop_hours' and scope_ref = ''`,
      [hubId],
    );
    if (held !== undefined) {
      await withoutGuards(
        `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
         values (gen_random_uuid(), $1, 'stale_failure_backstop_hours', '', 1, $2::jsonb, 'hours', clock_timestamp() - interval '1 day', '5eed0000-0000-4000-8000-0000000000e1')`,
        [hubId, JSON.stringify(held.value)],
      );
    }
  }
}

describe('the backstop escalates a failure left undecided beyond its hub’s threshold (AC-SLICE-001-34)', () => {
  // Break caught: a lane that escalates nothing, or everything; an escalation that does not set the moment; or one that is not recorded with its trigger, the threshold and the wait.
  it('escalates it, once, and records the escalation with its trigger, the threshold and how long it waited', async () => {
    await settle();
    const stale = await failure({ hoursAgo: 25 });
    const before = await requestOf(stale.requestId);

    const report = await backstop.runOnce();

    expect(report).toEqual({ escalated: 1, more: false, unusableHubs: [] });
    const after = await requestOf(stale.requestId);
    expect(after.state).toBe('CONFIRMED');
    expect(after.escalated_at).toBeInstanceOf(Date);
    expect(Date.now() - (after.escalated_at?.getTime() ?? 0)).toBeLessThan(60_000);
    expect(after.version).toBe(before.version + 1);

    const events = await eventsOf(stale.requestId);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      event_code: 'pickup.request.escalated',
      actor_type: 'SYSTEM',
      actor_id: null,
      surface_context: 'SYSTEM',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object_type: 'PickupRequest',
      responsible_hub_id: HUB_A,
      vendor_organization_id: vendor.row.organizationId,
      previous_state: 'CONFIRMED',
      resulting_state: 'CONFIRMED',
      note: null,
      serialisation_version: 1,
      related_ids: { pickup_stop_id: stale.stopId },
    });
    expect(event?.detail.trigger).toBe('BACKSTOP');
    expect(event?.detail.threshold_hours).toBe(24);
    // The failure was resolved 25 hours ago: the wait is that, to the second, plus the moments this test took.
    expect(event?.detail.waited_seconds).toBeGreaterThanOrEqual(25 * 3600);
    expect(event?.detail.waited_seconds).toBeLessThan(25 * 3600 + 120);
    expect(event?.before_after.escalated_at.before).toBeNull();
    expect(new Date(event?.before_after.escalated_at.after ?? '').getTime()).toBe(
      after.escalated_at?.getTime(),
    );
    expect(event?.occurred_at.getTime()).toBe(after.escalated_at?.getTime());
    expect(event?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // Break caught: a backstop proven only on rows made by SQL, which do not carry what the rider's report writes (its category, its moment, its snapshot and its event): the plan's evidence
  // is a failure reported by the real operation, then aged by SQL, then escalated by the lane.
  it('escalates a failure the rider really reported, once it has sat beyond the threshold, and not before', async () => {
    await settle();
    const arranged = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendor.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 2,
      stopStates: ['ARRIVED', 'PENDING'],
    });
    const stop = arranged.stops[0];
    if (stop === undefined) throw new Error('the run has a stop');
    const etag = (await arranged.rider.client.get(`${API}/pickup-stops/${stop.id}`)).header('etag');
    const reported = await arranged.rider.client.post(
      `${API}/pickup-stops/${stop.id}/fail`,
      {
        category: 'PARCEL_NOT_READY',
        reason_code: 'PARCELS_NOT_PACKED',
        note: 'The parcels were not packed when the rider came',
      },
      { headers: { 'If-Match': etag ?? '', 'Idempotency-Key': randomUUID() } },
    );
    expect(reported.status, reported.text).toBe(200);

    // A failure a few seconds old is the Ops decision queue's.
    expect(await backstop.runOnce()).toEqual({ escalated: 0, more: false, unusableHubs: [] });
    expect((await requestOf(stop.requestId)).escalated_at).toBeNull();

    // Aged by SQL, as the plan's evidence says, it is the lane's.
    await withoutGuards(
      `update pickup_stop set resolved_at = clock_timestamp() - interval '25 hours' where id = $1`,
      [stop.id],
    );
    expect(await backstop.runOnce()).toEqual({ escalated: 1, more: false, unusableHubs: [] });
    expect((await requestOf(stop.requestId)).state).toBe('CONFIRMED');
    expect((await requestOf(stop.requestId)).escalated_at).not.toBeNull();
    const [escalated] = await eventsOf(stop.requestId);
    expect(escalated?.actor_type).toBe('SYSTEM');
    expect(escalated?.detail.trigger).toBe('BACKSTOP');
    expect(escalated?.related_ids.pickup_stop_id).toBe(stop.id);
    const [failedEvent] = await routes.rows<{ actor_type: string }>(
      `select actor_type from audit_event where event_code = 'pickup.stop.failed' and object_id = $1`,
      [stop.id],
    );
    expect(failedEvent?.actor_type).toBe('RIDER');
  });

  // Break caught: an escalation made twice (the moment moved, a second event), or a request the officer or the lane already escalated taken again.
  it('is once however many times it looks: a request it escalated is not taken again', async () => {
    await settle();
    const stale = await failure({ hoursAgo: 30 });
    expect(await backstop.runOnce()).toMatchObject({ escalated: 1 });
    const first = await requestOf(stale.requestId);

    expect(await backstop.runOnce()).toEqual({ escalated: 0, more: false, unusableHubs: [] });
    expect(await backstop.runOnce()).toMatchObject({ escalated: 0 });

    const again = await requestOf(stale.requestId);
    expect(again.escalated_at?.getTime()).toBe(first.escalated_at?.getTime());
    expect(again.version).toBe(first.version);
    expect(await eventsOf(stale.requestId)).toHaveLength(1);
  });

  // Break caught: a threshold compared the wrong way round (a failure that has waited less than a day escalated, or one that has waited more not), or a boundary read as the other side.
  it('leaves a failure that has not waited as long as the threshold, and takes the one that has', async () => {
    await settle();
    const fresh = await failure({ hoursAgo: 23 });
    const justOver = await failure({ hoursAgo: 24 });
    const stale = await failure({ hoursAgo: 48 });

    const report = await backstop.runOnce();

    expect(report.escalated).toBe(2);
    expect((await requestOf(fresh.requestId)).escalated_at).toBeNull();
    expect((await requestOf(justOver.requestId)).escalated_at).not.toBeNull();
    expect((await requestOf(stale.requestId)).escalated_at).not.toBeNull();
    expect(await eventsOf(fresh.requestId)).toEqual([]);
  });

  // Break caught: the threshold of one hub applied to the requests of another (a hub with a longer wait escalated at the shorter one's), or the event recording a threshold
  // that is not the one the request was judged by.
  it('judges each hub by its own threshold, and records the one it used', async () => {
    await settle();
    await withThreshold(HUB_B, '48', async () => {
      const waited30InB = await failure({ hubId: HUB_B, hoursAgo: 30 });
      const waited50InB = await failure({ hubId: HUB_B, hoursAgo: 50 });
      const waited30InA = await failure({ hoursAgo: 30 });

      expect(await backstop.runOnce()).toEqual({ escalated: 2, more: false, unusableHubs: [] });

      expect((await requestOf(waited30InB.requestId)).escalated_at).toBeNull();
      expect((await requestOf(waited50InB.requestId)).escalated_at).not.toBeNull();
      expect((await requestOf(waited30InA.requestId)).escalated_at).not.toBeNull();
      const [inB] = await eventsOf(waited50InB.requestId);
      const [inA] = await eventsOf(waited30InA.requestId);
      expect(inB?.detail.threshold_hours).toBe(48);
      expect(inB?.responsible_hub_id).toBe(HUB_B);
      expect(inA?.detail.threshold_hours).toBe(24);
      expect(inA?.responsible_hub_id).toBe(HUB_A);
    });
  });

  // Break caught: the lane widening what it takes: a failure an officer decided, a request that was cancelled or rescheduled, a request whose stop did not fail, or a request that
  // was never confirmed, escalated because it is old.
  it('leaves alone what is decided, cancelled, rescheduled or no failure at all', async () => {
    await settle();
    const escalatedByOps = await failure({
      hoursAgo: 40,
      request: { escalatedAt: new Date('2026-11-04T10:00:00Z') },
    });
    const cancelled = await failure({ hoursAgo: 40, request: { state: 'CANCELLED' } });
    const skipped = await failure({ hoursAgo: 40, stopState: 'SKIPPED' });
    const collected = await failure({ hoursAgo: 40, stopState: 'COLLECTED' });
    const arrived = await failure({ hoursAgo: 40, stopState: 'ARRIVED' });
    const pending = await failure({ hoursAgo: 40, request: { state: 'PENDING' } });
    const heldBefore = await Promise.all(
      [escalatedByOps, cancelled, skipped, collected, arrived, pending].map(
        async (each) => [each.requestId, await requestOf(each.requestId)] as const,
      ),
    );

    expect(await backstop.runOnce()).toEqual({ escalated: 0, more: false, unusableHubs: [] });

    for (const [id, was] of heldBefore) {
      const now = await requestOf(id);
      expect(now, id).toEqual(was);
      expect(await eventsOf(id), id).toEqual([]);
    }
  });

  // Break caught: a rescheduled request (cancelled with a replacement) escalated, or the replacement it made taken for a failure.
  it('leaves a request an officer rescheduled, and the replacement it made', async () => {
    await settle();
    const stale = await failure({ hoursAgo: 40 });
    const token = (await ops.client.get(`${API}/pickup-requests/${stale.requestId}`)).header(
      'etag',
    );
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution) values ('FIXTURE_BACKSTOP_CANCEL', 'PICKUP_CANCELLATION', 'Fixture reason', 'CUSTOMER') on conflict do nothing`,
    );
    const rescheduled = await ops.client.post(
      `${API}/pickup-requests/${stale.requestId}/cancel`,
      { reason_code: 'FIXTURE_BACKSTOP_CANCEL', create_replacement: true },
      { origin: OPS, headers: { 'If-Match': token ?? '', 'Idempotency-Key': randomUUID() } },
    );
    expect(rescheduled.status).toBe(200);

    expect(await backstop.runOnce()).toEqual({ escalated: 0, more: false, unusableHubs: [] });

    expect((await requestOf(stale.requestId)).state).toBe('CANCELLED');
    expect(await eventsOf(stale.requestId)).toEqual([]);
  });

  // Break caught: a batch that is not bounded, or that does not say it was full, so that a backlog is left for ever or taken in one long transaction; or the oldest not first.
  it('takes a batch at a time, oldest first, and says when it was full', async () => {
    await settle();
    const oldest = await failure({ hoursAgo: 60 });
    const middle = await failure({ hoursAgo: 50 });
    const newest = await failure({ hoursAgo: 30 });
    const small = new FailureBackstop({ database: work.service, clock, batchSize: 2 });

    expect(await small.runOnce()).toEqual({ escalated: 2, more: true, unusableHubs: [] });
    expect((await requestOf(oldest.requestId)).escalated_at).not.toBeNull();
    expect((await requestOf(middle.requestId)).escalated_at).not.toBeNull();
    expect((await requestOf(newest.requestId)).escalated_at).toBeNull();

    expect(await small.runOnce()).toEqual({ escalated: 1, more: false, unusableHubs: [] });
    expect((await requestOf(newest.requestId)).escalated_at).not.toBeNull();
  });

  // Break caught: a lane that waits for a request another transaction holds (an officer who is escalating or cancelling it) instead of going on with the rest, which holds the
  // whole check and its connection behind one officer's act. The request that was held is judged at the next look.
  it('goes on with the rest when another transaction holds a request: it does not wait for it', async () => {
    await settle();
    const held = await failure({ hoursAgo: 40 });
    const free = await failure({ hoursAgo: 30 });
    const officer = clientFor(routes.database.urlFor('postgres'));
    await officer.connect();
    try {
      await officer.query('begin');
      await officer.query('select 1 from pickup_request where id = $1 for update', [
        held.requestId,
      ]);
      const report = await Promise.race([
        backstop.runOnce(),
        new Promise<'waiting'>((resolve) =>
          setTimeout(() => {
            resolve('waiting');
          }, 8_000),
        ),
      ]);
      expect(report, 'the lane waited for a request another transaction holds').not.toBe('waiting');
      expect(report).toEqual({ escalated: 1, more: false, unusableHubs: [] });
      expect((await requestOf(free.requestId)).escalated_at).not.toBeNull();
      expect((await requestOf(held.requestId)).escalated_at).toBeNull();
    } finally {
      await officer.query('rollback').catch(() => undefined);
      await officer.end();
    }
    expect(await backstop.runOnce()).toMatchObject({ escalated: 1 });
    expect((await requestOf(held.requestId)).escalated_at).not.toBeNull();
    expect(await eventsOf(held.requestId)).toHaveLength(1);
  });

  // Break caught: two lanes at once escalating one request twice (two moments, two events), or a lane that waits for the other's rows instead of going on.
  it('escalates a request once when two lanes look at once', async () => {
    await settle();
    const stale = await several(8, { hoursAgo: 30 });
    const other = buildService(routes.database, { poolMax: 2, login: WORKER_RUNTIME_ROLE });
    try {
      const one = new FailureBackstop({ database: work.service, clock, batchSize: 1 });
      const two = new FailureBackstop({ database: other.service, clock, batchSize: 1 });
      const drain = async (lane: FailureBackstop): Promise<number> => {
        let escalated = 0;
        for (let round = 0; round < 20; round += 1) {
          const report = await lane.runOnce();
          escalated += report.escalated;
          if (!report.more && report.escalated === 0) break;
        }
        return escalated;
      };

      const [first, second] = await Promise.all([drain(one), drain(two)]);

      expect(first + second).toBe(8);
      for (const each of stale) {
        expect((await requestOf(each.requestId)).escalated_at, each.requestId).not.toBeNull();
        expect(await eventsOf(each.requestId), each.requestId).toHaveLength(1);
      }
    } finally {
      await other.close();
    }
  });
});

describe('a hub the backstop cannot judge is told, and nothing of it is escalated', () => {
  // Break caught: a hub with no threshold judged by an invented one (24 hours, or none: everything escalated), or silently skipped; or one hub's missing value stopping the others.
  it('names a hub that has a failure waiting and no threshold, and still escalates the other hubs', async () => {
    await settle();
    const inHubB = await failure({ hubId: HUB_B, hoursAgo: 200 });
    const inHubA = await failure({ hoursAgo: 30 });

    const report = await backstop.runOnce();

    expect(report).toEqual({ escalated: 1, more: false, unusableHubs: [HUB_B] });
    expect((await requestOf(inHubB.requestId)).escalated_at).toBeNull();
    expect(await eventsOf(inHubB.requestId)).toEqual([]);
    expect((await requestOf(inHubA.requestId)).escalated_at).not.toBeNull();
  });

  // Break caught: a value that is not a whole number of hours from 1 to 8760 read as a threshold (a zero that escalates everything, a negative, text, a fraction).
  it.each([
    ['zero', '0'],
    ['a negative number', '-5'],
    ['text', '"24"'],
    ['a fraction', '24.5'],
    ['null', 'null'],
    ['a boolean', 'true'],
    ['an object', '{}'],
    ['more than a year', '9000'],
    ['absent', undefined],
  ])('does not judge a hub whose threshold is %s', async (_name, value) => {
    await settle();
    const stale = await failure({ hoursAgo: 100 });
    await withThreshold(HUB_A, value, async () => {
      const report = await backstop.runOnce();

      expect(report).toEqual({ escalated: 0, more: false, unusableHubs: [HUB_A] });
      expect((await requestOf(stale.requestId)).escalated_at).toBeNull();
      expect(await eventsOf(stale.requestId)).toEqual([]);
    });
    // The value is back, and the failure is judged.
    expect(await backstop.runOnce()).toMatchObject({ escalated: 1, unusableHubs: [] });
  });

  // Break caught: the value in force taken from the wrong version (a later one that is not in force yet, or an older one), or the threshold of another setting.
  it('judges by the value in force: a version that begins tomorrow is not yet', async () => {
    await settle();
    const stale = await failure({ hoursAgo: 23 });
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
         values (gen_random_uuid(), $1, 'stale_failure_backstop_hours', '', 2, '1'::jsonb, 'hours', clock_timestamp() + interval '1 day', '5eed0000-0000-4000-8000-0000000000e1')`,
        [HUB_A],
      );
      await routes.admin.query('commit');
      expect(await backstop.runOnce()).toEqual({ escalated: 0, more: false, unusableHubs: [] });
      expect((await requestOf(stale.requestId)).escalated_at).toBeNull();
    } finally {
      await withoutGuards(
        `delete from hub_setting where hub_id = $1 and setting_key = 'stale_failure_backstop_hours' and version = 2`,
        [HUB_A],
      );
    }
  });
});

describe('the capability is a barrier, and the guard holds the rule for every writer', () => {
  const can = async (role: string): Promise<boolean> =>
    (
      await routes.rows<{ allowed: boolean }>(
        `select has_function_privilege($1, 'melarc.failure_backstop_escalate(integer)', 'EXECUTE') as allowed`,
        [role],
      )
    )[0]?.allowed ?? false;

  // Break caught: the function executable by PUBLIC or by the API's login, so that code running as the API could escalate; or the capability role with a privilege on a table.
  it('lets only the capability role, and the worker login that inherits it, execute the function, and gives the role no table', async () => {
    expect(await can(WORKER_PICKUP_BACKSTOP_ROLE)).toBe(true);
    expect(await can(WORKER_RUNTIME_ROLE)).toBe(true);
    expect(await can(API_RUNTIME_ROLE)).toBe(false);
    expect(await can('public')).toBe(false);
    const tables = await routes.rows(
      `select 1 from information_schema.role_table_grants where grantee = $1
       union all select 1 from information_schema.role_column_grants where grantee = $1`,
      [WORKER_PICKUP_BACKSTOP_ROLE],
    );
    expect(tables).toEqual([]);
  });

  // Break caught: the function answering a context that is not the backstop's: another capability of the same login, or none.
  it('refuses a context that is not the failure backstop’s', async () => {
    for (const capability of ['notification', 'credential_delivery'] as const) {
      const refused = await refusalOfTheFunction(
        work.service.transactionWithContext(systemContext(capability), async (tx) =>
          tx.execute(sql`select * from melarc.failure_backstop_escalate(10)`),
        ),
      );
      expect(refused, capability).toBe(
        'the failures left undecided are escalated by the failure backstop, and by nobody else',
      );
    }
  });

  // Break caught: a batch outside one to a thousand, which would take the whole table in a transaction or nothing.
  it.each([0, -1, 1001])('refuses a batch of %s requests', async (batch) => {
    const code = await sqlstateOf(
      work.service.transactionWithContext(systemContext('pickup_backstop'), async (tx) =>
        tx.execute(sql`select * from melarc.failure_backstop_escalate(${batch}::integer)`),
      ),
    );
    expect(code).toBe('22023');
  });

  // Break caught: the policies admitting the capability to statements of the login itself (not inside the function): the lane reading requests or writing the moment directly.
  // The login holds column grants on some of these tables through its other capabilities, so a read is either refused or sees no row; a write is refused.
  it('reaches no row by a statement of its own: the capability is for the function', async () => {
    await settle();
    await failure({ hoursAgo: 100 });
    for (const table of ['pickup_request', 'pickup_stop', 'hub_setting']) {
      let seen: number | string;
      try {
        const result = await work.service.transactionWithContext(
          systemContext('pickup_backstop'),
          async (tx) => tx.execute(sql.raw(`select count(*)::int as n from ${table}`)),
        );
        seen = (result.rows[0] as { n: number }).n;
      } catch (error) {
        seen = serverErrorIn(error)?.code ?? 'other';
      }
      expect(seen === 0 || seen === '42501', `${table}: ${String(seen)}`).toBe(true);
    }
    for (const statement of [
      sql`update pickup_request set escalated_at = clock_timestamp()`,
      sql`insert into audit_event (id, event_code, occurred_at, actor_type, surface_context, object_type, correlation_id, outcome, enhanced, serialisation_version)
          values (gen_random_uuid(), 'pickup.request.escalated', now(), 'SYSTEM', 'SYSTEM', 'PickupRequest', 'x', 'SUCCEEDED', true, 1)`,
    ]) {
      const code = await sqlstateOf(
        work.service.transactionWithContext(systemContext('pickup_backstop'), async (tx) =>
          tx.execute(statement),
        ),
      );
      expect(code).toBe('42501');
    }
  });

  // Break caught: the policies reading for a login that is not the owner (an arm of the policy that does not ask for the owner), so that the capability alone would read the rows.
  it('is not read by the capability alone: the policies ask for the owner that the function runs as', async () => {
    const policies = await routes.rows<{ polname: string; check: string }>(
      `select polname, coalesce(pg_get_expr(polqual, polrelid), '') || coalesce(pg_get_expr(polwithcheck, polrelid), '') as "check"
         from pg_policy where polname like '%backstop%' order by polname`,
    );
    expect(policies.map((policy) => policy.polname)).toEqual([
      'audit_event_insert_backstop',
      'hub_setting_backstop_read',
      'pickup_request_backstop_escalate',
      'pickup_request_backstop_read',
      'pickup_stop_backstop_read',
    ]);
    for (const policy of policies) {
      expect(policy.check, policy.polname).toContain("task_capability() = 'pickup_backstop'");
      expect(policy.check.toLowerCase(), policy.polname).toContain("current_user = 'melarc_owner'");
    }
  });

  const refusal = async (
    statement: string,
    values: unknown[] = [],
  ): Promise<{ code?: string; detail?: string }> => {
    try {
      await routes.admin.query(statement, values);
      return {};
    } catch (error) {
      const failed = error as { code?: string; detail?: string };
      return {
        ...(failed.code === undefined ? {} : { code: failed.code }),
        ...(failed.detail === undefined ? {} : { detail: failed.detail }),
      };
    }
  };

  // Break caught (the rule of the request's guard, for the statement of any writer): a moment recorded for a request with no failed stop, or one not confirmed.
  it('refuses the moment of an escalation on a request that is not confirmed or has no stop that failed', async () => {
    const plain = await failure({ stopState: 'SKIPPED' });
    const cancelled = await failure({ request: { state: 'CANCELLED' } });
    for (const id of [plain.requestId, cancelled.requestId]) {
      expect(
        await refusal('update pickup_request set escalated_at = clock_timestamp() where id = $1', [
          id,
        ]),
        id,
      ).toEqual({ code: '23514', detail: 'reason=STATE_CONFLICT' });
    }
  });

  // Break caught: the backstop's context writing anything of a request but the moment (the guard's rule for it, which the function never tests because it only sets the moment).
  it('refuses a statement under the backstop’s context that changes anything but the moment of the escalation', async () => {
    const stale = await failure({ hoursAgo: 40 });
    await routes.admin.query('begin');
    try {
      await routes.admin.query(
        `select set_config('melarc.principal_type', 'SYSTEM', true), set_config('melarc.task_capability', 'pickup_backstop', true)`,
      );
      await expect(
        routes.admin.query(
          `update pickup_request set escalated_at = clock_timestamp(), secondary_phone = '+233200000009' where id = $1`,
          [stale.requestId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await routes.admin.query('rollback');
    }
    expect((await requestOf(stale.requestId)).escalated_at).toBeNull();
  });
});

describe('the lane in the worker’s runtime (D-A1)', () => {
  let sink: string;

  beforeAll(async () => {
    sink = await mkdtemp(join(tmpdir(), 'melarc-backstop-sink-'));
  });

  afterAll(async () => {
    await rm(sink, { recursive: true, force: true });
  });

  function workerConfig(over: Record<string, string> = {}) {
    const delivery = localKeys().purposes.credential_delivery;
    const secret = delivery.versions[delivery.activeVersion]?.reveal();
    if (secret === undefined) throw new Error('the test keys hold no delivery key');
    const loaded = loadWorkerConfig({
      NODE_ENV: 'development',
      APP_ENV: 'local',
      DATABASE_WORKER_URL: routes.database.urlFor(WORKER_RUNTIME_ROLE),
      KEY_CUSTODY: 'local',
      KEY_CREDENTIAL_DELIVERY_MATERIAL: `${String(delivery.activeVersion)}:${secret}`,
      KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: String(delivery.activeVersion),
      DELIVERY_CAPTURE_DIRECTORY: sink,
      DELIVERY_WORKER_POLL_INTERVAL_MS: '100',
      PICKUP_BACKSTOP_INTERVAL_MINUTES: '15',
      SHUTDOWN_TIMEOUT_MS: '5000',
      ...over,
    });
    if (!loaded.ok) throw new Error(`refused: ${loaded.problems.map((p) => p.key).join(', ')}`);
    return loaded.config;
  }

  async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`gave up waiting for ${what}`);
  }

  // Break caught: a worker that does not run the lane (the failure stays undecided), that runs it on another cadence than the configuration's, that escalates twice when it looks again,
  // or whose health does not show a hub it cannot judge: the plan's evidence, an aged row escalated once with its trigger, through the real worker.
  it('escalates an aged failure once with its trigger, looks again on the configured cadence, and serves the hub it cannot judge as its health', async () => {
    await settle();
    const stale = await failure({ hoursAgo: 30 });
    const unjudged = await failure({ hubId: HUB_B, hoursAgo: 90 });
    const port = await freePort();
    const lines: string[] = [];
    const runtime = createDeliveryWorkerRuntime(
      workerConfig({
        DELIVERY_WORKER_METRICS_PORT: String(port),
        DELIVERY_WORKER_METRICS_HOST: '127.0.0.1',
      }),
      {
        destination: { write: (line: string) => void lines.push(line) },
        backstopIntervalMs: 250,
      },
    );
    await runtime.startMetrics();
    runtime.start();
    try {
      await until(
        async () => (await requestOf(stale.requestId)).escalated_at !== null,
        'the lane to escalate the aged failure',
      );
      // It looks again, on the cadence it was given, and does not escalate the request again.
      const checks = async (): Promise<number> => {
        const text = await (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();
        const match = /pickup_backstop_runs_total\{outcome="CHECKED"\} (\d+)/.exec(text);
        return Number(match?.[1] ?? 0);
      };
      await until(async () => (await checks()) >= 3, 'the lane to look three times');

      const text = await (await fetch(`http://127.0.0.1:${String(port)}/metrics`)).text();
      expect(text).toMatch(/pickup_backstop_escalations_total 1\n/);
      expect(text).toMatch(/pickup_backstop_unusable_hubs 1\n/);
    } finally {
      expect(await runtime.shutdown()).toBe('clean');
    }

    const events = await eventsOf(stale.requestId);
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ trigger: 'BACKSTOP', threshold_hours: 24 });
    expect((await requestOf(unjudged.requestId)).escalated_at).toBeNull();
    // The hub it could not judge is named in the log, at error level, and so is nothing of a request or a person.
    const said = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const unusable = said.filter((line) => String(line.msg).includes('cannot judge a hub'));
    expect(unusable.length).toBeGreaterThanOrEqual(1);
    expect(unusable[0]).toMatchObject({ level: 'error', hubs: [HUB_B] });
    expect(lines.join('')).not.toContain(stale.requestId);
  }, 90_000);

  // Break caught: two workers at once escalating one request twice.
  it('is once when two workers look at once', async () => {
    await settle();
    const stale = await several(5, { hoursAgo: 30 });
    const runtimes = [0, 1].map(() =>
      createDeliveryWorkerRuntime(workerConfig(), {
        destination: { write: () => undefined },
        backstopIntervalMs: 250,
      }),
    );
    for (const runtime of runtimes) runtime.start();
    try {
      await until(async () => {
        const rows = await Promise.all(stale.map((each) => requestOf(each.requestId)));
        return rows.every((row) => row.escalated_at !== null);
      }, 'the workers to escalate the aged failures');
      // Both look again before the end of the test.
      await new Promise((resolve) => setTimeout(resolve, 700));
    } finally {
      for (const runtime of runtimes) expect(await runtime.shutdown()).toBe('clean');
    }

    for (const each of stale) {
      expect(await eventsOf(each.requestId), each.requestId).toHaveLength(1);
      expect((await requestOf(each.requestId)).version, each.requestId).toBe(2);
    }
  }, 90_000);

  // Break caught: a lane that counts a failed check as a good one, or hides it: with the database refusing the lane's call, the check is FAILED, the error is raised for the worker's loop.
  it('counts a check that raised as failed, and raises it for the worker’s loop to log', async () => {
    const counted: string[] = [];
    const task = failureBackstopTask({
      backstop: {
        runOnce: () => Promise.reject(new Error('the database was away')),
        recordUnusable: () => {
          throw new Error('a failed check records nothing');
        },
      },
      logger: { info: () => undefined, error: () => undefined } as never,
      metrics: {
        increment: (name: string, labels?: Readonly<Record<string, string>>) => {
          counted.push(`${name}:${labels?.outcome ?? ''}`);
        },
        observe: () => undefined,
      },
      intervalMs: 900_000,
    });

    await expect(task.run(new AbortController().signal)).rejects.toThrow('the database was away');
    expect(counted).toEqual(['pickup_backstop_runs_total:FAILED']);
  });
});
