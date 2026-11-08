import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nextOperatingDay } from '../../src/pickup/booking-rules.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import { newBundle, grant } from './support/policy-fixtures.js';
import {
  exceptionRow,
  holdingPickupRequest,
  insertOnePackageException,
  insertPickupRequest,
  operatingDay,
  pickupRequestRow,
  setHubSetting,
} from './support/pickups.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.17, `cancelPickupRequest` and `waiveCancellationCharge` against the real application and a real PostgreSQL (`AC-SLICE-001-05`, `-60` to
 * `-64`, `-79`; pickup-request.md sections 5.2 to 5.4; state-machines.md section 3; `MSC-DEC-196`, `-197`, `-388`): a vendor cancels only its
 * own `PENDING` request; Ops cancels at every point, with no charge before a rider is assigned; after assignment the charge is **discretionary**
 * and always a recorded outcome (`APPLIED`, `NOT_APPLIED`, `UNAVAILABLE`, `EXEMPT`), never a null and never `SETTING_MISSING`; and only Senior Ops
 * relieves an applied charge, in full, under a note.
 *
 * The reasons are fixtures of the tests' own: the codes of the `PICKUP_CANCELLATION` domain are the Product Owner's to supply (D-05) and none is
 * seeded, so these tests prove the mechanism and not a catalogue.
 */
const ONE = (id: string) => `${API}/pickup-requests/${id}`;
const CANCEL = (id: string) => `${API}/pickup-requests/${id}/cancel`;
const WAIVE = (id: string) => `${API}/pickup-requests/${id}/cancellation-charge/waiver`;
const WAIVER_NOTE = 'The vendor is a long-standing customer and the rider was not yet dispatched';

const REASONS = {
  customer: 'FIXTURE_CANCEL_CUSTOMER',
  external: 'FIXTURE_CANCEL_EXTERNAL',
  melarc: 'FIXTURE_CANCEL_MELARC',
  needsNote: 'FIXTURE_CANCEL_NEEDS_NOTE',
  retired: 'FIXTURE_CANCEL_RETIRED',
  otherDomain: 'FIXTURE_FAILURE_OTHER_DOMAIN',
} as const;

let routes: VendorRoutes;
let ops: Actor;
let opsTwo: Actor;
let senior: Actor;
let opsB: Actor;
let agent: Actor;
let agentTwo: Actor;
let vendorOne: ArrangedVendor;
let vendorTwo: ArrangedVendor;
let vendorInB: ArrangedVendor;
let browserOne: TestClient;
let browserTwo: TestClient;
let ahead: string;

beforeAll(async () => {
  // The race of the lock test holds a row until the test has seen the cancellation wait for it: the test ends the wait and not a bound, so the
  // database's lock bound is lengthened for this application alone. Nothing here tests a timeout.
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  await seedHubConfiguration(routes.database);
  vendorOne = await routes.vendor();
  vendorTwo = await routes.vendor();
  vendorInB = await routes.vendor({ hubId: HUB_B });
  browserOne = routes.browser(vendorOne.device.credential.token);
  browserTwo = routes.browser(vendorTwo.device.credential.token);
  for (const [browser, vendor] of [
    [browserOne, vendorOne],
    [browserTwo, vendorTwo],
  ] as const) {
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
  }
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsTwo = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  // The reschedules have their own Ops members: the API limits the requests one principal makes in a minute, and the file is run inside one.
  agent = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  agentTwo = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  ahead = await operatingDay(routes.admin, 3);
  const reason = (
    code: string,
    domain: string,
    attribution: string,
    over: { requiresNote?: boolean; active?: boolean } = {},
  ): Promise<unknown> =>
    routes.admin.query(
      `insert into reason_code (code, domain, label, attribution, requires_note, active) values ($1, $2, $3, $4, $5, $6)`,
      [
        code,
        domain,
        `Fixture ${code}`,
        attribution,
        over.requiresNote ?? false,
        over.active ?? true,
      ],
    );
  await reason(REASONS.customer, 'PICKUP_CANCELLATION', 'CUSTOMER');
  await reason(REASONS.external, 'PICKUP_CANCELLATION', 'EXTERNAL');
  await reason(REASONS.melarc, 'PICKUP_CANCELLATION', 'MELARC');
  await reason(REASONS.needsNote, 'PICKUP_CANCELLATION', 'CUSTOMER', { requiresNote: true });
  await reason(REASONS.retired, 'PICKUP_CANCELLATION', 'CUSTOMER', { active: false });
  await reason(REASONS.otherDomain, 'PICKUP_FAILURE', 'CUSTOMER');
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

/** A request of the first vendor in hub A, `PENDING` unless the test says otherwise. */
const arrange = async (
  over: Parameters<typeof pickupRequestRow>[2] & { assigned?: boolean } = {},
  vendor: ArrangedVendor = vendorOne,
  hub: string = HUB_A,
): Promise<string> => {
  const { assigned, ...row } = over;
  const id = (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, hub, { serviceDate: ahead, ...row }),
    )
  ).id;
  if (assigned === true) {
    await routes.admin.query(`update pickup_request set rider_assigned = true where id = $1`, [id]);
  }
  return id;
};
/** A confirmed request whose manifest already has an assigned rider (the manifest tables arrive in S1.20; the fact is the request's own). */
const assigned = (vendor: ArrangedVendor = vendorOne, hub: string = HUB_A): Promise<string> =>
  arrange({ state: 'CONFIRMED', assigned: true }, vendor, hub);

const etagOf = async (client: TestClient, id: string): Promise<string> => {
  const read = await client.get(ONE(id));
  expect(read.status).toBe(200);
  const etag = read.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
};
const tokenOf = async (who: Actor | TestClient, id: string): Promise<string> =>
  etagOf('client' in who ? who.client : who, id);

interface CancelBody {
  readonly reason_code?: unknown;
  readonly note?: unknown;
  readonly create_replacement?: unknown;
  readonly apply_charge?: unknown;
  readonly charge_reason_code?: unknown;
  readonly extra?: Record<string, unknown>;
}
const cancelBody = (body: CancelBody): Record<string, unknown> => ({
  reason_code: body.reason_code,
  note: body.note,
  create_replacement: body.create_replacement,
  apply_charge: body.apply_charge,
  charge_reason_code: body.charge_reason_code,
  ...body.extra,
});
const cancel = (
  who: Actor | TestClient,
  id: string,
  body: CancelBody,
  options: { ifMatch?: string | null; key?: string } = {},
): Promise<TestResponse> => {
  const client = 'client' in who ? who.client : who;
  const origin = 'client' in who ? { origin: OPS } : {};
  return client.post(CANCEL(id), cancelBody(body), {
    ...origin,
    headers: {
      ...(options.ifMatch === null || options.ifMatch === undefined
        ? {}
        : { 'If-Match': options.ifMatch }),
      'Idempotency-Key': options.key ?? randomUUID(),
    },
  });
};
/** Cancel with the request's current token, the usual way. */
const cancelNow = async (
  who: Actor | TestClient,
  id: string,
  body: CancelBody,
): Promise<TestResponse> => cancel(who, id, body, { ifMatch: await tokenOf(who, id) });

