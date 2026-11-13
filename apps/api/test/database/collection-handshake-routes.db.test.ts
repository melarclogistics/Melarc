import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { excusePhotos } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.27, the five operations of the collection handshake, against a real PostgreSQL and the real application (`pickup.collection.confirm`,
 * `pickup.handshake.override`, `pickup.handshake.resolve`; `AC-SLICE-001-23`, `-24`, `-26`, `-73`; pickup-collection.md; state-machines.md section 6).
 * What the database decides is tested at its own level (`collection-handshake.db.test.ts`); here each claim is what a caller meets:
 *
 * - **The primary rung**: the rider that counted the stop asks for the code and is shown it once (the same key shows it again while it is the live one),
 *   the vendor enters it, the stop closes as the count says, and the code is in no stored place: no event, no envelope, no stored answer.
 * - **The ladder**: a wrong code is counted and refused, the last one is `ATTEMPTS_EXHAUSTED` and a right code after it is refused; an expired code is
 *   `CODE_EXPIRED`, kept expired, and routes to Ops, who resolve it; the SMS fallback makes a code the rider has not seen, to the registered number only,
 *   capped and spaced by the database; the override is Ops's, with a note and its enhanced event.
 * - **An individual sender's code goes by SMS and the rider enters it**; a vendor's request has no such text.
 * - **Who may**: the rider that counted, the vendor of the pickup, Ops in the hub; nobody else, and in no other way.
 */
let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let browser: TestClient;
let ops: Actor;
let otherHubOps: Actor;
let senior: Actor;
let seniorOtherHub: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor();
  // The registered number is the phone of the vendor's credential where its channel is PHONE (F-23, migration 0073). Vendor B has a business contact number and no credential
  // phone: the business contact is no registered number, and the fallback never goes to it.
  await routes.admin.query(
    `update vendor_credential set recovery_phone = '+233201112222', delivery_channel = 'PHONE' where vendor_account_id = $1`,
    [vendorA.row.accountId],
  );
  await routes.admin.query(
    `update vendor_organization set contact_phone = '+233209990000' where id = $1`,
    [vendorA.row.organizationId],
  );
  await routes.admin.query(
    `update vendor_organization set contact_phone = '+233208880000' where id = $1`,
    [vendorB.row.organizationId],
  );
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  otherHubOps = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  seniorOtherHub = await routes.actor(BUNDLE_IDS.seniorOps, HUB_B);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const HANDSHAKE = (id: string) => `${STOP(id)}/handshake`;
const VERIFY = (id: string) => `${HANDSHAKE(id)}/verify`;
const FALLBACK = (id: string) => `${HANDSHAKE(id)}/sms-fallback`;
const OVERRIDE = (id: string) => `${HANDSHAKE(id)}/ops-override`;
const RESOLVE = (id: string) => `${HANDSHAKE(id)}/resolve`;

interface Handshake {
  readonly stop_id: string;
  readonly state: string;
  readonly direction: string;
  readonly channel: string | null;
  readonly attempts: number;
  readonly expires_at: string | null;
  readonly fallback_used: boolean;
  readonly authorised_by: string | null;
  readonly display_code?: string;
}
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const ruleOf = (response: TestResponse): string | undefined =>
  (response.json() as { details?: { rule?: string } }).details?.rule;
const violationsOf = (response: TestResponse): { pointer: string; rule: string }[] =>
  (response.json() as { details?: { violations?: { pointer: string; rule: string }[] } }).details
    ?.violations ?? [];

/** A run in progress whose first stop the rider has arrived at (three declared) and a second still to be worked. */
const run = (vendor: ArrangedVendor = vendorA): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: 2,
    stopStates: ['ARRIVED', 'PENDING'],
  });
const first = (arranged: ArrangedRun): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[0];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

const tokenOf = async (rider: ArrangedRider, stopId: string): Promise<string> =>
  (await rider.client.get(STOP(stopId))).header('etag') ?? '';

/** The rider's count of the stop (S1.26), as the rider makes it. */
async function count(rider: ArrangedRider, stopId: string, collected = 3): Promise<TestResponse> {
  // The handshake is about the close of a counted stop, not the photos (D-A10): the stop is let through without them.
  await excusePhotos(routes, stopId);
  return rider.client.post(
    `${STOP(stopId)}/collect`,
    collected < 3
      ? { collected_count: collected, variance_reason_code: 'SOME_PARCELS_NOT_READY' }
      : { collected_count: collected },
    { headers: { 'If-Match': await tokenOf(rider, stopId), 'Idempotency-Key': randomUUID() } },
  );
}

