import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/auth/ports/audit-writer.port.js';
import { RUN_ACCESS, type RunAccess } from '../../src/platform/domain-ports/run-access.port.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertRider, riderRow } from './support/riders.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.24, the run custody handover (`fleet.custody.initiate`, `.accept` and `.read`; `AC-SLICE-001-67` and `-68`; state-machines.md section 4.1;
 * domain-model.md section 6.8.1; MSC-DEC-246). Against a real PostgreSQL and the real application, each claim:
 *
 * - **Opening moves nothing, and custody changes hands only on acceptance**: after an opening the run, its stops and its holder are exactly as
 *   they were; a failed handover leaves custody where it was and a further one may be opened; an accepted one makes the receiver the holder, and
 *   the stops worked before keep the rider who worked them.
 * - **One open handover per run, from whoever holds the custody**: a second opening, a stale token, a run not in progress, a destination that is
 *   unavailable, both or neither destination, and a hub that is not the run's are each refused as the contract says. A run the hub holds has no
 *   rider to hand on.
 * - **Only the named receiver accepts (or Ops, where the hub is the destination)**: the sender, a colleague and a run that does not exist are one
 *   answer to a rider; Ops cannot accept a handover to a rider; Ops alone fails one. A rider is `PERMISSION_DENIED` where it is not a rider's act.
 * - **Reads are by party**: a rider reads the handovers it is a party to, and nothing of the run; staff those of their hubs, with the hub axis told.
 * - **The count taken is a custody record**: it is kept on the handover and is written nowhere else.
 */
const MANIFEST = (id: string) => `${API}/pickup-manifests/${id}`;
const OPEN = (id: string) => `${MANIFEST(id)}/custody-handover`;
const ACCEPT = (id: string) => `${OPEN(id)}/accept`;
const FAIL = (id: string) => `${OPEN(id)}/fail`;
const HANDOVERS = `${API}/run-custody-handovers`;
const HANDOVER = (id: string) => `${HANDOVERS}/${id}`;
const STOP = (id: string) => `${API}/pickup-stops/${id}`;

let routes: VendorRoutes;
let days: ManifestDays;
let vendorA: ArrangedVendor;
let vendorB: ArrangedVendor;
let browser: TestClient;
let ops: Actor;
let opsB: Actor;
let noKey: Actor;
let wide: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendorA = await routes.vendor();
  vendorB = await routes.vendor({ hubId: HUB_B });
  browser = routes.browser(vendorA.device.credential.token);
  expect((await routes.signIn(browser, vendorA.row.accountIdentifier, vendorA.secret)).status).toBe(
    200,
  );
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  noKey = await routes.actor(
    await newBundle(routes.admin, [grant('pickup.read', 'own', 'any', 'A')]),
    HUB_A,
  );
  // Reads custody in every hub, with a primary hub of its own: its read of the other hub is a crossing.
  wide = await routes.actor(
    await newBundle(routes.admin, [grant('fleet.custody.read', 'all', 'any', 'A')]),
    HUB_A,
  );
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

// The authenticated API allows 120 calls a minute to a session, and a test of a race makes many: each test has officers of its own.
beforeEach(async () => {
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
});

interface Handover {
  readonly id: string;
  readonly manifest_id: string;
  readonly from_rider_id: string;
  readonly to_rider_id: string | null;
  readonly to_hub_id: string | null;
  readonly state: string;
  readonly parcel_count_taken: number | null;
  readonly initiated_at: string;
  readonly resolved_at: string | null;
}
interface Page {
  readonly items: Handover[];
  readonly next_page_token: string | null;
}
const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];
const handoverOf = (response: TestResponse): Handover => response.json() as Handover;

/** What two answers must share to be indistinguishable: everything but the request's own identifier. */
const shapeOf = (response: TestResponse) => ({
  status: response.status,
  body: { ...(response.json() as Record<string, unknown>), request_id: undefined },
  headers: response
    .headerEntries()
    .filter(([name]) => !/^(date|x-request-id|request-id)$/.test(name)),
});

const run = (over: Partial<Parameters<typeof arrangeRun>[2]> = {}): Promise<ArrangedRun> =>
  arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendorA.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    ...over,
  });

const manifestEtag = async (actor: Actor, id: string): Promise<string> =>
  (await actor.client.get(MANIFEST(id))).header('etag') ?? '';

/** Opens a handover as Ops, on the run as Ops reads it, unless the test says otherwise. */
async function open(
  actor: Actor,
  runId: string,
  body: Record<string, unknown>,
  over: { etag?: string } = {},
): Promise<TestResponse> {
  const etag = over.etag ?? (await manifestEtag(actor, runId));
  return actor.client.post(OPEN(runId), body, { origin: OPS, headers: { 'If-Match': etag } });
}

const toRider = (rider: ArrangedRider, note = 'The rider broke down at the roadside') => ({
  to_rider_id: rider.id,
  note,
});

/** Accepts as a rider, on the handover's token. */
function acceptAsRider(
  rider: ArrangedRider,
  runId: string,
  etag: string,
  count = 4,
  key: string = randomUUID(),
): Promise<TestResponse> {
  return rider.client.post(
    ACCEPT(runId),
    { parcel_count_taken: count },
    { headers: { 'If-Match': etag, 'Idempotency-Key': key } },
  );
}

function acceptAsOps(
  actor: Actor,
  runId: string,
  etag: string,
  count = 4,
  key: string = randomUUID(),
): Promise<TestResponse> {
  return actor.client.post(
    ACCEPT(runId),
    { parcel_count_taken: count },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': key } },
  );
}

function failAsOps(
  actor: Actor,
  runId: string,
  etag: string,
  note = 'The rider named did not arrive',
  key: string = randomUUID(),
): Promise<TestResponse> {
  return actor.client.post(
    FAIL(runId),
    { note },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': key } },
  );
}