interface Cancelled {
  readonly id: string;
  readonly state: string;
  readonly cancelled_by_actor_type: string | null;
  readonly cancelled_at: string | null;
  readonly cancellation_reason: { code: string; label: string } | null;
  readonly cancellation_charge_outcome: string | null;
  readonly cancellation_charge: { amount_minor: number; currency: string } | null;
  readonly cancellation_charge_snapshot: {
    amount_minor: number;
    setting_key: string;
    effective_version: string;
  } | null;
  readonly replacement_request_id: string | null;
}
const bodyOf = (response: TestResponse): Cancelled => response.json() as Cancelled;

const rowOf = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await routes.rows(`select * from pickup_request where id = $1`, [id]);
  if (row === undefined) throw new Error('no such request');
  return row;
};
const countOf = async (): Promise<number> =>
  Number((await routes.rows<{ n: number }>(`select count(*)::int as n from pickup_request`))[0]?.n);

interface Event {
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly enhanced: boolean;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly reason_code: string | null;
  readonly reason_label: string | null;
  readonly note: string | null;
  readonly before_after: Record<string, unknown> | null;
  readonly detail: Record<string, unknown>;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
}
const eventsOf = (id: string, code: string): Promise<Event[]> =>
  routes.rows<Event>(
    `select actor_type, actor_id, enhanced, previous_state, resulting_state, reason_code, reason_label, note, before_after, detail,
            responsible_hub_id, vendor_organization_id
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, id],
  );
const CANCELLED = 'pickup.request.cancelled';
const CHARGEABLE = 'pickup.request.cancelled_chargeable';
const WAIVED = 'pickup.cancellation_charge.waived';

/** A refusal changed nothing: the request is as it was, at the same version, and nothing was recorded or made. */
const expectUntouched = async (id: string, state = 'PENDING', before = 1): Promise<void> => {
  const row = await rowOf(id);
  expect([row.state, row.version, row.cancelled_at, row.cancellation_charge_outcome]).toEqual([
    state,
    before,
    null,
    null,
  ]);
  for (const code of [CANCELLED, CHARGEABLE, WAIVED])
    expect(await eventsOf(id, code), code).toEqual([]);
};

describe('a vendor cancels its own pending request (AC-SLICE-001-05, -79)', () => {
  // Break caught: the vendor unable to cancel what it booked, a cancellation that records no actor or reason, or that carries a charge.
  it('cancels it, free of charge, as the vendor, with the reason it gave', async () => {
    const id = await arrange();
    const answer = await cancelNow(browserOne, id, { reason_code: REASONS.customer });

    expect(answer.status).toBe(200);
    const request = bodyOf(answer);
    expect(request).toMatchObject({
      id,
      state: 'CANCELLED',
      cancelled_by_actor_type: 'VENDOR',
      cancellation_reason: { code: REASONS.customer, label: `Fixture ${REASONS.customer}` },
      cancellation_charge_outcome: null,
      cancellation_charge: null,
      cancellation_charge_snapshot: null,
      replacement_request_id: null,
    });
    expect(request.cancelled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const stored = await rowOf(id);
    expect(stored).toMatchObject({
      state: 'CANCELLED',
      cancelled_by: vendorOne.row.accountId,
      cancelled_by_actor_type: 'VENDOR',
      version: 2,
    });
    // The token of the answer is the one a fresh read hands out.
    expect(answer.header('etag')).toBe(await etagOf(browserOne, id));
  });

  // Break caught: the cancellation written outside the transaction of the act, as the wrong actor, or as the chargeable kind.
  it('writes pickup.request.cancelled as the vendor’s account, with the reason as it was', async () => {
    const id = await arrange();
    expect((await cancelNow(browserOne, id, { reason_code: REASONS.customer })).status).toBe(200);
    expect(await eventsOf(id, CANCELLED)).toEqual([
      {
        actor_type: 'VENDOR_ACCOUNT',
        actor_id: vendorOne.row.accountId,
        enhanced: false,
        previous_state: 'PENDING',
        resulting_state: 'CANCELLED',
        reason_code: REASONS.customer,
        reason_label: `Fixture ${REASONS.customer}`,
        note: null,
        before_after: null,
        detail: { cancelled_by_actor_type: 'VENDOR' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
    expect(await eventsOf(id, CHARGEABLE)).toEqual([]);
  });

  // Break caught: a vendor cancelling a confirmed request (AC-05: PERMISSION_DENIED; the office still can), or the request changed by the refusal.
  it('is refused PERMISSION_DENIED for a confirmed request, which the office can still cancel', async () => {
    const id = await arrange({ state: 'CONFIRMED' });
    const refused = await cancelNow(browserOne, id, { reason_code: REASONS.customer });
    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    await expectUntouched(id, 'CONFIRMED');

    const office = await cancelNow(ops, id, { reason_code: REASONS.customer });
    expect(office.status).toBe(200);
    expect(bodyOf(office)).toMatchObject({ state: 'CANCELLED', cancelled_by_actor_type: 'OPS' });
  });

  // Break caught: a vendor told that another vendor's request exists (AC-79): the answer must be the one for an id that matches nothing.
  it('answers another vendor’s request exactly as an id that matches nothing', async () => {
    const theirs = await arrange({}, vendorTwo);
    const body = { reason_code: REASONS.customer };
    const other = await cancel(browserOne, theirs, body, { ifMatch: '"x"' });
    const none = await cancel(browserOne, randomUUID(), body, { ifMatch: '"x"' });
    expect([other.status, codeOf(other)]).toEqual([404, 'NOT_FOUND']);
    expect(none.status).toBe(404);
    const shape = (response: TestResponse) => ({
      status: response.status,
      body: { ...(response.json() as Record<string, unknown>), request_id: undefined },
    });
    expect(shape(other)).toEqual(shape(none));
    await expectUntouched(theirs);
  });

  // Break caught: a vendor electing a charge (it may never), or naming a charge reason.
  it('may never elect or explain a charge', async () => {
    const id = await arrange();
    for (const extra of [
      { apply_charge: true },
      { apply_charge: false },
      { charge_reason_code: REASONS.customer },
    ]) {
      const answer = await cancel(
        browserOne,
        id,
        { reason_code: REASONS.customer, ...extra },
        { ifMatch: await tokenOf(browserOne, id) },
      );
      expect([answer.status, codeOf(answer)], JSON.stringify(extra)).toEqual([
        403,
        'PERMISSION_DENIED',
      ]);
    }
    await expectUntouched(id);
  });
});

describe('Ops cancels at any point, with no charge before a rider is assigned', () => {
  // Break caught: the office unable to cancel a pending or a confirmed request, or a charge decision demanded where no rider is committed.
  it.each([
    ['a pending request', { state: 'PENDING' as const }],
    ['a confirmed request that has no rider yet', { state: 'CONFIRMED' as const }],
  ])('cancels %s free of charge, as Ops', async (_name, over) => {
    const id = await arrange(over);
    const answer = await cancelNow(ops, id, { reason_code: REASONS.melarc });
    expect(answer.status).toBe(200);
    expect(bodyOf(answer)).toMatchObject({
      state: 'CANCELLED',
      cancelled_by_actor_type: 'OPS',
      // No rider is committed: there is no charge to decide, so there is no outcome to record (the five outcomes are of a post-assignment cancellation).
      cancellation_charge_outcome: null,
      cancellation_charge: null,
    });
    expect((await rowOf(id)).cancelled_by).toBe(ops.identity.id);
    const [event] = await eventsOf(id, CANCELLED);
    expect(event).toMatchObject({
      actor_type: 'STAFF',
      actor_id: ops.identity.id,
      previous_state: over.state,
      resulting_state: 'CANCELLED',
      detail: { cancelled_by_actor_type: 'OPS' },
    });
    expect(await eventsOf(id, CHARGEABLE)).toEqual([]);
  });

  // Break caught: a charge elected on a request no rider holds, or a charge reason given where no charge is decided (a member that decides nothing).
  it('refuses a charge decision where no rider is assigned', async () => {
    const id = await arrange({ state: 'CONFIRMED' });
    for (const extra of [
      { apply_charge: true },
      { apply_charge: false },
      { charge_reason_code: REASONS.customer },
    ]) {
      const answer = await cancelNow(ops, id, { reason_code: REASONS.customer, ...extra });
      expect([answer.status, codeOf(answer)], JSON.stringify(extra)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    await expectUntouched(id, 'CONFIRMED');
  });

  // Break caught: a request outside the hubs of the grant cancelled, or told it does not exist when it does.
  it('tells Ops a request outside its hubs from one that does not exist', async () => {
    const elsewhere = await arrange({}, vendorInB, HUB_B);
    const outside = await cancel(
      ops,
      elsewhere,
      { reason_code: REASONS.customer },
      { ifMatch: await tokenOf(opsB, elsewhere) },
    );
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await cancel(
      ops,
      randomUUID(),
      { reason_code: REASONS.customer },
      { ifMatch: '"x"' },
    );
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    await expectUntouched(elsewhere);
  });

  // Break caught: a request that is already over cancelled again, the terminal states becoming a second way out.
  it('refuses a request that is already cancelled', async () => {
    const id = await arrange({ state: 'CANCELLED' });
    const answer = await cancelNow(ops, id, { reason_code: REASONS.customer });
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await eventsOf(id, CANCELLED)).toEqual([]);
  });

  // Break caught: a holder of another bundle's keys cancelling, or a caller with no session.
  it('is refused to a bundle without the key and to a caller with no session', async () => {
    const id = await arrange();
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const refused = await cancel(
      finance,
      id,
      { reason_code: REASONS.customer },
      { ifMatch: await tokenOf(ops, id) },
    );
    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    const anonymous = await routes
      .browser()
      .post(CANCEL(id), cancelBody({ reason_code: REASONS.customer }), {
        origin: OPS,
        headers: { 'If-Match': '"x"', 'Idempotency-Key': randomUUID() },
      });
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    await expectUntouched(id);
  });
});

describe('the reason of a cancellation', () => {
  // Break caught: a cancellation with no reason, a reason that is not of the domain, retired or unknown accepted, or a note a reason requires left out.
  it.each([
    ['none', { reason_code: undefined }, 400, 'VALIDATION_FAILED'],
    ['blank', { reason_code: '  ' }, 422, 'REASON_REQUIRED'],
    ['unknown', { reason_code: 'NO_SUCH_REASON' }, 422, 'REASON_NOT_ACTIVE'],
    ['retired', { reason_code: REASONS.retired }, 422, 'REASON_NOT_ACTIVE'],
    ['of another domain', { reason_code: REASONS.otherDomain }, 422, 'REASON_NOT_ACTIVE'],
    [
      'one that needs a note, given none',
      { reason_code: REASONS.needsNote },
      422,
      'REASON_REQUIRED',
    ],
    [
      'one that needs a note, given a blank one',
      { reason_code: REASONS.needsNote, note: '   ' },
      422,
      'REASON_REQUIRED',
    ],
  ])('refuses %s and changes nothing', async (_name, body, status, code) => {
    const id = await arrange();
    const answer = await cancelNow(ops, id, body);
    expect([answer.status, codeOf(answer)]).toEqual([status, code]);
    await expectUntouched(id);
  });

  // Break caught: a note kept without being screened, or one a reason requires not recorded.
  it('records the note it was given, and refuses one the ledger would not keep', async () => {
    const id = await arrange();
    const refused = await cancelNow(ops, id, {
      reason_code: REASONS.customer,
      note: 'Ring him on +233244123456',
    });
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
    await expectUntouched(id);

    const accepted = await cancelNow(ops, id, {
      reason_code: REASONS.needsNote,
      note: 'The customer changed the plan',
    });
    expect(accepted.status).toBe(200);
    expect((await eventsOf(id, CANCELLED))[0]).toMatchObject({
      note: 'The customer changed the plan',
    });
  });

  // Break caught: a reason read as the vendor could not (the catalogue is the office's), so that a vendor's own cancellation fails as a reason that does not exist.
  it('is readable to a vendor for its own cancellation', async () => {
    const id = await arrange();
    expect((await cancelNow(browserOne, id, { reason_code: REASONS.external })).status).toBe(200);
  });
});

describe('after a rider is assigned the charge is discretionary and always a recorded outcome (AC-SLICE-001-60, -61)', () => {
  const decide = (apply: boolean, over: CancelBody = {}): CancelBody => ({
    reason_code: REASONS.customer,
    apply_charge: apply,
    charge_reason_code: REASONS.customer,
    ...over,
  });

  // Break caught: a charge applied automatically to every post-assignment cancellation (a different policy from the approved one), or left null.
  it('records NOT_APPLIED, not a null, when Ops elects no charge (AC-60)', async () => {
    const id = await assigned();
    const answer = await cancelNow(ops, id, decide(false));
    expect(answer.status).toBe(200);
    expect(bodyOf(answer)).toMatchObject({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'NOT_APPLIED',
      cancellation_charge: null,
      cancellation_charge_snapshot: null,
    });
    expect(await rowOf(id)).toMatchObject({
      cancellation_charge_reason_code: REASONS.customer,
      cancellation_charge_reason_label: `Fixture ${REASONS.customer}`,
    });
  });

  // Break caught: an elected charge not applied, not snapshotted with its setting and version, or repriced when the setting changes later.
  it('applies the elected charge and snapshots the amount, the setting key and the version it was read from', async () => {
    const id = await assigned();
    const answer = await cancelNow(ops, id, decide(true));
    expect(answer.status).toBe(200);
    expect(bodyOf(answer)).toMatchObject({
      cancellation_charge_outcome: 'APPLIED',
      cancellation_charge: { amount_minor: 2000, currency: 'GHS' },
      cancellation_charge_snapshot: {
        amount_minor: 2000,
        setting_key: 'cancellation_charge_amount',
        effective_version: '1',
      },
    });
    await setHubSetting(routes.admin, HUB_A, 'cancellation_charge_amount', 3500, 'pesewas');
    try {
      const read = (await ops.client.get(ONE(id))).json() as Cancelled;
      expect(read.cancellation_charge).toEqual({ amount_minor: 2000, currency: 'GHS' });
      expect(read.cancellation_charge_snapshot?.effective_version).toBe('1');
    } finally {
      await setHubSetting(routes.admin, HUB_A, 'cancellation_charge_amount', 2000, 'pesewas');
    }
  });

  // Break caught: a charge always priced at the first version of the setting (or at a figure kept somewhere else), so that a change of the
  // amount never reaches a later cancellation, or is applied to one that was already made.
  it('prices a later cancellation at the version of the amount then in force', async () => {
    await setHubSetting(routes.admin, HUB_A, 'cancellation_charge_amount', 3500, 'pesewas');
    try {
      const [latest] = await routes.rows<{ version: number }>(
        `select max(version)::int as version from hub_setting where hub_id = $1 and setting_key = 'cancellation_charge_amount'`,
        [HUB_A],
      );
      const id = await assigned();
      const answer = await cancelNow(ops, id, decide(true));
      expect(answer.status).toBe(200);
      expect(bodyOf(answer)).toMatchObject({
        cancellation_charge: { amount_minor: 3500, currency: 'GHS' },
        cancellation_charge_snapshot: {
          amount_minor: 3500,
          setting_key: 'cancellation_charge_amount',
          effective_version: String(latest?.version),
        },
      });
    } finally {
      await setHubSetting(routes.admin, HUB_A, 'cancellation_charge_amount', 2000, 'pesewas');
    }
  });

  // Break caught: an unset amount blocking the cancellation or reported as SETTING_MISSING (an operational decision is never held hostage to
  // commercial configuration), or estimated at zero.
  it('records UNAVAILABLE and goes on where the hub has no amount (AC-61)', async () => {
    const id = await assigned(vendorInB, HUB_B);
    const answer = await cancelNow(opsB, id, decide(true));
    expect(answer.status).toBe(200);
    expect(codeOf(answer)).not.toBe('SETTING_MISSING');
    expect(bodyOf(answer)).toMatchObject({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'UNAVAILABLE',
      cancellation_charge: null,
      cancellation_charge_snapshot: null,
    });
  });

  // Break caught: Melarc billing a vendor for Melarc's own failure, or the cancellation refused for it (it proceeds, and EXEMPT is a fact of its own).
  it('records EXEMPT where the reason is attributed to Melarc, whatever Ops sent, and the cancellation proceeds', async () => {
    for (const apply of [true, false]) {
      const id = await assigned();
      const answer = await cancelNow(ops, id, decide(apply, { reason_code: REASONS.melarc }));
      expect(answer.status, String(apply)).toBe(200);
      expect(bodyOf(answer)).toMatchObject({
        cancellation_charge_outcome: 'EXEMPT',
        cancellation_charge: null,
        cancellation_charge_snapshot: null,
      });
    }
  });

  // Break caught: EXTERNAL treated as MELARC's (exempt) or as automatic: it leaves the decision exactly as discretionary as MSC-DEC-197 made it.
  it('leaves an externally attributed reason as discretionary as a customer’s', async () => {
    const charged = await cancelNow(
      ops,
      await assigned(),
      decide(true, { reason_code: REASONS.external }),
    );
    expect(bodyOf(charged).cancellation_charge_outcome).toBe('APPLIED');
    const not = await cancelNow(
      ops,
      await assigned(),
      decide(false, { reason_code: REASONS.external }),
    );
    expect(bodyOf(not).cancellation_charge_outcome).toBe('NOT_APPLIED');
  });

  // Break caught: the five outcomes recorded without the one event that makes them measurable, or recorded under the free-of-charge event.
  it('writes pickup.request.cancelled_chargeable with the outcome and the charge reason, for every outcome', async () => {
    const applied = await assigned();
    const exempt = await assigned();
    await cancelNow(ops, applied, decide(true));
    await cancelNow(ops, exempt, decide(true, { reason_code: REASONS.melarc }));
    expect(await eventsOf(applied, CHARGEABLE)).toEqual([
      {
        actor_type: 'STAFF',
        actor_id: ops.identity.id,
        enhanced: false,
        previous_state: 'CONFIRMED',
        resulting_state: 'CANCELLED',
        reason_code: REASONS.customer,
        reason_label: `Fixture ${REASONS.customer}`,
        note: null,
        before_after: null,
        detail: {
          cancelled_by_actor_type: 'OPS',
          charge_outcome: 'APPLIED',
          charge_reason_code: REASONS.customer,
          charge_reason_label: `Fixture ${REASONS.customer}`,
        },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
    expect((await eventsOf(exempt, CHARGEABLE))[0]?.detail).toMatchObject({
      charge_outcome: 'EXEMPT',
    });
    expect(await eventsOf(applied, CANCELLED)).toEqual([]);
  });

  // Break caught: a post-assignment cancellation made without the explicit decision and its reason (there is no default: a default would let the
  // decision go unmade).
  it.each([
    ['no election', { reason_code: REASONS.customer, charge_reason_code: REASONS.customer }],
    ['no charge reason', { reason_code: REASONS.customer, apply_charge: false }],
    [
      'a blank charge reason',
      { reason_code: REASONS.customer, apply_charge: true, charge_reason_code: ' ' },
    ],
  ])('refuses %s as REASON_REQUIRED and changes nothing', async (_name, body) => {
    const id = await assigned();
    const answer = await cancelNow(ops, id, body);
    expect([answer.status, codeOf(answer)]).toEqual([422, 'REASON_REQUIRED']);
    await expectUntouched(id, 'CONFIRMED', 2);
  });

  it('refuses a charge reason that is not an active reason of the domain', async () => {
    const id = await assigned();
    for (const charge of ['NO_SUCH_REASON', REASONS.retired, REASONS.otherDomain]) {
      const answer = await cancelNow(ops, id, decide(false, { charge_reason_code: charge }));
      expect([answer.status, codeOf(answer)], charge).toEqual([422, 'REASON_NOT_ACTIVE']);
    }
    await expectUntouched(id, 'CONFIRMED', 2);
  });

  // Break caught: a charge applied by an Ops member who does not hold the key to elect one (the second permission of the operation).
  it('lets only a holder of pickup.request.cancel_chargeable elect a charge', async () => {
    const bundle = await newBundle(routes.admin, [
      grant('pickup.request.cancel', 'own', 'any', 'A'),
      grant('pickup.read', 'own', 'any', 'A'),
    ]);
    const limited = await routes.actor(bundle, HUB_A);
    const id = await assigned();
    const refused = await cancelNow(limited, id, decide(true));
    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    await expectUntouched(id, 'CONFIRMED', 2);
    // Electing none needs no such key: the decision not to charge is the discretion of anyone who may cancel.
    expect((await cancelNow(limited, id, decide(false))).status).toBe(200);
  });
});

describe('once however many times it is sent, and under the version it was read at', () => {
  // Break caught: a retry that cancels twice or answers differently, or a record of the act made twice.
  it('replays the original answer for the same key and body', async () => {
    const id = await arrange();
    const etag = await tokenOf(ops, id);
    const key = randomUUID();
    const first = await cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: etag, key });
    const second = await cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: etag, key });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(second.header('etag')).toBe(first.header('etag'));
    expect(await eventsOf(id, CANCELLED)).toHaveLength(1);
  });

  it('refuses the same key with another body as IDEMPOTENCY_KEY_CONFLICT', async () => {
    const id = await arrange();
    const etag = await tokenOf(ops, id);
    const key = randomUUID();
    expect(
      (await cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: etag, key })).status,
    ).toBe(200);
    const other = await cancel(ops, id, { reason_code: REASONS.external }, { ifMatch: etag, key });
    expect([other.status, codeOf(other)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
  });

  // Break caught: a stale, missing, weak or foreign token accepted.
  it('refuses a stale, weak or foreign token, and no token at all', async () => {
    const id = await arrange();
    const other = await arrange();
    const etag = await tokenOf(ops, id);
    for (const wrong of [`W/${etag}`, etag.slice(1, -1), await tokenOf(ops, other), '*']) {
      const answer = await cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: wrong });
      expect([answer.status, codeOf(answer)], wrong).toEqual([409, 'STATE_CONFLICT']);
    }
    const missing = await cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: null });
    // A missing version is a malformed request (the header is required by the contract), told before the operation runs.
    expect([missing.status, codeOf(missing)]).toEqual([400, 'VALIDATION_FAILED']);
    await expectUntouched(id);
    await routes.admin.query(
      `update pickup_request set secondary_phone = '+233200000009' where id = $1`,
      [id],
    );
    const stale = await cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: etag });
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
  });

  // Break caught: two members of the office cancelling at once, both acting, the second overwriting the first.
  it('lets exactly one of two concurrent cancellations succeed', async () => {
    const id = await arrange();
    const etag = await tokenOf(ops, id);
    const [first, second] = await Promise.all([
      cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: etag }),
      cancel(opsTwo, id, { reason_code: REASONS.external }, { ifMatch: etag }),
    ]);
    const outcomes = [first, second]
      .map((each) =>
        each.status === 200 ? '200' : `${String(each.status)} ${String(codeOf(each))}`,
      )
      .sort();
    expect(outcomes).toEqual(['200', '409 STATE_CONFLICT']);
    expect(await eventsOf(id, CANCELLED)).toHaveLength(1);
  });

  // Break caught: the version compared outside the request's lock, so that a request changed while the cancellation waited is cancelled on the token of an earlier read.
  it('compares the version under the lock: a change committed while the cancellation waits is seen by it', async () => {
    const id = await arrange();
    const etag = await tokenOf(ops, id);
    const held = await holdingPickupRequest(routes.database, id);
    let cancelling: Promise<TestResponse> | undefined;
    try {
      cancelling = cancel(ops, id, { reason_code: REASONS.customer }, { ifMatch: etag });
      await waitUntilBlockedBy(routes.admin, held.pid, 'the cancellation', cancelling);
      await held.client.query(
        `update pickup_request set secondary_phone = '+233200000008' where id = $1`,
        [id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await cancelling?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await cancelling;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await rowOf(id)).state).toBe('PENDING');
  });
});

describe('a vendor’s request that the office confirms while its cancellation waits', () => {
  // Break caught: a vendor's request confirmed between its read and its lock cancelled all the same (the office has taken it in hand and the
  // vendor's cancellation is closed to it): the vendor is told the request has changed, and nothing is cancelled.
  it('is told the request has changed, and cancels nothing', async () => {
    const id = await arrange();
    const etag = await tokenOf(browserOne, id);
    const held = await holdingPickupRequest(routes.database, id);
    let cancelling: Promise<TestResponse> | undefined;
    try {
      cancelling = cancel(browserOne, id, { reason_code: REASONS.customer }, { ifMatch: etag });
      await waitUntilBlockedBy(routes.admin, held.pid, 'the vendor’s cancellation', cancelling);
      await held.client.query(
        `update pickup_request set state = 'CONFIRMED', confirmed_at = now(), confirmed_by = $2 where id = $1`,
        [id, ops.identity.id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await cancelling?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await cancelling;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await rowOf(id)).state).toBe('CONFIRMED');
    expect(await eventsOf(id, CANCELLED)).toEqual([]);
  });
});

describe('Ops reschedules a failed attempt: the source is cancelled and its replacement made in one act (AC-SLICE-001-06)', () => {
  const reschedule = (who: Actor, id: string, over: CancelBody = {}): Promise<TestResponse> =>
    cancelNow(who, id, { reason_code: REASONS.customer, create_replacement: true, ...over });
  /** A request already tried `attempt` times (a `CONFIRMED` one: only a confirmed request can have been attempted). */
  const tried = (attempt: number, over: Parameters<typeof arrange>[0] = {}): Promise<string> =>
    arrange({ state: 'CONFIRMED', attemptNumber: attempt, ...over });
  const today = async (): Promise<string> =>
    String(
      (
        await routes.rows<{ today: string }>(
          `select (now() at time zone 'Africa/Accra')::date::text as today`,
        )
      )[0]?.today,
    );

  interface Chained extends Cancelled {
    readonly replaces_request_id: string | null;
    readonly attempt_number: number;
    readonly attempt_extension_id: string | null;
    readonly escalated_at: string | null;
    readonly scheduled_service_date: string;
    readonly declared_package_count: number;
    readonly code: string;
    readonly rider_assigned: boolean;
  }
  const chained = (response: TestResponse): Chained => response.json() as Chained;

  // Break caught: a reschedule that edits the failed attempt instead of replacing it, that loses the reason, or that leaves no link to the
  // request to go on with (section 35.4.3); or a clone that is not a fresh pending booking of the next attempt.
  it('cancels the source with its reason, makes a pending replacement of the next attempt, and links the two', async () => {
    const id = await tried(1);
    const source = chained(await reschedule(agent, id, { note: 'Rider found the shop closed' }));
    expect(source).toMatchObject({
      id,
      state: 'CANCELLED',
      cancelled_by_actor_type: 'OPS',
      cancellation_reason: { code: REASONS.customer, label: `Fixture ${REASONS.customer}` },
      cancellation_charge_outcome: null,
    });
    const replacementId = source.replacement_request_id;
    expect(replacementId).toEqual(expect.any(String));
    if (replacementId === null) throw new Error('the source names no replacement');

    const clone = chained(await agent.client.get(ONE(replacementId)));
    expect(clone).toMatchObject({
      id: replacementId,
      state: 'PENDING',
      attempt_number: 2,
      replaces_request_id: id,
      replacement_request_id: null,
      attempt_extension_id: null,
      escalated_at: null,
      declared_package_count: 3,
      rider_assigned: false,
      cancellation_reason: null,
      cancellation_charge_outcome: null,
      confirmed_at: null,
    });
    // Its own operational code, drawn for the same hub (the first three letters are the hub's).
    expect(clone.code).not.toBe(source.code);
    expect(clone.code.slice(0, 3)).toBe(source.code.slice(0, 3));
    // The same booking: its sender, hub, intent and what the sender arranged.
    const [from, to] = [await rowOf(id), await rowOf(replacementId)];
    for (const column of [
      'vendor_organization_id',
      'responsible_hub_id',
      'pickup_intent',
      'declared_package_count',
      'resolved_pickup_location',
      'primary_phone',
      'default_payer_intent',
    ]) {
      expect(to[column], column).toEqual(from[column]);
    }
    expect(to.version).toBe(1);
    expect(to.created_by).toBe(agent.identity.id);
  });

  // Break caught: the two active together (AC-06's last line), however many were made, or a reschedule that leaves the source standing.
  it('leaves exactly one of the two active, and exactly one replacement', async () => {
    const id = await tried(1);
    expect((await reschedule(agent, id)).status).toBe(200);
    const [{ active, replacements } = { active: -1, replacements: -1 }] = await routes.rows<{
      active: number;
      replacements: number;
    }>(
      `select count(*) filter (where state in ('PENDING', 'CONFIRMED'))::int as active,
              count(*) filter (where replaces_request_id = $1)::int as replacements
         from pickup_request where id = $1 or replaces_request_id = $1`,
      [id],
    );
    expect([active, replacements]).toEqual([1, 1]);
  });

  // Break caught: the clone dated into the past (a request confirmed days late), or on the source's own day, or on a Sunday.
  it('is for the next operating day after the later of the source’s day and today', async () => {
    const later = await tried(1, { serviceDate: ahead });
    const laterClone = (
      await agent.client.get(
        ONE(chained(await reschedule(agent, later)).replacement_request_id ?? ''),
      )
    ).json() as Chained;
    expect(laterClone.scheduled_service_date).toBe(nextOperatingDay(ahead));

    const past = await tried(1, { serviceDate: await operatingDay(routes.admin, -2) });
    const pastClone = (
      await agent.client.get(
        ONE(chained(await reschedule(agent, past)).replacement_request_id ?? ''),
      )
    ).json() as Chained;
    expect(pastClone.scheduled_service_date).toBe(nextOperatingDay(await today()));
    for (const date of [laterClone.scheduled_service_date, pastClone.scheduled_service_date]) {
      expect(new Date(`${date}T12:00:00Z`).getUTCDay(), date).not.toBe(0);
    }
  });

  // Break caught: the approval of a single package lost on the replacement (the same trip would then need a second approval and owe a second fee).
  it('carries the one-package approval of the booking it replaces', async () => {
    const id = await arrange({ packages: 1 });
    const exception = (
      await insertOnePackageException(
        routes.admin,
        exceptionRow(id, { state: 'APPROVED', requestedBy: agent.identity.id }),
      )
    ).id;
    await routes.admin.query(
      `update pickup_request set one_package_exception_id = $2, state = 'CONFIRMED', confirmed_at = now(), confirmed_by = $3 where id = $1`,
      [id, exception, agent.identity.id],
    );
    const source = chained(await reschedule(agent, id));
    const clone = await rowOf(source.replacement_request_id ?? '');
    expect(clone.one_package_exception_id).toBe(exception);
    expect(clone.declared_package_count).toBe(1);
  });

  // Break caught: the reschedule open to anyone who may cancel (a vendor's own pending request included), or to a request no rider attempted.
  it('is Ops’s, and only for a confirmed request', async () => {
    const mine = await arrange();
    const before = await countOf();
    const asVendor = await browserOne.post(
      CANCEL(mine),
      cancelBody({ reason_code: REASONS.customer, create_replacement: true }),
      { headers: { 'If-Match': await tokenOf(browserOne, mine), 'Idempotency-Key': randomUUID() } },
    );
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    expect(await countOf()).toBe(before);
    await expectUntouched(mine);

    const pending = await arrange();
    const arranged = await countOf();
    const answer = await reschedule(agent, pending);
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await countOf()).toBe(arranged);
    await expectUntouched(pending);

    // Without a replacement the same request is cancelled as ever: the refusal is of the reschedule and not of the cancellation.
    expect((await cancelNow(agent, pending, { reason_code: REASONS.customer })).status).toBe(200);
  });

  // Break caught: a charge decision skipped because the cancellation reschedules, or a replacement made when the decision is refused.
  it('decides the charge of a cancellation after assignment as any cancellation does, and makes nothing when that is refused', async () => {
    const id = await tried(1, { assigned: true });
    const before = await countOf();
    const refused = await reschedule(agent, id);
    expect([refused.status, codeOf(refused)]).toEqual([422, 'REASON_REQUIRED']);
    expect(await countOf()).toBe(before);
    await expectUntouched(id, 'CONFIRMED', 2);

    const done = chained(
      await reschedule(agent, id, { apply_charge: false, charge_reason_code: REASONS.customer }),
    );
    expect(done).toMatchObject({ state: 'CANCELLED', cancellation_charge_outcome: 'NOT_APPLIED' });
    expect(await countOf()).toBe(before + 1);
    expect(await eventsOf(id, CHARGEABLE)).toHaveLength(1);
  });

  // Break caught: a reschedule outside the hubs of the grant, and one that is made twice for one key.
  it('stays in the hubs of the grant, and is made once however many times it is sent', async () => {
    const id = await tried(1);
    const etag = await tokenOf(agent, id);
    const outside = await cancel(
      opsB,
      id,
      { reason_code: REASONS.customer, create_replacement: true },
      { ifMatch: etag },
    );
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    await expectUntouched(id, 'CONFIRMED', 1);

    const key = randomUUID();
    const body = { reason_code: REASONS.customer, create_replacement: true };
    const first = await cancel(agent, id, body, { ifMatch: etag, key });
    const second = await cancel(agent, id, body, { ifMatch: etag, key });
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.json()).toEqual(first.json());
    expect(
      (await routes.rows(`select id from pickup_request where replaces_request_id = $1`, [id]))
        .length,
    ).toBe(1);
  });

  // Break caught: two members of the office rescheduling one attempt, each making a replacement.
  it('lets exactly one of two concurrent reschedules succeed, and makes one replacement', async () => {
    const id = await tried(1);
    const etag = await tokenOf(agent, id);
    const body = { reason_code: REASONS.customer, create_replacement: true };
    const [first, second] = await Promise.all([
      cancel(agent, id, body, { ifMatch: etag }),
      cancel(agentTwo, id, body, { ifMatch: etag }),
    ]);
    expect(
      [first, second]
        .map((each) =>
          each.status === 200 ? '200' : `${String(each.status)} ${String(codeOf(each))}`,
        )
        .sort(),
    ).toEqual(['200', '409 STATE_CONFLICT']);
    expect(
      (await routes.rows(`select id from pickup_request where replaces_request_id = $1`, [id]))
        .length,
    ).toBe(1);
  });

  // Break caught: the audit trail of the chain missing a link: the cancellation that names its replacement and the replacement's own timeline.
  it('writes the cancellation with its replacement and opens the replacement’s timeline', async () => {
    const id = await tried(1);
    const source = chained(await reschedule(agent, id));
    const replacementId = source.replacement_request_id ?? '';
    const [cancelled] = await routes.rows<{
      related_ids: Record<string, string>;
      detail: Record<string, unknown>;
    }>(`select related_ids, detail from audit_event where event_code = $1 and object_id = $2`, [
      CANCELLED,
      id,
    ]);
    expect(cancelled?.related_ids).toEqual({ replacement_request_id: replacementId });
    expect(cancelled?.detail).toEqual({ cancelled_by_actor_type: 'OPS' });
    const [created] = await routes.rows<{
      related_ids: Record<string, string>;
      resulting_state: string;
      detail: Record<string, unknown>;
    }>(
      `select related_ids, resulting_state, detail from audit_event where event_code = 'pickup.request.created' and object_id = $1`,
      [replacementId],
    );
    expect(created).toMatchObject({
      resulting_state: 'PENDING',
      related_ids: { replaces_request_id: id },
      detail: { pickup_intent: 'OWN_PACKAGES', declared_package_count: 3 },
    });
  });
});

describe('the attempt cap holds at the reschedule (AC-SLICE-001-07)', () => {
  const reschedule = (who: Actor, id: string): Promise<TestResponse> =>
    cancelNow(who, id, { reason_code: REASONS.customer, create_replacement: true });

  // Break caught: a fourth attempt made at a cap of three, a third refused, or the refusal made after the source was already cancelled.
  it('makes the third attempt and refuses the fourth with PICKUP_ATTEMPT_LIMIT_REACHED, changing nothing', async () => {
    const second = await arrange({ state: 'CONFIRMED', attemptNumber: 2 });
    const third = ((await reschedule(agent, second)).json() as { replacement_request_id: string })
      .replacement_request_id;
    expect((await rowOf(third)).attempt_number).toBe(3);

    const atCap = await arrange({ state: 'CONFIRMED', attemptNumber: 3 });
    const before = await countOf();
    const refused = await reschedule(agent, atCap);
    expect([refused.status, codeOf(refused)]).toEqual([422, 'PICKUP_ATTEMPT_LIMIT_REACHED']);
    expect(await countOf()).toBe(before);
    await expectUntouched(atCap, 'CONFIRMED', 1);
  });

  // Break caught: the cap enforced against a hub that sets none (an operational decision is not held hostage to configuration), or silently.
  it('blocks nothing in a hub with no cap, and records that it was not applied', async () => {
    const id = await arrange({ state: 'CONFIRMED', attemptNumber: 7 }, vendorInB, HUB_B);
    const answer = await reschedule(opsB, id);
    expect(answer.status).toBe(200);
    const [event] = await eventsOf(id, CANCELLED);
    expect(event?.detail).toEqual({
      cancelled_by_actor_type: 'OPS',
      attempt_cap_check: 'SETTING_MISSING',
    });
  });

  // Break caught: the cap read only for a reschedule that elects a charge (the configuration must be read for the reschedule itself).
  it('reads the cap for a reschedule that elects no charge too', async () => {
    const atCap = await arrange({ state: 'CONFIRMED', attemptNumber: 3 });
    const refused = await cancelNow(agent, atCap, {
      reason_code: REASONS.customer,
      create_replacement: true,
    });
    expect(codeOf(refused)).toBe('PICKUP_ATTEMPT_LIMIT_REACHED');
  });
});

describe('waiveCancellationCharge: only Senior Ops relieves an applied charge, in full (AC-SLICE-001-62 to -64)', () => {
  const waive = async (
    who: Actor,
    id: string,
    body: Record<string, unknown>,
    ifMatch?: string | null,
  ) =>
    who.client.post(WAIVE(id), body, {
      origin: OPS,
      headers: ifMatch === null ? {} : { 'If-Match': ifMatch ?? (await tokenOf(who, id)) },
    });
  const charged = async (): Promise<string> => {
    const id = await assigned();
    expect(
      (
        await cancelNow(ops, id, {
          reason_code: REASONS.customer,
          apply_charge: true,
          charge_reason_code: REASONS.customer,
        })
      ).status,
    ).toBe(200);
    return id;
  };

  // Break caught: an Ops Staff member relieving a charge (AC-62), or a Senior Ops waiver that records no actor or note, or that rewrites the snapshot.
  it('is refused to Ops Staff and done by Senior Ops, with the actor and the note recorded', async () => {
    const id = await charged();
    const refused = await waive(ops, id, { note: WAIVER_NOTE });
    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await rowOf(id)).cancellation_charge_outcome).toBe('APPLIED');
    expect(await eventsOf(id, WAIVED)).toEqual([]);

    const snapshot = (await rowOf(id)).cancellation_charge_snapshot;
    expect(snapshot).toMatchObject({
      amount_minor: 2000,
      setting_key: 'cancellation_charge_amount',
    });
    const done = await waive(senior, id, { note: WAIVER_NOTE });
    expect(done.status).toBe(200);
    // Relieved in full: no charge stands, and the snapshotted amount and its version stay readable, as the cancellation took them (AC-64).
    expect(bodyOf(done)).toMatchObject({
      state: 'CANCELLED',
      cancellation_charge_outcome: 'WAIVED',
      cancellation_charge: null,
      cancellation_charge_snapshot: snapshot,
    });
    expect(await rowOf(id)).toMatchObject({
      cancellation_charge_waived_by: senior.identity.id,
      cancellation_charge_waiver_note: WAIVER_NOTE,
    });
    expect(done.header('etag')).toBe(await etagOf(senior.client, id));
  });

  // Break caught: the waiver frequency unmeasurable (each waiver is its own event), the event not enhanced, or its before and after missing.
  it('writes one enhanced event for the waiver, with the actor, the note and the change', async () => {
    const id = await charged();
    expect((await waive(senior, id, { note: WAIVER_NOTE })).status).toBe(200);
    expect(await eventsOf(id, WAIVED)).toEqual([
      {
        actor_type: 'STAFF',
        actor_id: senior.identity.id,
        enhanced: true,
        previous_state: 'CANCELLED',
        resulting_state: 'CANCELLED',
        reason_code: null,
        reason_label: null,
        note: WAIVER_NOTE,
        before_after: { cancellation_charge_outcome: { before: 'APPLIED', after: 'WAIVED' } },
        detail: { permission: 'pickup.cancellation_charge.waive' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
  });

  // Break caught: a waiver recorded against no charge (it would corrupt the one signal this control depends on), or one written after the refusal.
  it.each([
    ['NOT_APPLIED', false, REASONS.customer],
    ['EXEMPT', true, REASONS.melarc],
  ])(
    'is refused as NO_CHARGE_APPLIED where the outcome is %s, and no waiver event is written (AC-63)',
    async (outcome, apply, reason) => {
      const id = await assigned();
      await cancelNow(ops, id, {
        reason_code: reason,
        apply_charge: apply,
        charge_reason_code: REASONS.customer,
      });
      expect((await rowOf(id)).cancellation_charge_outcome).toBe(outcome);
      const answer = await waive(senior, id, { note: WAIVER_NOTE });
      expect([answer.status, codeOf(answer)]).toEqual([422, 'NO_CHARGE_APPLIED']);
      expect(await eventsOf(id, WAIVED)).toEqual([]);
    },
  );

  it('is refused as NO_CHARGE_APPLIED where the amount was unavailable, where nothing was decided, and where it is already waived', async () => {
    const unavailable = await assigned(vendorInB, HUB_B);
    const seniorB = await routes.actor(BUNDLE_IDS.seniorOps, HUB_B);
    await cancelNow(opsB, unavailable, {
      reason_code: REASONS.customer,
      apply_charge: true,
      charge_reason_code: REASONS.customer,
    });
    expect(codeOf(await waive(seniorB, unavailable, { note: WAIVER_NOTE }))).toBe(
      'NO_CHARGE_APPLIED',
    );

    const free = await arrange();
    await cancelNow(ops, free, { reason_code: REASONS.customer });
    expect(codeOf(await waive(senior, free, { note: WAIVER_NOTE }))).toBe('NO_CHARGE_APPLIED');

    const again = await charged();
    expect((await waive(senior, again, { note: WAIVER_NOTE })).status).toBe(200);
    expect(codeOf(await waive(senior, again, { note: WAIVER_NOTE }))).toBe('NO_CHARGE_APPLIED');
    expect(await eventsOf(again, WAIVED)).toHaveLength(1);
  });

  it('is refused for a request that is not cancelled', async () => {
    const id = await assigned();
    const answer = await waive(senior, id, { note: WAIVER_NOTE });
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
  });

  // Break caught: a partial waiver accepted (it would reprice a snapshotted charge, section 3.7), or one with no note, or an unknown member.
  it.each([
    [
      'an amount (a partial waiver)',
      { note: WAIVER_NOTE, amount: { amount_minor: 500, currency: 'GHS' } },
      400,
      'VALIDATION_FAILED',
    ],
    ['an amount in pesewas', { note: WAIVER_NOTE, amount_minor: 500 }, 400, 'VALIDATION_FAILED'],
    ['no note', {}, 400, 'VALIDATION_FAILED'],
    ['a blank note', { note: '   ' }, 422, 'REASON_REQUIRED'],
    [
      'a note the ledger would not keep',
      { note: 'Rang him on +233244123456' },
      400,
      'VALIDATION_FAILED',
    ],
  ])('refuses %s and leaves the charge applied', async (_name, body, status, code) => {
    const id = await charged();
    const answer = await waive(senior, id, body);
    expect([answer.status, codeOf(answer)]).toEqual([status, code]);
    expect((await rowOf(id)).cancellation_charge_outcome).toBe('APPLIED');
    expect(await eventsOf(id, WAIVED)).toEqual([]);
  });

  // Break caught: the charge read before the request is locked, so that a waiver made while this one waited is taken for the state the
  // caller read (the second waiver would then fail as a server error, or relieve a charge that is no longer there).
  it('is judged under the request’s lock: a waiver committed while this one waits is seen by it', async () => {
    const id = await charged();
    const token = await tokenOf(senior, id);
    const held = await holdingPickupRequest(routes.database, id);
    let waiving: Promise<TestResponse> | undefined;
    try {
      waiving = waive(senior, id, { note: WAIVER_NOTE }, token);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the waiver', waiving);
      await held.client.query(
        `update pickup_request
            set cancellation_charge_outcome = 'WAIVED', cancellation_charge_waived_by = $2, cancellation_charge_waiver_note = 'first'
          where id = $1`,
        [id, senior.identity.id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await waiving?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await waiving;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await rowOf(id)).toMatchObject({ cancellation_charge_waiver_note: 'first' });
    expect(await eventsOf(id, WAIVED)).toEqual([]);
  });

  // Break caught: a waiver on a token that is no longer the request's, or outside the hubs of the grant, or for a vendor.
  it('is made under the version it was read at, in the hubs of the grant, and never for a vendor', async () => {
    const id = await charged();
    const stale = await waive(senior, id, { note: WAIVER_NOTE }, '"stale"');
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
    const seniorB = await routes.actor(BUNDLE_IDS.seniorOps, HUB_B);
    const outside = await waive(seniorB, id, { note: WAIVER_NOTE }, await tokenOf(senior, id));
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await senior.client.post(
      WAIVE(randomUUID()),
      { note: WAIVER_NOTE },
      { origin: OPS, headers: { 'If-Match': '"x"' } },
    );
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    const asVendor = await browserOne.post(
      WAIVE(id),
      { note: WAIVER_NOTE },
      { headers: { 'If-Match': '"x"' } },
    );
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await rowOf(id)).cancellation_charge_outcome).toBe('APPLIED');
  });
});
