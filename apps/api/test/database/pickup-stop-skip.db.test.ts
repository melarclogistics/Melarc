import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { CaptureTextMessageSender } from '../../src/platform/notifications/capture.text-message-sender.adapter.js';
import {
  NotificationLane,
  OPEN_POLICY,
} from '../../src/platform/notifications/notification-lane.js';
import { NotificationStore } from '../../src/platform/notifications/notification-store.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { insertAdHocSender, insertPickupRequest, pickupRequestRow } from './support/pickups.js';
import { liftProviderCeiling } from './support/provider-ceiling.js';
import { arrangeRun, arrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { buildService } from './support/service.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.23, `skipPickupStop` (`pickup.stop.skip`; `AC-SLICE-001-74` and `-67`; contracts/openapi.yaml; state-machines.md section 5, the signed
 * `PENDING/ARRIVED -> SKIPPED` row of Ops; MSC-DEC-412). Against a real PostgreSQL and the real application, each claim:
 *
 * - **It is Ops's act and nobody else's**: a rider (the assigned one and a second rider who holds custody alike), a vendor, a caller without
 *   the key and a caller outside the hub are refused, and the refusals say nothing of the stop.
 * - **It moves the stop and nothing else**: the stop is `SKIPPED` with the code, the note and the moment, and keeps its place, its arrival
 *   and its claim; the request keeps its state and its attempt chain, and is not written at all.
 * - **The reason is the catalogue's**: a code of `PICKUP_STOP_SKIP` and no other (not a failure code, not a system code, not an inactive
 *   one), with the note the reason requires; a refusal writes nothing.
 * - **A stop skipped is skipped once**: a stale token, a stop that is already resolved, and a retry are each answered as the contract says.
 * - **The Vendor is told**: an envelope for the notice and the audit event, in the transaction of the act, for a registered vendor.
 */
const STOP = (id: string) => `${API}/pickup-stops/${id}`;
const SKIP = (id: string) => `${STOP(id)}/skip`;
const MANIFEST = (id: string) => `${API}/pickup-manifests/${id}`;
const INACTIVE = 'FIXTURE_SKIP_INACTIVE';
const OTHER_DOMAIN = 'FIXTURE_SKIP_OTHER_DOMAIN';

let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let browser: TestClient;
let ops: Actor;
let opsB: Actor;
let noKey: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  // This file makes dozens of skips from one officer's session inside a minute; the ceiling of the operations that cause a text is proven elsewhere.
  await liftProviderCeiling(routes.admin);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor({ hubId: HUB_B });
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  // Reads pickups and holds no key to skip a stop.
  noKey = await routes.actor(
    await newBundle(routes.admin, [grant('pickup.read', 'own', 'any', 'A')]),
    HUB_A,
  );
  await routes.admin.query(
    `insert into reason_code (code, domain, label, attribution, requires_note, active)
     values ($1, 'PICKUP_STOP_SKIP', 'Fixture retired skip', 'MELARC', false, false),
            ($2, 'PICKUP_CANCELLATION', 'Fixture cancellation', 'CUSTOMER', false, true)`,
    [INACTIVE, OTHER_DOMAIN],
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

interface Stop {
  readonly id: string;
  readonly state: string;
  readonly sequence: number;
  readonly arrived_at: string | null;
  readonly skipped: { reason_code: string; note?: string; skipped_at: string } | null;
}
interface Manifest {
  readonly state: string;
  readonly completed_at: string | null;
  readonly stops: Stop[];
}
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    ...over,
  });

const onlyStop = (arranged: ArrangedRun, at = 0): ArrangedRun['stops'][number] => {
  const stop = arranged.stops[at];
  if (stop === undefined) throw new Error('stop');
  return stop;
};

/** The token the skip takes as `If-Match`: the stop as the officer reads it. */
const tokenOf = async (actor: Actor, stopId: string): Promise<string> =>
  (await actor.client.get(STOP(stopId))).header('etag') ?? '';

async function skip(
  actor: Actor,
  stopId: string,
  body: Record<string, unknown> = { reason_code: 'RUN_CUT_SHORT' },
  over: { etag?: string; key?: string } = {},
): Promise<TestResponse> {
  const etag = over.etag ?? (await tokenOf(actor, stopId));
  return actor.client.post(SKIP(stopId), body, {
    origin: OPS,
    headers: { 'If-Match': etag, 'Idempotency-Key': over.key ?? randomUUID() },
  });
}

