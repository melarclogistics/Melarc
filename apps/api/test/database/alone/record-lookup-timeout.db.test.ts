// Runs alone: its bounds (a lookup that must end after about 3 seconds, not the 4 of the lock wait) are wall-clock time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertPickupRequest, pickupRequestRow } from '../support/pickups.js';
import { insertRider, riderRow } from '../support/riders.js';
import { API, HUB_A, HUB_B, OPS, type Actor } from '../support/staff-routes.js';
import { clientFor } from '../support/test-database.js';
import { startVendorRoutes, type VendorRoutes } from '../support/vendor-routes.js';
import { insertVendor, vendorRow } from '../support/vendors.js';

/**
 * The bound on a search (`AC-LOOKUP-15`; the Product Owner's decision of 7 November 2026 on the audit, A5) and the events of a lookup that fails
 * (`AC-LOOKUP-11`; A4), against the real application and a real PostgreSQL. Every statement of `lookupRecords` is bounded at three seconds by a
 * `SET LOCAL statement_timeout` at the start of each key's transaction, as the counts of `getQueueSummary` are (`queue-summary-timeout.db.test.ts`
 * proves the limiter itself): a search that cannot finish in that time ends the whole read as the platform's failed read, after three seconds and
 * not after the four of the lock wait, returns nothing of what the earlier keys found, and writes no hub-crossing event for it; the next lookup is
 * whole. A search that waits on a lock is the slow scan of the feature, to the clock of the statement timeout (a wait counts in it).
 *
 * The two hubs each hold a vendor, a request and a rider whose names share a word, so that a Platform Admin without a hub of its own meets both hubs
 * in the first keys it is searched for (pickup.read, vendor.read) before the key that is held (dispatch.read, the riders; or pickup.read, the requests).
 */
const LOOKUP = `${API}/ops/lookup`;

let routes: VendorRoutes;

beforeAll(async () => {
  // The configured bounds nest as the configuration requires (lock wait inside statement time inside transaction time, 10 s): the lock wait (4 s) is
  // longer than the lookup's own bound (3 s), so that what ends the read is the bound under test, and the pool's statement timeout (6 s) is longer
  // than both.
  routes = await startVendorRoutes({
    env: { DATABASE_STATEMENT_TIMEOUT_MS: '6000', DATABASE_LOCK_TIMEOUT_MS: '4000' },
  });
  for (const [hub, suffix] of [
    [HUB_A, 'Alpha'],
    [HUB_B, 'Beta'],
  ] as const) {
    const vendor = await insertVendor(
      routes.admin,
      vendorRow({ hubId: hub, legalName: `Zuko Fabrics ${suffix} Ltd` }),
    );
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.organizationId, hub, { senderName: `Zuko Quarmby ${suffix}` }),
    );
    await insertRider(routes.admin, riderRow({ hubId: hub, fullName: `Zuko Boateng ${suffix}` }));
  }
}, 240_000);

afterAll(async () => {
  await routes.stop();
});

const ask = (actor: Actor, q: string, signal?: AbortSignal) =>
  actor.client.post(LOOKUP, { q }, { origin: OPS, ...(signal === undefined ? {} : { signal }) });

const crossingsOf = (actor: Actor) =>
  routes.rows<{ responsible_hub_id: string }>(
    `select responsible_hub_id from audit_event
      where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by responsible_hub_id`,
    [actor.identity.id],
  );

/** Asks while another connection holds `table` in access exclusive mode, and gives the answer and how long it took. */
async function askWhileHeld(table: string, actor: Actor, q: string) {
  await routes.admin.query('begin');
  try {
    await routes.admin.query(`lock table ${table} in access exclusive mode`);
    const started = performance.now();
    const answer = await ask(actor, q);
    return { answer, elapsed: performance.now() - started };
  } finally {
    await routes.admin.query('rollback');
  }
}

