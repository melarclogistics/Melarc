// Runs alone: its bounds (a lookup that must end after about 3 seconds, not the 4 of the lock wait) are wall-clock time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { insertPickupRequest, pickupRequestRow } from '../support/pickups.js';
import { insertRider, riderRow } from '../support/riders.js';
import { API, HUB_A, HUB_B, OPS, type Actor } from '../support/staff-routes.js';
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

const ask = (actor: Actor, q: string) => actor.client.post(LOOKUP, { q }, { origin: OPS });

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