const stopRows = (id: string) =>
  routes.rows<{
    state: string;
    sequence: number;
    arrived_at: Date | null;
    resolved_at: Date | null;
    released_at: Date | null;
    skip_snapshot: Record<string, unknown> | null;
    version: number;
  }>(
    `select state, sequence, arrived_at, resolved_at, released_at, skip_snapshot, version from pickup_stop where id = $1`,
    [id],
  );
const requestRow = (id: string) =>
  routes.rows<{ state: string; attempt_number: number; rider_assigned: boolean; version: number }>(
    `select state, attempt_number, rider_assigned, version from pickup_request where id = $1`,
    [id],
  );
const events = (code: string, objectId: string) =>
  routes.rows<{
    actor_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    reason_code: string | null;
    reason_label: string | null;
    note: string | null;
    related_ids: Record<string, string> | null;
    detail: Record<string, unknown> | null;
    responsible_hub_id: string | null;
    vendor_organization_id: string | null;
    enhanced: boolean;
    outcome: string;
  }>(
    `select actor_id, previous_state, resulting_state, reason_code, reason_label, note, related_ids, detail, responsible_hub_id,
            vendor_organization_id, enhanced, outcome
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );
const envelopes = (requestId: string) =>
  routes.rows<{
    event_type: string;
    aggregate_type: string;
    responsible_hub_id: string;
    vendor_organization_id: string | null;
    payload: Record<string, unknown>;
    operation_id: string;
    originating_principal_id: string;
  }>(
    `select event_type, aggregate_type, responsible_hub_id, vendor_organization_id, payload, operation_id, originating_principal_id
       from outbox where aggregate_id = $1 and event_type = 'pickup.stop.skipped'`,
    [requestId],
  );

describe('skipPickupStop: the act', () => {
  // Break caught: a skip that writes more or less than the stop (the request touched, the attempt chain moved, the claim released, the
  // place lost) or that answers with a representation other than the stop's own.
  it('skips a pending stop of a run in progress, and moves nothing else', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    const before = (await stopRows(stop.id))[0];
    const requestBefore = (await requestRow(stop.requestId))[0];
    const token = await tokenOf(ops, stop.id);

    const response = await skip(ops, stop.id, { reason_code: 'RUN_CUT_SHORT' });
    expect(response.status).toBe(200);
    const body = response.json() as Stop;
    expect(body).toMatchObject({
      id: stop.id,
      state: 'SKIPPED',
      sequence: 1,
      arrived_at: null,
      skipped: { reason_code: 'RUN_CUT_SHORT' },
    });
    expect(Object.keys(body.skipped ?? {}).toSorted()).toEqual(['reason_code', 'skipped_at']);
    expect(response.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(response.header('etag')).not.toBe(token);
    expect(response.header('etag')).toBe(await tokenOf(ops, stop.id));

    const after = (await stopRows(stop.id))[0];
    expect(after).toMatchObject({
      state: 'SKIPPED',
      sequence: 1,
      arrived_at: null,
      released_at: null,
    });
    expect(after?.resolved_at).toBeInstanceOf(Date);
    expect(after?.skip_snapshot).toMatchObject({ reason_code: 'RUN_CUT_SHORT' });
    expect(after?.version).toBe((before?.version ?? 0) + 1);
    // The request keeps its state and its chain, and is not written at all.
    expect((await requestRow(stop.requestId))[0]).toEqual(requestBefore);
    // The other stop is untouched and the run is still going.
    const manifest = (await ops.client.get(MANIFEST(arranged.manifest.id))).json() as Manifest;
    expect(manifest.state).toBe('IN_PROGRESS');
    expect(manifest.stops.map((each) => each.state)).toEqual(['SKIPPED', 'PENDING']);
  });

  // Break caught: a skip that drops the evidence of a visit that happened.
  it('skips an arrived stop and keeps the moment of the arrival', async () => {
    const arranged = await run({ stops: 2, stopStates: ['ARRIVED', 'PENDING'] });
    const stop = onlyStop(arranged);
    const before = (await stopRows(stop.id))[0];
    expect(before?.arrived_at).toBeInstanceOf(Date);
    const response = await skip(ops, stop.id, { reason_code: 'VENDOR_REQUESTED_SKIP' });
    expect(response.status).toBe(200);
    expect((await stopRows(stop.id))[0]).toMatchObject({
      state: 'SKIPPED',
      arrived_at: before?.arrived_at,
    });
    expect((response.json() as Stop).arrived_at).toBe(before?.arrived_at?.toISOString());
  });

  // Break caught: a skip before the start that is not the skip of a run in progress: the claim released (the request back in the pool and planned a
  // second time), the request or its chain written, the reason not judged, the Vendor not told, the ledger not written, or a rider, a vendor or a
  // caller without the key let in. A stop of a draft or a dispatched run can be unresolvable too (the dispatch of a draft with such a stop is refused,
  // and Ops resolves it with this act or cancels the draft), so the act is allowed there on the same terms.
  it.each([['DRAFT'], ['DISPATCHED']] as const)(
    'skips a stop of a %s run on the terms of a run in progress: the reason judged, the authority held, the claim kept, the request untouched, the Vendor told',
    async (state) => {
      const arranged = await run({ state, stops: 2 });
      const stop = onlyStop(arranged);
      const requestBefore = (await requestRow(stop.requestId))[0];
      const body = { reason_code: 'LOCATION_INACCESSIBLE', note: 'The gate was welded shut' };

      // The reason is judged here as it is anywhere, and nobody without the authority gets in; a refusal writes nothing.
      const refused: [Record<string, unknown>, string][] = [
        [{ reason_code: '' }, 'REASON_REQUIRED'],
        [{ reason_code: INACTIVE }, 'REASON_NOT_ACTIVE'],
        [{ reason_code: 'LOCATION_INACCESSIBLE' }, 'REASON_REQUIRED'],
      ];
      for (const [bad, code] of refused) {
        expect(outcome(await skip(ops, stop.id, bad)), `${state}: ${code}`).toEqual([422, code]);
      }
      const etag = await tokenOf(ops, stop.id);
      const headers = { 'If-Match': etag, 'Idempotency-Key': randomUUID() };
      for (const [who, denied] of [
        ['the assigned rider', await arranged.rider.client.post(SKIP(stop.id), body, { headers })],
        ['a vendor', await browser.post(SKIP(stop.id), body, { headers })],
        ['a caller without the key', await skip(noKey, stop.id, body, { etag })],
      ] as const) {
        expect(outcome(denied), `${state}: ${who}`).toEqual([403, 'PERMISSION_DENIED']);
      }
      expect((await stopRows(stop.id))[0]).toMatchObject({ state: 'PENDING', released_at: null });
      expect(await events('pickup.stop.skipped', stop.id)).toEqual([]);
      expect(await envelopes(stop.requestId)).toEqual([]);

      // Then the skip: the run keeps its state, the stop is skipped and still holds its request (the claim is kept until an explicit release), and
      // the request is not written at all.
      const response = await skip(ops, stop.id, body);
      expect(response.status, state).toBe(200);
      expect(
        ((await ops.client.get(MANIFEST(arranged.manifest.id))).json() as Manifest).state,
      ).toBe(state);
      expect((await stopRows(stop.id))[0]).toMatchObject({
        state: 'SKIPPED',
        released_at: null,
        arrived_at: null,
      });
      expect((await requestRow(stop.requestId))[0]).toEqual(requestBefore);

      // The ledger has the officer's act and the reason; the Vendor is told once, with the reason and the action and none of Ops's note.
      const written = await events('pickup.stop.skipped', stop.id);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        actor_id: ops.identity.id,
        reason_code: 'LOCATION_INACCESSIBLE',
        resulting_state: 'SKIPPED',
      });
      const queued = await envelopes(stop.requestId);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.payload).toMatchObject({
        reason: 'LOCATION_INACCESSIBLE',
        action: 'CORRECT_PICKUP_LOCATION',
      });
      expect(JSON.stringify(queued[0]?.payload)).not.toContain('welded');
      const notified = await events('vendor.pickup_skip.notified', stop.requestId);
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatchObject({
        reason_code: 'LOCATION_INACCESSIBLE',
        vendor_organization_id: vendorA.row.organizationId,
      });
    },
  );

  // Break caught: a note kept for the rider (Ops's own text, which the rider never reads, as it never reads the note of a cancellation), or
  // lost to staff.
  it('keeps the note for staff and shows the assigned rider the reason and the moment only', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    const response = await skip(ops, stop.id, {
      reason_code: 'LOCATION_INACCESSIBLE',
      note: 'The gate was welded shut',
    });
    expect(response.status).toBe(200);
    expect((response.json() as Stop).skipped).toMatchObject({
      reason_code: 'LOCATION_INACCESSIBLE',
      note: 'The gate was welded shut',
    });
    const staffRead = (await ops.client.get(STOP(stop.id))).json() as Stop;
    expect(staffRead.skipped?.note).toBe('The gate was welded shut');

    for (const read of [
      await arranged.rider.client.get(STOP(stop.id)),
      await arranged.rider.client.get(MANIFEST(arranged.manifest.id)),
    ]) {
      expect(read.status).toBe(200);
      expect(read.text).not.toContain('welded');
    }
    const riderStop = (await arranged.rider.client.get(STOP(stop.id))).json() as Stop;
    expect(riderStop.skipped).toMatchObject({ reason_code: 'LOCATION_INACCESSIBLE' });
    expect(Object.keys(riderStop.skipped ?? {}).toSorted()).toEqual(['reason_code', 'skipped_at']);
  });
});

describe('skipPickupStop: the reason', () => {
  // Break caught: a code of another domain, a retired or an unknown one, a system code, or a missing note accepted; or a refusal that leaves
  // something written.
  it('takes a code of PICKUP_STOP_SKIP with the note it requires, and refuses every other, writing nothing', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    const refused: [string, Record<string, unknown>, string][] = [
      ['an empty code', { reason_code: '' }, 'REASON_REQUIRED'],
      ['a code of another domain', { reason_code: OTHER_DOMAIN }, 'REASON_NOT_ACTIVE'],
      ['a retired code', { reason_code: INACTIVE }, 'REASON_NOT_ACTIVE'],
      ['an unknown code', { reason_code: 'NO_SUCH_REASON' }, 'REASON_NOT_ACTIVE'],
      [
        'the system code of a cancellation',
        { reason_code: 'REQUEST_CANCELLED' },
        'REASON_NOT_ACTIVE',
      ],
      ['the system code of a manifest', { reason_code: 'MANIFEST_CANCELLED' }, 'REASON_NOT_ACTIVE'],
      [
        'a note-bearing code with no note',
        { reason_code: 'LOCATION_INACCESSIBLE' },
        'REASON_REQUIRED',
      ],
      [
        'a note-bearing code with a blank note',
        { reason_code: 'STOP_RAISED_IN_ERROR', note: '   ' },
        'REASON_REQUIRED',
      ],
    ];
    for (const [what, body, code] of refused) {
      const response = await skip(ops, stop.id, body);
      expect(outcome(response), what).toEqual([422, code]);
    }
    expect((await stopRows(stop.id))[0]).toMatchObject({ state: 'PENDING', released_at: null });
    expect(await events('pickup.stop.skipped', stop.id)).toEqual([]);
    expect(await envelopes(stop.requestId)).toEqual([]);

    // A note on a code that does not need one is kept as given.
    const kept = await skip(ops, stop.id, {
      reason_code: 'RUN_CUT_SHORT',
      note: 'Curfew at 17:00',
    });
    expect(kept.status).toBe(200);
    expect((kept.json() as Stop).skipped?.note).toBe('Curfew at 17:00');
  });

  it('refuses a body that is not the contract’s as a validation failure', async () => {
    const stop = onlyStop(await run({ stops: 2 }));
    const bodies: Record<string, unknown>[] = [
      {},
      { note: 'no reason' },
      { reason_code: 'RUN_CUT_SHORT', unexpected: true },
      { reason_code: 7 },
      { reason_code: 'RUN_CUT_SHORT', note: 7 },
    ];
    for (const body of bodies) {
      expect(outcome(await skip(ops, stop.id, body)), JSON.stringify(body)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(outcome(await skip(ops, 'not-a-uuid', undefined, { etag: '"x"' }))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect((await stopRows(stop.id))[0]?.state).toBe('PENDING');
  });
});

describe('skipPickupStop: who may skip', () => {
  // Break caught: a rider (the assigned one, or the second rider who holds custody after a handover), a vendor or a caller without the key
  // that can skip; or a refusal that tells what the stop is.
  it('refuses a rider, a vendor and a caller without the key, and a session-less caller', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    const second = await arrangedRider(routes.kit, routes.admin);
    const etag = await tokenOf(ops, stop.id);
    const headers = { 'If-Match': etag, 'Idempotency-Key': randomUUID() };
    const body = { reason_code: 'RUN_CUT_SHORT' };

    expect(outcome(await arranged.rider.client.post(SKIP(stop.id), body, { headers }))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(outcome(await second.client.post(SKIP(stop.id), body, { headers }))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(outcome(await browser.post(SKIP(stop.id), body, { headers }))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(outcome(await skip(noKey, stop.id, body, { etag }))).toEqual([403, 'PERMISSION_DENIED']);
    const anonymous = await routes.kit.client
      .fork()
      .post(SKIP(stop.id), body, { origin: OPS, headers });
    expect(outcome(anonymous)).toEqual([401, 'SESSION_INVALID']);
    expect((await stopRows(stop.id))[0]?.state).toBe('PENDING');
  });

  it('refuses a request with no synchronizer token', async () => {
    const stop = onlyStop(await run({ stops: 2 }));
    // The session cookie alone: no synchronizer token is echoed by this client.
    const bare = routes.kit.client.fork();
    bare.seed('melarc_session', ops.token);
    const response = await bare.post(
      SKIP(stop.id),
      { reason_code: 'RUN_CUT_SHORT' },
      {
        origin: OPS,
        headers: { 'If-Match': await tokenOf(ops, stop.id), 'Idempotency-Key': randomUUID() },
      },
    );
    expect(outcome(response)).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect((await stopRows(stop.id))[0]?.state).toBe('PENDING');
  });

  // Break caught: an officer of another hub who can skip, or who learns the stop exists; an id that matches nothing told from a stop outside
  // the grant when it should not be, or the reverse.
  it('tells an officer a stop outside its hub from one that does not exist, and skips nothing of the other hub', async () => {
    const other = await run({
      stops: 2,
      hubId: HUB_B,
      vendorOrganizationId: vendorB.row.organizationId,
    });
    const stop = onlyStop(other);
    const outside = await ops.client.post(
      SKIP(stop.id),
      { reason_code: 'RUN_CUT_SHORT' },
      { origin: OPS, headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
    );
    expect(outcome(outside)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outside.text).not.toContain(stop.requestCode);
    expect(
      outcome(
        await ops.client.post(
          SKIP(randomUUID()),
          { reason_code: 'RUN_CUT_SHORT' },
          { origin: OPS, headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
        ),
      ),
    ).toEqual([404, 'NOT_FOUND']);
    expect((await stopRows(stop.id))[0]?.state).toBe('PENDING');
    expect((await skip(opsB, stop.id)).status).toBe(200);
  });
});

describe('skipPickupStop: the stop as it is', () => {
  // Break caught: a skip made on a token the officer did not read (a stale one, another stop's, none that parses), which would skip a stop
  // that had changed since it was looked at.
  it('refuses a stale token and the token of another stop, and skips on the current one', async () => {
    const arranged = await run({ stops: 3 });
    const [first, second] = [onlyStop(arranged, 0), onlyStop(arranged, 1)];
    const stale = await tokenOf(ops, first.id);
    // The stop moves under the officer: the rider arrives at it.
    const arrived = await arranged.rider.client.post(`${STOP(first.id)}/arrive`, undefined, {
      headers: { 'Idempotency-Key': randomUUID() },
    });
    expect(arrived.status).toBe(200);
    expect(outcome(await skip(ops, first.id, undefined, { etag: stale }))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(
      outcome(await skip(ops, first.id, undefined, { etag: await tokenOf(ops, second.id) })),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect(outcome(await skip(ops, first.id, undefined, { etag: 'W/"weak"' }))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect((await stopRows(first.id))[0]?.state).toBe('ARRIVED');
    expect((await skip(ops, first.id)).status).toBe(200);
  });

  // Break caught: a resolved stop skipped, which would erase a collection, a failure or an earlier skip.
  it('refuses a stop that is already resolved, in every way it can be, and leaves it as it is', async () => {
    const arranged = await run({
      stops: 5,
      stopStates: ['COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED', 'PENDING'],
    });
    for (const stop of arranged.stops.slice(0, 4)) {
      const before = (await stopRows(stop.id))[0];
      expect(outcome(await skip(ops, stop.id)), String(stop.sequence)).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
      expect((await stopRows(stop.id))[0]).toEqual(before);
    }
    expect(await events('pickup.stop.skipped', onlyStop(arranged).id)).toEqual([]);
  });

  // Break caught: the stop of a request the office cancelled skipped a second time, with a reason of Ops's over the system's.
  it('refuses the stop a cancellation already skipped', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    const etag = (await ops.client.get(`${API}/pickup-requests/${stop.requestId}`)).header('etag');
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, active)
       values ('FIXTURE_CANCEL_FOR_SKIP', 'PICKUP_CANCELLATION', 'Fixture', 'CUSTOMER', false, true)
       on conflict do nothing`,
    );
    const cancelled = await ops.client.post(
      `${API}/pickup-requests/${stop.requestId}/cancel`,
      {
        reason_code: 'FIXTURE_CANCEL_FOR_SKIP',
        apply_charge: false,
        charge_reason_code: 'FIXTURE_CANCEL_FOR_SKIP',
      },
      { origin: OPS, headers: { 'If-Match': etag ?? '', 'Idempotency-Key': randomUUID() } },
    );
    expect(cancelled.status).toBe(200);
    expect(outcome(await skip(ops, stop.id))).toEqual([409, 'STATE_CONFLICT']);
    expect((await stopRows(stop.id))[0]?.skip_snapshot).toMatchObject({
      reason_code: 'REQUEST_CANCELLED',
    });
  });
});