describe('a search that cannot finish', () => {
  // Break caught: a lookup with no bound of its own, which would hold its connection and the shared lock of the bundle until the lock wait ends (4 s
  // here), or answer 200 with a short answer; and a failure that is not the platform's failed read (a 500 with a code, or a body that tells why).
  it('ends the name scan of the requests after three seconds, as the failed read of the platform, and the next lookup is whole', async () => {
    const admin = await routes.platformAdmin();
    const first = await ask(admin, 'zuko');
    expect(first.status).toBe(200);

    // The scan of the requests, held on a lock by another connection: the search waits for it, and the bound is what ends the wait.
    const { answer, elapsed } = await askWhileHeld('pickup_request', admin, 'zuko');

    expect(answer.status).toBe(503);
    expect((answer.json() as { code?: string }).code).toBeUndefined();
    // The platform's own words and a request id, and nothing of the statement, the table or the SQLSTATE (the request id is random, so it is left out of
    // what is searched: its characters can spell anything).
    const body = answer.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(['message', 'request_id']);
    expect(String(body.message)).not.toMatch(/statement|timeout|pickup_request|57014/i);
    // Three seconds, and not the four of the lock wait that ends any other statement.
    expect(elapsed).toBeGreaterThanOrEqual(2800);
    expect(elapsed).toBeLessThan(3800);

    const again = await ask(admin, 'zuko');
    expect(again.status).toBe(200);
    expect(again.json()).toEqual(first.json());
  }, 60_000);

  // Break caught (A4): the events of a hub written in the transaction of the key that found it, which committed before the later search failed, so that a
  // lookup that answered nothing has recorded two crossings for results it never returned. Here the first two keys (the requests and the vendors) find
  // both hubs and the third (the riders) is held on a lock: the read fails, and the ledger holds nothing for the actor. The same lookup, once the rider
  // table is free, answers and writes one event for each hub.
  it('writes no hub-crossing event for a lookup that fails after earlier searches found both hubs, and writes them once it succeeds', async () => {
    const admin = await routes.platformAdmin();

    const { answer, elapsed } = await askWhileHeld('rider_identity', admin, 'zuko');

    expect(answer.status).toBe(503);
    expect((answer.json() as { code?: string }).code).toBeUndefined();
    expect(answer.text).not.toContain('items');
    expect(elapsed).toBeGreaterThanOrEqual(2800);
    expect(elapsed).toBeLessThan(3800);
    expect(await crossingsOf(admin)).toEqual([]);

    const whole = await ask(admin, 'zuko');
    expect(whole.status).toBe(200);
    expect((await crossingsOf(admin)).map((row) => row.responsible_hub_id)).toEqual([HUB_A, HUB_B]);
  }, 60_000);
});

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Waits until some statement of the test database is waiting on a lock: the lookup that the test holds has reached the table it holds. */
async function waitForALockWait(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [waiting] = await routes.rows<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if ((waiting?.waiting ?? 0) > 0) return;
    await sleep(50);
  }
  throw new Error('no statement waited on the lock the test holds');
}

describe('a session has one lookup in flight (AC-LOOKUP-16, the audit follow-up of 7 November 2026, A3.2)', () => {
  // Break caught: a second lookup of a session that runs beside the first (each holding a connection and the shared lock of the bundle for as long as a
  // search takes), answered with something other than the documented wait (429 RATE_LIMITED, Retry-After: 1), made to wait for the first, or one that
  // reads or writes anything; and a slot that the first lookup never gives back.
  it('refuses a second lookup at once while the first waits on a lock, and the session asks again when the first has ended', async () => {
    const admin = await routes.platformAdmin();
    await routes.admin.query('begin');
    let first: ReturnType<typeof ask> | undefined;
    try {
      await routes.admin.query('lock table pickup_request in access exclusive mode');
      first = ask(admin, 'zuko');
      await waitForALockWait();

      const started = performance.now();
      const second = await ask(admin, 'zuko');
      const elapsed = performance.now() - started;

      expect(second.status).toBe(429);
      expect((second.json() as { code?: string }).code).toBe('RATE_LIMITED');
      expect(second.header('retry-after')).toBe('1');
      // At once: not after the three seconds of the first, and not after the wait for its lock.
      expect(elapsed).toBeLessThan(1000);
      expect(await crossingsOf(admin), 'nothing was written for either').toEqual([]);
    } finally {
      await routes.admin.query('rollback');
    }

    // The first one was only waiting: with the lock released it ends whole, and the session may ask again.
    expect((await first).status).toBe(200);
    expect((await ask(admin, 'zuko')).status).toBe(200);
  }, 60_000);
});

