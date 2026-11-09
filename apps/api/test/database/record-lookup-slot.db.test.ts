import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { API, HUB_A, HUB_B, OPS, type Actor } from './support/staff-routes.js';
import { startVendorRoutes, type VendorRoutes } from './support/vendor-routes.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * A session has one lookup in flight (`AC-LOOKUP-16`, the audit follow-up of 7 November 2026, A3.2), against the real application and a real PostgreSQL: a second
 * lookup of the session while the first waits for a lock is refused with `429` `RATE_LIMITED` and `Retry-After: 1` and writes nothing, and the session asks again when
 * the first has ended. This half asserts no time, so a pull request runs it; that the refusal comes at once, and every bound of three seconds, is
 * `alone/record-lookup-timeout.db.test.ts`.
 *
 * The two hubs each hold a vendor, a request and a rider whose names share a word, so that a Platform Admin without a hub of its own meets both hubs.
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

      // Refused while the first still waits for its lock: it was answered at all, which a lookup that queued behind the first (or behind the lock) would not have
      // been before the lock was freed. How soon is asserted by alone/record-lookup-timeout.db.test.ts.
      const second = await ask(admin, 'zuko');

      expect(second.status).toBe(429);
      expect((second.json() as { code?: string }).code).toBe('RATE_LIMITED');
      expect(second.header('retry-after')).toBe('1');
      expect(await crossingsOf(admin), 'nothing was written for either').toEqual([]);
    } finally {
      await routes.admin.query('rollback');
    }

    // The first one was only waiting: with the lock released it ends whole, and the session may ask again.
    expect((await first).status).toBe(200);
    expect((await ask(admin, 'zuko')).status).toBe(200);
  }, 60_000);
});