describe('skipPickupStop: a retry', () => {
  // Break caught: a retry that skips twice, answers differently, or writes a second event; the same key for another body or another stop
  // accepted; a new key on a stop already skipped answered as a second success.
  it('replays the original answer, refuses the key for anything else, and finds a new key on a skipped stop in conflict', async () => {
    const arranged = await run({ stops: 3 });
    const [stop, other] = [onlyStop(arranged, 0), onlyStop(arranged, 1)];
    const key = randomUUID();
    const first = await skip(ops, stop.id, { reason_code: 'RUN_CUT_SHORT' }, { key });
    expect(first.status).toBe(200);
    const again = await skip(
      ops,
      stop.id,
      { reason_code: 'RUN_CUT_SHORT' },
      { key, etag: await tokenOf(ops, stop.id) },
    );
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    expect(again.header('etag')).toBe(first.header('etag'));
    expect(await events('pickup.stop.skipped', stop.id)).toHaveLength(1);
    expect(await envelopes(stop.requestId)).toHaveLength(1);

    const otherBody = await skip(
      ops,
      stop.id,
      { reason_code: 'VENDOR_REQUESTED_SKIP' },
      { key, etag: await tokenOf(ops, stop.id) },
    );
    expect(outcome(otherBody)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    const otherStop = await skip(ops, other.id, { reason_code: 'RUN_CUT_SHORT' }, { key });
    expect(outcome(otherStop)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect((await stopRows(other.id))[0]?.state).toBe('PENDING');

    expect(
      outcome(await skip(ops, stop.id, { reason_code: 'RUN_CUT_SHORT' }, { key: randomUUID() })),
    ).toEqual([409, 'STATE_CONFLICT']);
  });
});

describe('skipPickupStop: the record and the Vendor’s notice', () => {
  // Break caught: an event that misses the reason, the states, the request and the run, or one written twice; a note screened out; a
  // tier other than the catalogue's.
  it('writes one pickup.stop.skipped event by the officer, with the reason, the note and the identifiers', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    expect(
      (
        await skip(ops, stop.id, {
          reason_code: 'STOP_RAISED_IN_ERROR',
          note: 'Booked twice by mistake',
        })
      ).status,
    ).toBe(200);
    const written = await events('pickup.stop.skipped', stop.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_id: ops.identity.id,
      previous_state: 'PENDING',
      resulting_state: 'SKIPPED',
      reason_code: 'STOP_RAISED_IN_ERROR',
      note: 'Booked twice by mistake',
      related_ids: {
        pickup_request_id: stop.requestId,
        pickup_manifest_id: arranged.manifest.id,
      },
      detail: { cause: 'AUTHORISED_SKIP' },
      responsible_hub_id: HUB_A,
      enhanced: false,
      outcome: 'SUCCEEDED',
    });
    expect(written[0]?.reason_label).toBeTruthy();
  });

  // Break caught: a Vendor not told, told twice, told of someone else's pickup, or told in a message that carries the reason's note.
  it('queues the Vendor’s notice with the request and the reason, and records it', async () => {
    const arranged = await run({ stops: 2 });
    const stop = onlyStop(arranged);
    expect(
      (
        await skip(ops, stop.id, {
          reason_code: 'LOCATION_INACCESSIBLE',
          note: 'The gate was welded shut',
        })
      ).status,
    ).toBe(200);
    const queued = await envelopes(stop.requestId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      event_type: 'pickup.stop.skipped',
      aggregate_type: 'PICKUP_REQUEST',
      responsible_hub_id: HUB_A,
      vendor_organization_id: vendorA.row.organizationId,
      operation_id: 'skipPickupStop',
      originating_principal_id: ops.identity.id,
      payload: { reason: 'LOCATION_INACCESSIBLE' },
    });
    expect(JSON.stringify(queued[0]?.payload)).not.toContain('welded');

    const notified = await events('vendor.pickup_skip.notified', stop.requestId);
    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      reason_code: 'LOCATION_INACCESSIBLE',
      vendor_organization_id: vendorA.row.organizationId,
      outcome: 'SUCCEEDED',
    });
    expect(notified[0]?.detail).toMatchObject({ requested_action: 'CORRECT_PICKUP_LOCATION' });
    expect(JSON.stringify(notified[0])).not.toContain('welded');
  });

  // Break caught: the notice left out for the one skip that is the vendor's own request (the contract raises it for every skip, so that
  // it records the request was honoured).
  it('raises the notice for every reason, the vendor’s own request included', async () => {
    for (const code of ['RUN_CUT_SHORT', 'VENDOR_REQUESTED_SKIP']) {
      const stop = onlyStop(await run({ stops: 2 }));
      expect((await skip(ops, stop.id, { reason_code: code })).status).toBe(200);
      expect(await envelopes(stop.requestId), code).toHaveLength(1);
      expect(await events('vendor.pickup_skip.notified', stop.requestId), code).toHaveLength(1);
    }
  });

  // Break caught: a skip whose record or notice is not part of the act (a failure to write either leaves the stop skipped).
  it('leaves no skip, no envelope and no event if the record cannot be written', async () => {
    const stop = onlyStop(await run({ stops: 2 }));
    const broken = await routes.kit.admin.breakWrites('audit_event');
    try {
      const response = await skip(ops, stop.id);
      expect(response.status).toBe(500);
    } finally {
      await broken.mend();
    }
    expect((await stopRows(stop.id))[0]).toMatchObject({ state: 'PENDING', resolved_at: null });
    expect(await envelopes(stop.requestId)).toEqual([]);
    expect(await events('pickup.stop.skipped', stop.id)).toEqual([]);
    expect((await skip(ops, stop.id)).status).toBe(200);
  });
});

