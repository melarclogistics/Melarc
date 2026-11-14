import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { countIntake, handOver } from './support/handed-over.js';
import {
  declareIntakeEvidence,
  intakeEvidenceBody,
  pendingIntakeEvidence,
  storedIntakeEvidence,
} from './support/intake-evidence.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.34, what is found at an intake after its blind count (`recordIntakeCondition`, `adjudicateDiscrepancy`; `hub.intake.count` and `hub.osd.adjudicate`; `AC-SLICE-001-41`, `-42` and `-76`;
 * features/hub/hub-intake.md sections 5.1 and 5.2; state-machines.md section 7). Against a real PostgreSQL and the real application, each claim:
 *
 * - **A condition is recordable on a count that matched, and routes the case to Senior Ops**: damage or tampering carries stored evidence of the intake (`REASON_REQUIRED` when none,
 *   `EVIDENCE_NOT_STORED` for a record not stored), and the count, the declaration and the variance survive it unchanged.
 * - **The adjudication is Senior Ops's**: Ops Staff do not hold its key and are refused `PERMISSION_DENIED` before the body is read; it needs a reason; a zero declaration is resolved by it, with a reason.
 * - **The case, the findings and the token**: the findings are served on the intake, in the order they were made; the `ETag` moves with them (an escalation changes nothing else of the row).
 */
const INTAKES = `${API}/hub-intakes`;
const ONE = (id: string) => `${INTAKES}/${id}`;
const CONDITION = (id: string) => `${ONE(id)}/condition`;
const DISCREPANCY = (id: string) => `${ONE(id)}/discrepancy`;

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

interface Finding {
  readonly id: string;
  readonly kind: string;
  readonly condition: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by: string;
  readonly recorded_at: string;
}
interface Found {
  readonly id: string;
  readonly state: string;
  readonly count_phase: string;
  readonly rider_declared_count: number;
  readonly physical_count: number;
  readonly count_variance: string;
  readonly count_difference: number;
  readonly condition: string;
  readonly condition_findings?: readonly Finding[];
}

const outcome = (response: TestResponse): [number, string | undefined] => [
  response.status,
  codeOf(response),
];

/** An intake of hub A that has been counted, and the receiver and the Senior Ops of the hub. A count that matches a declaration above zero is cleared for itemization. */
async function counted(
  declared = 3,
  physical = 3,
): Promise<{ id: string; receiver: Actor; senior: Actor }> {
  const receiver = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  const done = await handOver(routes, vendor, days, { collected: [3], declared: [declared] });
  const id = done.intakes[0]?.id ?? '';
  expect((await countIntake(receiver, id, physical)).status).toBe(200);
  return { id, receiver, senior };
}

const etagOf = async (actor: Actor, id: string): Promise<string> =>
  (await actor.client.get(ONE(id))).header('etag') ?? '';

/** The receiver records a condition, on the `ETag` of the read unless the test says otherwise. */
async function record(
  actor: Actor,
  id: string,
  body: unknown,
  over: { etag?: string | null; key?: string | null } = {},
): Promise<TestResponse> {
  const etag = over.etag === undefined ? await etagOf(actor, id) : over.etag;
  return actor.client.post(CONDITION(id), body, {
    origin: OPS,
    headers: {
      ...(etag === null ? {} : { 'If-Match': etag }),
      ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
    },
  });
}

/** Senior Ops adjudicates, on the `ETag` of the read unless the test says otherwise. */
async function adjudicate(
  actor: Actor,
  id: string,
  body: unknown,
  over: { etag?: string | null } = {},
): Promise<TestResponse> {
  const etag = over.etag === undefined ? await etagOf(actor, id) : over.etag;
  return actor.client.post(DISCREPANCY(id), body, {
    origin: OPS,
    headers: etag === null ? {} : { 'If-Match': etag },
  });
}

const rowOf = async (id: string) =>
  (
    await routes.rows<{
      state: string;
      condition: string;
      physical_count: number;
      count_variance: string;
      count_difference: number;
      version: number;
    }>(
      `select state, condition, physical_count, count_variance, count_difference, version from pickup_intake where id = $1`,
      [id],
    )
  )[0];

