import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  COPIED_COLUMNS,
  FRESH_COLUMNS,
  SET_BY_THE_ACT_COLUMNS,
} from '../../src/pickup/pickup-request-clone.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  insertAdHocSender,
  insertPickupRequest,
  holdingPickupRequest,
  operatingDay,
  pickupRequestRow,
} from './support/pickups.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.15, `resolveCutoffException` against the real application and a real PostgreSQL (state-machines.md section 3; pickup-request.md
 * section 5.2, "Past the hub booking cutoff"; `AC-SLICE-001-04`, `-06`): Ops decides a late booking that waits in `PENDING_OPS_REVIEW`,
 * approving it for its day or cancelling it and cloning it for the next operating day in one act, under a note, once however often sent.
 *
 * A request waiting for a decision is arranged as the administrator: its making is the confirmation's (`pickup-request-confirmation-routes`),
 * and one journey below goes through it to show the two operations agree.
 */
const ONE = (id: string) => `${API}/pickup-requests/${id}`;
const CONFIRM = (id: string) => `${API}/pickup-requests/${id}/confirm`;
const CUTOFF = (id: string) => `${API}/pickup-requests/${id}/cutoff-exception`;
const SAME_DAY = 'APPROVE_SAME_DAY';
const NEXT_DAY = 'RESCHEDULE_NEXT_DAY';
const NOTE = 'Vendor asked by phone and the run is not yet built';

let routes: VendorRoutes;
let ops: Actor;
let opsTwo: Actor;
let opsB: Actor;
let vendorOne: ArrangedVendor;
let vendorInB: ArrangedVendor;
let browserOne: TestClient;
let ahead: string;
let past: string;

beforeAll(async () => {
  // The race of the lock test holds a row until the test has seen the decision wait for it: the test ends the wait and not a bound, so
  // the database's lock bound is lengthened for this application alone. Nothing here tests a timeout.
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  await seedHubConfiguration(routes.database);
  vendorOne = await routes.vendor();
  vendorInB = await routes.vendor({ hubId: HUB_B });
  browserOne = routes.browser(vendorOne.device.credential.token);
  expect(
    (await routes.signIn(browserOne, vendorOne.row.accountIdentifier, vendorOne.secret)).status,
  ).toBe(200);
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsTwo = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  ahead = await operatingDay(routes.admin, 3);
  past = await operatingDay(routes.admin, -2);
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

/** A confirmed request waiting in `PENDING_OPS_REVIEW`: three packages of the first vendor in hub A for a date that has passed. */
const late = async (
  over: Parameters<typeof pickupRequestRow>[2] = {},
  vendor: ArrangedVendor = vendorOne,
  hub: string = HUB_A,
): Promise<string> =>
  (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, hub, {
        serviceDate: past,
        state: 'CONFIRMED',
        cutoffState: 'PENDING_OPS_REVIEW',
        ...over,
      }),
    )
  ).id;

const etagOf = async (actor: Actor, id: string): Promise<string> => {
  const read = await actor.client.get(ONE(id));
  expect(read.status).toBe(200);
  const etag = read.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
};

interface Decision {
  readonly decision?: string;
  readonly note?: unknown;
  readonly extra?: Record<string, unknown>;
}
const resolve = (
  actor: Actor,
  id: string,
  decision: Decision,
  options: { ifMatch?: string | null; key?: string } = {},
): Promise<TestResponse> =>
  actor.client.post(
    CUTOFF(id),
    { decision: decision.decision, note: decision.note, ...decision.extra },
    {
      origin: OPS,
      headers: {
        ...(options.ifMatch === null || options.ifMatch === undefined
          ? {}
          : { 'If-Match': options.ifMatch }),
        'Idempotency-Key': options.key ?? randomUUID(),
      },
    },
  );

/** Resolve with the request's current token, the usual way to a decision. */
const decide = async (
  actor: Actor,
  id: string,
  decision: string,
  note: unknown = NOTE,
): Promise<TestResponse> =>
  resolve(actor, id, { decision, note }, { ifMatch: await etagOf(actor, id) });

