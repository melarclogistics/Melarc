import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { arrangeRun, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * R76, the sub-ceiling of the operations that cause an outbound text (`provider_initiating_operation_ceiling_per_minute`, settings.md section
 * 7.7; plan OB-S1-65; the review of 4 November 2026), through the real application and a real PostgreSQL, from the seven routes that declare it:
 * `confirmPickupRequest`, `dispatchManifest`, `skipPickupStop`, `initiateHandshake`, `requestSmsHandshakeFallback` and, since the messages of S1.28,
 * `reportPickupFailure` and `recordCollection`. The counter itself is
 * tested at its own level (`alone/rate-limiter.db.test.ts`) and the guard at its own (`authentication-guard.db.test.ts`); here each claim is
 * what a caller meets:
 *
 * - **Every one of the five is bounded**, by a limit read from the setting, for the session that asks; the request after the limit is `429
 *   RATE_LIMITED` before the operation runs, and whatever the earlier ones were answered (a refusal for a missing token counts: a request
 *   counts when it is admitted).
 * - **The session has one counter**, not one for each operation: a caller cannot spend the limit five times over by spreading it.
 * - **It bounds the cause and not the caller**: a read, and another session, are not touched.
 * - **It holds under concurrency**: of a burst, exactly the limit reaches the operation, and the operation's effect (a stop skipped, an event
 *   recorded) is that many and no more; the rest changed nothing.
 */
const CEILING = 'provider_initiating_operation_ceiling_per_minute';

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const setCeiling = (limit: number) =>
  routes.admin.query(`update setting set value = $1::jsonb where key = $2`, [
    JSON.stringify(limit),
    CEILING,
  ]);

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const staffRequest = (
  actor: Actor,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestResponse> =>
  actor.client.post(
    path,
    {},
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID(), ...headers } },
  );
const riderRequest = (rider: ArrangedRider, path: string): Promise<TestResponse> =>
  rider.client.post(path, {}, { headers: { 'Idempotency-Key': randomUUID() } });

/** A rider with a session of its own: the two handshake operations are the rider's. */
async function aRider(): Promise<ArrangedRider> {
  const arranged = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 1,
    stopStates: ['ARRIVED'],
  });
  return arranged.rider;
}

/** The five operations: each is asked of a session that is new to the test, with a request that no operation would accept (so that it changes nothing whatever the count). */
const OPERATIONS: readonly {
  readonly id: string;
  readonly ask: () => () => Promise<TestResponse>;
}[] = [
  {
    id: 'confirmPickupRequest',
    ask: () => {
      const actor = routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
      return async () =>
        staffRequest(await actor, `${API}/pickup-requests/${randomUUID()}/confirm`);
    },
  },
  {
    id: 'dispatchManifest',
    ask: () => {
      const actor = routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
      return async () =>
        staffRequest(await actor, `${API}/pickup-manifests/${randomUUID()}/dispatch`);
    },
  },
  {
    id: 'skipPickupStop',
    ask: () => {
      const actor = routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
      return async () => staffRequest(await actor, `${STOP(randomUUID())}/skip`);
    },
  },
  {
    id: 'initiateHandshake',
    ask: () => {
      const rider = aRider();
      return async () => riderRequest(await rider, `${STOP(randomUUID())}/handshake`);
    },
  },
  {
    id: 'requestSmsHandshakeFallback',
    ask: () => {
      const rider = aRider();
      return async () => riderRequest(await rider, `${STOP(randomUUID())}/handshake/sms-fallback`);
    },
  },
  {
    id: 'reportPickupFailure',
    ask: () => {
      const rider = aRider();
      return async () => riderRequest(await rider, `${STOP(randomUUID())}/fail`);
    },
  },
  {
    id: 'recordCollection',
    ask: () => {
      const rider = aRider();
      return async () => riderRequest(await rider, `${STOP(randomUUID())}/collect`);
    },
  },
];

