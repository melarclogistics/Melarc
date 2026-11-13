import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { excusePhotos } from './support/evidence-photo.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import type { StopState } from './support/manifests.js';
import { arrangeRun, arrangedRider, type ArrangedRider, type ArrangedRun } from './support/runs.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.31, the hub handover (`submitHubHandover`, `hub.handover.submit`; `AC-SLICE-001-17`, `-18` (the server half), `-39`, `-44`, `-45`, `-75`, `-76` (its first half) and
 * `-78`; features/hub/hub-intake.md section 5.1; state-machines.md sections 4 and 7; domain-model.md section 6.6). Against a real PostgreSQL and the real application, each claim:
 *
 * - **The handover is the run's completion, one intake for each collected request**: the rows are exactly the run's collected requests, each once, and each opens one intake at
 *   `AWAITING_COUNT`; the run moves `IN_PROGRESS` to `COMPLETED` in the same transaction; nothing is counted or received.
 * - **The declaration is the rider's own number**: stored as given (a zero is legal, a count above the collected one is kept), never taken from the collected count, and each
 *   correction of the pre-fill is recorded; the answer, the events and the columns the application can read never carry it.
 * - **The device's moment and the server's receipt are kept apart**, whatever the device's clock says.
 * - **A retry is not a second handover**: the same key replays the answer and opens one set; the same key with other rows is `IDEMPOTENCY_KEY_CONFLICT`.
 * - **Who and when**: the custody holder only (the assigned rider, or whoever accepted a custody handover); every stop terminal; a run in progress.
 */
const MANIFEST = (id: string) => `${API}/pickup-manifests/${id}`;
const HANDOVER = (id: string) => `${MANIFEST(id)}/hub-handover`;
const OPEN = (id: string) => `${MANIFEST(id)}/custody-handover`;
const ACCEPT = (id: string) => `${OPEN(id)}/accept`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let ops: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

// The authenticated API allows 120 calls a minute to a session: each test has an officer of its own.
beforeEach(async () => {
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
});

interface Leg {
  readonly state: StopState;
  /** What the rider counted at the door: the collection record of a stop that was collected or partly collected. */
  readonly collected?: number;
}
interface Handed extends ArrangedRun {
  /** What each stop's request was counted at (by request), where it was counted. */
  readonly counted: ReadonlyMap<string, number>;
}
interface Intake {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly hub_id: string;
  readonly pickup_request_id: string;
  readonly pickup_manifest_id: string;
  readonly handed_over_by: string;
  readonly handed_over_at: string;
  readonly declaration_captured_at: string;
  readonly active_receiver_id: string | null;
  readonly lock_acquired_at: string | null;
  readonly count_phase: string;
}
interface Row {
  readonly pickup_request_id: string;
  readonly declared_count: number;
}

const isCounted = (state: StopState): boolean =>
  state === 'COLLECTED' || state === 'PARTIALLY_COLLECTED';

/**
 * A run in progress of the day whose stops are in the states given. A stop that was collected or partly collected is arranged as one that has been counted (the collection
 * record the rider made, with its count) and then closed, as a handshake closes one; the other states are arranged as they are.
 */
async function handedRun(
  legs: readonly Leg[],
  over: Partial<Parameters<typeof arrangeRun>[2]> = {},
): Promise<Handed> {
  const arranged = await arrangeRun(routes.kit, routes.admin, {
    vendorOrganizationId: vendor.row.organizationId,
    serviceDate: days.today,
    state: 'IN_PROGRESS',
    stops: legs.length,
    stopStates: legs.map((leg) => (isCounted(leg.state) ? 'ARRIVED' : leg.state)),
    ...over,
  });
  const counted = new Map<string, number>();
  for (const [at, leg] of legs.entries()) {
    const stop = arranged.stops[at];
    if (stop === undefined || !isCounted(leg.state)) continue;
    const collected = leg.collected ?? 3;
    counted.set(stop.requestId, collected);
    await excusePhotos(routes, stop.id);
    await routes.admin.query(
      `insert into collection_record (id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot, handshake_type, recorded_by)
       values ($1, $2, $3, 3, $4, $5, $6::jsonb, 'VENDOR_ENTERED_RIDER_DISPLAYED', $7)`,
      [
        randomUUID(),
        stop.id,
        HUB_A,
        collected,
        collected < 3 ? 'SHORT' : 'MATCH',
        collected < 3
          ? JSON.stringify({
              reason_code: 'SOME_PARCELS_NOT_READY',
              label: 'Some parcels not ready',
              attribution: 'CUSTOMER',
            })
          : null,
        arranged.rider.id,
      ],
    );
    await routes.admin.query(
      `update pickup_stop set state = $2, resolved_at = now() where id = $1`,
      [stop.id, leg.state],
    );
  }
  return { ...arranged, counted };
}