interface Resolved {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly cutoff_exception_state: string | null;
  readonly replacement_request_id: string | null;
  readonly cancelled_by_actor_type: string | null;
  readonly cancelled_at: string | null;
  readonly cancellation_reason: unknown;
  readonly cancellation_charge_outcome: unknown;
}
const bodyOf = (response: TestResponse): Resolved => response.json() as Resolved;

const rowOf = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await routes.rows(`select * from pickup_request where id = $1`, [id]);
  if (row === undefined) throw new Error('no such request');
  return row;
};
const countOf = async (): Promise<number> =>
  Number((await routes.rows<{ n: number }>(`select count(*)::int as n from pickup_request`))[0]?.n);

interface Event {
  readonly actor_id: string | null;
  readonly enhanced: boolean;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly note: string | null;
  readonly before_after: Record<string, unknown> | null;
  readonly related_ids: Record<string, unknown> | null;
  readonly detail: Record<string, unknown>;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
}
const eventsOf = (id: string, code: string): Promise<Event[]> =>
  routes.rows<Event>(
    `select actor_id, enhanced, previous_state, resulting_state, note, before_after, related_ids, detail, responsible_hub_id, vendor_organization_id
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, id],
  );
const RESOLVED = 'pickup.request.cutoff_exception_resolved';

/** The day after a date on which the hub operates (Monday to Saturday), worked out by the database and not by the code under test. */
const dayAfter = async (date: string): Promise<string> => {
  const [row] = await routes.rows<{ day: string }>(
    `select to_char(d + case when extract(isodow from d + 1) = 7 then 2 else 1 end, 'YYYY-MM-DD') as day from (select $1::date as d) t`,
    [date],
  );
  if (row === undefined) throw new Error('the database gave no date');
  return row.day;
};

/** A refusal changed nothing: the request still waits for its decision, at the same version, with no clone and no event. */
const expectUndecided = async (id: string, before: number): Promise<void> => {
  const row = await rowOf(id);
  expect([row.state, row.cutoff_exception_state, row.replacement_request_id, row.version]).toEqual([
    'CONFIRMED',
    'PENDING_OPS_REVIEW',
    null,
    1,
  ]);
  expect(await countOf()).toBe(before);
  expect(await eventsOf(id, RESOLVED)).toEqual([]);
};

describe('a same-day exception is approved', () => {
  // Break caught: the request cancelled, cloned or left queued by an approval, or its exception state not settled.
  it('keeps the request confirmed and settles its exception as SAME_DAY_APPROVED, with no clone', async () => {
    const id = await late();
    const before = await countOf();
    const answer = await decide(ops, id, SAME_DAY);

    expect(answer.status).toBe(200);
    expect(bodyOf(answer)).toMatchObject({
      id,
      state: 'CONFIRMED',
      cutoff_exception_state: 'SAME_DAY_APPROVED',
      replacement_request_id: null,
    });
    expect(await countOf()).toBe(before);
    expect(await rowOf(id)).toMatchObject({
      state: 'CONFIRMED',
      cutoff_exception_state: 'SAME_DAY_APPROVED',
      version: 2,
    });
    // The token of the answer is the one a fresh read hands out.
    expect(answer.header('etag')).toBe(await etagOf(ops, id));
  });

  // Break caught: a decision that leaves no enhanced record, or not the note, the decision and the actor (an Ops override of a hub rule).
  it('records one enhanced event with the decision, the actor and the note', async () => {
    const id = await late();
    expect((await decide(ops, id, SAME_DAY)).status).toBe(200);

    expect(await eventsOf(id, RESOLVED)).toEqual([
      {
        actor_id: ops.identity.id,
        enhanced: true,
        previous_state: 'CONFIRMED',
        resulting_state: 'CONFIRMED',
        note: NOTE,
        before_after: {
          cutoff_exception_state: { before: 'PENDING_OPS_REVIEW', after: 'SAME_DAY_APPROVED' },
        },
        related_ids: {},
        detail: { decision: SAME_DAY, cutoff_exception_state: 'SAME_DAY_APPROVED' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
    expect(await eventsOf(id, 'pickup.request.created')).toEqual([]);
  });
});

describe('a booking is rescheduled to the next operating day (AC-SLICE-001-06)', () => {
  // Break caught: a source left active beside its clone, a clone not linked to it, or a cancellation that lacks who made it and when.
  it('cancels the source as RESCHEDULED and makes a PENDING clone linked to it, never both active', async () => {
    const id = await late();
    const before = await countOf();
    const answer = await decide(ops, id, NEXT_DAY);

    expect(answer.status).toBe(200);
    const source = bodyOf(answer);
    expect(source).toMatchObject({
      id,
      state: 'CANCELLED',
      cutoff_exception_state: 'RESCHEDULED',
      cancelled_by_actor_type: 'OPS',
      cancellation_reason: null,
      cancellation_charge_outcome: null,
    });
    expect(source.cancelled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const cloneId = source.replacement_request_id;
    expect(cloneId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await countOf()).toBe(before + 1);

    const storedSource = await rowOf(id);
    expect(storedSource).toMatchObject({
      state: 'CANCELLED',
      cancelled_by: ops.identity.id,
      replacement_request_id: cloneId,
    });
    const clone = await rowOf(cloneId ?? '');
    expect(clone).toMatchObject({
      state: 'PENDING',
      replaces_request_id: id,
      created_by: ops.identity.id,
      cutoff_exception_state: null,
      confirmed_at: null,
      cancelled_at: null,
      estimate_snapshot: null,
      rider_assigned: false,
      version: 1,
    });
    // The two are never both active (AC-06).
    const active = [storedSource, clone].filter(
      (each) => each.state === 'PENDING' || each.state === 'CONFIRMED',
    );
    expect(active).toHaveLength(1);
    // The token of the answer is the one a fresh read of the source hands out.
    expect(answer.header('etag')).toBe(await etagOf(ops, id));
  });

  // Break caught: a clone for the same day (still late), for a Sunday, or in the past because the request was confirmed days late.
  it('is for the next operating day after today when the date has passed, and never a Sunday', async () => {
    const id = await late({ serviceDate: past });
    const cloneId = bodyOf(await decide(ops, id, NEXT_DAY)).replacement_request_id ?? '';
    const [stored] = await routes.rows<{ day: string; isodow: number }>(
      `select scheduled_service_date::text as day, extract(isodow from scheduled_service_date)::int as isodow from pickup_request where id = $1`,
      [cloneId],
    );
    // The database's own tomorrow on the hub's clock, moved off a Sunday.
    expect(stored?.day).toBe(await operatingDay(routes.admin, 1));
    expect(stored?.isodow).not.toBe(7);
  });

  // Break caught: today taken as the starting point whatever the service date, which moves a request dated ahead back toward today.
  it('counts from the service date when that is later than today', async () => {
    const id = await late({ serviceDate: ahead });
    const cloneId = bodyOf(await decide(ops, id, NEXT_DAY)).replacement_request_id ?? '';
    const [stored] = await routes.rows<{ day: string }>(
      `select scheduled_service_date::text as day from pickup_request where id = $1`,
      [cloneId],
    );
    expect(stored?.day).toBe(await dayAfter(ahead));
  });

  // Break caught: the clone not carrying the booking (a payer arrangement, a location, the acknowledged cap), or carrying a charge or a cancellation.
  it('carries the booking to the clone column for column, and starts everything else fresh', async () => {
    const sender = await insertAdHocSender(routes.admin, { state: 'REUSABLE' });
    const id = await late({
      intent: 'ADHOC_SENDER',
      vendorOrganizationId: null,
      adHocSenderId: sender.id,
      packages: 4,
      attemptNumber: 2,
    });
    await routes.admin.query(
      `update pickup_request set secondary_phone = '+233200000077', current_item_description = 'Phone accessories',
         default_payer_intent = 'SPLIT', split_basis = 'PERCENTAGE', split_sender_percentage = 40.5, declared_value_minor = 90000,
         liability_cap_acknowledged_at = now(), liability_cap_snapshot = '{"amount_minor":30000,"setting_key":"liability_cap_amount","effective_version":"UNVERSIONED"}'::jsonb,
         location_overrides = '{"address":"Today only: the Osu pop-up"}'::jsonb, pickup_location = '{"address":"Kiosk by the Tema station"}'::jsonb
       where id = $1`,
      [id],
    );
    const cloneId = bodyOf(await decide(ops, id, NEXT_DAY)).replacement_request_id ?? '';
    const source = await rowOf(id);
    const clone = await rowOf(cloneId);

    for (const column of COPIED_COLUMNS) {
      expect(clone[column], column).toEqual(source[column]);
    }
    expect(clone).toMatchObject({
      declared_package_count: 4,
      attempt_number: 2,
      default_payer_intent: 'SPLIT',
      split_basis: 'PERCENTAGE',
      declared_value_minor: 90000,
      secondary_phone: '+233200000077',
    });
    // Its own identity and code, with the hub prefix of the one it replaces.
    expect(clone.id).not.toBe(id);
    expect(clone.code).not.toBe(source.code);
    expect(String(clone.code)).toMatch(/^ACC-PR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    // Nothing of the source's cancellation or confirmation is carried.
    for (const column of [
      'cancelled_by',
      'cancelled_by_actor_type',
      'cancellation_reason_code',
      'cancellation_charge_outcome',
      'cancellation_charge_snapshot',
      'replacement_request_id',
      'confirmed_by',
      'confirmed_at',
    ]) {
      expect(clone[column], column).toBeNull();
    }
  });

  // Break caught: a column added to the table that no clone decision covers (carried, set or reset), the day a charge or a manifest fact arrives.
  it('has every column of the table classified as carried, set by the act, or fresh', async () => {
    const columns = (
      await routes.rows<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'pickup_request'`,
      )
    ).map((row) => row.column_name);
    const classified = [...COPIED_COLUMNS, ...SET_BY_THE_ACT_COLUMNS, ...FRESH_COLUMNS];
    expect([...classified].sort()).toEqual([...columns].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  // Break caught: the cap refusing, or counting, a reschedule that is no attempt (the operation names no such refusal), or an extension lost.
  it('keeps the attempt number and its extension, as no pickup was attempted', async () => {
    const extension = randomUUID();
    const id = await late({ attemptNumber: 4, attemptExtensionId: extension });
    const cloneId = bodyOf(await decide(ops, id, NEXT_DAY)).replacement_request_id ?? '';
    expect(await rowOf(cloneId)).toMatchObject({
      attempt_number: 4,
      attempt_extension_id: extension,
    });
  });

  // Break caught: events that leave the clone without a start to its timeline, or that name no link between the two.
  it('records the decision with the replacement link, and opens the clone’s own timeline', async () => {
    const id = await late();
    const cloneId = bodyOf(await decide(ops, id, NEXT_DAY)).replacement_request_id ?? '';

    expect(await eventsOf(id, RESOLVED)).toEqual([
      {
        actor_id: ops.identity.id,
        enhanced: true,
        previous_state: 'CONFIRMED',
        resulting_state: 'CANCELLED',
        note: NOTE,
        before_after: {
          state: { before: 'CONFIRMED', after: 'CANCELLED' },
          cutoff_exception_state: { before: 'PENDING_OPS_REVIEW', after: 'RESCHEDULED' },
          replacement_request_id: { before: null, after: cloneId },
        },
        related_ids: { replacement_request_id: cloneId },
        detail: { decision: NEXT_DAY, cutoff_exception_state: 'RESCHEDULED' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
    expect(await eventsOf(cloneId, 'pickup.request.created')).toEqual([
      {
        actor_id: ops.identity.id,
        enhanced: false,
        previous_state: null,
        resulting_state: 'PENDING',
        note: null,
        before_after: null,
        related_ids: { replaces_request_id: id },
        detail: { pickup_intent: 'OWN_PACKAGES', declared_package_count: 3 },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
  });

  // Break caught: the two operations disagreeing: a late booking confirmed, rescheduled, and its clone then not confirmable on time.
  it('gives a clone that Ops can read, confirm and find on time', async () => {
    const id = await late({ state: 'PENDING', cutoffState: undefined as never });
    const confirmed = await ops.client.post(CONFIRM(id), undefined, {
      origin: OPS,
      headers: { 'If-Match': await etagOf(ops, id) },
    });
    expect(confirmed.status).toBe(200);
    expect(bodyOf(confirmed).cutoff_exception_state).toBe('PENDING_OPS_REVIEW');

    const cloneId = bodyOf(await decide(ops, id, NEXT_DAY)).replacement_request_id ?? '';
    const read = await ops.client.get(ONE(cloneId));
    expect(read.status).toBe(200);
    expect(bodyOf(read)).toMatchObject({ state: 'PENDING', cutoff_exception_state: null });
    const again = await ops.client.post(CONFIRM(cloneId), undefined, {
      origin: OPS,
      headers: { 'If-Match': await etagOf(ops, cloneId) },
    });
    expect(again.status).toBe(200);
    expect(bodyOf(again)).toMatchObject({ state: 'CONFIRMED', cutoff_exception_state: null });
  });
});

describe('only a booking waiting for a decision can be decided', () => {
  // Break caught: a decision on a request that is not waiting (never late, already decided, or no longer confirmed).
  it.each([
    ['pending', { state: 'PENDING', cutoffState: undefined }],
    ['confirmed on time', { state: 'CONFIRMED', cutoffState: undefined }],
    ['already approved', { state: 'CONFIRMED', cutoffState: 'SAME_DAY_APPROVED' as const }],
    ['already rescheduled', { state: 'CANCELLED', cutoffState: 'RESCHEDULED' as const }],
  ])(
    'refuses a request that is %s with STATE_CONFLICT and changes nothing',
    async (_name, over) => {
      const id = await late(over as never);
      const before = await countOf();
      const answer = await decide(ops, id, NEXT_DAY);
      expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
      expect(await countOf()).toBe(before);
      expect(await eventsOf(id, RESOLVED)).toEqual([]);
    },
  );

  // Break caught: a decision taken twice, the second silently overwriting the first (a request approved and then also rescheduled).
  it('lets exactly one of two concurrent decisions win and tells the other STATE_CONFLICT', async () => {
    const id = await late();
    const etag = await etagOf(ops, id);
    const before = await countOf();

    const [approve, reschedule] = await Promise.all([
      resolve(ops, id, { decision: SAME_DAY, note: NOTE }, { ifMatch: etag }),
      resolve(opsTwo, id, { decision: NEXT_DAY, note: NOTE }, { ifMatch: etag }),
    ]);

    const outcomes = [approve, reschedule]
      .map((each) =>
        each.status === 200 ? '200' : `${String(each.status)} ${String(codeOf(each))}`,
      )
      .sort();
    expect(outcomes).toEqual(['200', '409 STATE_CONFLICT']);
    const row = await rowOf(id);
    // Whichever won, the request is settled once and consistently.
    if (approve.status === 200) {
      expect([row.state, row.cutoff_exception_state, await countOf()]).toEqual([
        'CONFIRMED',
        'SAME_DAY_APPROVED',
        before,
      ]);
    } else {
      expect([row.state, row.cutoff_exception_state, await countOf()]).toEqual([
        'CANCELLED',
        'RESCHEDULED',
        before + 1,
      ]);
    }
    expect(await eventsOf(id, RESOLVED)).toHaveLength(1);
  });

  // Break caught: the version compared outside the request's lock, so that a request approved or rescheduled on the token of a read that
  // a change committed while the decision waited has made stale. The race is made, not hoped for (see the confirmation's twin).
  it('compares the version under the lock: a change committed while the decision waits is seen by it', async () => {
    const id = await late();
    const etag = await etagOf(ops, id);
    const before = await countOf();
    const held = await holdingPickupRequest(routes.database, id);
    let deciding: Promise<TestResponse> | undefined;
    try {
      deciding = resolve(ops, id, { decision: NEXT_DAY, note: NOTE }, { ifMatch: etag });
      await waitUntilBlockedBy(routes.admin, held.pid, 'the decision', deciding);
      await held.client.query(
        `update pickup_request set secondary_phone = '+233200000008' where id = $1`,
        [id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await deciding?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await deciding;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await countOf()).toBe(before);
    expect(await eventsOf(id, RESOLVED)).toEqual([]);
    expect((await rowOf(id)).cutoff_exception_state).toBe('PENDING_OPS_REVIEW');
  });

  // Break caught: a stale, missing, weak or foreign token accepted, so that a client that never read the request can decide it.
  it('refuses a stale token, a weak one, the token of another request, and no token at all', async () => {
    const id = await late();
    const other = await late();
    const before = await countOf();
    const etag = await etagOf(ops, id);

    for (const wrong of [`W/${etag}`, etag.slice(1, -1), await etagOf(ops, other), '*']) {
      const answer = await resolve(ops, id, { decision: SAME_DAY, note: NOTE }, { ifMatch: wrong });
      expect([answer.status, codeOf(answer)], wrong).toEqual([409, 'STATE_CONFLICT']);
    }
    const missing = await resolve(ops, id, { decision: SAME_DAY, note: NOTE }, { ifMatch: null });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
    await expectUndecided(id, before);

    await routes.admin.query(
      `update pickup_request set secondary_phone = '+233200000009' where id = $1`,
      [id],
    );
    const stale = await resolve(ops, id, { decision: SAME_DAY, note: NOTE }, { ifMatch: etag });
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
  });
});

describe('the note that explains the decision', () => {
  // Break caught: a decision taken with no reason, which the audit record exists to give (blank is REASON_REQUIRED).
  it.each([
    ['spaces', '   '],
    ['a tab and spaces', ' \t '],
    ['a line break', '\n'],
  ])('refuses a note of %s as REASON_REQUIRED and changes nothing', async (_name, note) => {
    const id = await late();
    const before = await countOf();
    const answer = await decide(ops, id, NEXT_DAY, note);
    expect([answer.status, codeOf(answer)]).toEqual([422, 'REASON_REQUIRED']);
    await expectUndecided(id, before);
  });

  // Break caught: a malformed body answered as a missing reason, or accepted, or an unknown decision acted on.
  it.each([
    ['no note', { decision: SAME_DAY }],
    ['an empty note', { decision: SAME_DAY, note: '' }],
    ['a note that is not text', { decision: SAME_DAY, note: 7 }],
    ['no decision', { note: NOTE }],
    ['an unknown decision', { decision: 'DECLINE', note: NOTE }],
    [
      'a member the contract does not name',
      { decision: SAME_DAY, note: NOTE, extra: { price: 1 } },
    ],
  ])('refuses %s as a validation failure and changes nothing', async (_name, decision) => {
    const id = await late();
    const before = await countOf();
    const answer = await resolve(ops, id, decision, { ifMatch: await etagOf(ops, id) });
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
    await expectUndecided(id, before);
  });

  // Break caught: a note the ledger will not keep accepted here, so the decision fails as an unexplained 500 after it has begun.
  it('refuses a note the audit record would not keep, before anything is decided', async () => {
    const id = await late();
    const before = await countOf();
    // (The ledger refuses an international number, an address, a control character and a note past 1000 characters.)
    for (const note of [
      'Call him on +233244123456',
      'Write to ama@example.com',
      'x'.repeat(1001),
      'two\nlines',
    ]) {
      const answer = await decide(ops, id, SAME_DAY, note);
      expect([answer.status, codeOf(answer)], note.slice(0, 20)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    await expectUndecided(id, before);
  });
});

describe('once however many times it is sent', () => {
  // Break caught: a retry that makes a second clone, or answers differently from the first answer.
  it('replays the original answer for the same key and body and makes no second clone', async () => {
    const id = await late();
    const etag = await etagOf(ops, id);
    const key = randomUUID();
    const before = await countOf();

    const first = await resolve(
      ops,
      id,
      { decision: NEXT_DAY, note: NOTE },
      { ifMatch: etag, key },
    );
    const second = await resolve(
      ops,
      id,
      { decision: NEXT_DAY, note: NOTE },
      { ifMatch: etag, key },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.header('etag')).toBe(first.header('etag'));
    expect(await countOf()).toBe(before + 1);
    expect(await eventsOf(id, RESOLVED)).toHaveLength(1);
  });

  // Break caught: a key reused for a different decision treated as the same command.
  it('refuses the same key with another decision as IDEMPOTENCY_KEY_CONFLICT', async () => {
    const id = await late();
    const etag = await etagOf(ops, id);
    const key = randomUUID();
    expect(
      (await resolve(ops, id, { decision: SAME_DAY, note: NOTE }, { ifMatch: etag, key })).status,
    ).toBe(200);

    const other = await resolve(
      ops,
      id,
      { decision: NEXT_DAY, note: NOTE },
      { ifMatch: etag, key },
    );
    expect([other.status, codeOf(other)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect((await rowOf(id)).cutoff_exception_state).toBe('SAME_DAY_APPROVED');
  });

  it('refuses a request with no Idempotency-Key and one with a key that is not a token', async () => {
    const id = await late();
    const before = await countOf();
    const etag = await etagOf(ops, id);
    const missing = await ops.client.post(
      CUTOFF(id),
      { decision: SAME_DAY, note: NOTE },
      { origin: OPS, headers: { 'If-Match': etag } },
    );
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
    // (A key is one to 128 characters with no control character; "two words" is a key. A key of 129 characters is not.)
    const bad = await resolve(
      ops,
      id,
      { decision: SAME_DAY, note: NOTE },
      { ifMatch: etag, key: 'k'.repeat(129) },
    );
    expect([bad.status, codeOf(bad)]).toEqual([400, 'VALIDATION_FAILED']);
    await expectUndecided(id, before);
  });
});

describe('who may decide, and which request', () => {
  // Break caught: Ops deciding a request of a hub outside its grant, or told it does not exist when it does.
  it('tells Ops a request outside its hubs from one that does not exist', async () => {
    const id = await late({}, vendorInB, HUB_B);
    const before = await countOf();
    const outside = await resolve(
      ops,
      id,
      { decision: SAME_DAY, note: NOTE },
      { ifMatch: await etagOf(opsB, id) },
    );
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await resolve(
      ops,
      randomUUID(),
      { decision: SAME_DAY, note: NOTE },
      { ifMatch: '"x"' },
    );
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    await expectUndecided(id, before);
  });

  // Break caught: a vendor deciding on its own late booking, or a holder of other keys deciding.
  it('refuses a vendor, a holder of another bundle’s keys and a caller with no session', async () => {
    const id = await late();
    const before = await countOf();
    const etag = await etagOf(ops, id);
    const body = { decision: SAME_DAY, note: NOTE };
    const asVendor = await browserOne.post(CUTOFF(id), body, {
      headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
    });
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const asFinance = await resolve(finance, id, body, { ifMatch: etag });
    expect([asFinance.status, codeOf(asFinance)]).toEqual([403, 'PERMISSION_DENIED']);
    const anonymous = await routes.browser().post(CUTOFF(id), body, {
      origin: OPS,
      headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
    });
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    await expectUndecided(id, before);
  });

  it('refuses an id that is not a UUID as a validation failure', async () => {
    const answer = await resolve(
      ops,
      'not-a-uuid',
      { decision: SAME_DAY, note: NOTE },
      { ifMatch: '"x"' },
    );
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: Senior Ops, who hold the key by their bundle, not able to decide, or a decision attributed to the wrong person.
  it('lets Senior Ops decide as well, in their own name', async () => {
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const id = await late();
    expect((await decide(senior, id, SAME_DAY)).status).toBe(200);
    expect((await eventsOf(id, RESOLVED))[0]?.actor_id).toBe(senior.identity.id);
  });
});