describe('the seven operations that write an envelope for a text or a feed are each bounded, for the session that asks', () => {
  // Break caught: a route that causes a text and does not declare the ceiling (the hole of OB-S1-65), a ceiling counted for one operation and not another, or a limit
  // that is not the setting's. The requests are ones the operation would refuse in any case, so that what is shown is the guard's alone.
  for (const operation of OPERATIONS) {
    it(`${operation.id}: the request after the limit is 429 RATE_LIMITED, and the ones before it are not`, async () => {
      await setCeiling(3);
      const send = operation.ask();

      for (let each = 1; each <= 3; each += 1) {
        const admitted = await send();
        expect(admitted.status, `request ${String(each)} of ${operation.id}`).not.toBe(429);
      }
      const refused = await send();

      expect([refused.status, codeOf(refused)]).toEqual([429, 'RATE_LIMITED']);
    });
  }

  // Break caught: a limit written into the code, or read once and kept: the setting read on every admission, so that a lowered value bites at once and a raised one
  // lets the same session go on.
  it('follows its setting: a lowered limit refuses the next request and a raised one admits it', async () => {
    const actor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const send = () => staffRequest(actor, `${STOP(randomUUID())}/skip`);

    await setCeiling(2);
    expect((await send()).status).not.toBe(429);
    expect((await send()).status).not.toBe(429);
    expect((await send()).status).toBe(429);

    await setCeiling(4);
    expect((await send()).status).not.toBe(429);
    expect((await send()).status).not.toBe(429);
    expect((await send()).status).toBe(429);
  });
});

describe('what the ceiling counts, and what it leaves alone', () => {
  // Break caught: a counter for each operation (five times the limit for a caller who spreads its requests), or one kept by the route.
  it('is one counter for the session across the operations that declare it', async () => {
    await setCeiling(3);
    const actor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);

    expect((await staffRequest(actor, `${STOP(randomUUID())}/skip`)).status).not.toBe(429);
    expect(
      (await staffRequest(actor, `${API}/pickup-manifests/${randomUUID()}/dispatch`)).status,
    ).not.toBe(429);
    expect((await staffRequest(actor, `${STOP(randomUUID())}/skip`)).status).not.toBe(429);

    const fourth = await staffRequest(actor, `${API}/pickup-requests/${randomUUID()}/confirm`);
    expect([fourth.status, codeOf(fourth)]).toEqual([429, 'RATE_LIMITED']);
  });

  // Break caught (the review of 5 November 2026, "define how retries and refused operations consume capacity"): a refused request taken for a free one. The ceiling is admitted by the
  // authentication step, before the token is checked and before the operation runs, so a request refused for a missing synchronizer token has taken its place. This is the rule, and it
  // is written down (settings.md section 7.7); a request the ceiling itself refuses takes none.
  it('counts a request refused for a missing synchronizer token, and does not count the one it refuses', async () => {
    await setCeiling(2);
    const actor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const bare = routes.kit.client.fork();
    bare.seed('melarc_session', actor.token);
    const withoutToken = () =>
      bare.post(
        `${STOP(randomUUID())}/skip`,
        { reason_code: 'RUN_CUT_SHORT' },
        { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
      );

    const first = await withoutToken();
    expect([first.status, codeOf(first)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect((await staffRequest(actor, `${STOP(randomUUID())}/skip`)).status).not.toBe(429);
    const third = await withoutToken();
    expect([third.status, codeOf(third)]).toEqual([429, 'RATE_LIMITED']);
  });

  // Break caught: a replay of an idempotent request taken for free, so that a client that retries without end spends nothing: a replay is a request and takes a place, though it sends
  // nothing again.
  it('counts the replay of an idempotent request, which sends nothing again', async () => {
    await setCeiling(2);
    const actor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const arranged = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendor.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 2,
    });
    const stop = arranged.stops[0];
    if (stop === undefined) throw new Error('stop');
    const key = randomUUID();
    const token = (await actor.client.get(STOP(stop.id))).header('etag') ?? '';
    const skip = () =>
      actor.client.post(
        `${STOP(stop.id)}/skip`,
        { reason_code: 'RUN_CUT_SHORT' },
        { origin: OPS, headers: { 'If-Match': token, 'Idempotency-Key': key } },
      );

    const done = await skip();
    const replayed = await skip();
    const third = await skip();

    expect(done.status).toBe(200);
    expect(replayed.status).toBe(200);
    expect(replayed.json()).toEqual(done.json());
    expect([third.status, codeOf(third)]).toEqual([429, 'RATE_LIMITED']);
    const events = await routes.rows<{ n: string }>(
      `select count(*) as n from audit_event where event_code = 'pickup.stop.skipped' and object_id = $1`,
      [stop.id],
    );
    expect(events[0]?.n).toBe('1');
  });

  // Break caught: the ceiling taken for a lock-out of the session, or kept across sessions: the caller who is at its limit still reads, and another session is
  // not at it.
  it('leaves a read of the same session and the whole of another session alone', async () => {
    await setCeiling(2);
    const spent = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const other = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);

    expect((await staffRequest(spent, `${STOP(randomUUID())}/skip`)).status).not.toBe(429);
    expect((await staffRequest(spent, `${STOP(randomUUID())}/skip`)).status).not.toBe(429);
    expect((await staffRequest(spent, `${STOP(randomUUID())}/skip`)).status).toBe(429);

    expect((await spent.client.get(`${API}/pickup-manifests`)).status).toBe(200);
    expect((await staffRequest(other, `${STOP(randomUUID())}/skip`)).status).not.toBe(429);
    expect((await staffRequest(other, `${STOP(randomUUID())}/skip`)).status).not.toBe(429);
    expect((await staffRequest(other, `${STOP(randomUUID())}/skip`)).status).toBe(429);
  });
});