const events = (code: string, objectId: string) =>
  routes.rows<{
    actor_id: string | null;
    enhanced: boolean;
    previous_state: string | null;
    resulting_state: string | null;
    note: string | null;
    related_ids: Record<string, unknown> | null;
    detail: Record<string, unknown> | null;
  }>(
    `select actor_id, enhanced, previous_state, resulting_state, note, related_ids, detail from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

describe('recordIntakeCondition (AC-SLICE-001-41, -42)', () => {
  // Break caught: a condition that cannot be recorded on a count that matched (the commonest real case), that changes a count, that does not send the case to Senior Ops, that leaves the finding out of
  // the intake's representation, or whose ETag does not move.
  it('records damage with its evidence on a count that matched: MATCH stays, the case routes to Senior Ops, the finding is served, and no count changes', async () => {
    const { id, receiver } = await counted();
    const before = (await receiver.client.get(ONE(id))).json() as Found;
    expect(before).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      count_variance: 'MATCH',
      condition: 'OK',
    });
    const etagBefore = await etagOf(receiver, id);
    const photo = await storedIntakeEvidence(routes, receiver, id);

    const response = await record(receiver, id, {
      condition: 'DAMAGED',
      note: 'The box is crushed',
      evidence_ids: [photo],
    });
    expect(response.status).toBe(200);
    const body = response.json() as Found;
    expect(body).toMatchObject({
      id,
      count_phase: 'POST_COUNT',
      state: 'RECONCILIATION_REQUIRED',
      condition: 'DAMAGED',
      count_variance: 'MATCH',
      count_difference: 0,
      physical_count: before.physical_count,
      rider_declared_count: before.rider_declared_count,
    });
    expect(body.condition_findings).toHaveLength(1);
    expect(body.condition_findings?.[0]).toMatchObject({
      kind: 'CONDITION',
      condition: 'DAMAGED',
      outcome: null,
      note: 'The box is crushed',
      evidence_ids: [photo],
      recorded_by: receiver.identity.id,
    });
    expect(response.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(response.header('etag')).not.toBe(etagBefore);
    // A read is the same representation with the same token.
    const read = await receiver.client.get(ONE(id));
    expect(read.json()).toEqual(body);
    expect(read.header('etag')).toBe(response.header('etag'));
    expect(await rowOf(id)).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      condition: 'DAMAGED',
      count_variance: 'MATCH',
      count_difference: 0,
    });
    // The ledger: the recording (not enhanced, naming the finding and the evidence by count) and the case that opened.
    const recorded = await events('hub.intake.condition_recorded', id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      actor_id: receiver.identity.id,
      enhanced: false,
      previous_state: 'READY_FOR_ITEMIZATION',
      resulting_state: 'RECONCILIATION_REQUIRED',
      note: 'The box is crushed',
      detail: { condition: 'DAMAGED', evidence_count: 1 },
    });
    const opened = await events('hub.osd.opened', id);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      previous_state: 'READY_FOR_ITEMIZATION',
      resulting_state: 'RECONCILIATION_REQUIRED',
      detail: { dimension: 'CONDITION', condition: 'DAMAGED' },
    });
    expect(JSON.stringify(recorded)).not.toContain(photo);
  });

  // Break caught: tampering recordable with no evidence, or with a record that is not stored (AC-SLICE-001-42), a record of another intake, or the same record twice; and a refusal that leaves a
  // finding or a changed intake behind.
  it('refuses tampering with no evidence (REASON_REQUIRED), and evidence that is not stored, another intake’s or cited twice, and commits nothing', async () => {
    const { id, receiver } = await counted();
    const other = await counted();
    const pending = await pendingIntakeEvidence(routes, receiver, id);
    const foreign = await storedIntakeEvidence(routes, other.receiver, other.id);
    const stored = await storedIntakeEvidence(routes, receiver, id);
    const state = await rowOf(id);
    const refusals: [string, unknown, number, string][] = [
      ['no evidence', { condition: 'TAMPERED' }, 422, 'REASON_REQUIRED'],
      ['an empty list', { condition: 'TAMPERED', evidence_ids: [] }, 422, 'REASON_REQUIRED'],
      [
        'a record not stored',
        { condition: 'TAMPERED', evidence_ids: [pending] },
        422,
        'EVIDENCE_NOT_STORED',
      ],
      [
        'another intake’s record',
        { condition: 'DAMAGED', evidence_ids: [foreign] },
        422,
        'EVIDENCE_NOT_STORED',
      ],
      [
        'a record that does not exist',
        { condition: 'DAMAGED', evidence_ids: [randomUUID()] },
        422,
        'EVIDENCE_NOT_STORED',
      ],
      [
        'the same record twice',
        { condition: 'DAMAGED', evidence_ids: [stored, stored] },
        400,
        'VALIDATION_FAILED',
      ],
    ];
    for (const [name, body, status, code] of refusals) {
      expect(outcome(await record(receiver, id, body)), name).toEqual([status, code]);
    }
    expect(await rowOf(id)).toEqual(state);
    const read = (await receiver.client.get(ONE(id))).json() as Found;
    expect(read.condition_findings).toBeUndefined();
  });

  // Break caught: a recording of OK that moves the case, a condition that can be recorded twice, one before the count, one that does not read the ETag, and a body that is not the contract's.
  it('records OK as a finding that moves nothing, once, and only after the count, on the ETag of the read', async () => {
    const { id, receiver } = await counted();
    const waiting =
      (await handOver(routes, vendor, days, { collected: [3], declared: [3] })).intakes[0]?.id ??
      '';
    const refused = await record(receiver, waiting, { condition: 'OK' });
    expect([refused.status, codeOf(refused)]).toEqual([409, 'STATE_CONFLICT']);
    expect((refused.json() as { details?: { rule?: string } }).details?.rule).toBe(
      'intake_not_counted',
    );

    const etag = await etagOf(receiver, id);
    const first = await record(receiver, id, { condition: 'OK' }, { etag });
    expect(first.status).toBe(200);
    expect(first.json()).toMatchObject({ state: 'READY_FOR_ITEMIZATION', condition: 'OK' });
    expect((first.json() as Found).condition_findings).toHaveLength(1);
    // The token moved with the finding: the old one is stale, and a recording of the same intake on it is refused.
    const stale = await record(receiver, id, { condition: 'OTHER' }, { etag });
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
    expect((stale.json() as { details?: { rule?: string } }).details?.rule).toBe('stale');
    // One condition: an intake whose condition is recorded is not recorded again once it is not OK.
    const second = await record(receiver, id, {
      condition: 'DAMAGED',
      evidence_ids: [await storedIntakeEvidence(routes, receiver, id)],
    });
    expect(second.status).toBe(200);
    const third = await record(receiver, id, { condition: 'OTHER' });
    expect([third.status, codeOf(third)]).toEqual([409, 'STATE_CONFLICT']);
    expect((third.json() as { details?: { rule?: string } }).details?.rule).toBe(
      'condition_already_recorded',
    );
    // The contract's body, and the headers it requires.
    for (const [name, body] of [
      ['no condition', {}],
      ['a condition that is none', { condition: 'BROKEN' }],
      ['an unknown member', { condition: 'OK', declared_count: 3 }],
      ['evidence that is no identifier', { condition: 'OK', evidence_ids: ['x'] }],
    ] as const) {
      const bad = await record(receiver, id, body);
      expect([bad.status, codeOf(bad)], name).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(outcome(await record(receiver, id, { condition: 'OK' }, { etag: null }))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(outcome(await record(receiver, id, { condition: 'OK' }, { key: null }))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
  });

  // Break caught: a retry that records again (a second finding, a second event), one that answers differently, and the same key with another condition that is accepted.
  it('answers a retry with the original response, once, and refuses the same key with another condition', async () => {
    const { id, receiver } = await counted();
    const etag = await etagOf(receiver, id);
    const key = randomUUID();
    const first = await record(receiver, id, { condition: 'OK' }, { etag, key });
    expect(first.status).toBe(200);
    const replay = await record(receiver, id, { condition: 'OK' }, { etag, key });
    expect(replay.status).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(replay.header('etag')).toBe(first.header('etag'));
    expect(await events('hub.intake.condition_recorded', id)).toHaveLength(1);
    const another = await record(receiver, id, { condition: 'OTHER' }, { etag, key });
    expect([another.status, codeOf(another)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });

  // Break caught: a condition open to a user without hub.intake.count, to Senior Ops by their other key, to a rider, to another hub's officer or on an id that matches nothing.
  it('is refused without hub.intake.count, to a rider, on another hub’s intake, and for an id that matches nothing', async () => {
    const { id, receiver } = await counted();
    const otherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    const done = await handOver(routes, vendor, days, { collected: [3] });
    const etag = await etagOf(receiver, id);
    expect(outcome(await record(finance, id, { condition: 'OK' }, { etag }))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(outcome(await record(otherHub, id, { condition: 'OK' }, { etag }))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await record(receiver, randomUUID(), { condition: 'OK' }, { etag }))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    const rider = await done.run.rider.client.post(
      CONDITION(id),
      { condition: 'OK' },
      { headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );
    expect(outcome(rider)).toEqual([403, 'PERMISSION_DENIED']);
    expect((await rowOf(id))?.condition).toBe('OK');
  });
});

describe('adjudicateDiscrepancy (AC-SLICE-001-42, -76)', () => {
  // Break caught: the adjudication open to Ops Staff (they do not hold the key), or one that tells them anything of the body: a malformed one is refused before it is read.
  it('is refused to Ops Staff with PERMISSION_DENIED, before the body is read', async () => {
    const { id, receiver } = await counted(3, 1);
    const etag = await etagOf(receiver, id);
    expect(
      outcome(await adjudicate(receiver, id, { outcome: 'ACCEPTED', note: 'fine' }, { etag })),
    ).toEqual([403, 'PERMISSION_DENIED']);
    const malformed = await receiver.client.post(DISCREPANCY(id), '{"broken": ', {
      origin: OPS,
      headers: { 'If-Match': etag, 'Content-Type': 'application/json' },
    });
    expect(outcome(malformed)).toEqual([403, 'PERMISSION_DENIED']);
    expect((await rowOf(id))?.state).toBe('RECONCILIATION_REQUIRED');
  });

  // Break caught: a zero declaration that is cleared for itemization by the count (it must go to reconciliation whatever the variance), one that Ops Staff can resolve, or a resolution without a reason; a
  // count that changes; the case left open by ACCEPTED. AC-SLICE-001-76.
  it('resolves a zero declaration, which went to reconciliation although the count matched, with a reason by Senior Ops; no count changes', async () => {
    const { id, receiver, senior } = await counted(0, 0);
    const before = (await receiver.client.get(ONE(id))).json() as Found;
    expect(before).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      count_variance: 'MATCH',
      count_difference: 0,
      rider_declared_count: 0,
      physical_count: 0,
    });
    // The count that opened the case said why.
    expect((await events('hub.osd.opened', id))[0]).toMatchObject({
      previous_state: 'COUNTED',
      resulting_state: 'RECONCILIATION_REQUIRED',
      detail: { dimension: 'ZERO_DECLARATION', count_variance: 'MATCH' },
    });
    const etag = await etagOf(senior, id);
    // A reason in words: blank is REASON_REQUIRED, not a malformed body.
    for (const note of ['   ', '\t']) {
      expect(
        outcome(await adjudicate(senior, id, { outcome: 'ACCEPTED', note }, { etag })),
      ).toEqual([422, 'REASON_REQUIRED']);
    }
    const response = await adjudicate(
      senior,
      id,
      { outcome: 'ACCEPTED', note: 'The parcels are on the way' },
      { etag },
    );
    expect(response.status).toBe(200);
    const body = response.json() as Found;
    expect(body).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      count_variance: 'MATCH',
      count_difference: 0,
      rider_declared_count: 0,
      physical_count: 0,
    });
    expect(body.condition_findings).toHaveLength(1);
    expect(body.condition_findings?.[0]).toMatchObject({
      kind: 'ADJUDICATION',
      outcome: 'ACCEPTED',
      condition: null,
      note: 'The parcels are on the way',
      recorded_by: senior.identity.id,
    });
    expect(response.header('etag')).not.toBe(etag);
    expect(await rowOf(id)).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      physical_count: 0,
      count_variance: 'MATCH',
      count_difference: 0,
    });
    // The ledger: the adjudication, enhanced, with the reason and the comparison it explains, unchanged.
    const resolved = await events('hub.osd.resolved', id);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      actor_id: senior.identity.id,
      enhanced: true,
      previous_state: 'RECONCILIATION_REQUIRED',
      resulting_state: 'READY_FOR_ITEMIZATION',
      note: 'The parcels are on the way',
      detail: {
        outcome: 'ACCEPTED',
        resolved: true,
        physical_count: 0,
        rider_declared_count: 0,
        count_variance: 'MATCH',
        count_difference: 0,
      },
    });
    // Resolved once: the case is no longer in reconciliation.
    const again = await adjudicate(senior, id, { outcome: 'WRITTEN_OFF', note: 'again' });
    expect([again.status, codeOf(again)]).toEqual([409, 'STATE_CONFLICT']);
    expect((again.json() as { details?: { rule?: string } }).details?.rule).toBe(
      'not_awaiting_resolution',
    );
  });

  // Break caught: an escalation that clears the case (it must record and leave it open), that leaves no finding, or whose ETag does not move although a finding was added (the row did not change).
  it('records an escalation and leaves the case open, moves the ETag with the finding, and lets the case be adjudicated after', async () => {
    const { id, senior } = await counted(3, 1);
    const etag = await etagOf(senior, id);
    const escalated = await adjudicate(
      senior,
      id,
      { outcome: 'ESCALATED', note: 'To the hub manager' },
      { etag },
    );
    expect(escalated.status).toBe(200);
    expect(escalated.json()).toMatchObject({
      state: 'RECONCILIATION_REQUIRED',
      count_variance: 'SHORT',
      count_difference: -2,
    });
    expect(
      (escalated.json() as Found).condition_findings?.map((finding) => finding.outcome),
    ).toEqual(['ESCALATED']);
    expect(escalated.header('etag')).not.toBe(etag);
    const resolved = await events('hub.osd.resolved', id);
    expect(resolved[0]).toMatchObject({
      resulting_state: 'RECONCILIATION_REQUIRED',
      detail: { outcome: 'ESCALATED', resolved: false },
    });
    // The old token is stale; the new one adjudicates, and the findings are in the order they were made.
    expect(
      outcome(await adjudicate(senior, id, { outcome: 'WRITTEN_OFF', note: 'x' }, { etag })),
    ).toEqual([409, 'STATE_CONFLICT']);
    const final = await adjudicate(senior, id, {
      outcome: 'WRITTEN_OFF',
      note: 'Written off by the manager',
    });
    expect(final.status).toBe(200);
    expect(final.json()).toMatchObject({ state: 'READY_FOR_ITEMIZATION' });
    expect((final.json() as Found).condition_findings?.map((finding) => finding.outcome)).toEqual([
      'ESCALATED',
      'WRITTEN_OFF',
    ]);
  });

  // Break caught: a condition the adjudication sets with no evidence, with evidence that is not the intake's or is not stored, or that cannot cite the receiver's photos (it judges them); the adjudicator's own photos
  // (purpose OSD, under its own key) refused.
  it('sets a condition with stored evidence of the intake, the receiver’s photos or its own, and refuses it without', async () => {
    const { id, receiver, senior } = await counted(3, 1);
    const receiverPhoto = await storedIntakeEvidence(routes, receiver, id, 'CONDITION');
    const ownPhoto = await storedIntakeEvidence(routes, senior, id, 'OSD');
    const pending = await pendingIntakeEvidence(routes, senior, id, 'OSD');
    expect(
      outcome(
        await adjudicate(senior, id, { outcome: 'ACCEPTED', condition: 'DAMAGED', note: 'why' }),
      ),
    ).toEqual([422, 'REASON_REQUIRED']);
    expect(
      outcome(
        await adjudicate(senior, id, {
          outcome: 'ACCEPTED',
          condition: 'DAMAGED',
          evidence_ids: [pending],
          note: 'why',
        }),
      ),
    ).toEqual([422, 'EVIDENCE_NOT_STORED']);
    expect((await rowOf(id))?.state).toBe('RECONCILIATION_REQUIRED');
    const done = await adjudicate(senior, id, {
      outcome: 'VENDOR_NOTIFIED',
      condition: 'DAMAGED',
      evidence_ids: [receiverPhoto, ownPhoto],
      note: 'The vendor will be told',
    });
    expect(done.status).toBe(200);
    expect(done.json()).toMatchObject({
      state: 'READY_FOR_ITEMIZATION',
      condition: 'DAMAGED',
      count_variance: 'SHORT',
    });
    expect((done.json() as Found).condition_findings?.[0]).toMatchObject({
      evidence_ids: [receiverPhoto, ownPhoto],
      condition: 'DAMAGED',
      outcome: 'VENDOR_NOTIFIED',
    });
    // The evidence of the adjudication is the adjudicator's act: Ops Staff do not hold its key.
    expect(outcome(await declareIntakeEvidence(receiver, intakeEvidenceBody(id, 'OSD')))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
  });

  // Break caught: an adjudication of an intake that is waiting for its count, or has been cleared; of another hub's intake, or by a rider.
  it('refuses an intake that is not in reconciliation, another hub’s intake, an id that matches nothing and a rider', async () => {
    const { id, senior } = await counted(3, 3);
    const otherHub = await routes.actor(BUNDLE_IDS.seniorOps, HUB_B);
    const waiting =
      (await handOver(routes, vendor, days, { collected: [3], declared: [3] })).intakes[0]?.id ??
      '';
    const etag = await etagOf(senior, id);
    const waitingEtag = await etagOf(senior, waiting);
    const body = { outcome: 'ACCEPTED', note: 'x' };
    expect(outcome(await adjudicate(senior, id, body, { etag }))).toEqual([409, 'STATE_CONFLICT']);
    expect(outcome(await adjudicate(senior, waiting, body, { etag: waitingEtag }))).toEqual([
      409,
      'STATE_CONFLICT',
    ]);
    expect(outcome(await adjudicate(otherHub, id, body, { etag }))).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(outcome(await adjudicate(senior, randomUUID(), body, { etag }))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(outcome(await adjudicate(senior, id, { outcome: 'ACCEPTED' }, { etag }))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(outcome(await adjudicate(senior, id, { outcome: 'LOST', note: 'x' }, { etag }))).toEqual(
      [400, 'VALIDATION_FAILED'],
    );
    expect(
      outcome(await adjudicate(senior, id, { ...body, rider_declared_count: 3 }, { etag })),
    ).toEqual([400, 'VALIDATION_FAILED']);
    expect((await rowOf(id))?.state).toBe('READY_FOR_ITEMIZATION');
  });
});

describe('an authorised act on another hub’s intake is audited', () => {
  // Break caught: a condition or an adjudication by a staff member whose primary hub is not the intake's (a Platform Admin has none) that leaves no trace (audit.md section 5.4).
  it('writes a crossing for a condition and for an adjudication, naming the hub of the intake, and none for the receiver of the hub', async () => {
    const { id, receiver } = await counted(3, 1);
    const admin = await routes.platformAdmin();
    const crossings = (actor: Actor) =>
      routes.rows<{ responsible_hub_id: string }>(
        `select responsible_hub_id from audit_event where event_code = 'auth.hub_boundary.crossed' and object_id = $1 and actor_id = $2`,
        [id, actor.identity.id],
      );
    // The tokens are read by the receiver of the hub, so that nothing the administrator reads is counted: each act is the one that crosses, and only it.
    expect(await crossings(admin)).toEqual([]);
    const recorded = await record(
      admin,
      id,
      { condition: 'OTHER', note: 'Wet' },
      { etag: await etagOf(receiver, id) },
    );
    expect(recorded.status).toBe(200);
    expect(await crossings(admin)).toEqual([{ responsible_hub_id: HUB_A }]);
    const adjudicated = await adjudicate(
      admin,
      id,
      { outcome: 'ACCEPTED', note: 'Accepted' },
      { etag: await etagOf(receiver, id) },
    );
    expect(adjudicated.status).toBe(200);
    expect(await crossings(admin)).toEqual([
      { responsible_hub_id: HUB_A },
      { responsible_hub_id: HUB_A },
    ]);
    // The receiver of the hub itself crosses nothing.
    expect(await crossings(receiver)).toEqual([]);
  });
});

describe('the findings are served on the intake, in the order they were made', () => {
  // Break caught: findings missing from a list of intakes (the queue is read with the same shape as one intake), or shown on an intake that has none; the three OS&D dimensions told together.
  it('serves them in the list as in the read, none for an intake with none, and the three dimensions apart', async () => {
    const { id, receiver, senior } = await counted(3, 1);
    const clean = await counted(3, 3);
    const photo = await storedIntakeEvidence(routes, receiver, id);
    expect(
      (await record(receiver, id, { condition: 'OTHER', note: 'Wet', evidence_ids: [photo] }))
        .status,
    ).toBe(200);
    expect(
      (await adjudicate(senior, id, { outcome: 'ACCEPTED', note: 'Short and wet, accepted' }))
        .status,
    ).toBe(200);
    const listed = await senior.client.get(`${INTAKES}?page_size=100`);
    const items = (listed.json() as { items: Found[] }).items;
    const mine = items.find((item) => item.id === id);
    const theirs = items.find((item) => item.id === clean.id);
    // Count, condition and dispute are independent: a short count, a condition of OTHER and an adjudication, all there, none collapsed into another.
    expect(mine).toMatchObject({
      count_variance: 'SHORT',
      count_difference: -2,
      condition: 'OTHER',
      state: 'READY_FOR_ITEMIZATION',
    });
    expect(mine?.condition_findings?.map((finding) => finding.kind)).toEqual([
      'CONDITION',
      'ADJUDICATION',
    ]);
    expect(theirs?.condition_findings).toBeUndefined();
    expect(Object.keys(theirs ?? {})).not.toContain('condition_findings');
  });
});