/** A counted vendor's pickup: the run, the stop the rider has arrived at, and the count recorded. */
async function counted(vendor: ArrangedVendor = vendorA, collected = 3) {
  const arranged = await run(vendor);
  const stop = first(arranged);
  expect((await count(arranged.rider, stop.id, collected)).status).toBe(200);
  return { arranged, rider: arranged.rider, stop };
}

/** A counted individual sender's pickup. */
async function countedSender() {
  const rider = await arrangedRider(routes.kit, routes.admin);
  const sender = await insertAdHocSender(routes.admin, { state: 'PROVISIONAL' });
  const manifest = await insertManifest(
    routes.admin,
    manifestRow(HUB_A, {
      state: 'IN_PROGRESS',
      serviceDate: days.today,
      assignedRiderId: rider.id,
    }),
  );
  const request = await insertPickupRequest(
    routes.admin,
    pickupRequestRow(vendorA.row.organizationId, HUB_A, {
      vendorOrganizationId: null,
      adHocSenderId: sender.id,
      intent: 'ADHOC_SENDER',
      state: 'CONFIRMED',
      serviceDate: days.today,
    }),
  );
  await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [
    request.id,
  ]);
  const stop = await insertStop(
    routes.admin,
    stopRow(manifest, request.id, 1, {
      state: 'ARRIVED',
      pickupSummary: {
        reference: request.code,
        sender_display_name: 'Ama Walk-in',
        declared_package_count: 3,
        resolved_pickup_location: { address: 'Fixture stall' },
        location_note: null,
        contact_phone: null,
      },
    }),
  );
  expect((await count(rider, stop.id)).status).toBe(200);
  return { rider, stop, request };
}

const initiate = (
  rider: ArrangedRider,
  stopId: string,
  key: string = randomUUID(),
): Promise<TestResponse> =>
  rider.client.post(HANDSHAKE(stopId), undefined, { headers: { 'Idempotency-Key': key } });
const verifyAsVendor = (stopId: string, code: string): Promise<TestResponse> =>
  browser.post(VERIFY(stopId), { code });
const verifyAsRider = (rider: ArrangedRider, stopId: string, code: string): Promise<TestResponse> =>
  rider.client.post(VERIFY(stopId), { code });
const fallback = (
  rider: ArrangedRider,
  stopId: string,
  trigger = 'NO_DATA',
  key: string = randomUUID(),
): Promise<TestResponse> =>
  rider.client.post(FALLBACK(stopId), { trigger }, { headers: { 'Idempotency-Key': key } });
const override = (
  actor: Actor,
  stopId: string,
  note = 'Phoned the vendor on the number we hold',
): Promise<TestResponse> =>
  actor.client.post(
    OVERRIDE(stopId),
    { verification_note: note },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );
const resolve = (
  actor: Actor,
  stopId: string,
  note = 'The vendor confirmed by phone',
  over: Record<string, unknown> = {},
): Promise<TestResponse> =>
  actor.client.post(
    RESOLVE(stopId),
    { note, ...over },
    { origin: OPS, headers: { 'Idempotency-Key': randomUUID() } },
  );

/** The code of a generation of a stop's handshake as the application makes it. */
const codeOf1 = (stopId: string, generation = 1): string =>
  routes.handshakeCodes.codeFor(stopId, generation, routes.handshakeCodes.activeVersion, 4);

const handshakeRow = async (stopId: string) =>
  (
    await routes.rows<{
      state: string;
      attempts: number;
      code_generation: number;
      fallback_sends: number;
      channel: string | null;
    }>(
      `select state, attempts, code_generation, fallback_sends, channel from collection_handshake where pickup_stop_id = $1`,
      [stopId],
    )
  )[0];
const stopState = async (stopId: string): Promise<string | undefined> =>
  (await routes.rows<{ state: string }>(`select state from pickup_stop where id = $1`, [stopId]))[0]
    ?.state;
const eventsOf = (stopId: string) =>
  routes.rows<{
    event_code: string;
    actor_type: string;
    surface_context: string;
    enhanced: boolean;
    note: string | null;
  }>(
    `select event_code, actor_type, surface_context, enhanced, note from audit_event
      where (event_code like 'pickup.handshake.%' or event_code in ('pickup.stop.collected', 'pickup.stop.partially_collected'))
        and (object_id::text = $1 or related_ids ->> 'pickup_stop_id' = $1)
      order by recorded_at, id`,
    [stopId],
  );