async function skipAsOps(actor: Actor, stopId: string): Promise<TestResponse> {
  const etag = (await actor.client.get(STOP(stopId))).header('etag') ?? '';
  return actor.client.post(
    `${STOP(stopId)}/skip`,
    { reason_code: 'RUN_CUT_SHORT' },
    { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
  );
}

const handoverRows = (manifestId: string) =>
  routes.rows<{
    id: string;
    state: string;
    from_rider_id: string;
    to_rider_id: string | null;
    to_hub_id: string | null;
    parcel_count_taken: number | null;
    accepted_by: string | null;
    failed_by: string | null;
    initiation_note: string;
    failure_note: string | null;
    initiated_by: string;
    resolved_at: Date | null;
    version: number;
  }>(
    `select id, state, from_rider_id, to_rider_id, to_hub_id, parcel_count_taken, accepted_by, failed_by, initiation_note, failure_note,
            initiated_by, resolved_at, version
       from run_custody_handover where manifest_id = $1 order by initiated_at, id`,
    [manifestId],
  );
const manifestRowOf = (id: string) =>
  routes.rows(`select * from pickup_manifest where id = $1`, [id]).then((rows) => rows[0]);
const stopRowsOf = (manifestId: string) =>
  routes.rows(`select * from pickup_stop where pickup_manifest_id = $1 order by sequence`, [
    manifestId,
  ]);
const holderOf = (manifestId: string) =>
  routes
    .rows<{ holder: string | null }>(`select melarc.run_custody_holder($1) as holder`, [manifestId])
    .then((rows) => rows[0]?.holder);
const events = (code: string, objectId: string) =>
  routes.rows<{
    actor_type: string;
    actor_id: string | null;
    previous_state: string | null;
    resulting_state: string | null;
    note: string | null;
    related_ids: Record<string, string> | null;
    detail: Record<string, unknown> | null;
    responsible_hub_id: string | null;
    enhanced: boolean;
    surface_context: string;
  }>(
    `select actor_type, actor_id, previous_state, resulting_state, note, related_ids, detail, responsible_hub_id, enhanced, surface_context
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

describe('initiateRunCustodyHandover: opening a handover moves nothing', () => {
  // Break caught: an opening that changes the run, its stops or its holder (a window in which custody has moved before anyone accepted), or one
  // that answers with another shape than the contract's, writes the note into a representation a rider reads, or has no token.
  it('opens a pending handover to a second rider and leaves the run, its stops and its holder as they were', async () => {
    const arranged = await run({ stops: 3, stopStates: ['COLLECTED', 'PENDING', 'PENDING'] });
    const second = await arrangedRider(routes.kit, routes.admin);
    const runBefore = await manifestRowOf(arranged.manifest.id);
    const stopsBefore = await stopRowsOf(arranged.manifest.id);

    const response = await open(ops, arranged.manifest.id, toRider(second));
    expect(response.status).toBe(200);
    const body = handoverOf(response);
    expect(body).toMatchObject({
      manifest_id: arranged.manifest.id,
      from_rider_id: arranged.rider.id,
      to_rider_id: second.id,
      to_hub_id: null,
      state: 'PENDING',
      parcel_count_taken: null,
      resolved_at: null,
    });
    expect(Object.keys(body).toSorted()).toEqual(
      [
        'from_rider_id',
        'id',
        'initiated_at',
        'manifest_id',
        'parcel_count_taken',
        'resolved_at',
        'state',
        'to_hub_id',
        'to_rider_id',
      ].toSorted(),
    );
    expect(response.text).not.toContain('roadside');
    expect(response.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(response.header('etag')).toBe((await ops.client.get(HANDOVER(body.id))).header('etag'));

    // Nothing moved: the run and its stops are the rows they were, and the assigned rider still holds the custody.
    expect(await manifestRowOf(arranged.manifest.id)).toEqual(runBefore);
    expect(await stopRowsOf(arranged.manifest.id)).toEqual(stopsBefore);
    expect(await holderOf(arranged.manifest.id)).toBe(arranged.rider.id);
    const rows = await handoverRows(arranged.manifest.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: 'PENDING',
      initiated_by: ops.identity.id,
      initiation_note: 'The rider broke down at the roadside',
    });
  });

  it('opens a pending handover to the hub, the run’s own', async () => {
    const arranged = await run({ stops: 2 });
    const response = await open(ops, arranged.manifest.id, {
      to_hub_id: HUB_A,
      note: 'Unsafe to hand over at the roadside',
    });
    expect(response.status).toBe(200);
    expect(handoverOf(response)).toMatchObject({
      to_rider_id: null,
      to_hub_id: HUB_A,
      state: 'PENDING',
    });
  });

  // Break caught: an opening not recorded as an enhanced chain-of-custody event, recorded in another name, or one that keeps a note the ledger
  // cannot hold.
  it('records one enhanced event by the officer, with the parties and the note', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const body = handoverOf(await open(ops, arranged.manifest.id, toRider(second)));
    const written = await events('fleet.custody.initiated', body.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_type: 'STAFF',
      actor_id: ops.identity.id,
      resulting_state: 'PENDING',
      note: 'The rider broke down at the roadside',
      related_ids: {
        pickup_manifest_id: arranged.manifest.id,
        from_rider_id: arranged.rider.id,
        to_rider_id: second.id,
      },
      responsible_hub_id: HUB_A,
      enhanced: true,
    });
  });
});

describe('initiateRunCustodyHandover: what is refused', () => {
  // Break caught: a request that names both destinations, neither, a hub that is not the run's, or a note that is blank or that the ledger could
  // not keep, each of which would give a handover that cannot be told where custody goes or why.
  it('refuses both destinations, neither, another hub, a blank note and an unkeepable one, writing nothing', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const refused: [string, Record<string, unknown>, number, string][] = [
      ['both', { to_rider_id: second.id, to_hub_id: HUB_A, note: 'x' }, 400, 'VALIDATION_FAILED'],
      ['neither', { note: 'No one' }, 400, 'VALIDATION_FAILED'],
      ['another hub', { to_hub_id: HUB_B, note: 'x' }, 400, 'VALIDATION_FAILED'],
      ['a blank note', { to_rider_id: second.id, note: '   ' }, 422, 'REASON_REQUIRED'],
      [
        'a note with a number in it',
        { to_rider_id: second.id, note: 'Call +233201234567 for the parcels' },
        400,
        'VALIDATION_FAILED',
      ],
      [
        'an extra member',
        { to_rider_id: second.id, note: 'x', from_rider_id: second.id },
        400,
        'VALIDATION_FAILED',
      ],
      ['no note member', { to_rider_id: second.id }, 400, 'VALIDATION_FAILED'],
      [
        'a destination that is not an id',
        { to_rider_id: 'not-a-uuid', note: 'x' },
        400,
        'VALIDATION_FAILED',
      ],
    ];
    for (const [what, body, status, code] of refused) {
      expect(outcome(await open(ops, arranged.manifest.id, body)), what).toEqual([status, code]);
    }
    expect(await handoverRows(arranged.manifest.id)).toEqual([]);
  });

  // Break caught: a destination that can be the one who holds the custody, a rider who is not active, one of another hub, or one that does not
  // exist told apart from the others (which would say which riders exist).
  it('answers a destination that cannot take the custody in one way, whatever the reason', async () => {
    const arranged = await run({ stops: 2 });
    const otherHub = await insertRider(routes.admin, riderRow({ hubId: HUB_B }));
    const suspended = await insertRider(
      routes.admin,
      riderRow({ hubId: HUB_A, status: 'SUSPENDED' }),
    );
    const answers: TestResponse[] = [];
    for (const id of [arranged.rider.id, otherHub.id, suspended.id, randomUUID()]) {
      const answer = await open(ops, arranged.manifest.id, { to_rider_id: id, note: 'x' });
      expect(outcome(answer), id).toEqual([422, 'RIDER_UNAVAILABLE']);
      answers.push(answer);
    }
    const [first, ...rest] = answers.map(shapeOf);
    for (const each of rest) expect(each).toEqual(first);
    expect(await handoverRows(arranged.manifest.id)).toEqual([]);
  });

  // Break caught: a handover opened on a run that is not in progress, or on a token the officer did not read.
  it('refuses a run that is not in progress and a token that is not the run’s current one', async () => {
    const second = await arrangedRider(routes.kit, routes.admin);
    for (const state of ['DRAFT', 'DISPATCHED', 'COMPLETED'] as const) {
      const arranged = await run({
        state,
        stops: 1,
        stopState: state === 'COMPLETED' ? 'SKIPPED' : 'PENDING',
      });
      expect(outcome(await open(ops, arranged.manifest.id, toRider(second))), state).toEqual([
        409,
        'STATE_CONFLICT',
      ]);
    }
    const arranged = await run({ stops: 2 });
    const stale = await manifestEtag(ops, arranged.manifest.id);
    const arrived = await arranged.rider.client.post(
      `${STOP(arranged.stops[0]?.id ?? '')}/arrive`,
      undefined,
      { headers: { 'Idempotency-Key': randomUUID() } },
    );
    expect(arrived.status).toBe(200);
    expect(
      outcome(await open(ops, arranged.manifest.id, toRider(second), { etag: stale })),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect(
      outcome(await open(ops, arranged.manifest.id, toRider(second), { etag: '"x"' })),
    ).toEqual([409, 'STATE_CONFLICT']);
    expect(await handoverRows(arranged.manifest.id)).toEqual([]);
    expect((await open(ops, arranged.manifest.id, toRider(second))).status).toBe(200);
  });

  // Break caught: two handovers open on one run (a second request, a double click), which would leave custody with two receivers.
  it('keeps one open handover per run', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const third = await arrangedRider(routes.kit, routes.admin);
    expect((await open(ops, arranged.manifest.id, toRider(second))).status).toBe(200);
    expect(outcome(await open(ops, arranged.manifest.id, toRider(third)))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(await handoverRows(arranged.manifest.id)).toHaveLength(1);
  });

  it('opens exactly one of two handovers opened at the same moment', async () => {
    for (let round = 0; round < 4; round += 1) {
      const arranged = await run({ stops: 2 });
      const second = await arrangedRider(routes.kit, routes.admin);
      const third = await arrangedRider(routes.kit, routes.admin);
      const etag = await manifestEtag(ops, arranged.manifest.id);
      const [a, b] = await Promise.all([
        open(ops, arranged.manifest.id, toRider(second), { etag }),
        open(ops, arranged.manifest.id, toRider(third), { etag }),
      ]);
      expect([a.status, b.status].toSorted(), `round ${String(round)}`).toEqual([200, 409]);
      expect(await handoverRows(arranged.manifest.id)).toHaveLength(1);
    }
  });

  // Break caught: a rider (the one who needs a handover cannot use it), a vendor or a caller without the key that can open one; a run of
  // another hub opened by an officer who cannot see it; an id that is real and one that is not told apart for the rider.
  it('is Ops’s act: others are refused, and a run of another hub is told as outside the hub', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const etag = await manifestEtag(ops, arranged.manifest.id);
    const headers = { 'If-Match': etag };
    expect(
      outcome(
        await arranged.rider.client.post(OPEN(arranged.manifest.id), toRider(second), { headers }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(await browser.post(OPEN(arranged.manifest.id), toRider(second), { headers })),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await noKey.client.post(OPEN(arranged.manifest.id), toRider(second), {
          origin: OPS,
          headers,
        }),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(
      outcome(
        await routes.kit.client
          .fork()
          .post(OPEN(arranged.manifest.id), toRider(second), { origin: OPS, headers }),
      ),
    ).toEqual([401, 'SESSION_INVALID']);
    expect(outcome(await open(opsB, arranged.manifest.id, toRider(second)))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await open(ops, randomUUID(), toRider(second), { etag: '"x"' }))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(await handoverRows(arranged.manifest.id)).toEqual([]);
  });
});

describe('acceptRunCustodyHandover: custody changes hands only here', () => {
  // Break caught: an acceptance that does not make the receiver the holder, that rewrites the run's rider or a stop's attribution, that seeds a
  // count anywhere, or that leaves no enhanced chain-of-custody event in the receiver's name.
  it('makes the receiver the holder, keeps the run’s rider and the worked stops, and records the count only on the handover', async () => {
    const arranged = await run({ stops: 3, stopStates: ['COLLECTED', 'PENDING', 'PENDING'] });
    const second = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    const runBefore = await manifestRowOf(arranged.manifest.id);
    const stopsBefore = await stopRowsOf(arranged.manifest.id);

    const response = await acceptAsRider(
      second,
      arranged.manifest.id,
      opened.header('etag') ?? '',
      4,
    );
    expect(response.status).toBe(200);
    expect(handoverOf(response)).toMatchObject({
      state: 'COMPLETED',
      parcel_count_taken: 4,
      from_rider_id: arranged.rider.id,
      to_rider_id: second.id,
    });
    expect(handoverOf(response).resolved_at).not.toBeNull();
    expect(response.header('etag')).not.toBe(opened.header('etag'));

    expect(await holderOf(arranged.manifest.id)).toBe(second.id);
    // The run keeps its assigned rider, and not one row of the run or of its stops changed.
    expect(await manifestRowOf(arranged.manifest.id)).toEqual(runBefore);
    expect(await stopRowsOf(arranged.manifest.id)).toEqual(stopsBefore);
    const rows = await handoverRows(arranged.manifest.id);
    expect(rows[0]).toMatchObject({
      state: 'COMPLETED',
      parcel_count_taken: 4,
      accepted_by: second.id,
    });

    const written = await events('fleet.custody.accepted', handoverOf(response).id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: second.id,
      previous_state: 'PENDING',
      resulting_state: 'COMPLETED',
      related_ids: {
        pickup_manifest_id: arranged.manifest.id,
        from_rider_id: arranged.rider.id,
        to_rider_id: second.id,
      },
      enhanced: true,
      surface_context: 'RIDER_ANDROID',
    });
    expect(written[0]?.detail).toMatchObject({ parcel_count_taken: 4, destination: 'RIDER' });
  });

  // Break caught: a rider who is not the named receiver, the sender, a colleague, or a run that does not exist told in different ways, which would
  // say whose custody a handover is.
  it('answers a rider who is not the receiver, the sender and a run that does not exist in one way', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const colleague = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    const etag = opened.header('etag') ?? '';

    const answers = [
      await acceptAsRider(colleague, arranged.manifest.id, etag),
      await acceptAsRider(arranged.rider, arranged.manifest.id, etag),
      await acceptAsRider(colleague, randomUUID(), etag),
    ];
    for (const answer of answers) expect(outcome(answer)).toEqual([422, 'NOT_ASSIGNED_RIDER']);
    const [first, ...rest] = answers.map(shapeOf);
    for (const each of rest) expect(each).toEqual(first);
    expect((await handoverRows(arranged.manifest.id))[0]?.state).toBe('PENDING');
    expect(await holderOf(arranged.manifest.id)).toBe(arranged.rider.id);
  });

  // Break caught: Ops accepting a handover to a rider (the receiver's act), a rider accepting the hub's, or Ops not able to accept the hub's.
  it('lets Ops accept only a handover to the hub, and the receiving rider only a handover to it', async () => {
    const toRiderRun = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const riderHandover = await open(ops, toRiderRun.manifest.id, toRider(second));
    expect(
      outcome(await acceptAsOps(ops, toRiderRun.manifest.id, riderHandover.header('etag') ?? '')),
    ).toEqual([403, 'PERMISSION_DENIED']);

    const toHubRun = await run({ stops: 2 });
    const hubHandover = await open(ops, toHubRun.manifest.id, {
      to_hub_id: HUB_A,
      note: 'Unsafe to hand over at the roadside',
    });
    const etag = hubHandover.header('etag') ?? '';
    expect(outcome(await acceptAsRider(second, toHubRun.manifest.id, etag))).toEqual([
      422,
      'NOT_ASSIGNED_RIDER',
    ]);
    expect(outcome(await acceptAsRider(toHubRun.rider, toHubRun.manifest.id, etag))).toEqual([
      422,
      'NOT_ASSIGNED_RIDER',
    ]);
    const accepted = await acceptAsOps(ops, toHubRun.manifest.id, etag, 7);
    expect(accepted.status).toBe(200);
    expect(handoverOf(accepted)).toMatchObject({ state: 'COMPLETED', parcel_count_taken: 7 });
    // The hub holds the custody now: no rider does, and nobody can hand it on to a rider.
    expect(await holderOf(toHubRun.manifest.id)).toBeNull();
    expect((await handoverRows(toHubRun.manifest.id))[0]?.accepted_by).toBe(ops.identity.id);
    expect(outcome(await open(ops, toHubRun.manifest.id, toRider(second)))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
  });

  // Break caught: an acceptance on a token the receiver did not read, a retry that accepts twice, a key reused for another request, or an
  // acceptance when nothing is pending.
  it('takes the handover’s token, replays a retry, and refuses a second acceptance', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    const etag = opened.header('etag') ?? '';

    expect(outcome(await acceptAsRider(second, arranged.manifest.id, '"stale"'))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(
      outcome(
        await second.client.post(
          ACCEPT(arranged.manifest.id),
          { parcel_count_taken: 1 },
          { headers: { 'Idempotency-Key': randomUUID() } },
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED']);
    for (const count of [-1, 1.5, '3', null]) {
      expect(
        outcome(
          await second.client.post(
            ACCEPT(arranged.manifest.id),
            { parcel_count_taken: count },
            { headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
          ),
        ),
        String(count),
      ).toEqual([400, 'VALIDATION_FAILED']);
    }

    const key = randomUUID();
    const first = await acceptAsRider(second, arranged.manifest.id, etag, 3, key);
    expect(first.status).toBe(200);
    const again = await acceptAsRider(second, arranged.manifest.id, etag, 3, key);
    expect(again.status).toBe(200);
    expect(again.text).toBe(first.text);
    expect(await events('fleet.custody.accepted', handoverOf(first).id)).toHaveLength(1);
    expect(outcome(await acceptAsRider(second, arranged.manifest.id, etag, 9, key))).toEqual([
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);
    // Another key, nothing pending now: the receiver is told it is not a custody to it (the rider reads no more than its handovers), Ops is told
    // plainly.
    expect(outcome(await acceptAsRider(second, arranged.manifest.id, etag))).toEqual([
      422,
      'NOT_ASSIGNED_RIDER',
    ]);
    const hubRun = await run({ stops: 2 });
    expect(outcome(await acceptAsOps(ops, hubRun.manifest.id, '"x"'))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect((await handoverRows(arranged.manifest.id))[0]?.parcel_count_taken).toBe(3);
  });

  // Break caught (the adversarial review of 2 November 2026): a count the column cannot hold answered with a 500, which turns a client's mistake
  // into a server failure and leaves the key to be reused. The largest count is the column's: 2147483647. A larger one, and one JavaScript cannot
  // hold exactly, are the client's error.
  it('takes the largest count the column holds and refuses a larger one as a validation failure', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const etag = (await open(ops, arranged.manifest.id, toRider(second))).header('etag') ?? '';
    for (const count of [2147483648, 9007199254740991, 1e21]) {
      const refused = await acceptAsRider(second, arranged.manifest.id, etag, count);
      expect(outcome(refused), String(count)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await handoverRows(arranged.manifest.id))[0]?.state).toBe('PENDING');
    const taken = await acceptAsRider(second, arranged.manifest.id, etag, 2147483647);
    expect(taken.status).toBe(200);
    expect(handoverOf(taken).parcel_count_taken).toBe(2147483647);
  });

  it('refuses the acceptance of a run of another hub to an officer who cannot see it', async () => {
    const hubB = await run({
      stops: 2,
      hubId: HUB_B,
      vendorOrganizationId: vendorB.row.organizationId,
    });
    expect(outcome(await acceptAsOps(ops, hubB.manifest.id, '"x"'))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await acceptAsOps(ops, randomUUID(), '"x"'))).toEqual([404, 'NOT_FOUND']);
  });

  it('opens a further handover from the receiver, who now holds the custody, and to the rider who first held it', async () => {
    const arranged = await run({ stops: 3, stopStates: ['COLLECTED', 'PENDING', 'PENDING'] });
    const second = await arrangedRider(routes.kit, routes.admin);
    const first = await open(ops, arranged.manifest.id, toRider(second));
    expect(
      (await acceptAsRider(second, arranged.manifest.id, first.header('etag') ?? '')).status,
    ).toBe(200);
    // The sender is no longer the holder: the next handover starts from the receiver, and the first rider may be its destination.
    const again = await open(ops, arranged.manifest.id, toRider(arranged.rider, 'Handing it back'));
    expect(again.status).toBe(200);
    expect(handoverOf(again)).toMatchObject({
      from_rider_id: second.id,
      to_rider_id: arranged.rider.id,
    });
    // And the receiver cannot be named as its own destination.
    expect(
      outcome(await failAsOps(ops, arranged.manifest.id, again.header('etag') ?? '', 'Withdrawn')),
    ).toEqual([200, undefined]);
    expect(outcome(await open(ops, arranged.manifest.id, toRider(second)))).toEqual([
      422,
      'RIDER_UNAVAILABLE',
    ]);
  });
});

describe('failRunCustodyHandover: custody stays where it was', () => {
  // Break caught: a failure that moves custody, stops the run, or cannot be followed by another handover; one with no note; one that Ops did not
  // make; a failure of a handover that is not pending.
  it('leaves the custody and the run as they were, records the note, and lets another handover be opened', async () => {
    const arranged = await run({ stops: 3, stopStates: ['COLLECTED', 'PENDING', 'PENDING'] });
    const second = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    const etag = opened.header('etag') ?? '';
    const runBefore = await manifestRowOf(arranged.manifest.id);

    expect(outcome(await failAsOps(ops, arranged.manifest.id, etag, '   '))).toEqual([
      422,
      'REASON_REQUIRED',
    ]);
    expect(
      outcome(
        await second.client.post(
          FAIL(arranged.manifest.id),
          { note: 'x' },
          { headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
        ),
      ),
    ).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await failAsOps(opsB, arranged.manifest.id, etag))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await failAsOps(ops, arranged.manifest.id, '"stale"'))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);

    const failed = await failAsOps(
      ops,
      arranged.manifest.id,
      etag,
      'The rider named did not arrive',
    );
    expect(failed.status).toBe(200);
    expect(handoverOf(failed)).toMatchObject({ state: 'FAILED', parcel_count_taken: null });
    expect(handoverOf(failed).resolved_at).not.toBeNull();
    expect(await holderOf(arranged.manifest.id)).toBe(arranged.rider.id);
    expect(await manifestRowOf(arranged.manifest.id)).toEqual(runBefore);
    const rows = await handoverRows(arranged.manifest.id);
    expect(rows[0]).toMatchObject({
      state: 'FAILED',
      failed_by: ops.identity.id,
      failure_note: 'The rider named did not arrive',
    });
    const written = await events('fleet.custody.failed', handoverOf(failed).id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      actor_id: ops.identity.id,
      previous_state: 'PENDING',
      resulting_state: 'FAILED',
      note: 'The rider named did not arrive',
      enhanced: false,
    });

    // A failed handover is over: it cannot be failed or accepted again, and a further one may be opened.
    expect(outcome(await failAsOps(ops, arranged.manifest.id, etag))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(outcome(await acceptAsRider(second, arranged.manifest.id, etag))).toEqual([
      422,
      'NOT_ASSIGNED_RIDER',
    ]);
    expect((await open(ops, arranged.manifest.id, toRider(second))).status).toBe(200);
  });

  it('replays a retry of the failure and refuses its key for another request', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const etag = (await open(ops, arranged.manifest.id, toRider(second))).header('etag') ?? '';
    const key = randomUUID();
    const first = await failAsOps(ops, arranged.manifest.id, etag, 'Did not arrive', key);
    const again = await failAsOps(ops, arranged.manifest.id, etag, 'Did not arrive', key);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.text).toBe(first.text);
    expect(await events('fleet.custody.failed', handoverOf(first).id)).toHaveLength(1);
    expect(outcome(await failAsOps(ops, arranged.manifest.id, etag, 'Another note', key))).toEqual([
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
    ]);
  });
});

describe('a stranded run is closed by whoever took the parcels (AC-SLICE-001-67)', () => {
  // Break caught: the whole flow of the criterion not working end to end: Ops skipping the rest after the transfer (and only Ops), the first
  // rider kept as the one who worked the earlier stops, and the sender no longer the holder.
  it('lets Ops skip the remaining stops after the transfer, refuses the receiver the skip, and keeps the stops worked before with their rider', async () => {
    const arranged = await run({ stops: 3, stopStates: ['COLLECTED', 'PENDING', 'PENDING'] });
    const second = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    expect(
      (await acceptAsRider(second, arranged.manifest.id, opened.header('etag') ?? '', 5)).status,
    ).toBe(200);

    const worked = arranged.stops[0];
    const workedBefore = (await stopRowsOf(arranged.manifest.id)).find(
      (row) => (row as { id: string }).id === worked?.id,
    );
    // The receiver cannot skip (AC-74): a skip is Ops's act.
    const rest = arranged.stops.slice(1);
    const receiverTry = await second.client.post(
      `${STOP(rest[0]?.id ?? '')}/skip`,
      { reason_code: 'RUN_CUT_SHORT' },
      { headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() } },
    );
    expect(outcome(receiverTry)).toEqual([403, 'PERMISSION_DENIED']);
    for (const stop of rest) expect((await skipAsOps(ops, stop.id)).status).toBe(200);

    // Something was collected, so the hub handover (a later task) is the completion; the system does not close the run, and it is still the
    // assigned rider's run on record, the receiver holding its custody.
    const row = (await manifestRowOf(arranged.manifest.id)) as {
      state: string;
      assigned_rider_id: string;
    };
    expect(row.state).toBe('IN_PROGRESS');
    expect(row.assigned_rider_id).toBe(arranged.rider.id);
    expect(await holderOf(arranged.manifest.id)).toBe(second.id);
    expect(
      (await stopRowsOf(arranged.manifest.id)).find(
        (each) => (each as { id: string }).id === worked?.id,
      ),
    ).toEqual(workedBefore);
  });
});

describe('a handover that resolves can complete a run with nothing collected (AC-SLICE-001-78)', () => {
  // Break caught: a run closed while a handover is pending (a closed run with an open custody record), or left in progress for ever when the
  // handover resolves, whichever way it resolves and whoever resolves it: the completion in the receiving rider's own transaction in particular.
  it('keeps the run in progress while a handover is pending, and completes it by System when the receiver accepts', async () => {
    const arranged = await run({ stops: 1, stopStates: ['PENDING'] });
    const second = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    expect((await skipAsOps(ops, arranged.stops[0]?.id ?? '')).status).toBe(200);
    // Every stop is terminal and none collected, but the handover stands: the run is not completed.
    expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state).toBe(
      'IN_PROGRESS',
    );

    const accepted = await acceptAsRider(second, arranged.manifest.id, opened.header('etag') ?? '');
    expect(accepted.status).toBe(200);
    const row = (await manifestRowOf(arranged.manifest.id)) as {
      state: string;
      completed_at: Date | null;
    };
    expect(row.state).toBe('COMPLETED');
    expect(row.completed_at).toBeInstanceOf(Date);
    const completions = await events('pickup.manifest.completed', arranged.manifest.id);
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: second.id,
      detail: { completed_by: 'SYSTEM', cause: 'CUSTODY_HANDOVER_RESOLVED' },
      related_ids: { rider_id: arranged.rider.id },
    });
  });

  it('completes the run when Ops fails the pending handover', async () => {
    const arranged = await run({ stops: 1 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    expect((await skipAsOps(ops, arranged.stops[0]?.id ?? '')).status).toBe(200);
    expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state).toBe(
      'IN_PROGRESS',
    );
    expect((await failAsOps(ops, arranged.manifest.id, opened.header('etag') ?? '')).status).toBe(
      200,
    );
    expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state).toBe(
      'COMPLETED',
    );
    const completions = await events('pickup.manifest.completed', arranged.manifest.id);
    expect(completions[0]).toMatchObject({
      actor_id: ops.identity.id,
      detail: { completed_by: 'SYSTEM', cause: 'CUSTODY_HANDOVER_RESOLVED' },
    });
  });

  it('completes the run when Ops accepts a pending handover to the hub', async () => {
    const arranged = await run({ stops: 1 });
    const opened = await open(ops, arranged.manifest.id, {
      to_hub_id: HUB_A,
      note: 'Unsafe roadside',
    });
    expect((await skipAsOps(ops, arranged.stops[0]?.id ?? '')).status).toBe(200);
    expect((await acceptAsOps(ops, arranged.manifest.id, opened.header('etag') ?? '')).status).toBe(
      200,
    );
    expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state).toBe(
      'COMPLETED',
    );
  });

  // Break caught: a resolution that completes a run with something collected, or with a stop still to be worked.
  it('does not complete a run that collected something, or that has a stop to work', async () => {
    const collected = await run({ stops: 2, stopStates: ['COLLECTED', 'PENDING'] });
    const second = await arrangedRider(routes.kit, routes.admin);
    const first = await open(ops, collected.manifest.id, toRider(second));
    expect((await skipAsOps(ops, collected.stops[1]?.id ?? '')).status).toBe(200);
    expect(
      (await acceptAsRider(second, collected.manifest.id, first.header('etag') ?? '')).status,
    ).toBe(200);
    expect(((await manifestRowOf(collected.manifest.id)) as { state: string }).state).toBe(
      'IN_PROGRESS',
    );

    const open2 = await run({ stops: 2, stopStates: ['SKIPPED', 'PENDING'] });
    const third = await arrangedRider(routes.kit, routes.admin);
    const other = await open(ops, open2.manifest.id, toRider(third));
    expect((await acceptAsRider(third, open2.manifest.id, other.header('etag') ?? '')).status).toBe(
      200,
    );
    expect(((await manifestRowOf(open2.manifest.id)) as { state: string }).state).toBe(
      'IN_PROGRESS',
    );
  });

  // Break caught: a skip and a handover's resolution, in either order and at the same moment, leaving the run stranded in progress, completed
  // twice, completed with a handover pending, or a deadlock.
  it('ends a skip of the last stop against the resolution of the pending handover as one serial order would', async () => {
    for (let round = 0; round < 6; round += 1) {
      const arranged = await run({ stops: 1 });
      const second = await arrangedRider(routes.kit, routes.admin);
      const opened = await open(ops, arranged.manifest.id, toRider(second));
      const etag = opened.header('etag') ?? '';
      const [skipped, accepted] = await Promise.all([
        skipAsOps(ops, arranged.stops[0]?.id ?? ''),
        acceptAsRider(second, arranged.manifest.id, etag),
      ]);
      const tag = `round ${String(round)}: skip ${String(skipped.status)}, accept ${String(accepted.status)}`;
      expect(skipped.status, tag).toBe(200);
      expect(accepted.status, tag).toBe(200);
      expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state, tag).toBe(
        'COMPLETED',
      );
      expect(await events('pickup.manifest.completed', arranged.manifest.id), tag).toHaveLength(1);
    }
  });

  it('resolves exactly one of an acceptance and a failure made at the same moment', async () => {
    for (let round = 0; round < 6; round += 1) {
      const arranged = await run({ stops: 2 });
      const second = await arrangedRider(routes.kit, routes.admin);
      const opened = await open(ops, arranged.manifest.id, toRider(second));
      const etag = opened.header('etag') ?? '';
      const [accepted, failed] = await Promise.all([
        acceptAsRider(second, arranged.manifest.id, etag),
        failAsOps(ops, arranged.manifest.id, etag),
      ]);
      const tag = `round ${String(round)}: accept ${String(accepted.status)}, fail ${String(failed.status)}`;
      // Exactly one of them resolved it: the other found it already resolved (the rider is told it is not a custody to it, Ops a conflict).
      expect(
        [accepted.status, failed.status].filter((status) => status === 200),
        tag,
      ).toHaveLength(1);
      const loser = accepted.status === 200 ? failed : accepted;
      // The loser finds the handover resolved: Ops is told it is a conflict (409), the rider that it is no custody to it (422, NOT_ASSIGNED_RIDER).
      expect([409, 422], tag).toContain(loser.status);
      const rows = await handoverRows(arranged.manifest.id);
      expect(rows, tag).toHaveLength(1);
      expect(['COMPLETED', 'FAILED'], tag).toContain(rows[0]?.state);
      expect((accepted.status === 200) === (rows[0]?.state === 'COMPLETED'), tag).toBe(true);
      expect((failed.status === 200) === (rows[0]?.state === 'FAILED'), tag).toBe(true);
    }
  });
});

describe('the reads of custody handovers: by party, with the hub axis told', () => {
  // Break caught: a rider who reads a handover it is not a party to, or a staff reader of another hub; a list that is not by party; a filter that
  // widens; a list that does not page, or pages in the wrong order.
  it('lists a rider the handovers it is a party to, and staff those of their hubs, newest first', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const stranger = await arrangedRider(routes.kit, routes.admin);
    const first = handoverOf(await open(ops, arranged.manifest.id, toRider(second)));
    expect(
      (
        await failAsOps(
          ops,
          arranged.manifest.id,
          (await ops.client.get(HANDOVER(first.id))).header('etag') ?? '',
        )
      ).status,
    ).toBe(200);
    const newer = handoverOf(await open(ops, arranged.manifest.id, toRider(second, 'Again')));
    const hubB = await run({
      stops: 1,
      hubId: HUB_B,
      vendorOrganizationId: vendorB.row.organizationId,
    });
    const other = handoverOf(
      await open(opsB, hubB.manifest.id, { to_hub_id: HUB_B, note: 'Roadside' }),
    );

    const idsOf = (response: TestResponse): string[] =>
      (response.json() as Page).items.map((each) => each.id);
    // The receiver and the sender see both of this run's handovers, newest first; the stranger sees none; Ops of hub A sees hub A's only.
    expect(idsOf(await second.client.get(HANDOVERS))).toEqual([newer.id, first.id]);
    expect(idsOf(await arranged.rider.client.get(HANDOVERS))).toEqual([newer.id, first.id]);
    expect(idsOf(await stranger.client.get(HANDOVERS))).toEqual([]);
    const hubA = idsOf(await ops.client.get(HANDOVERS));
    expect(hubA).toEqual(expect.arrayContaining([newer.id, first.id]));
    expect(hubA).not.toContain(other.id);
    expect(idsOf(await opsB.client.get(HANDOVERS))).toContain(other.id);
    // The filters narrow and widen nothing.
    expect(
      idsOf(await ops.client.get(`${HANDOVERS}?manifest_id=${arranged.manifest.id}&state=PENDING`)),
    ).toEqual([newer.id]);
    expect(idsOf(await ops.client.get(`${HANDOVERS}?manifest_id=${hubB.manifest.id}`))).toEqual([]);
    expect(idsOf(await second.client.get(`${HANDOVERS}?manifest_id=${hubB.manifest.id}`))).toEqual(
      [],
    );
    // Paged: one at a time, the same order, and the last page has no token.
    const page1 = (await second.client.get(`${HANDOVERS}?page_size=1`)).json() as Page;
    expect(page1.items.map((each) => each.id)).toEqual([newer.id]);
    expect(page1.next_page_token).not.toBeNull();
    const page2 = (
      await second.client.get(
        `${HANDOVERS}?page_size=1&page_token=${encodeURIComponent(page1.next_page_token ?? '')}`,
      )
    ).json() as Page;
    expect(page2.items.map((each) => each.id)).toEqual([first.id]);
    expect(page2.next_page_token).toBeNull();
  });

  it('refuses a malformed filter, and a vendor, and a caller without the key', async () => {
    for (const query of [
      'state=DONE',
      'manifest_id=nope',
      'page_size=0',
      'page_size=1000',
      'page_token=junk',
      'page_size=x',
    ]) {
      expect(outcome(await ops.client.get(`${HANDOVERS}?${query}`)), query).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(outcome(await browser.get(HANDOVERS))).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await noKey.client.get(HANDOVERS))).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcome(await routes.kit.client.fork().get(HANDOVERS))).toEqual([
      401,
      'SESSION_INVALID',
    ]);
  });

  // Break caught: a token that is not the one an act hands out, or does not move when the handover resolves; a rider told apart a handover it is
  // not a party to from one that does not exist; staff outside the hub not told so; a crossing not recorded.
  it('reads one handover with its token, and tells who may read it', async () => {
    const arranged = await run({ stops: 2 });
    const second = await arrangedRider(routes.kit, routes.admin);
    const stranger = await arrangedRider(routes.kit, routes.admin);
    const opened = await open(ops, arranged.manifest.id, toRider(second));
    const id = handoverOf(opened).id;

    const read = await ops.client.get(HANDOVER(id));
    expect(read.status).toBe(200);
    expect(read.json()).toEqual(opened.json());
    expect(read.header('etag')).toBe(opened.header('etag'));
    expect((await second.client.get(HANDOVER(id))).status).toBe(200);
    expect((await arranged.rider.client.get(HANDOVER(id))).status).toBe(200);
    expect((await second.client.get(HANDOVER(id))).header('etag')).toBe(opened.header('etag'));

    const nothing = shapeOf(await stranger.client.get(HANDOVER(randomUUID())));
    expect(nothing.status).toBe(404);
    expect(shapeOf(await stranger.client.get(HANDOVER(id)))).toEqual(nothing);
    expect(outcome(await opsB.client.get(HANDOVER(id)))).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcome(await ops.client.get(HANDOVER(randomUUID())))).toEqual([404, 'NOT_FOUND']);
    expect(outcome(await ops.client.get(HANDOVER('not-a-uuid')))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(outcome(await browser.get(HANDOVER(id)))).toEqual([403, 'PERMISSION_DENIED']);

    // The token moves when the handover resolves.
    expect(
      (await acceptAsRider(second, arranged.manifest.id, opened.header('etag') ?? '')).status,
    ).toBe(200);
    expect((await ops.client.get(HANDOVER(id))).header('etag')).not.toBe(opened.header('etag'));

    // A reader of every hub is recorded crossing into the other: one event naming the hub and no contents.
    const hubB = await run({
      stops: 1,
      hubId: HUB_B,
      vendorOrganizationId: vendorB.row.organizationId,
    });
    const foreign = handoverOf(
      await open(opsB, hubB.manifest.id, { to_hub_id: HUB_B, note: 'Roadside' }),
    );
    expect((await wide.client.get(HANDOVER(foreign.id))).status).toBe(200);
    const crossings = await routes.rows<{
      object_type: string;
      object_id: string;
      responsible_hub_id: string;
    }>(
      `select object_type, object_id, responsible_hub_id from audit_event
        where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 and object_id = $2`,
      [wide.identity.id, foreign.id],
    );
    expect(crossings).toEqual([
      { object_type: 'RunCustodyHandover', object_id: foreign.id, responsible_hub_id: HUB_B },
    ]);
    expect((await wide.client.get(HANDOVER(id))).status).toBe(200);
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 and object_id = $2`,
        [wide.identity.id, id],
      ),
    ).toEqual([]);
  });
});