/** The run's collected requests, in the order of its stops, each declared at what it was counted at unless the test says another number. */
const rowsFor = (handed: Handed, declared: readonly (number | undefined)[] = []): Row[] =>
  handed.stops
    .filter((stop) => handed.counted.has(stop.requestId))
    .map((stop, at) => ({
      pickup_request_id: stop.requestId,
      declared_count: declared[at] ?? handed.counted.get(stop.requestId) ?? 0,
    }));

const manifestEtag = async (id: string): Promise<string> =>
  (await ops.client.get(MANIFEST(id))).header('etag') ?? '';

/**
 * The token of the run as **the rider** reads it: the representation of a stop differs by reader (a skip's note is staff's own), so a run with a stop that was skipped has another token
 * for Ops than for the rider, and the handover is compared with the rider's. The receiver of a custody handover reads no run (no read operation is its, finding of S1.31), so the token of
 * the run as Ops reads it stands in for what its handset would have kept, which is the same where no stop was skipped.
 */
const riderEtag = async (rider: ArrangedRider, id: string): Promise<string> => {
  const read = await rider.client.get(MANIFEST(id));
  return read.status === 200 ? (read.header('etag') ?? '') : manifestEtag(id);
};

const capturedNow = (): string => new Date(Date.now() - 60_000).toISOString();

/** The custody holder submits the handover, on the run's token as it is now unless the test says otherwise. */
async function submit(
  rider: ArrangedRider,
  runId: string,
  body: Record<string, unknown>,
  over: { etag?: string; key?: string | null } = {},
): Promise<TestResponse> {
  const etag = over.etag ?? (await riderEtag(rider, runId));
  return rider.client.post(HANDOVER(runId), body, {
    headers: {
      'If-Match': etag,
      ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
    },
  });
}

const intakesOf = (response: TestResponse): Intake[] => response.json() as Intake[];

const intakeRows = (manifestId: string) =>
  routes.rows<{
    id: string;
    code: string;
    responsible_hub_id: string;
    pickup_request_id: string;
    pickup_manifest_id: string;
    handed_over_by: string;
    handed_over_at: Date;
    declaration_captured_at: Date;
    state: string;
    rider_declared_count: number;
    prefilled_count: number;
    physical_count: number | null;
    counted_at: Date | null;
    counted_by: string | null;
    count_variance: string | null;
    active_receiver_id: string | null;
    version: number;
  }>(`select * from pickup_intake where pickup_manifest_id = $1 order by id`, [manifestId]);

const manifestOf = (id: string) =>
  routes
    .rows<{ state: string; completed_at: Date | null; version: number }>(
      `select state, completed_at, version from pickup_manifest where id = $1`,
      [id],
    )
    .then((rows) => rows[0]);