describe('under concurrency', () => {
  /** A run of fourteen stops still to be worked, and an officer's token for each. */
  async function fourteen(
    actor: Actor,
  ): Promise<{ run: ArrangedRun; tokens: Map<string, string> }> {
    const arranged = await arrangeRun(routes.kit, routes.admin, {
      vendorOrganizationId: vendor.row.organizationId,
      serviceDate: days.today,
      state: 'IN_PROGRESS',
      stops: 14,
    });
    const tokens = new Map<string, string>();
    for (const stop of arranged.stops) {
      tokens.set(stop.id, (await actor.client.get(STOP(stop.id))).header('etag') ?? '');
    }
    return { run: arranged, tokens };
  }

  // Break caught: a ceiling that reads the count and writes it in two steps (a burst slips past it), or one that admits and then rolls back on the operation's failure.
  // Of fourteen skips asked at once by one session, exactly the limit are done: those stops are skipped, each with its event, and the other nine are exactly as they were.
  it('lets exactly the limit of a burst through, and the operation does exactly that much', async () => {
    await setCeiling(5);
    const actor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const { run, tokens } = await fourteen(actor);

    const answers = await Promise.all(
      run.stops.map(async (stop) => ({
        stop: stop.id,
        response: await actor.client.post(
          `${STOP(stop.id)}/skip`,
          { reason_code: 'RUN_CUT_SHORT' },
          {
            origin: OPS,
            headers: {
              'If-Match': tokens.get(stop.id) ?? '',
              'Idempotency-Key': randomUUID(),
            },
          },
        ),
      })),
    );

    const done = answers.filter((each) => each.response.status === 200).map((each) => each.stop);
    const refused = answers.filter((each) => each.response.status === 429);
    expect(
      answers.map((each) => each.response.status).toSorted(),
      'every answer is the operation’s or the ceiling’s',
    ).toEqual([...Array<number>(5).fill(200), ...Array<number>(9).fill(429)]);
    expect(refused.every((each) => codeOf(each.response) === 'RATE_LIMITED')).toBe(true);

    const states = await routes.rows<{ id: string; state: string }>(
      `select id, state from pickup_stop where id = any($1::uuid[])`,
      [run.stops.map((stop) => stop.id)],
    );
    expect(
      states
        .filter((row) => row.state === 'SKIPPED')
        .map((row) => row.id)
        .toSorted(),
    ).toEqual(done.toSorted());
    expect(states.filter((row) => row.state === 'PENDING')).toHaveLength(9);
    const events = await routes.rows<{ object_id: string }>(
      `select object_id from audit_event where event_code = 'pickup.stop.skipped' and object_id = any($1::uuid[])`,
      [run.stops.map((stop) => stop.id)],
    );
    expect(events.map((row) => row.object_id).toSorted()).toEqual(done.toSorted());
  });
});
