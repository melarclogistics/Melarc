import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import {
  holdingClaim,
  insertManifest,
  insertStop,
  manifestRow,
  stopRow,
  type StopState,
} from './support/manifests.js';
import { insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.20 closeout, `cancelPickupRequest` against a request that a manifest has claimed (the Product Owner's decisions of 1 and 2 November 2026, on the reviewer's recommendation;
 * the master specification, 21.1; state-machines.md section 5): **the cancellation takes effect at once, on the rider's stop too, and the
 * rider's acknowledgement decides nothing.**
 *
 * - **The office's right to cancel is not touched by a manifest** (domain-model.md 6.2: "office cancellation remains available at every
 *   point"); a vendor still cannot cancel a request that is confirmed, and a manifested request is.
 * - **The stop that holds the request is skipped in the same transaction**, on a draft manifest and on a dispatched one: `PENDING` or
 *   `ARRIVED` becomes `SKIPPED` with the system's reason `REQUEST_CANCELLED`. The stop keeps its place, the arrival it recorded and its
 *   claim (a release is an explicit, authorized act, and a cancelled request must not return to the pool); the manifest does not move but
 *   its `ETag` does, because a stop it shows changed. The rider's next read shows the skip.
 * - **A stop already resolved is not touched**: a collection, a partial collection, a failure and an earlier skip stay exactly as they
 *   are, and no skip event is written for them.
 * - **It serialises with whatever else changes the stop**: a collection that commits first leaves nothing to skip, one that rolls back
 *   leaves the stop to be skipped, and a creation whose claim is not yet decided is waited for and its stop is skipped; each wait is
 *   observed from the server and ends when the test says so.
 * - **Dispatch's recheck stays as a second guard**: the query below is the rule S1.21 applies (a stop still to be worked, still holding its
 *   claim, for a request that is no longer confirmed), and it finds no stop that a cancellation made, only one arranged behind its back.
 */
const LIST = `${API}/pickup-manifests`;
const REQUESTS = `${API}/pickup-requests`;
const CANCEL = (id: string) => `${REQUESTS}/${id}/cancel`;
const CUSTOMER_REASON = 'FIXTURE_CANCEL_CUSTOMER';

let routes: VendorRoutes;
let days: ManifestDays;
let maker: Actor;
let canceller: Actor;
let vendor: ArrangedVendor;
let browser: TestClient;