const envelopesOf = (requestId: string) =>
  routes.rows<{ payload: Record<string, unknown> }>(
    `select payload from outbox where aggregate_id = $1 and event_type = 'pickup.handshake.requested' order by created_at, id`,
    [requestId],
  );
const age = (stopId: string) =>
  routes.admin.query(
    `update collection_handshake set expires_at = clock_timestamp() - interval '1 second' where pickup_stop_id = $1`,
    [stopId],
  );

describe('initiateHandshake and verifyHandshake: the primary rung, a vendor’s pickup', () => {
  // Break caught: the handshake not made, the code not shown, shown with the wrong life, the stop not closed by the vendor's entry, the channel not
  // recorded on the ordinary path, or the code kept in the event, the envelope or the stored answer.
  it('shows the rider the code once, the vendor enters it, the stop closes COLLECTED on the portal, and the code is stored nowhere', async () => {
    const { rider, stop } = await counted();
    const key = randomUUID();
    const issued = await initiate(rider, stop.id, key);
    expect(issued.status).toBe(201);
    const body = issued.json() as Handshake;
    expect(body).toMatchObject({
      stop_id: stop.id,
      state: 'CODE_GENERATED',
      direction: 'VENDOR_ENTERED_RIDER_DISPLAYED',
      channel: null,
      attempts: 0,
      fallback_used: false,
      authorised_by: null,
    });
    expect(body.display_code).toBe(codeOf1(stop.id));
    expect(body.display_code).toMatch(/^[0-9]{4}$/);
    expect(Date.parse(body.expires_at ?? '') - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(Date.parse(body.expires_at ?? '') - Date.now()).toBeLessThanOrEqual(15 * 60_000);

    // The same key is the same answer, the code included while it is the live one, and no second handshake.
    const again = await initiate(rider, stop.id, key);
    expect(again.status).toBe(201);
    expect(again.json()).toEqual(body);
    expect(
      await routes.rows(`select 1 from collection_handshake where pickup_stop_id = $1`, [stop.id]),
    ).toHaveLength(1);

    const verified = await verifyAsVendor(stop.id, body.display_code ?? '');
    expect(verified.status).toBe(200);
    expect(verified.json()).toMatchObject({
      stop_id: stop.id,
      state: 'VERIFIED',
      channel: 'PORTAL',
      attempts: 0,
      authorised_by: null,
    });
    expect(Object.keys(verified.json() as object)).not.toContain('display_code');
    expect(await stopState(stop.id)).toBe('COLLECTED');

    // Once the handshake has ended the same key is told what it was told, without the code: the code is shown again only while it is the live one.
    const late = await initiate(rider, stop.id, key);
    expect(late.status).toBe(201);
    expect(Object.keys(late.json() as object)).not.toContain('display_code');
    expect(late.json()).toMatchObject({ stop_id: stop.id, state: 'CODE_GENERATED' });

    // The ledger: the code was generated, verified, and the stop closed, each in the name of who did it; the channel is on the ordinary path too.
    const events = await eventsOf(stop.id);
    expect(events.map((event) => event.event_code).toSorted()).toEqual(
      [
        'pickup.handshake.generated',
        'pickup.handshake.verified',
        'pickup.stop.collected',
      ].toSorted(),
    );
    expect(events.find((e) => e.event_code === 'pickup.handshake.generated')).toMatchObject({
      actor_type: 'RIDER',
      surface_context: 'RIDER_ANDROID',
      enhanced: false,
    });
    expect(events.find((e) => e.event_code === 'pickup.handshake.verified')).toMatchObject({
      actor_type: 'VENDOR_ACCOUNT',
      surface_context: 'VENDOR_PWA',
      enhanced: false,
    });

    // The sentinel (AC-SLICE-001-23): the code appears in no event, no envelope and no stored answer of the platform.
    const code = body.display_code ?? '';
    const stored = await routes.rows<{ n: string }>(
      `select (
         (select count(*) from audit_event where to_jsonb(audit_event)::text like '%"' || $1 || '"%')
       + (select count(*) from outbox where to_jsonb(outbox)::text like '%"' || $1 || '"%')
       + (select count(*) from collection_handshake where to_jsonb(collection_handshake)::text like '%"' || $1 || '"%')
       + (select count(*) from idempotency_record where convert_from(coalesce(response_body, ''::bytea), 'UTF8') like '%' || $1 || '%')
       + (select count(*) from idempotency_record where convert_from(coalesce(response_body, ''::bytea), 'UTF8') like '%display_code%')
       )::text as n`,
      [code],
    );
    expect(stored[0]?.n).toBe('0');
  });

  // Break caught (the review of 5 November 2026): the code made at one length and kept at the length the platform holds when the write comes. The application reads the length, the
  // database takes the stop's lock, and the length moves in between: nothing is kept, the rider is told to ask again (409, rule `code_length_changed`), and the next request
  // makes the code with the length now held and shows it.
  it('tells the rider to ask again when the platform’s code length moved while the code was made, and keeps nothing', async () => {
    const { rider, stop } = await counted();
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from pickup_stop where id = $1 for update`, [stop.id]);
      const pid = await backendPidOf(holder);

      const asking = initiate(rider, stop.id);
      await waitUntilBlockedBy(routes.admin, pid, 'the request for the code', asking);
      await routes.admin.query(
        `update setting set value = '5'::jsonb where key = 'handshake_code_length'`,
      );
      await holder.query('rollback');

      const refused = await asking;
      expect([refused.status, codeOf(refused)]).toEqual([409, 'STATE_CONFLICT']);
      expect(ruleOf(refused)).toBe('code_length_changed');
      expect(
        await routes.rows(`select 1 from collection_handshake where pickup_stop_id = $1`, [
          stop.id,
        ]),
      ).toEqual([]);

      const again = await initiate(rider, stop.id);
      expect(again.status).toBe(201);
      expect((again.json() as Handshake).display_code).toMatch(/^[0-9]{5}$/);
    } finally {
      await holder.end().catch(() => undefined);
      await routes.admin.query(
        `update setting set value = '4'::jsonb where key = 'handshake_code_length'`,
      );
    }
  });

  // Break caught (AC-SLICE-001-23; plan section on the code): the code in a line the application logged while it was made, shown and entered. It is looked for as the whole
  // token it is, at eight digits (the longest the platform allows), so that a coincidence with a number of the log is not a possibility.
  it('logs nothing of the code: not while it is made and shown, not while it is entered', async () => {
    await routes.admin.query(
      `update setting set value = '8'::jsonb where key = 'handshake_code_length'`,
    );
    try {
      const { rider, stop } = await counted();
      const issued = await initiate(rider, stop.id);
      expect(issued.status).toBe(201);
      const code = (issued.json() as Handshake).display_code ?? '';
      expect(code).toMatch(/^[0-9]{8}$/);
      expect((await verifyAsVendor(stop.id, code)).status).toBe(200);
      // A wrong entry too: the log of a refusal must not name the code that was entered.
      const second = await counted();
      const other = (await initiate(second.rider, second.stop.id)).json() as Handshake;
      const wrong = other.display_code === '00000000' ? '11111111' : '00000000';
      expect((await verifyAsVendor(second.stop.id, wrong)).status).toBeGreaterThanOrEqual(400);

      const logged = JSON.stringify(routes.kit.app.logs.records());
      expect(logged.length).toBeGreaterThan(100);
      expect(logged).not.toContain(code);
      expect(logged).not.toContain(other.display_code ?? '');
      expect(logged).not.toContain(wrong);
    } finally {
      await routes.admin.query(
        `update setting set value = '4'::jsonb where key = 'handshake_code_length'`,
      );
    }
  });

  // Break caught: a stop asked for before it is counted, a second code for the same stop, and an Idempotency-Key reused for another stop.
  it('refuses a code before the count is recorded, a second code for the stop, and a key used for another request', async () => {
    const arranged = await run();
    const stop = first(arranged);
    expect(outcome(await initiate(arranged.rider, stop.id))).toEqual([
      422,
      'COLLECTION_NOT_RECORDED',
    ]);
    expect(await count(arranged.rider, stop.id)).toHaveProperty('status', 200);
    const key = randomUUID();
    expect((await initiate(arranged.rider, stop.id, key)).status).toBe(201);
    const second = await initiate(arranged.rider, stop.id);
    expect(outcome(second)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(second)).toBe('handshake_exists');
    const other = await counted();
    expect(outcome(await initiate(other.rider, other.stop.id, key))).toEqual([201, undefined]);
    expect(outcome(await initiate(arranged.rider, other.stop.id, key))).toEqual([
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);
  });

  // Break caught: only the rider that counted may begin it: a vendor, an officer, another rider, a rider holding the run by custody.
  it('is the counting rider’s alone: a vendor is PERMISSION_DENIED, an officer is PERMISSION_DENIED, another rider is NOT_ASSIGNED_RIDER', async () => {
    const { rider, stop } = await counted();
    expect(
      outcome(
        await browser.post(HANDSHAKE(stop.id), undefined, {
          headers: { 'Idempotency-Key': randomUUID() },
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await ops.client.post(HANDSHAKE(stop.id), undefined, {
          origin: OPS,
          headers: { 'Idempotency-Key': randomUUID() },
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    const stranger = await arrangedRider(routes.kit, routes.admin);
    expect(outcome(await initiate(stranger, stop.id))).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    expect(await handshakeRow(stop.id)).toBeUndefined();
    expect((await initiate(rider, stop.id)).status).toBe(201);
  });

  // Break caught (AC-SLICE-001-24, -26): a wrong code not counted, the limit not enforced, a right code accepted after the limit, the stop closed by it.
  it('counts each wrong code, ends at the fifth, and refuses the right code afterwards; the stop stays ARRIVED', async () => {
    const { rider, stop } = await counted();
    const code = ((await initiate(rider, stop.id)).json() as Handshake).display_code ?? '';
    for (let n = 1; n <= 4; n += 1) {
      expect(outcome(await verifyAsVendor(stop.id, `000${String(n)}`))).toEqual([
        422,
        'CODE_INVALID',
      ]);
      expect((await handshakeRow(stop.id))?.attempts).toBe(n);
    }
    expect(outcome(await verifyAsVendor(stop.id, '0005'))).toEqual([422, 'ATTEMPTS_EXHAUSTED']);
    expect(await handshakeRow(stop.id)).toMatchObject({ state: 'EXHAUSTED', attempts: 5 });
    expect(outcome(await verifyAsVendor(stop.id, code))).toEqual([422, 'ATTEMPTS_EXHAUSTED']);
    expect(await stopState(stop.id)).toBe('ARRIVED');
  });

  // Break caught (AC-SLICE-001-26): the right code accepted after its life (late self-confirmation), the expiry not kept, Ops unable to close the stop.
  it('refuses the right code after its life, keeps it expired, and Ops resolve it: the stop closes and the exception is recorded', async () => {
    const { rider, stop } = await counted(vendorA, 2);
    const code = ((await initiate(rider, stop.id)).json() as Handshake).display_code ?? '';
    await age(stop.id);
    expect(outcome(await verifyAsVendor(stop.id, code))).toEqual([422, 'CODE_EXPIRED']);
    expect(await handshakeRow(stop.id)).toMatchObject({ state: 'EXPIRED' });
    expect(await stopState(stop.id)).toBe('ARRIVED');
    expect(outcome(await verifyAsVendor(stop.id, code))).toEqual([422, 'CODE_EXPIRED']);

    // Ops Staff do not hold the key of the resolution; Senior Ops do.
    expect(outcome(await resolve(ops, stop.id))).toEqual([403, 'PERMISSION_DENIED']);
    const resolved = await resolve(
      senior,
      stop.id,
      'The vendor confirmed by phone and sent a photo of the parcels',
    );
    expect(resolved.status).toBe(200);
    expect(resolved.json()).toMatchObject({
      stop_id: stop.id,
      state: 'MANUALLY_RESOLVED',
      channel: 'OPS_OVERRIDE',
      authorised_by: senior.identity.id,
    });
    expect(await stopState(stop.id)).toBe('PARTIALLY_COLLECTED');
    const events = await eventsOf(stop.id);
    const exception = events.find(
      (event) => event.event_code === 'pickup.handshake.manually_resolved',
    );
    expect(exception).toMatchObject({
      actor_type: 'STAFF',
      enhanced: true,
      note: 'The vendor confirmed by phone and sent a photo of the parcels',
    });
    expect(events.map((event) => event.event_code)).toContain('pickup.stop.partially_collected');
  });

  // Break caught: a text that cannot be a code treated as a different error (an oracle) or not counted, and a vendor entering a code for a stop that is not its own.
  it('answers a text that cannot be a code as a wrong code, and a stop that is not the vendor’s as NOT_FOUND', async () => {
    const { rider, stop } = await counted();
    await initiate(rider, stop.id);
    expect(outcome(await verifyAsVendor(stop.id, 'abcd'))).toEqual([422, 'CODE_INVALID']);
    expect(outcome(await verifyAsVendor(stop.id, ''))).toEqual([422, 'CODE_INVALID']);
    expect((await handshakeRow(stop.id))?.attempts).toBe(2);
    const foreign = await counted(vendorB);
    await initiate(foreign.rider, foreign.stop.id);
    expect(outcome(await verifyAsVendor(foreign.stop.id, '1234'))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await verifyAsVendor(randomUUID(), '1234'))).toEqual([404, 'NOT_FOUND']);
    expect((await handshakeRow(foreign.stop.id))?.attempts).toBe(0);
  });

  // Break caught: the rider able to prove the vendor's presence with the code it displays itself.
  it('refuses the rider the code it displays (PERMISSION_DENIED) before the SMS fallback, and a stop with no handshake as STATE_CONFLICT', async () => {
    const { rider, stop } = await counted();
    expect(outcome(await verifyAsRider(rider, stop.id, '1234'))).toEqual([409, 'STATE_CONFLICT']);
    const code = ((await initiate(rider, stop.id)).json() as Handshake).display_code ?? '';
    expect(outcome(await verifyAsRider(rider, stop.id, code))).toEqual([403, 'PERMISSION_DENIED']);
    expect(await stopState(stop.id)).toBe('ARRIVED');
  });
});

describe('requestSmsHandshakeFallback: the first rung down', () => {
  // Break caught: the fallback not superseding the rider's code, not sent to the registered number only, the new code entered by the wrong party, the channel lost.
  it('makes a new code the rider has not seen, asks the lane to text it, and the rider enters what the vendor read out on SMS_FALLBACK', async () => {
    const { rider, stop, arranged } = await counted();
    const shown = ((await initiate(rider, stop.id)).json() as Handshake).display_code ?? '';
    const sent = await fallback(rider, stop.id, 'NO_DATA');
    expect(sent.status).toBe(202);
    expect(sent.json()).toMatchObject({
      stop_id: stop.id,
      state: 'CODE_GENERATED',
      fallback_used: true,
      attempts: 0,
    });
    expect(Object.keys(sent.json() as object)).not.toContain('display_code');
    expect(await envelopesOf(first(arranged).requestId)).toEqual([{ payload: { generation: 2 } }]);
    // The code it was shown is spent; the vendor reading out the new one, the rider enters it.
    expect(outcome(await verifyAsVendor(stop.id, shown))).toEqual([422, 'CODE_INVALID']);
    const entered = await verifyAsRider(rider, stop.id, codeOf1(stop.id, 2));
    expect(entered.status).toBe(200);
    expect(entered.json()).toMatchObject({
      state: 'VERIFIED',
      channel: 'SMS_FALLBACK',
      fallback_used: true,
    });
    expect(await stopState(stop.id)).toBe('COLLECTED');
    expect((await eventsOf(stop.id)).map((event) => event.event_code)).toContain(
      'pickup.handshake.fallback_sms',
    );
  });

  // Break caught (CRIT-08): the cap and the cooldown held by the application and not the database; busy accepted as a trigger; a number the rider supplies.
  it('is capped and spaced by the database, and refuses a trigger that is not a technical failure', async () => {
    const { rider, stop } = await counted();
    await initiate(rider, stop.id);
    expect(outcome(await fallback(rider, stop.id, 'VENDOR_BUSY'))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(violationsOf(await fallback(rider, stop.id, 'VENDOR_BUSY'))).toEqual([
      { in: 'body', pointer: '/trigger', rule: 'not_a_technical_failure' },
    ]);
    expect((await fallback(rider, stop.id, 'PORTAL_DOWN')).status).toBe(202);
    expect(outcome(await fallback(rider, stop.id))).toEqual([422, 'SMS_FALLBACK_LIMIT_REACHED']);
    expect((await handshakeRow(stop.id))?.fallback_sends).toBe(1);
  });

  // Break caught: a fallback to a vendor with no registered number going somewhere, and an individual sender given a fallback it does not have.
  it('refuses a vendor with no registered number (NO_REGISTERED_NUMBER) and an individual sender (STATE_CONFLICT)', async () => {
    const noNumber = await counted(vendorB);
    await initiate(noNumber.rider, noNumber.stop.id);
    expect(outcome(await fallback(noNumber.rider, noNumber.stop.id))).toEqual([
      422,
      'NO_REGISTERED_NUMBER',
    ]);
    expect(await envelopesOf(noNumber.stop.requestId)).toEqual([]);

    const sender = await countedSender();
    await initiate(sender.rider, sender.stop.id);
    const refused = await fallback(sender.rider, sender.stop.id);
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(refused)).toBe('fallback_not_applicable');
  });

  // Break caught: a code that has run out sent again, or the mark of its expiry rolled back with the refusal; a retry of the request told something else.
  it('does not revive a code that has run out: the expiry is kept, the answer is STATE_CONFLICT, and the same key is told the same', async () => {
    const { rider, stop } = await counted();
    await initiate(rider, stop.id);
    await age(stop.id);
    const key = randomUUID();
    const refused = await fallback(rider, stop.id, 'NO_DATA', key);
    expect(outcome(refused)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(refused)).toBe('code_expired');
    expect(await handshakeRow(stop.id)).toMatchObject({ state: 'EXPIRED', fallback_sends: 0 });
    const retried = await fallback(rider, stop.id, 'NO_DATA', key);
    expect(outcome(retried)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(retried)).toBe('code_expired');
  });
});

describe('an individual sender’s handshake: the code goes by SMS and the rider enters it', () => {
  // Break caught: the sender's code shown to the rider, a text not asked of the lane, a vendor able to enter it, the rider unable to.
  it('shows no code, asks the lane to text the sender, refuses a vendor, and closes the stop when the rider enters the code', async () => {
    const { rider, stop, request } = await countedSender();
    const issued = await initiate(rider, stop.id);
    expect(issued.status).toBe(201);
    const body = issued.json() as Handshake;
    expect(body).toMatchObject({ direction: 'SENDER_SMS_RIDER_ENTERED', state: 'CODE_GENERATED' });
    expect(Object.keys(body)).not.toContain('display_code');
    expect(await envelopesOf(request.id)).toEqual([{ payload: { generation: 1 } }]);
    expect(outcome(await verifyAsVendor(stop.id, codeOf1(stop.id)))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await verifyAsRider(rider, stop.id, '0000'))).toEqual([422, 'CODE_INVALID']);
    const entered = await verifyAsRider(rider, stop.id, codeOf1(stop.id));
    expect(entered.status).toBe(200);
    expect(entered.json()).toMatchObject({ state: 'VERIFIED', channel: 'PORTAL', attempts: 1 });
    expect(await stopState(stop.id)).toBe('COLLECTED');
  });
});

describe('authoriseHandshakeOverride: Ops’s rung', () => {
  // Break caught: the override not closing the stop, not naming the officer, the note not required, the enhanced event missing or without the note.
  it('verifies on OPS_OVERRIDE naming the officer, closes the stop as the count says, and records the enhanced exception with its note', async () => {
    const { rider, stop } = await counted(vendorA, 2);
    await initiate(rider, stop.id);
    const overridden = await override(ops, stop.id, 'Phoned the vendor on the number we hold');
    expect(overridden.status).toBe(200);
    expect(overridden.json()).toMatchObject({
      state: 'VERIFIED',
      channel: 'OPS_OVERRIDE',
      authorised_by: ops.identity.id,
    });
    expect(await stopState(stop.id)).toBe('PARTIALLY_COLLECTED');
    const exception = (await eventsOf(stop.id)).find(
      (event) => event.event_code === 'pickup.handshake.fallback_override',
    );
    expect(exception).toMatchObject({
      actor_type: 'STAFF',
      surface_context: 'OPS_PORTAL',
      enhanced: true,
      note: 'Phoned the vendor on the number we hold',
    });
  });

  // Break caught: the note optional, an officer of another hub overriding, a stop that matches nothing, a rider or a vendor reaching the officer's route.
  it('needs the note, the hub, and the officer’s key', async () => {
    const { rider, stop } = await counted();
    await initiate(rider, stop.id);
    expect(outcome(await override(ops, stop.id, '   '))).toEqual([422, 'REASON_REQUIRED']);
    expect(outcome(await override(otherHubOps, stop.id))).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcome(await override(ops, randomUUID()))).toEqual([404, 'NOT_FOUND']);
    expect(
      outcome(
        await rider.client.post(
          OVERRIDE(stop.id),
          { verification_note: 'x' },
          { headers: { 'Idempotency-Key': randomUUID() } },
        ),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await browser.post(
          OVERRIDE(stop.id),
          { verification_note: 'x' },
          { headers: { 'Idempotency-Key': randomUUID() } },
        ),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(await stopState(stop.id)).toBe('ARRIVED');
    expect((await override(ops, stop.id)).status).toBe(200);
  });

  // Break caught: a stop overridden twice, or an uncounted stop overridden.
  it('refuses an uncounted stop (COLLECTION_NOT_RECORDED) and an overridden one (STATE_CONFLICT)', async () => {
    const arranged = await run();
    expect(outcome(await override(ops, first(arranged).id))).toEqual([
      422,
      'COLLECTION_NOT_RECORDED',
    ]);
    const { stop } = await counted();
    expect((await override(ops, stop.id)).status).toBe(200);
    expect(outcome(await override(ops, stop.id))).toEqual([409, 'STATE_CONFLICT']);
  });
});

describe('resolveHandshake: the resolution of a handshake that ended short', () => {
  // Break caught: a live code resolved by hand (the vendor could still enter it), the note optional, evidence accepted that nothing stores.
  it('refuses a live code (STATE_CONFLICT), a blank note (REASON_REQUIRED) and evidence that is not stored (EVIDENCE_NOT_STORED)', async () => {
    const { rider, stop } = await counted();
    await initiate(rider, stop.id);
    const live = await resolve(senior, stop.id);
    expect(outcome(live)).toEqual([409, 'STATE_CONFLICT']);
    expect(ruleOf(live)).toBe('code_live');
    expect(outcome(await resolve(senior, stop.id, '  '))).toEqual([422, 'REASON_REQUIRED']);
    expect(
      outcome(await resolve(senior, stop.id, 'Photo attached', { evidence_ids: [randomUUID()] })),
    ).toEqual([422, 'EVIDENCE_NOT_STORED']);
    expect(outcome(await resolve(otherHubOps, stop.id))).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await resolve(seniorOtherHub, stop.id))).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(await stopState(stop.id)).toBe('ARRIVED');
    expect(outcome(await resolve(senior, randomUUID()))).toEqual([404, 'NOT_FOUND']);
  });
});

describe('verifyHandshake: ownership is judged before the stop is locked (OB-S1-74 (2))', () => {
  // Break caught: the stop's row lock taken before the caller is known to own the stop, so that another vendor that had guessed a stop's identifier is made to wait for the lock of
  // whoever is working on it and learns by how long the answer takes that the stop exists and is being worked; or the owner no longer meeting the stop's lock at all (the
  // handshake is judged under it), which would let two entries of a code run side by side.
  it('answers a vendor or a rider that does not own the stop at once, as it answers a stop that does not exist, while the owner waits for the stop’s lock', async () => {
    const { rider, stop } = await counted();
    const issued = await initiate(rider, stop.id);
    expect(issued.status).toBe(201);
    const code = (issued.json() as Handshake).display_code ?? '';
    const browserB = routes.browser(vendorB.device.credential.token);
    expect(
      (await routes.signIn(browserB, vendorB.row.accountIdentifier, vendorB.secret)).status,
    ).toBe(200);
    const otherRider = (await run()).rider;
    const askers: [string, (id: string) => Promise<TestResponse>][] = [
      ['another vendor', (id) => browserB.post(VERIFY(id), { code: '0000' })],
      ['another rider', (id) => verifyAsRider(otherRider, id, '0000')],
    ];

    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      // Someone is working on the stop: its row lock is held.
      await holder.query('begin');
      await holder.query(`select id from pickup_stop where id = $1 for update`, [stop.id]);
      const pid = await backendPidOf(holder);

      for (const [who, ask] of askers) {
        const asking = ask(stop.id);
        // The refusal is not made to wait: the work ends before any backend is seen waiting for the holder's lock.
        const waited = await waitUntilBlockedBy(routes.admin, pid, who, asking).then(
          () => true,
          () => false,
        );
        expect(waited, `${who} was made to wait for the stop’s lock`).toBe(false);
        const answer = await asking;
        // And it is the answer a stop that does not exist is given: nothing tells the two apart.
        expect(outcome(answer), who).toEqual(outcome(await ask(randomUUID())));
        expect(answer.status, who).toBeGreaterThanOrEqual(400);
      }
      expect(await handshakeRow(stop.id)).toMatchObject({ state: 'CODE_GENERATED', attempts: 0 });

      // The owner meets the lock: the handshake is judged under it.
      const owner = verifyAsVendor(stop.id, code);
      await waitUntilBlockedBy(routes.admin, pid, 'the owner’s entry', owner);
      await holder.query('rollback');
      expect((await owner).status).toBe(200);
      expect(await handshakeRow(stop.id)).toMatchObject({ state: 'VERIFIED' });
    } finally {
      await holder.end().catch(() => undefined);
    }
  });
});