const events = (code: string, objectId: string) =>
  routes.rows<{
    actor_type: string;
    actor_id: string | null;
    surface_context: string;
    object_type: string;
    previous_state: string | null;
    resulting_state: string | null;
    note: string | null;
    related_ids: Record<string, unknown> | null;
    detail: Record<string, unknown> | null;
    responsible_hub_id: string | null;
    enhanced: boolean;
    outcome: string;
  }>(
    `select actor_type, actor_id, surface_context, object_type, previous_state, resulting_state, note, related_ids, detail, responsible_hub_id, enhanced, outcome
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

/** What a refusal says: the status, the code and the violations it names. */
const refusalOf = (response: TestResponse) => ({
  status: response.status,
  code: codeOf(response),
  details: (response.json() as { details?: { violations?: Record<string, unknown>[] } }).details,
});

/** Custody of the run moves from its assigned rider to another, as the two routes of S1.24 do it. */
async function custodyMovesTo(arranged: ArrangedRun, receiver: ArrangedRider): Promise<void> {
  const opened = await ops.client.post(
    OPEN(arranged.manifest.id),
    { to_rider_id: receiver.id, note: 'The rider broke down at the roadside' },
    { origin: OPS, headers: { 'If-Match': await manifestEtag(arranged.manifest.id) } },
  );
  expect(opened.status).toBe(200);
  const accepted = await receiver.client.post(
    ACCEPT(arranged.manifest.id),
    { parcel_count_taken: 4 },
    { headers: { 'If-Match': opened.header('etag') ?? '', 'Idempotency-Key': randomUUID() } },
  );
  expect(accepted.status).toBe(200);
}

describe('submitHubHandover: one intake for each collected request, and the run is completed by it', () => {
  // Break caught: a handover that opens no intake, opens one for a request with nothing collected (the failed one), one for the whole run instead of one for each row, answers in another
  // order than the rows, answers with the declaration or another shape than the contract's, or leaves the run in progress. AC-SLICE-001-75, -39 and -17 (its second half).
  it('opens an intake at AWAITING_COUNT for each row, in the order of the rows, none for a failed stop, and completes the run', async () => {
    const handed = await handedRun([
      { state: 'COLLECTED', collected: 3 },
      { state: 'COLLECTED', collected: 3 },
      { state: 'PARTIALLY_COLLECTED', collected: 2 },
      { state: 'FAILED' },
    ]);
    const [p, q, r, s] = handed.stops;
    // The rows are sent in another order than the stops', so that the order of the answer is the rows' and no accident of the stops'.
    const rows = [
      { pickup_request_id: r?.requestId ?? '', declared_count: 2 },
      { pickup_request_id: p?.requestId ?? '', declared_count: 3 },
      { pickup_request_id: q?.requestId ?? '', declared_count: 3 },
    ];
    const captured = capturedNow();
    const response = await submit(handed.rider, handed.manifest.id, {
      rows,
      captured_at: captured,
    });
    expect(response.status).toBe(201);

    const body = intakesOf(response);
    expect(body.map((intake) => intake.pickup_request_id)).toEqual(
      rows.map((row) => row.pickup_request_id),
    );
    const run = await manifestOf(handed.manifest.id);
    expect(run?.state).toBe('COMPLETED');
    expect(run?.completed_at).toBeInstanceOf(Date);
    for (const intake of body) {
      expect(Object.keys(intake).sort()).toEqual(
        [
          'active_receiver_id',
          'code',
          'count_phase',
          'declaration_captured_at',
          'handed_over_at',
          'handed_over_by',
          'hub_id',
          'id',
          'lock_acquired_at',
          'pickup_manifest_id',
          'pickup_request_id',
          'state',
        ].sort(),
      );
      expect(intake).toMatchObject({
        id: expect.stringMatching(UUID) as string,
        code: expect.stringMatching(/^[A-Z]{3}-IN-[2-9A-HJKMNP-Z]{6}$/) as string,
        state: 'AWAITING_COUNT',
        hub_id: HUB_A,
        pickup_manifest_id: handed.manifest.id,
        handed_over_by: handed.rider.id,
        declaration_captured_at: captured,
        active_receiver_id: null,
        lock_acquired_at: null,
        count_phase: 'PRE_COUNT',
      });
      // The receipt is the database's, and it is the moment the run was completed by this handover.
      expect(intake.handed_over_at).toBe(run?.completed_at?.toISOString());
    }
    expect(new Set(body.map((intake) => intake.code)).size).toBe(3);

    const stored = await intakeRows(handed.manifest.id);
    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.pickup_request_id).sort()).toEqual(
      [p?.requestId, q?.requestId, r?.requestId].sort(),
    );
    expect(stored.some((row) => row.pickup_request_id === s?.requestId)).toBe(false);
    // AC-SLICE-001-39: receiving is a distinct act. Nothing was counted, received or locked by the handover.
    for (const row of stored) {
      expect(row).toMatchObject({
        state: 'AWAITING_COUNT',
        physical_count: null,
        counted_at: null,
        counted_by: null,
        count_variance: null,
        active_receiver_id: null,
        version: 1,
      });
    }
    // The stops were not touched by the handover.
    const stopStates = await routes.rows<{ state: string }>(
      `select state from pickup_stop where pickup_manifest_id = $1 order by sequence`,
      [handed.manifest.id],
    );
    expect(stopStates.map((stop) => stop.state)).toEqual([
      'COLLECTED',
      'COLLECTED',
      'PARTIALLY_COLLECTED',
      'FAILED',
    ]);
  });

  // Break caught: a declaration taken from the collected count (the independence of MSC-DEC-194 part 3), a zero refused, a count above the collected one clamped, or a correction
  // of the pre-fill that is nowhere recorded. AC-SLICE-001-44 and the first half of -76.
  it('stores each declared count as given, a zero and a count above the collected one included, and records the pre-fill each correction was made from', async () => {
    const handed = await handedRun([
      { state: 'COLLECTED', collected: 3 },
      { state: 'COLLECTED', collected: 3 },
      { state: 'PARTIALLY_COLLECTED', collected: 2 },
      { state: 'COLLECTED', collected: 3 },
    ]);
    // Counted at 3, 3, 2 and 3; declared at 3 (as pre-filled), 2 (corrected down), 0 (a collected request the rider did not bring) and 7 (corrected up).
    const rows = rowsFor(handed, [3, 2, 0, 7]);
    const response = await submit(handed.rider, handed.manifest.id, {
      rows,
      captured_at: capturedNow(),
    });
    expect(response.status).toBe(201);

    const stored = new Map(
      (await intakeRows(handed.manifest.id)).map((row) => [row.pickup_request_id, row]),
    );
    const declaredOf = (requestId: string) => stored.get(requestId)?.rider_declared_count;
    const prefilledOf = (requestId: string) => stored.get(requestId)?.prefilled_count;
    expect(rows.map((row) => declaredOf(row.pickup_request_id))).toEqual([3, 2, 0, 7]);
    // What each form was pre-filled with is the collection record's count, kept beside the declaration, so that a correction is a fact: declared and pre-filled differ.
    expect(rows.map((row) => prefilledOf(row.pickup_request_id))).toEqual([3, 3, 2, 3]);
    // A zero declaration opens its intake all the same (it routes to reconciliation after the blind count, S1.33).
    expect(stored.get(rows[2]?.pickup_request_id ?? '')?.state).toBe('AWAITING_COUNT');
    expect(stored.size).toBe(4);
  });

  // Break caught: a declaration that the application derives from the collected count when the row is the same number, or one that needs the collected count to exist.
  it('keeps the rider’s number when it is the collected count too, and does not depend on it', async () => {
    const handed = await handedRun([{ state: 'COLLECTED', collected: 3 }]);
    const response = await submit(handed.rider, handed.manifest.id, {
      rows: rowsFor(handed, [3]),
      captured_at: capturedNow(),
    });
    expect(response.status).toBe(201);
    const [only] = await intakeRows(handed.manifest.id);
    expect(only).toMatchObject({ rider_declared_count: 3, prefilled_count: 3 });
  });

  // Break caught: a captured moment that is replaced by the server's, clamped or refused because the device's clock is wrong, or a receipt moment that follows the device. F-35: the bound on a
  // device clock is an open value, so a skewed clock is kept as it was given and the receipt stays the server's.
  it('keeps the device’s moment apart from the receipt, whether the clock is days behind or ahead', async () => {
    const before = Date.now();
    for (const skew of [-3 * 86_400_000, 3 * 86_400_000]) {
      const handed = await handedRun([{ state: 'COLLECTED' }]);
      const captured = new Date(Date.now() + skew).toISOString();
      const response = await submit(handed.rider, handed.manifest.id, {
        rows: rowsFor(handed),
        captured_at: captured,
      });
      expect(response.status).toBe(201);
      const [intake] = intakesOf(response);
      expect(intake?.declaration_captured_at).toBe(captured);
      // The receipt is the server's moment, now, whatever the device said.
      const received = Date.parse(intake?.handed_over_at ?? '');
      expect(received).toBeGreaterThanOrEqual(before - 1_000);
      expect(received).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(intake?.handed_over_at).not.toBe(captured);
      const [stored] = await intakeRows(handed.manifest.id);
      expect(stored?.declaration_captured_at.toISOString()).toBe(captured);
    }
  });

  // Break caught: a moment the database cannot hold (year 0), a date that does not exist, or no moment at all, reaching the insert.
  it('refuses a captured moment that names no instant, and a body that is not the contract’s, and opens nothing', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }]);
    const etag = await manifestEtag(handed.manifest.id);
    const rows = rowsFor(handed);
    for (const body of [
      { rows, captured_at: '0000-01-01T00:00:00.000Z' },
      { rows, captured_at: '2026-02-30T10:00:00.000Z' },
      { rows, captured_at: 'yesterday' },
      { rows },
      { captured_at: capturedNow() },
      { rows: [], captured_at: capturedNow() },
      { rows, captured_at: capturedNow(), extra: true },
      { rows: [{ ...rows[0], declared_count: -1 }], captured_at: capturedNow() },
      { rows: [{ ...rows[0], declared_count: 1.5 }], captured_at: capturedNow() },
      // Past the column's range: it passes the contract's schema (a minimum and no maximum) and would reach the insert; the service refuses it.
      { rows: [{ ...rows[0], declared_count: 2_147_483_648 }], captured_at: capturedNow() },
      { rows: [{ pickup_request_id: rows[0]?.pickup_request_id }], captured_at: capturedNow() },
      { rows: [{ ...rows[0], note: 'x' }], captured_at: capturedNow() },
    ]) {
      const response = await submit(handed.rider, handed.manifest.id, body, { etag });
      expect(refusalOf(response), JSON.stringify(body)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
  });
});

describe('submitHubHandover: the audit trail says what was done and never the declaration', () => {
  // Break caught: no event of the handover, one for each intake (the catalogue says one for the handover, naming the intakes), a run completion that is not the handover's, a note that
  // is lost, or a count (the rider's declaration, or what it was pre-filled with) in the ledger before the blind count exists to compare it.
  it('writes one hub.handover.submitted naming the intakes and one pickup.manifest.completed, carrying no count', async () => {
    const handed = await handedRun([
      { state: 'COLLECTED', collected: 3 },
      { state: 'PARTIALLY_COLLECTED', collected: 2 },
    ]);
    const response = await submit(handed.rider, handed.manifest.id, {
      rows: rowsFor(handed, [2, 2]),
      captured_at: capturedNow(),
      note: 'Left one parcel at the gate',
    });
    expect(response.status).toBe(201);
    const ids = intakesOf(response).map((intake) => intake.id);

    const submitted = await events('hub.handover.submitted', handed.manifest.id);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: handed.rider.id,
      surface_context: 'RIDER_ANDROID',
      object_type: 'PickupManifest',
      responsible_hub_id: HUB_A,
      enhanced: false,
      outcome: 'SUCCEEDED',
      note: 'Left one parcel at the gate',
    });
    // The intakes are named in the order of their identifiers, which the ledger binds to the stored rows.
    expect(submitted[0]?.related_ids).toEqual({
      pickup_manifest_id: handed.manifest.id,
      rider_id: handed.rider.id,
      intake_ids: [...ids].sort(),
    });
    expect(submitted[0]?.detail).toEqual({ intakes_opened: 2 });

    const completed = await events('pickup.manifest.completed', handed.manifest.id);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      actor_type: 'RIDER',
      actor_id: handed.rider.id,
      previous_state: 'IN_PROGRESS',
      resulting_state: 'COMPLETED',
      responsible_hub_id: HUB_A,
      detail: { completed_by: 'CUSTODY_HOLDER', cause: 'HUB_HANDOVER' },
    });
    // Nothing of the declaration, or of what it was pre-filled with, is in any event of the run or of an intake.
    const everything = await routes.rows<{ text: string }>(
      `select concat_ws(' ', detail::text, before_after::text, related_ids::text, note) as text
         from audit_event where object_id = $1 or related_ids ->> 'pickup_manifest_id' = $1::text`,
      [handed.manifest.id],
    );
    for (const row of everything) expect(row.text).not.toMatch(/declared|prefill|collected/i);
  });
});

describe('submitHubHandover: a retry is not a second handover', () => {
  // Break caught: a replay that opens a second set of intakes, answers with different ids or a refusal of the run's state, writes a second event, or a key that is not looked at before the
  // run's state is (the run is completed by the first call, so a retry meets a completed run). AC-SLICE-001-18, the server half.
  it('replays the original answer, byte for byte, and opens one set', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }, { state: 'COLLECTED', collected: 2 }]);
    const etag = await manifestEtag(handed.manifest.id);
    const key = randomUUID();
    const body = { rows: rowsFor(handed, [3, 1]), captured_at: capturedNow() };
    const first = await submit(handed.rider, handed.manifest.id, body, { etag, key });
    expect(first.status).toBe(201);
    // The retry carries the token the rider read before, which the run has since moved past.
    const second = await submit(handed.rider, handed.manifest.id, body, { etag, key });
    expect(second.status).toBe(201);
    expect(second.text).toBe(first.text);

    expect(await intakeRows(handed.manifest.id)).toHaveLength(2);
    expect(await events('hub.handover.submitted', handed.manifest.id)).toHaveLength(1);
    expect(await events('pickup.manifest.completed', handed.manifest.id)).toHaveLength(1);
  });

  // Break caught: another body under the key answered as a replay (it would hand the rider another handover's intakes), or one that runs. AC-SLICE-001-75, the last clause.
  it('refuses the same key with other rows as IDEMPOTENCY_KEY_CONFLICT and changes nothing', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }, { state: 'COLLECTED' }]);
    const etag = await manifestEtag(handed.manifest.id);
    const key = randomUUID();
    const first = await submit(
      handed.rider,
      handed.manifest.id,
      { rows: rowsFor(handed, [3, 3]), captured_at: capturedNow() },
      { etag, key },
    );
    expect(first.status).toBe(201);
    const other = await submit(
      handed.rider,
      handed.manifest.id,
      { rows: rowsFor(handed, [3, 2]), captured_at: capturedNow() },
      { etag, key },
    );
    expect(refusalOf(other)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_CONFLICT' });
    const stored = await intakeRows(handed.manifest.id);
    expect(stored.map((row) => row.rider_declared_count).sort()).toEqual([3, 3]);
  });

  // Break caught: a handover that is accepted with no key (a retry that could not be told from a second handover), or with one the store cannot keep (the contract bounds a key's length).
  it('refuses a handover with no Idempotency-Key, an empty one, or one that is too long', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }]);
    const etag = await manifestEtag(handed.manifest.id);
    for (const key of [null, '', 'k'.repeat(129)]) {
      const response = await submit(
        handed.rider,
        handed.manifest.id,
        { rows: rowsFor(handed), captured_at: capturedNow() },
        { etag, key },
      );
      expect(refusalOf(response), String(key)).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);
  });
});

describe('submitHubHandover: the rows are exactly the run’s collected requests, each once', () => {
  // Break caught: a handover that omits a collected request, repeats one, names the failed stop's request, names a request of another run or one that does not exist and still opens
  // something. Each is VALIDATION_FAILED naming the row, and nothing opens and the run stays in progress. AC-SLICE-001-75.
  it('refuses a row omitted, repeated, naming a failed request or a stranger, naming the row, and opens nothing', async () => {
    const handed = await handedRun([
      { state: 'COLLECTED' },
      { state: 'COLLECTED' },
      { state: 'PARTIALLY_COLLECTED', collected: 2 },
      { state: 'FAILED' },
    ]);
    const other = await handedRun([{ state: 'COLLECTED' }]);
    const [p, q, r, s] = handed.stops;
    const row = (requestId: string | undefined, declared = 3): Row => ({
      pickup_request_id: requestId ?? '',
      declared_count: declared,
    });
    const etag = await manifestEtag(handed.manifest.id);
    const cases: { name: string; rows: Row[]; violation: Record<string, unknown> }[] = [
      {
        name: 'omits R',
        rows: [row(p?.requestId), row(q?.requestId)],
        violation: {
          in: 'body',
          pointer: '/rows',
          rule: 'missing',
          pickup_request_id: r?.requestId,
        },
      },
      {
        name: 'repeats P',
        rows: [row(p?.requestId), row(q?.requestId), row(r?.requestId, 2), row(p?.requestId)],
        violation: { in: 'body', pointer: '/rows/3/pickup_request_id', rule: 'repeated' },
      },
      {
        name: 'names S, which failed',
        rows: [row(p?.requestId), row(q?.requestId), row(r?.requestId, 2), row(s?.requestId, 1)],
        violation: { in: 'body', pointer: '/rows/3/pickup_request_id', rule: 'not_collected' },
      },
      {
        name: 'names a request of another run',
        rows: [
          row(p?.requestId),
          row(q?.requestId),
          row(r?.requestId, 2),
          row(other.stops[0]?.requestId),
        ],
        violation: { in: 'body', pointer: '/rows/3/pickup_request_id', rule: 'not_collected' },
      },
      {
        name: 'names a request that does not exist',
        rows: [row(p?.requestId), row(q?.requestId), row(r?.requestId, 2), row(randomUUID())],
        violation: { in: 'body', pointer: '/rows/3/pickup_request_id', rule: 'not_collected' },
      },
    ];
    for (const refused of cases) {
      const response = await submit(
        handed.rider,
        handed.manifest.id,
        { rows: refused.rows, captured_at: capturedNow() },
        { etag },
      );
      const said = refusalOf(response);
      expect(said, refused.name).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(said.details?.violations, refused.name).toContainEqual(refused.violation);
    }
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);
    expect(await intakeRows(other.manifest.id)).toHaveLength(0);
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await events('hub.handover.submitted', handed.manifest.id)).toHaveLength(0);
  });
});

describe('submitHubHandover: every stop must be terminal', () => {
  // Break caught: a handover on a run with a stop still to be worked (PENDING or ARRIVED), which would complete a run with work left; and a handover that stays refused once the stop is
  // terminal. AC-SLICE-001-45 and -17.
  it('is STOPS_UNRESOLVED while a stop is still to be worked, and available once every stop is terminal', async () => {
    for (const waiting of ['PENDING', 'ARRIVED'] as const) {
      const handed = await handedRun([{ state: 'COLLECTED' }, { state: waiting }]);
      const body = { rows: rowsFor(handed), captured_at: capturedNow() };
      const refused = await submit(handed.rider, handed.manifest.id, body);
      expect(refusalOf(refused), waiting).toMatchObject({ status: 422, code: 'STOPS_UNRESOLVED' });
      expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
      expect(await intakeRows(handed.manifest.id)).toHaveLength(0);

      // Ops skips the stop that cannot be worked: the run may now be handed over.
      const stop = handed.stops[1];
      await routes.admin.query(
        `update pickup_stop set state = 'SKIPPED', resolved_at = now(), skip_snapshot = $2::jsonb where id = $1`,
        [
          stop?.id,
          JSON.stringify({
            reason_code: 'RUN_CUT_SHORT',
            note: 'Skipped by Ops',
            skipped_at: '2026-11-03T09:30:00.000Z',
          }),
        ],
      );
      const accepted = await submit(handed.rider, handed.manifest.id, body);
      expect(accepted.status, `${waiting}: ${accepted.text}`).toBe(201);
      expect((await manifestOf(handed.manifest.id))?.state).toBe('COMPLETED');
    }
  });
});

describe('submitHubHandover: a run that is not in progress, and a token that is not the run’s', () => {
  // Break caught: a handover on a run the system completed (nothing was collected, so it has no handover and no intake), on a run already handed over, or on one that has not started.
  // AC-SLICE-001-78: the handover of a run the system completed is STATE_CONFLICT.
  it('is STATE_CONFLICT for a run the system completed, one already handed over and one only dispatched', async () => {
    const settled = await handedRun([{ state: 'FAILED' }, { state: 'SKIPPED' }], {
      state: 'COMPLETED',
    });
    const handedOver = await handedRun([{ state: 'COLLECTED' }]);
    const first = await submit(handedOver.rider, handedOver.manifest.id, {
      rows: rowsFor(handedOver),
      captured_at: capturedNow(),
    });
    expect(first.status).toBe(201);
    const dispatched = await handedRun([{ state: 'PENDING' }], { state: 'DISPATCHED' });

    // A completed run with nothing collected has no row to hand over, so a body of any shape is judged by the run's state first.
    const attempts: [string, ArrangedRider, string, Record<string, unknown>][] = [
      [
        'a run the system completed',
        settled.rider,
        settled.manifest.id,
        {
          rows: [{ pickup_request_id: randomUUID(), declared_count: 1 }],
          captured_at: capturedNow(),
        },
      ],
      [
        'a run already handed over',
        handedOver.rider,
        handedOver.manifest.id,
        { rows: rowsFor(handedOver), captured_at: capturedNow() },
      ],
      [
        'a run only dispatched',
        dispatched.rider,
        dispatched.manifest.id,
        {
          rows: [{ pickup_request_id: randomUUID(), declared_count: 1 }],
          captured_at: capturedNow(),
        },
      ],
    ];
    for (const [name, rider, runId, body] of attempts) {
      const response = await submit(rider, runId, body);
      expect(refusalOf(response), name).toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    }
    expect(await intakeRows(settled.manifest.id)).toHaveLength(0);
    expect(await events('hub.handover.submitted', settled.manifest.id)).toHaveLength(0);
    // The run that was handed over once still has its one set.
    expect(await intakeRows(handedOver.manifest.id)).toHaveLength(1);
  });

  // Break caught: a token that is not compared (a handover on a run that changed since the rider read it: a stop Ops skipped, a pickup cancelled), a missing or weak one accepted.
  it('is STATE_CONFLICT for a stale, a missing or a foreign If-Match, and opens nothing', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }, { state: 'COLLECTED' }]);
    const body = { rows: rowsFor(handed), captured_at: capturedNow() };
    const fresh = await manifestEtag(handed.manifest.id);
    const another = await handedRun([{ state: 'COLLECTED' }]);
    for (const etag of [
      '"stale"',
      `W/${fresh}`,
      '*',
      await manifestEtag(another.manifest.id),
      '',
    ]) {
      const response = await submit(handed.rider, handed.manifest.id, body, { etag });
      expect(refusalOf(response), etag).toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    }
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
  });

  // Break caught: a handover while a custody handover of the run is open (the holder is still the assigned rider until acceptance, but a run is never closed over an open custody record;
  // state-machines.md section 4).
  it('is STATE_CONFLICT while a custody handover of the run is pending, and the run stays in progress', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }]);
    const second = await arrangedRider(routes.kit, routes.admin);
    const opened = await ops.client.post(
      OPEN(handed.manifest.id),
      { to_rider_id: second.id, note: 'The rider will hand on at the roadside' },
      { origin: OPS, headers: { 'If-Match': await manifestEtag(handed.manifest.id) } },
    );
    expect(opened.status).toBe(200);
    const response = await submit(handed.rider, handed.manifest.id, {
      rows: rowsFor(handed),
      captured_at: capturedNow(),
    });
    expect(refusalOf(response)).toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);
  });
});

describe('submitHubHandover: only the custody holder hands over', () => {
  // Break caught: a handover by a rider with no relation to the run (told another thing than a run that does not exist), or by an officer or a vendor. NOT_ASSIGNED_RIDER is one answer
  // for a colleague's run and for an id that matches nothing.
  it('tells a rider with no relation to the run, and an id that matches nothing, NOT_ASSIGNED_RIDER, the same', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }]);
    const stranger = await arrangedRider(routes.kit, routes.admin);
    const body = { rows: rowsFor(handed), captured_at: capturedNow() };
    const etag = await manifestEtag(handed.manifest.id);
    const theirs = await submit(stranger, handed.manifest.id, body, { etag });
    const nothing = await submit(stranger, randomUUID(), body, { etag });
    expect(refusalOf(theirs)).toMatchObject({ status: 422, code: 'NOT_ASSIGNED_RIDER' });
    expect(refusalOf(nothing)).toMatchObject({ status: 422, code: 'NOT_ASSIGNED_RIDER' });
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);
  });

  // Break caught: a handover by an officer (the key is a rider's: R only), which would let the office close a run whose parcels it does not hold.
  it('is PERMISSION_DENIED for an officer', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }]);
    const response = await ops.client.post(
      HANDOVER(handed.manifest.id),
      { rows: rowsFor(handed), captured_at: capturedNow() },
      {
        origin: OPS,
        headers: {
          'If-Match': await manifestEtag(handed.manifest.id),
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(refusalOf(response)).toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
  });

  // Break caught: the assigned rider completing a run it has handed the custody of away (the stranded run's whole point), the receiver being refused the completion it was promised, or the
  // intakes carrying the wrong custody holder. AC-SLICE-001-67: the second rider, who holds custody, completes the run by the hub handover; the assigned rider receives NOT_CUSTODY_HOLDER.
  it('is NOT_CUSTODY_HOLDER for the assigned rider who has handed custody over, and the receiver, who holds it, completes the run', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }, { state: 'COLLECTED', collected: 2 }]);
    const receiver = await arrangedRider(routes.kit, routes.admin);
    await custodyMovesTo(handed, receiver);
    const body = { rows: rowsFor(handed), captured_at: capturedNow() };
    const etag = await manifestEtag(handed.manifest.id);

    const former = await submit(handed.rider, handed.manifest.id, body, { etag });
    expect(refusalOf(former)).toMatchObject({ status: 422, code: 'NOT_CUSTODY_HOLDER' });
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);

    const holder = await submit(receiver, handed.manifest.id, body, { etag });
    expect(holder.status).toBe(201);
    const stored = await intakeRows(handed.manifest.id);
    expect(stored).toHaveLength(2);
    // The intakes say who handed them over: the custody holder, not the rider the run is assigned to.
    expect(stored.every((row) => row.handed_over_by === receiver.id)).toBe(true);
    expect((await manifestOf(handed.manifest.id))?.state).toBe('COMPLETED');
    const completed = await events('pickup.manifest.completed', handed.manifest.id);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ actor_id: receiver.id });
  });
});

describe('submitHubHandover: a run in progress that has nothing to hand over', () => {
  // Break caught: a handover that goes on to judge the rows of a run on which nothing was collected and refuses each as a request not collected (VALIDATION_FAILED), instead of saying that such a
  // run has no handover at all. The system completes such a run when its last stop turns terminal, so the run is left in progress here as the administrator can, which is the only way to reach it.
  it('is STATE_CONFLICT (nothing_collected) for a run whose stops are all failed or skipped', async () => {
    const handed = await handedRun([{ state: 'FAILED' }, { state: 'SKIPPED' }]);
    const response = await submit(handed.rider, handed.manifest.id, {
      rows: [{ pickup_request_id: randomUUID(), declared_count: 1 }],
      captured_at: capturedNow(),
    });
    expect(refusalOf(response)).toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect((response.json() as { details?: { rule?: string } }).details?.rule).toBe(
      'nothing_collected',
    );
    expect((await manifestOf(handed.manifest.id))?.state).toBe('IN_PROGRESS');
    expect(await intakeRows(handed.manifest.id)).toHaveLength(0);
  });
});

describe('submitHubHandover: two handovers of one run end as one would', () => {
  // Break caught: a second handover let through while the first is in flight (two sets of intakes, a run completed twice), a deadlock between the two, or a refusal that is not the first's
  // having won. The two ask under two keys and the same token, as a double tap of two taps would: whichever wins, the other is STATE_CONFLICT, and one set results.
  it('lets one of two handovers of one run, under two keys, win and refuses the other as STATE_CONFLICT', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }, { state: 'COLLECTED' }]);
    const etag = await riderEtag(handed.rider, handed.manifest.id);
    const body = { rows: rowsFor(handed), captured_at: capturedNow() };
    const sent = await Promise.all([
      submit(handed.rider, handed.manifest.id, body, { etag }),
      submit(handed.rider, handed.manifest.id, body, { etag }),
    ]);
    expect(sent.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([201, 409]);
    const refused = sent.find((response) => response.status === 409);
    expect(refused === undefined ? undefined : codeOf(refused)).toBe('STATE_CONFLICT');
    expect(await intakeRows(handed.manifest.id)).toHaveLength(2);
    expect(await events('hub.handover.submitted', handed.manifest.id)).toHaveLength(1);
    expect(await events('pickup.manifest.completed', handed.manifest.id)).toHaveLength(1);
  });

  // Break caught: a retry that arrives while the first request is still in flight answered with a refusal, a second set of intakes, or another answer. The store makes the second wait for the
  // first and answers it with the first's answer.
  it('answers two requests that carry one key, sent at the same moment, with one answer, and opens one set', async () => {
    const handed = await handedRun([{ state: 'COLLECTED' }, { state: 'COLLECTED' }]);
    const etag = await riderEtag(handed.rider, handed.manifest.id);
    const key = randomUUID();
    const body = { rows: rowsFor(handed), captured_at: capturedNow() };
    const sent = await Promise.all([
      submit(handed.rider, handed.manifest.id, body, { etag, key }),
      submit(handed.rider, handed.manifest.id, body, { etag, key }),
    ]);
    expect(sent.map((response) => response.status)).toEqual([201, 201]);
    expect(sent[1].text).toBe(sent[0].text);
    expect(await intakeRows(handed.manifest.id)).toHaveLength(2);
    expect(await events('hub.handover.submitted', handed.manifest.id)).toHaveLength(1);
  });
});

describe('submitHubHandover: the declaration is nowhere the application can say it', () => {
  // Break caught: the declaration reaching the answer, the ledger or a log line before the blind count exists to compare it. The numbers are ones that a uuid, a port or a moment cannot hold
  // by chance (above 65535 and in no group of a uuid), and the whole of what the run wrote to the ledger is read, every column.
  it('puts the declaration in no answer, no event and no log line', async () => {
    const handed = await handedRun([
      { state: 'COLLECTED' },
      { state: 'PARTIALLY_COLLECTED', collected: 2 },
    ]);
    const response = await submit(handed.rider, handed.manifest.id, {
      rows: rowsFor(handed, [71234, 83456]),
      captured_at: capturedNow(),
      note: 'Counted twice at the gate',
    });
    expect(response.status).toBe(201);
    const stored = await intakeRows(handed.manifest.id);
    expect(stored.map((row) => row.rider_declared_count).toSorted((a, b) => a - b)).toEqual([
      71234, 83456,
    ]);
    const ledger = JSON.stringify(
      await routes.rows(
        `select * from audit_event where object_id = $1 or related_ids::text like '%' || $1::text || '%'`,
        [handed.manifest.id],
      ),
    );
    for (const [where, text] of [
      ['the answer', response.text],
      ['the ledger', ledger],
      ['the log', routes.kit.app.logs.text()],
    ] as const) {
      expect(text, where).not.toMatch(/\b(71234|83456)\b/);
    }
  });
});