describe('the whole lookup has one budget of three seconds (AC-LOOKUP-17, the audit follow-up of 7 November 2026, A3.2)', () => {
  // Break caught: a budget for each key, so that a lookup whose keys each take less than the bound of a statement ends only when all of them have (here the
  // requests take 1.8 seconds, then the vendors wait until 4.2 seconds after the start: 4.2 seconds, and a whole answer, where the budget ends it at 3).
  it('ends the read after about three seconds in all, though no statement of it took three', async () => {
    const admin = await routes.platformAdmin();
    const other = clientFor(routes.database.urlFor('postgres'));
    await other.connect();
    let release: NodeJS.Timeout | undefined;
    try {
      await routes.admin.query('begin');
      await routes.admin.query('lock table pickup_request in access exclusive mode');
      await other.query('begin');
      await other.query('lock table vendor_account in access exclusive mode');

      const started = performance.now();
      // The vendors are free again 4.2 seconds after the start, whatever the lookup does.
      release = setTimeout(() => {
        void other.query('rollback').catch(() => undefined);
      }, 4200);
      const answered = ask(admin, 'zuko').then((answer) => ({ answer, at: performance.now() }));
      await sleep(1800);
      // The application's clock is the kit's manual one, which does not move with the wall clock: the test says that the 1.8 seconds have passed, so that
      // what is left of the lookup's budget is 1.2 seconds when the vendors are reached (the database's own statement timeout runs on real time).
      routes.kit.clock.advance(1800);
      await routes.admin.query('rollback');
      const { answer, at } = await answered;

      expect(answer.status).toBe(503);
      expect((answer.json() as { code?: string }).code).toBeUndefined();
      expect(answer.text).not.toContain('items');
      // About three seconds from the start: not the 4.2 at which the last key would have been free, as it was when each key had three seconds of its own.
      expect(at - started).toBeGreaterThanOrEqual(2800);
      expect(at - started).toBeLessThan(3800);
      expect(await crossingsOf(admin)).toEqual([]);
    } finally {
      if (release !== undefined) clearTimeout(release);
      await routes.admin.query('rollback').catch(() => undefined);
      await other.query('rollback').catch(() => undefined);
      await other.end();
    }

    // Nothing is left over: the next lookup is whole.
    expect((await ask(admin, 'zuko')).status).toBe(200);
  }, 60_000);
});

/** Waits until no statement of the test database is waiting on a lock, and says how long that took; fails if one still is after `within` milliseconds. */
async function waitForNoLockWait(within: number): Promise<number> {
  const started = performance.now();
  for (;;) {
    const [waiting] = await routes.rows<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
    );
    if ((waiting?.waiting ?? 0) === 0) return performance.now() - started;
    if (performance.now() - started > within) {
      throw new Error(
        `a statement was still waiting on a lock ${String(within)} ms after the client left`,
      );
    }
    await sleep(25);
  }
}

describe('a client that leaves while its lookup runs (run 4, Stage 1, A4.1 and A4.2)', () => {
  // Break caught (A4.2): finishing the request's budget cancels no statement, so the search of a lookup whose client had left went on waiting for its lock until
  // its own three-second bound, and the session kept its slot for that long (every other lookup of the session was a 429, and each 429 puts the portal's
  // automatic reads on hold). The lock is still held here when the assertion is made: what ends the wait is the cancel of the statement, not the lock being freed.
  it('cancels the statement the lookup is waiting with as soon as the client leaves, and gives the session its slot back', async () => {
    const admin = await routes.platformAdmin();
    await routes.admin.query('begin');
    let first: Promise<unknown> | undefined;
    try {
      await routes.admin.query('lock table pickup_request in access exclusive mode');
      const leaving = new AbortController();
      first = ask(admin, 'zuko', leaving.signal).then(
        (answer) => answer,
        (error: unknown) => error,
      );
      await waitForALockWait();
      const whileItRuns = await ask(admin, 'zuko');
      expect(whileItRuns.status, 'the slot is held while the first lookup runs').toBe(429);

      leaving.abort();
      const took = await waitForNoLockWait(1500);

      // Well inside the three seconds the statement would otherwise have waited (its bound), and with the table still locked.
      expect(took).toBeLessThan(1500);
      expect(await crossingsOf(admin), 'nothing was written for the lookup that was left').toEqual(
        [],
      );
    } finally {
      await routes.admin.query('rollback');
    }

    await first;
    // The session's slot is free: the next lookup is whole, and not a 429.
    const again = await ask(admin, 'zuko');
    expect(again.status).toBe(200);
  }, 60_000);
});