describe('skipPickupStop: the notice reaches the Vendor’s feed, through the real lane', () => {
  const clock = new SystemClock();
  const NEVER = new AbortController().signal;

  /** One tick of the notification lane, as the delivery worker runs it, over the same database. */
  async function relay(): Promise<void> {
    const work = buildService(routes.database, { poolMax: 3, login: WORKER_RUNTIME_ROLE });
    try {
      const lane = new NotificationLane({
        store: new NotificationStore({
          database: work.service,
          clock,
          workerId: 'skip-notice-lane',
        }),
        sender: new CaptureTextMessageSender({
          sink: { record: () => Promise.resolve() },
          clock,
        }),
        policy: OPEN_POLICY,
        logger: work.logs.logger,
        leaseMs: 30_000,
        firstReceiptCheckMs: 0,
        receiptHoldMs: 60_000,
        random: () => 0.5,
      });
      for (let tick = 0; tick < 3; tick += 1) await lane.runOnce(NEVER);
    } finally {
      await work.close();
    }
  }

  const noticesOf = (requestId: string) =>
    routes.rows<{
      message_kind: string;
      audience: string;
      channel: string;
      state: string;
      vendor_organization_id: string | null;
      parameters: Record<string, string>;
      destination_hint: string | null;
    }>(
      `select message_kind, audience, channel, state, vendor_organization_id, parameters, destination_hint
         from notification where subject_id = $1 order by message_kind`,
      [requestId],
    );

  // Break caught: a notice that dead-letters (no message answers the event), reaches the wrong audience, names no reason, carries Ops's note, or
  // is a text to somebody's number.
  it('becomes one feed entry for the vendor, with the reason and the action as tokens and nothing of the note', async () => {
    const stop = onlyStop(await run({ stops: 2 }));
    expect(
      (
        await skip(ops, stop.id, {
          reason_code: 'LOCATION_INACCESSIBLE',
          note: 'The gate was welded shut',
        })
      ).status,
    ).toBe(200);
    await relay();
    const skipNotices = (await noticesOf(stop.requestId)).filter(
      (each) => each.message_kind === 'PICKUP_SKIPPED_VENDOR_FEED',
    );
    expect(skipNotices).toEqual([
      {
        message_kind: 'PICKUP_SKIPPED_VENDOR_FEED',
        audience: 'VENDOR_FEED',
        channel: 'FEED',
        state: 'DELIVERED',
        vendor_organization_id: vendorA.row.organizationId,
        parameters: { reason: 'LOCATION_INACCESSIBLE', action: 'CORRECT_PICKUP_LOCATION' },
        destination_hint: null,
      },
    ]);
    expect(JSON.stringify(skipNotices)).not.toContain('welded');
    const envelope = await routes.rows<{ relay_state: string; last_outcome: string | null }>(
      `select relay_state, last_outcome from outbox where aggregate_id = $1 and event_type = 'pickup.stop.skipped'`,
      [stop.requestId],
    );
    expect(envelope).toEqual([{ relay_state: 'RELAYED', last_outcome: 'MATERIALISED' }]);
  });

  it('asks nothing of the vendor for a reason that is Melarc’s own or the vendor’s own request', async () => {
    for (const code of ['RUN_CUT_SHORT', 'VENDOR_REQUESTED_SKIP', 'STOP_RAISED_IN_ERROR']) {
      const stop = onlyStop(await run({ stops: 2 }));
      expect(
        (await skip(ops, stop.id, { reason_code: code, note: 'Booked twice' })).status,
        code,
      ).toBe(200);
      await relay();
      const notice = (await noticesOf(stop.requestId)).find(
        (each) => each.message_kind === 'PICKUP_SKIPPED_VENDOR_FEED',
      );
      expect(notice?.parameters, code).toEqual({ reason: code, action: 'NONE' });
    }
  });

  // Break caught: a notice raised for a pickup that has no vendor (an individual sender is not a Vendor; no document asks for a text to it on a
  // skip), or an event that says nothing of why none was.
  it('queues no notice for an individual sender’s pickup, and the event of the skip says so', async () => {
    const sender = await insertAdHocSender(routes.admin);
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
    const manifest = await insertManifest(
      routes.admin,
      manifestRow(HUB_A, { state: 'DRAFT', serviceDate: days.today }),
    );
    const stop = await insertStop(routes.admin, stopRow(manifest, request.id, 1));
    expect((await skip(ops, stop.id)).status).toBe(200);
    expect(await envelopes(request.id)).toEqual([]);
    expect(await events('vendor.pickup_skip.notified', request.id)).toEqual([]);
    const skipped = await events('pickup.stop.skipped', stop.id);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.detail).toMatchObject({ vendor_notice: 'NO_VENDOR' });
  });
});