beforeAll(async () => {
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  browser = routes.browser(vendor.device.credential.token);
  expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
    200,
  );
  maker = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  canceller = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution, requires_note, active)
     values ($1, 'PICKUP_CANCELLATION', 'Fixture customer cancellation', 'CUSTOMER', false, true)`,
    [CUSTOMER_REASON],
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

/** A value the test has just arranged to be there; a missing one is a failure of the test, said so. */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error('the value the test expected is missing');
  return value;
}

const confirmed = async (assigned = false): Promise<string> => {
  const id = (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, HUB_A, {
        state: 'CONFIRMED',
        serviceDate: days.day,
      }),
    )
  ).id;
  if (assigned) {
    await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [id]);
  }
  return id;
};

interface Made {
  readonly id: string;
  readonly stops: { readonly id: string; readonly pickup_request_id: string }[];
}

/** A manifest of two confirmed requests, made through the route. */
async function manifestOfTwo(): Promise<{ manifest: Made; etag: string; requests: string[] }> {
  const requests = [await confirmed(), await confirmed()];
  const made = await maker.client.post(
    LIST,
    { pickup_request_ids: requests, service_date: days.day },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );
  expect(made.status).toBe(201);
  return { manifest: made.json() as Made, etag: made.header('etag') ?? '', requests };
}

const readManifest = (id: string): Promise<TestResponse> => maker.client.get(`${LIST}/${id}`);

const etagOf = async (client: TestClient, id: string): Promise<string> => {
  const read = await client.get(`${REQUESTS}/${id}`);
  expect(read.status).toBe(200);
  return read.header('etag') ?? '';
};

const cancel = async (
  who: Actor | TestClient,
  id: string,
  body: Record<string, unknown> = {},
  options: { ifMatch?: string; key?: string } = {},
): Promise<TestResponse> => {
  const client = 'client' in who ? who.client : who;
  return client.post(
    CANCEL(id),
    { reason_code: CUSTOMER_REASON, ...body },
    {
      ...('client' in who ? { origin: OPS } : {}),
      headers: {
        'If-Match': options.ifMatch ?? (await etagOf(client, id)),
        'Idempotency-Key': options.key ?? randomUUID(),
      },
    },
  );
};

interface StopRecord {
  readonly id: string;
  readonly state: string;
  readonly sequence: number;
  readonly arrived_at: Date | null;
  readonly resolved_at: Date | null;
  readonly skip_snapshot: { reason_code: string; label: string; skipped_at: string } | null;
  readonly failure_category: string | null;
  readonly released_at: Date | null;
  readonly version: number;
}

const stopOf = async (requestId: string): Promise<StopRecord> => {
  const [row] = await routes.rows<StopRecord>(
    `select id, state, sequence, arrived_at, resolved_at, skip_snapshot, failure_category, released_at, version
       from pickup_stop where pickup_request_id = $1`,
    [requestId],
  );
  if (row === undefined) throw new Error('the request has no stop');
  return row;
};

const requestStateOf = async (id: string): Promise<string | undefined> =>
  (await routes.rows<{ state: string }>(`select state from pickup_request where id = $1`, [id]))[0]
    ?.state;

/**
 * The rule dispatch must apply as a second guard, as a query: the stops of a manifest that are still to be worked, still hold their claim,
 * and are for a request that is no longer confirmed. A manifest with none may be dispatched; one with any may not.
 */
const deadStopsOf = (manifestId: string) =>
  routes.rows<{ pickup_request_id: string }>(
    `select s.pickup_request_id
       from pickup_stop s join pickup_request r on r.id = s.pickup_request_id
      where s.pickup_manifest_id = $1 and s.state in ('PENDING', 'ARRIVED') and s.released_at is null and r.state <> 'CONFIRMED'
      order by s.sequence`,
    [manifestId],
  );

interface EventRecord {
  readonly event_code: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly enhanced: boolean;
  readonly object_type: string;
  readonly object_id: string;
  readonly responsible_hub_id: string | null;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly reason_code: string | null;
  readonly reason_label: string | null;
  readonly related_ids: Record<string, unknown> | null;
  readonly detail: Record<string, unknown>;
  readonly recorded_at: Date;
}

/** The events of the act on a request, in the order they were written: those about the request and those about the stops it held. */
const eventsOf = (requestId: string, code: string) =>
  routes.rows<EventRecord>(
    `select event_code, actor_type, actor_id, enhanced, object_type, object_id, responsible_hub_id, previous_state, resulting_state,
            reason_code, reason_label, related_ids, detail, recorded_at
       from audit_event
      where event_code = $2 and (object_id::text = $1 or related_ids ->> 'pickup_request_id' = $1)
      order by recorded_at, id`,
    [requestId, code],
  );

describe('the office cancels a request that a draft manifest holds', () => {
  // Break caught: a manifest that withdraws the office's right to cancel (the rule of 2 November 2026: do not silently disable an existing
  // cancellation right to avoid handling the stop).
  it('succeeds: the right is not taken away by the manifest', async () => {
    const { requests } = await manifestOfTwo();
    const answer = await cancel(canceller, requests[0] ?? '');
    expect(answer.status).toBe(200);
    expect(answer.json()).toMatchObject({ id: requests[0], state: 'CANCELLED' });
  });

  // Break caught: a cancellation that leaves the stop to be worked (the dead stop of the earlier behaviour), that releases or removes it,
  // that moves it in the order, that touches the other stop or the manifest, or that stamps the skip with a moment the stop does not carry.
  it('skips the stop in the same act: in its place, with its claim kept, and the other stop and the manifest as they were', async () => {
    const { manifest, requests } = await manifestOfTwo();
    const [cancelled, kept] = requests as [string, string];
    const before = await stopOf(cancelled);
    expect(before).toMatchObject({ state: 'PENDING', sequence: 1, released_at: null, version: 1 });
    expect((await cancel(canceller, cancelled)).status).toBe(200);

    const after = await stopOf(cancelled);
    expect(after).toMatchObject({
      id: before.id,
      state: 'SKIPPED',
      sequence: 1,
      arrived_at: null,
      released_at: null,
      version: 2,
    });
    expect(after.resolved_at).not.toBeNull();
    expect(after.skip_snapshot).toEqual({
      reason_code: 'REQUEST_CANCELLED',
      label: 'Request cancelled',
      skipped_at: present(after.resolved_at).toISOString(),
    });
    expect(await stopOf(kept)).toMatchObject({
      state: 'PENDING',
      sequence: 2,
      released_at: null,
      version: 1,
      resolved_at: null,
      skip_snapshot: null,
    });
    expect(
      await routes.rows(`select state from pickup_manifest where id = $1`, [manifest.id]),
    ).toEqual([{ state: 'DRAFT' }]);

    // The claim is still held: no second stop can claim the cancelled request (nothing released it).
    const other = await insertManifest(routes.admin, manifestRow(HUB_A));
    await expect(insertStop(routes.admin, stopRow(other, cancelled, 1))).rejects.toMatchObject({
      code: '23505',
    });
  });

  // Break caught: a skip the readers cannot see, or one whose representation carries more than the contract states (the label the table
  // keeps, the note of the cancellation), or a manifest whose ETag does not move when a stop it shows has.
  it('shows the skip on the manifest as the contract states it, and moves the manifest’s ETag', async () => {
    const { manifest, etag, requests } = await manifestOfTwo();
    const cancelled = requests[0] ?? '';
    expect(
      (await cancel(canceller, cancelled, { note: 'The vendor closed the shop' })).status,
    ).toBe(200);

    const read = await readManifest(manifest.id);
    expect(read.status).toBe(200);
    expect(read.header('etag')).not.toBe(etag);
    const stops = (
      read.json() as {
        state: string;
        stops: { pickup_request_id: string; state: string; skipped: unknown }[];
      }
    ).stops;
    const skipped = stops.find((stop) => stop.pickup_request_id === cancelled);
    expect(skipped).toMatchObject({ state: 'SKIPPED' });
    expect(skipped?.skipped).toEqual({
      reason_code: 'REQUEST_CANCELLED',
      skipped_at: (await stopOf(cancelled)).resolved_at?.toISOString(),
    });
    expect(JSON.stringify(read.json())).not.toContain('closed the shop');
    expect(read.json()).toMatchObject({ state: 'DRAFT' });
    expect(stops.find((stop) => stop.pickup_request_id === requests[1])).toMatchObject({
      state: 'PENDING',
      skipped: null,
    });
  });

  // Break caught: a cancelled request that can be built into a run again, or that the pool still offers.
  it('leaves the request unable to join another manifest and out of the pool, and Ops can list the stops left behind', async () => {
    const { manifest, requests } = await manifestOfTwo();
    const cancelled = requests[0] ?? '';
    expect((await cancel(canceller, cancelled)).status).toBe(200);

    const again = await maker.client.post(
      LIST,
      { pickup_request_ids: [cancelled], service_date: days.day },
      { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect([again.status, codeOf(again)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(JSON.stringify(again.json())).toContain('not_confirmed');

    const idsOf = async (query: string): Promise<string[]> => {
      const found: string[] = [];
      let token: string | null = null;
      do {
        const answer: TestResponse = await maker.client.get(
          `${REQUESTS}?${query}&page_size=100${token === null ? '' : `&page_token=${token}`}`,
        );
        expect(answer.status, query).toBe(200);
        const page = answer.json() as { items: { id: string }[]; next_page_token: string | null };
        found.push(...page.items.map((item) => item.id));
        token = page.next_page_token;
      } while (token !== null);
      return found;
    };
    expect(await idsOf('state=CONFIRMED&manifested=false')).not.toContain(cancelled);
    // The claim is the manifest's, the state is the request's: the cancelled request is still shown as one a manifest holds.
    expect(await idsOf('state=CANCELLED&manifested=true')).toContain(cancelled);
    expect(await idsOf('state=CONFIRMED&manifested=true')).not.toContain(cancelled);
    expect(manifest.stops.map((stop) => stop.pickup_request_id)).toContain(cancelled);
  });

  // Break caught: a stop left to be worked for a cancelled request (which dispatch's recheck would then have to refuse), or a recheck that
  // no longer finds one arranged behind the cancellation's back. Since the S1.22 correction the database refuses such a stop at the end of the
  // transaction that makes it, whoever writes, so the control of the helper is arranged with the triggers of the constraint off, as only an
  // administrator could, and the same insert without that is refused.
  it('leaves dispatch no dead stop to refuse, and its recheck still finds one that is arranged', async () => {
    const { manifest, requests } = await manifestOfTwo();
    expect(await deadStopsOf(manifest.id)).toEqual([]);
    expect((await cancel(canceller, requests[1] ?? '')).status).toBe(200);
    expect(await deadStopsOf(manifest.id)).toEqual([]);

    const strayRequest = (
      await insertPickupRequest(
        routes.admin,
        pickupRequestRow(vendor.row.organizationId, HUB_A, {
          state: 'CANCELLED',
          serviceDate: days.day,
        }),
      )
    ).id;
    const stray = await insertManifest(routes.admin, manifestRow(HUB_A));
    await expect(insertStop(routes.admin, stopRow(stray, strayRequest, 1))).rejects.toMatchObject({
      code: '23514',
    });
    expect(await deadStopsOf(stray.id)).toEqual([]);

    const arranging = clientFor(routes.database.urlFor('postgres'));
    await arranging.connect();
    try {
      await arranging.query('begin');
      await arranging.query('set local session_replication_role = replica');
      await insertStop(arranging, stopRow(stray, strayRequest, 1));
      await arranging.query('commit');
    } finally {
      await arranging.query('rollback').catch(() => undefined);
      await arranging.end();
    }
    expect(await deadStopsOf(stray.id)).toEqual([{ pickup_request_id: strayRequest }]);
  });

  // Break caught: a reschedule of a manifested request that leaves a live duplicate, or that leaves the source's stop to be worked.
  it('is the same for the reschedule of a failed attempt: the source is cancelled, its stop skipped, and the replacement is on no manifest', async () => {
    const { manifest, requests } = await manifestOfTwo();
    const source = requests[0] ?? '';
    const answer = await cancel(canceller, source, { create_replacement: true });
    expect(answer.status).toBe(200);
    const replacement = (answer.json() as { replacement_request_id: string | null })
      .replacement_request_id;
    expect(replacement).not.toBeNull();
    expect(await stopOf(source)).toMatchObject({ state: 'SKIPPED', released_at: null });
    expect(
      await routes.rows(`select 1 from pickup_stop where pickup_request_id = $1`, [replacement]),
    ).toEqual([]);
    expect(await deadStopsOf(manifest.id)).toEqual([]);
  });

  // Break caught: a skip with no record, a record by another actor or at the wrong tier, one written before the cancellation that caused
  // it, a count of stops that is not the number skipped, or a reason that is not the system's.
  it('records the cancellation, then one skipped-stop event for the stop, by the same actor', async () => {
    const { manifest, requests } = await manifestOfTwo();
    const cancelled = requests[0] ?? '';
    expect((await cancel(canceller, cancelled)).status).toBe(200);

    const [request] = await eventsOf(cancelled, 'pickup.request.cancelled');
    const stops = await eventsOf(cancelled, 'pickup.stop.skipped');
    expect(request).toMatchObject({
      actor_type: 'STAFF',
      actor_id: canceller.identity.id,
      enhanced: false,
      object_type: 'PickupRequest',
      detail: { cancelled_by_actor_type: 'OPS', stops_skipped: 1 },
    });
    const stop = await stopOf(cancelled);
    expect(stops).toEqual([
      expect.objectContaining({
        actor_type: 'STAFF',
        actor_id: canceller.identity.id,
        enhanced: false,
        object_type: 'PickupStop',
        object_id: stop.id,
        responsible_hub_id: HUB_A,
        previous_state: 'PENDING',
        resulting_state: 'SKIPPED',
        reason_code: 'REQUEST_CANCELLED',
        reason_label: 'Request cancelled',
        related_ids: { pickup_request_id: cancelled, pickup_manifest_id: manifest.id },
        detail: { cause: 'REQUEST_CANCELLATION' },
      }),
    ]);
    expect(present(request).recorded_at.getTime()).toBeLessThanOrEqual(
      present(stops[0]).recorded_at.getTime(),
    );
    // The other request of the manifest, which was not cancelled, has no such event.
    expect(await eventsOf(requests[1] ?? '', 'pickup.stop.skipped')).toEqual([]);
  });

  // Break caught: a count or a skip event for a request that no stop holds (a vendor's pending request, a confirmed one on no manifest).
  it('records no skipped stop, and no count of them, for a request that no stop holds', async () => {
    const free = await confirmed();
    expect((await cancel(canceller, free)).status).toBe(200);
    const [event] = await eventsOf(free, 'pickup.request.cancelled');
    expect(event?.detail).toEqual({ cancelled_by_actor_type: 'OPS' });
    expect(await eventsOf(free, 'pickup.stop.skipped')).toEqual([]);
  });

  // Break caught: a replay that skips again (a second event, a second version), or that answers differently from the first answer.
  it('answers the same command again as it was answered and skips nothing a second time', async () => {
    const { requests } = await manifestOfTwo();
    const cancelled = requests[0] ?? '';
    const key = randomUUID();
    const etag = await etagOf(canceller.client, cancelled);
    const first = await cancel(canceller, cancelled, {}, { ifMatch: etag, key });
    expect(first.status).toBe(200);
    const stopAfterFirst = await stopOf(cancelled);

    const second = await cancel(canceller, cancelled, {}, { ifMatch: etag, key });
    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(await stopOf(cancelled)).toEqual(stopAfterFirst);
    expect(await eventsOf(cancelled, 'pickup.stop.skipped')).toHaveLength(1);
    expect(await eventsOf(cancelled, 'pickup.request.cancelled')).toHaveLength(1);
  });

  // Break caught: a stop skipped by a cancellation that was then refused (the skip written before the refusal and kept), so that a rider is
  // told a cancellation that never happened.
  it('leaves the stop untouched when the cancellation is refused', async () => {
    const { requests } = await manifestOfTwo();
    const held = requests[0] ?? '';
    const before = await stopOf(held);

    const stale = await cancel(canceller, held, {}, { ifMatch: '"not-the-current-version"' });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    const unknownReason = await cancel(canceller, held, { reason_code: 'NOT_A_REASON' });
    expect([unknownReason.status, codeOf(unknownReason)]).toEqual([422, 'REASON_NOT_ACTIVE']);

    expect(await stopOf(held)).toEqual(before);
    expect(await requestStateOf(held)).toBe('CONFIRMED');
    expect(await eventsOf(held, 'pickup.stop.skipped')).toEqual([]);
  });
});

describe('the office cancels a request that a dispatched manifest holds', () => {
  async function arrangedRider(): Promise<{ id: string; client: TestClient }> {
    const row = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const device = await insertRiderDevice(routes.admin, row.id);
    const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
      principalId: row.id,
      registeredDeviceId: device.id,
    });
    return { id: row.id, client: routes.kit.client.fork().bearer(session.token) };
  }

  /** A dispatched run assigned to the rider, with one stop for each state given, arranged as the administrator (no operation of this task dispatches). */
  async function dispatched(riderId: string, states: readonly StopState[], assigned = false) {
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DISPATCHED', assignedRiderId: riderId, serviceDate: days.day }),
    );
    const requests: string[] = [];
    for (const [at, state] of states.entries()) {
      const request = await confirmed(assigned);
      await insertStop(routes.admin, stopRow(manifest, request, at + 1, { state }));
      requests.push(request);
    }
    return { manifest, requests };
  }

  const riderReads = (rider: { client: TestClient }, manifestId: string) =>
    rider.client.get(`${LIST}/${manifestId}`);

  // Break caught: a cancellation that waits for the rider to acknowledge it (the stop still to be worked on the rider's next read), or one
  // that stops the run (the manifest is not cancelled by the cancellation of one of its requests).
  it('takes effect at once: the rider’s next read shows the stop skipped with the reason, and the run still dispatched', async () => {
    const rider = await arrangedRider();
    const { manifest, requests } = await dispatched(rider.id, ['PENDING', 'PENDING']);
    const [cancelled, kept] = requests as [string, string];
    const before = await riderReads(rider, manifest.id);
    expect(before.status).toBe(200);
    expect(
      (before.json() as { stops: { state: string; skipped: unknown }[] }).stops.map(
        (stop) => stop.state,
      ),
    ).toEqual(['PENDING', 'PENDING']);

    expect((await cancel(canceller, cancelled)).status).toBe(200);

    const after = await riderReads(rider, manifest.id);
    expect(after.status).toBe(200);
    expect(after.header('etag')).not.toBe(before.header('etag'));
    const run = after.json() as {
      state: string;
      stops: {
        pickup_request_id: string;
        state: string;
        skipped: Record<string, unknown> | null;
      }[];
    };
    expect(run.state).toBe('DISPATCHED');
    expect(run.stops.find((stop) => stop.pickup_request_id === cancelled)).toMatchObject({
      state: 'SKIPPED',
      skipped: { reason_code: 'REQUEST_CANCELLED' },
    });
    expect(run.stops.find((stop) => stop.pickup_request_id === kept)).toMatchObject({
      state: 'PENDING',
      skipped: null,
    });
    // What the rider reads is what Ops reads.
    const staff = await readManifest(manifest.id);
    expect(staff.header('etag')).toBe(after.header('etag'));
    expect(staff.json()).toEqual(after.json());
    // The rider's list still carries the run.
    const listed = await rider.client.get(`${LIST}?page_size=100`);
    expect((listed.json() as { items: { id: string }[] }).items.map((item) => item.id)).toContain(
      manifest.id,
    );
  });

  // Break caught: the arrival of a rider already at the door erased by the skip (it is the evidence of the visit), a skip that is not
  // after it, or an arrived stop left to be collected for a request that no longer exists.
  it('skips a stop the rider has arrived at, and keeps the arrival', async () => {
    const rider = await arrangedRider();
    const { requests } = await dispatched(rider.id, ['ARRIVED']);
    const arrived = requests[0] ?? '';
    await routes.admin.query(
      `update pickup_stop set arrived_at = clock_timestamp() - interval '10 minutes' where pickup_request_id = $1`,
      [arrived],
    );
    const before = await stopOf(arrived);
    expect(before.state).toBe('ARRIVED');

    expect((await cancel(canceller, arrived)).status).toBe(200);

    const after = await stopOf(arrived);
    expect(after).toMatchObject({ state: 'SKIPPED', released_at: null, sequence: 1 });
    expect(after.arrived_at).toEqual(before.arrived_at);
    expect(present(after.resolved_at).getTime()).toBeGreaterThan(
      present(before.arrived_at).getTime(),
    );
    expect(after.skip_snapshot?.reason_code).toBe('REQUEST_CANCELLED');
    const [event] = await eventsOf(arrived, 'pickup.stop.skipped');
    expect(event).toMatchObject({ previous_state: 'ARRIVED', resulting_state: 'SKIPPED' });
  });

  // Break caught: custody erased or turned into a skip by a cancellation (the rule of 2 November 2026: do not erase custody or turn
  // collected parcels into a skipped pickup), or a visit that happened rewritten, or a skip written again over a skip.
  it.each(['COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'] as const)(
    'leaves a %s stop exactly as it is, and writes no skip for it',
    async (state) => {
      const rider = await arrangedRider();
      const { manifest, requests } = await dispatched(rider.id, [state]);
      const resolved = requests[0] ?? '';
      const before = await stopOf(resolved);

      const answer = await cancel(canceller, resolved);
      expect(answer.status).toBe(200);
      expect(answer.json()).toMatchObject({ id: resolved, state: 'CANCELLED' });

      expect(await stopOf(resolved)).toEqual(before);
      expect(await eventsOf(resolved, 'pickup.stop.skipped')).toEqual([]);
      const [event] = await eventsOf(resolved, 'pickup.request.cancelled');
      expect(event?.detail).toEqual({ cancelled_by_actor_type: 'OPS' });
      expect(await deadStopsOf(manifest.id)).toEqual([]);
    },
  );

  // Break caught: the charge rules tied to the stop (a charge decision skipped, or decided differently, because the stop is skipped), or a
  // refused decision that still skips the stop.
  it('decides the charge as for any cancellation after assignment, and only a cancellation that succeeds skips the stop', async () => {
    const rider = await arrangedRider();
    const { requests } = await dispatched(rider.id, ['PENDING'], true);
    const assigned = requests[0] ?? '';

    // No decision on the charge: refused, and the stop is as it was.
    const undecided = await cancel(canceller, assigned);
    expect([undecided.status, codeOf(undecided)]).toEqual([422, 'REASON_REQUIRED']);
    expect((await stopOf(assigned)).state).toBe('PENDING');
    expect(await requestStateOf(assigned)).toBe('CONFIRMED');

    const decided = await cancel(canceller, assigned, {
      apply_charge: false,
      charge_reason_code: CUSTOMER_REASON,
    });
    expect(decided.status).toBe(200);
    expect(decided.json()).toMatchObject({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'NOT_APPLIED',
    });
    expect((await stopOf(assigned)).state).toBe('SKIPPED');
    const [event] = await eventsOf(assigned, 'pickup.request.cancelled_chargeable');
    expect(event?.detail).toMatchObject({ charge_outcome: 'NOT_APPLIED', stops_skipped: 1 });
  });

  // Break caught: an act of the rider on a skipped stop accepted by the database because the order of the steps was ignored. The route that
  // records a collection (S1.24) adds its own refusal against the cancelled request; the stop's own state is the guard behind it.
  it('refuses the rider’s outdated act on the skipped stop, whatever the order the act says', async () => {
    const rider = await arrangedRider();
    const { requests } = await dispatched(rider.id, ['ARRIVED']);
    const arrived = requests[0] ?? '';
    const stop = await stopOf(arrived);
    expect((await cancel(canceller, arrived)).status).toBe(200);

    // The act written as a compare-and-set finds the stop no longer arrived at, and changes nothing.
    const conditional = await routes.admin.query(
      `update pickup_stop set state = 'COLLECTED' where id = $1 and state = 'ARRIVED'`,
      [stop.id],
    );
    expect(conditional.rowCount).toBe(0);
    // The act written without the condition is refused by the stop's state machine.
    await expect(
      routes.admin.query(`update pickup_stop set state = 'COLLECTED' where id = $1`, [stop.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      routes.admin.query(`update pickup_stop set state = 'ARRIVED' where id = $1`, [stop.id]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await stopOf(arrived)).toMatchObject({ state: 'SKIPPED', version: stop.version + 1 });
  });
});

describe('a cancellation and another act on the same stop meet', () => {
  /** An open transaction of its own, as a competing act would be, and the server process that runs it. */
  async function opened() {
    const client = clientFor(routes.database.urlFor('postgres'));
    await client.connect();
    await client.query('begin');
    return { client, pid: await backendPidOf(client) };
  }

  async function arrangedStop(state: StopState = 'ARRIVED') {
    const rider = await insertRider(routes.admin, riderRow({ hubId: HUB_A }));
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DISPATCHED', assignedRiderId: rider.id, serviceDate: days.day }),
    );
    const request = await confirmed();
    const stop = await insertStop(routes.admin, stopRow(manifest, request, 1, { state }));
    return { manifest, request, stop };
  }

  // Break caught: a cancellation that skips a stop whose collection committed while it waited (custody erased, a collected stop turned into
  // a skip), because it judged the stop on what it read before the wait and not on what the lock found.
  it('leaves a stop alone when the collection committed first', async () => {
    const { request, stop } = await arrangedStop('ARRIVED');
    const collector = await opened();
    let cancelling: Promise<TestResponse> | undefined;
    try {
      await collector.client.query(
        `update pickup_stop set state = 'COLLECTED', resolved_at = clock_timestamp() where id = $1`,
        [stop.id],
      );
      cancelling = cancel(canceller, request);
      await waitUntilBlockedBy(routes.admin, collector.pid, 'the cancellation', cancelling);
      await collector.client.query('commit');
    } catch (error) {
      await collector.client.query('rollback').catch(() => undefined);
      await cancelling?.catch(() => undefined);
      throw error;
    } finally {
      await collector.client.end();
    }
    const answer = await cancelling;
    expect(answer.status).toBe(200);
    expect(await requestStateOf(request)).toBe('CANCELLED');
    expect(await stopOf(request)).toMatchObject({
      state: 'COLLECTED',
      skip_snapshot: null,
      released_at: null,
    });
    expect(await eventsOf(request, 'pickup.stop.skipped')).toEqual([]);
  });

  // Break caught: a stop left to be worked because the cancellation saw a competing change and gave up on the stop, although the change was
  // abandoned.
  it('skips the stop when the competing act was abandoned', async () => {
    const { request, stop } = await arrangedStop('ARRIVED');
    const collector = await opened();
    let cancelling: Promise<TestResponse> | undefined;
    try {
      await collector.client.query(
        `update pickup_stop set state = 'COLLECTED', resolved_at = clock_timestamp() where id = $1`,
        [stop.id],
      );
      cancelling = cancel(canceller, request);
      await waitUntilBlockedBy(routes.admin, collector.pid, 'the cancellation', cancelling);
      await collector.client.query('rollback');
    } catch (error) {
      await collector.client.query('rollback').catch(() => undefined);
      await cancelling?.catch(() => undefined);
      throw error;
    } finally {
      await collector.client.end();
    }
    expect((await cancelling).status).toBe(200);
    expect(await stopOf(request)).toMatchObject({ state: 'SKIPPED' });
    expect(await eventsOf(request, 'pickup.stop.skipped')).toHaveLength(1);
  });

  // Break caught: a cancellation that does not meet a claim that is still being made, and so leaves the stop the creation commits behind it
  // to be worked for a request that is cancelled (the dead stop, reached by timing alone).
  it('waits for a claim that is not yet decided, and skips the stop it finds when the claim stood', async () => {
    const request = await confirmed();
    const held = await holdingClaim(routes.database, HUB_A, request);
    let cancelling: Promise<TestResponse> | undefined;
    try {
      cancelling = cancel(canceller, request);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the cancellation', cancelling);
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await cancelling?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    expect((await cancelling).status).toBe(200);
    expect(await requestStateOf(request)).toBe('CANCELLED');
    expect(await stopOf(request)).toMatchObject({ state: 'SKIPPED', released_at: null });
    expect(await deadStopsOf(held.manifest.id)).toEqual([]);
  });

  it('waits for a claim that is not yet decided, and has nothing to skip when the claim was abandoned', async () => {
    const request = await confirmed();
    const held = await holdingClaim(routes.database, HUB_A, request);
    let cancelling: Promise<TestResponse> | undefined;
    try {
      cancelling = cancel(canceller, request);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the cancellation', cancelling);
      await held.client.query('rollback');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await cancelling?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    expect((await cancelling).status).toBe(200);
    expect(await requestStateOf(request)).toBe('CANCELLED');
    expect(
      await routes.rows(`select 1 from pickup_stop where pickup_request_id = $1`, [request]),
    ).toEqual([]);
    expect(await eventsOf(request, 'pickup.stop.skipped')).toEqual([]);
  });
});

describe('a vendor and a request that a manifest holds', () => {
  // Break caught: a vendor reaching a manifested request (AC-05: the vendor cancels only its own PENDING request, and a manifested
  // request is confirmed), or the refusal changing the stop.
  it('cannot cancel it: PERMISSION_DENIED, and the stop is as it was', async () => {
    const { requests } = await manifestOfTwo();
    const held = requests[0] ?? '';
    const before = await stopOf(held);
    const refused = await cancel(browser, held);
    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    expect(await stopOf(held)).toEqual(before);
    expect(await requestStateOf(held)).toBe('CONFIRMED');
  });
});