describe('a custody act and the run port it uses are one transaction (F-32: a port opens none)', () => {
  const runAccess = (): RunAccess =>
    routes.kit.app.app.get<RunAccess>(RUN_ACCESS, { strict: false });
  const ledger = (): AuditWriter =>
    routes.kit.app.app.get<AuditWriter>(AUDIT_WRITER, { strict: false });

  /** A run whose only stop has been skipped and to the hub of which a handover stands, so that its resolution completes the run. */
  async function settledByResolution(): Promise<{
    readonly arranged: ArrangedRun;
    readonly etag: string;
  }> {
    const arranged = await run({ stops: 1 });
    const opened = await open(ops, arranged.manifest.id, {
      to_hub_id: HUB_A,
      note: 'Unsafe roadside',
    });
    expect(opened.status).toBe(200);
    expect((await skipAsOps(ops, arranged.stops[0]?.id ?? '')).status).toBe(200);
    return { arranged, etag: opened.header('etag') ?? '' };
  }

  // Break caught: a port called outside the act's transaction (on a connection of its own, or after the commit), which would turn the work of one act
  // into separate calls: the completion could then commit while the resolution that caused it was rolled back, or the reverse.
  it('hands the port the transaction of the act, the same one for every call and the same as the act’s own ledger writes', async () => {
    const { arranged, etag } = await settledByResolution();
    const access = runAccess();
    const peek = vi.spyOn(access, 'peek');
    const lock = vi.spyOn(access, 'lock');
    const complete = vi.spyOn(access, 'completeIfSettled');
    const written = vi.spyOn(ledger(), 'write');
    try {
      expect((await acceptAsOps(ops, arranged.manifest.id, etag)).status).toBe(200);
      expect(peek).toHaveBeenCalledTimes(1);
      expect(lock).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0]?.[2]).toBe('CUSTODY_HANDOVER_RESOLVED');
      // The act's own ledger write of the acceptance is the first the writer was given.
      const handles = [peek, lock, complete, written].map((spy) => spy.mock.calls[0]?.[0]);
      expect(handles[0]).toBeDefined();
      expect(new Set(handles).size).toBe(1);
    } finally {
      for (const spy of [peek, lock, complete, written]) spy.mockRestore();
    }
    expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state).toBe(
      'COMPLETED',
    );
  });

  // Break caught: the completion's failure leaving the resolution behind (a handover accepted for a run that was not completed and that nothing now
  // would complete), or the idempotency key kept by an act that did not happen.
  it.each([['accept'], ['fail']])(
    'takes the %s back whole when the completion through the port fails, and lets the same request be sent again',
    async (kind) => {
      const { arranged, etag } = await settledByResolution();
      const key = randomUUID();
      const send = (): Promise<TestResponse> =>
        kind === 'accept'
          ? acceptAsOps(ops, arranged.manifest.id, etag, 4, key)
          : failAsOps(ops, arranged.manifest.id, etag, 'The named receiver did not arrive', key);
      const failing = vi
        .spyOn(runAccess(), 'completeIfSettled')
        .mockRejectedValueOnce(new Error('the port failed'));
      try {
        expect((await send()).status).toBeGreaterThanOrEqual(500);
        expect(failing).toHaveBeenCalledTimes(1);
      } finally {
        failing.mockRestore();
      }

      // Nothing of the act is kept: the handover is pending as it was, the run is in progress, no event of the resolution was written.
      expect((await handoverRows(arranged.manifest.id)).map((row) => row.state)).toEqual([
        'PENDING',
      ]);
      expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state).toBe(
        'IN_PROGRESS',
      );
      const resolved = kind === 'accept' ? 'fleet.custody.accepted' : 'fleet.custody.failed';
      const handoverId = (await handoverRows(arranged.manifest.id))[0]?.id ?? '';
      expect(await events(resolved, handoverId)).toEqual([]);
      expect(await events('pickup.manifest.completed', arranged.manifest.id)).toEqual([]);

      // The key was not spent by an act that did not happen: the same request, sent again, is the act.
      expect((await send()).status).toBe(200);
      expect((await handoverRows(arranged.manifest.id)).map((row) => row.state)).toEqual([
        kind === 'accept' ? 'COMPLETED' : 'FAILED',
      ]);
      expect(((await manifestRowOf(arranged.manifest.id)) as { state: string }).state).toBe(
        'COMPLETED',
      );
    },
  );

  // Break caught: a failure to lock and version the run, inside the opening, leaving a handover for a run that was never held.
  it('opens nothing when the port cannot lock the run for the opening', async () => {
    const arranged = await run({ stops: 1 });
    const etag = await manifestEtag(ops, arranged.manifest.id);
    const failing = vi
      .spyOn(runAccess(), 'lockWithVersion')
      .mockRejectedValueOnce(new Error('the port failed'));
    try {
      const refused = await open(
        ops,
        arranged.manifest.id,
        { to_hub_id: HUB_A, note: 'Unsafe roadside' },
        { etag },
      );
      expect(refused.status).toBeGreaterThanOrEqual(500);
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      failing.mockRestore();
    }
    expect(await handoverRows(arranged.manifest.id)).toEqual([]);
    expect(
      (
        await open(
          ops,
          arranged.manifest.id,
          { to_hub_id: HUB_A, note: 'Unsafe roadside' },
          { etag },
        )
      ).status,
    ).toBe(200);
  });
});
