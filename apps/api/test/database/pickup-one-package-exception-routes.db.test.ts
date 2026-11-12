import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import {
  holdingOnePackageException,
  holdingPickupRequest,
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
 * S1.16, the one-package exception against the real application and a real PostgreSQL (`AC-SLICE-001-03`; pickup-request.md sections 5.1 and
 * 5.2; state-machines.md section 3; permissions.md section 6): Ops raises it for a request of one package with the recipient, any holder of
 * `pickup.exception.approve` decides it and never the requester unless a Platform Admin, the approval makes the request confirmable and
 * snapshots the GH₵20 single-package fee as due (not collected), and the approval travels with the booking into the clone of a reschedule.
 */
const ONE = (id: string) => `${API}/pickup-requests/${id}`;
const ASK = (id: string) => `${API}/pickup-requests/${id}/one-package-exception`;
const APPROVE = (id: string) => `${API}/pickup-requests/${id}/one-package-exception/approve`;
const CONFIRM = (id: string) => `${API}/pickup-requests/${id}/confirm`;
const CUTOFF = (id: string) => `${API}/pickup-requests/${id}/cutoff-exception`;
const NOTE = 'The customer sends one parcel to a relative';
const WEDNESDAY = '2026-11-04';
const FRIDAY = '2026-11-06';

const recipient = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Kofi Recipient',
  phone: '024 400 0111',
  location: { address: 'House 7, Adenta Housing Down', landmark: 'Near the market' },
  ...over,
});
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  note: NOTE,
  recipient: recipient(),
  ...over,
});

let routes: VendorRoutes;
let ops: Actor;
let opsTwo: Actor;
let senior: Actor;
let admin: Actor;
let opsB: Actor;
let vendorOne: ArrangedVendor;
let vendorInB: ArrangedVendor;
let browserOne: TestClient;
let ahead: string;
let past: string;

beforeAll(async () => {
  // The race of the approval holds a row until the test has seen the approval wait for it: the test ends the wait and not a bound, so the
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
  vendorInB = await routes.vendor({ hubId: HUB_B });
  browserOne = routes.browser(vendorOne.device.credential.token);
  expect(
    (await routes.signIn(browserOne, vendorOne.row.accountIdentifier, vendorOne.secret)).status,
  ).toBe(200);
  ops = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  opsTwo = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  admin = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
  opsB = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
  ahead = await operatingDay(routes.admin, 3);
  past = await operatingDay(routes.admin, -2);
  // The address-to-zone data is the owner's to supply and none is seeded: a few aliases of the tests' own, for the estimate of a destination.
  const zones = await routes.rows<{ id: string; service_area: string }>(
    `select id, service_area from service_zone where hub_id = $1`,
    [HUB_A],
  );
  for (const [area, alias] of [
    ['ACCRA_TEMA', 'adenta housing down'],
    ['AMASAMAN_ENVIRONS', 'amasaman junction'],
  ] as const) {
    const zone = zones.find((each) => each.service_area === area);
    if (zone === undefined) throw new Error(`the launch hub has no zone in ${area}`);
    await routes.admin.query(
      `insert into service_zone_alias (id, hub_id, zone_id, alias, kind) values ($1, $2, $3, $4, 'LANDMARK')`,
      [randomUUID(), HUB_A, zone.id, alias],
    );
  }
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

/** A `PENDING` request of one package by the first vendor in hub A for a date ahead, unless the test says otherwise. */
const single = async (
  over: Parameters<typeof pickupRequestRow>[2] = {},
  vendor: ArrangedVendor = vendorOne,
  hub: string = HUB_A,
): Promise<string> =>
  (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, hub, {
        packages: 1,
        serviceDate: ahead,
        ...over,
      }),
    )
  ).id;

const ask = (
  actor: Actor,
  id: string,
  over: Record<string, unknown> = body(),
): Promise<TestResponse> => actor.client.post(ASK(id), over, { origin: OPS });
const approve = (actor: Actor, id: string): Promise<TestResponse> =>
  actor.client.post(APPROVE(id), undefined, { origin: OPS });
const etagOf = async (actor: Actor, id: string): Promise<string> => {
  const read = await actor.client.get(ONE(id));
  expect(read.status).toBe(200);
  const etag = read.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
};
const confirm = async (actor: Actor, id: string): Promise<TestResponse> =>
  actor.client.post(CONFIRM(id), undefined, {
    origin: OPS,
    headers: { 'If-Match': await etagOf(actor, id) },
  });

interface Approval {
  readonly id: string;
  readonly state: string;
  readonly requested_by: string;
  readonly approved_by: string | null;
  readonly note?: string;
}
const approvalOf = (response: TestResponse): Approval => response.json() as Approval;

interface RequestBody {
  readonly state: string;
  readonly one_package_exception_id: string | null;
  readonly one_package_exception: null | {
    readonly id: string;
    readonly state: string;
    readonly requested_by: string;
    readonly requested_at: string;
    readonly approved_by: string | null;
    readonly decided_at: string | null;
    readonly note: string;
    readonly recipient: { name: string; phone: string; location: Record<string, unknown> };
    readonly single_package_fee: null | { amount_minor: number; currency: string };
  };
  readonly indicative_estimate: null | {
    readonly status: string;
    readonly total: { amount_minor: number; currency: string } | null;
    readonly components: readonly {
      kind: string;
      quantity: number;
      amount: { amount_minor: number };
    }[];
  };
  readonly cutoff_exception_state: string | null;
  readonly replacement_request_id: string | null;
}
const requestOf = (response: TestResponse): RequestBody => response.json() as RequestBody;

interface ExceptionRow {
  readonly id: string;
  readonly pickup_request_id: string;
  readonly state: string;
  readonly requested_by: string;
  readonly approved_by: string | null;
  readonly decided_at: Date | null;
  readonly note: string;
  readonly recipient_name: string;
  readonly recipient_phone: string;
  readonly recipient_location: Record<string, unknown>;
  readonly single_package_fee_snapshot: Record<string, unknown> | null;
}
const exceptionsOf = (requestId: string): Promise<ExceptionRow[]> =>
  routes.rows<ExceptionRow>(
    `select * from one_package_exception where pickup_request_id = $1 order by requested_at, id`,
    [requestId],
  );
const requestRowOf = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await routes.rows(`select * from pickup_request where id = $1`, [id]);
  if (row === undefined) throw new Error('no such request');
  return row;
};

interface Event {
  readonly actor_id: string | null;
  readonly enhanced: boolean;
  readonly object_id: string;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly before_after: Record<string, unknown> | null;
  readonly related_ids: Record<string, unknown> | null;
  readonly detail: Record<string, unknown>;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
}
const eventsOf = (id: string, code: string): Promise<Event[]> =>
  routes.rows<Event>(
    `select actor_id, enhanced, object_id, previous_state, resulting_state, before_after, related_ids, detail, responsible_hub_id, vendor_organization_id
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, id],
  );

/** A refusal made nothing: no exception, and the request as it was. */
const expectNothingMade = async (id: string): Promise<void> => {
  expect(await exceptionsOf(id)).toEqual([]);
  expect((await requestRowOf(id)).one_package_exception_id).toBeNull();
  expect(await eventsOf(id, 'pickup.exception.requested')).toEqual([]);
};

describe('requestOnePackageException: Ops raises an exception for a request of one package', () => {
  // Break caught: an exception made without its recipient or its note, in the wrong name, or that changes the request or its state.
  it('records the exception as REQUESTED with its recipient and note, leaving the request PENDING and unlinked', async () => {
    const id = await single();
    const before = await requestRowOf(id);
    const answer = await ask(ops, id);

    expect(answer.status).toBe(201);
    const approval = approvalOf(answer);
    expect(approval).toMatchObject({
      state: 'REQUESTED',
      requested_by: ops.identity.id,
      approved_by: null,
      note: NOTE,
    });
    const [stored] = await exceptionsOf(id);
    expect(stored).toMatchObject({
      id: approval.id,
      pickup_request_id: id,
      state: 'REQUESTED',
      requested_by: ops.identity.id,
      approved_by: null,
      decided_at: null,
      note: NOTE,
      recipient_name: 'Kofi Recipient',
      // The phone is stored in its normal form, as every phone of the platform is.
      recipient_phone: '+233244000111',
      recipient_location: { address: 'House 7, Adenta Housing Down', landmark: 'Near the market' },
      single_package_fee_snapshot: null,
    });
    // The request is not changed by being asked about: it is still pending, links nothing, and keeps its version.
    const after = await requestRowOf(id);
    expect([after.state, after.one_package_exception_id, after.version]).toEqual([
      'PENDING',
      null,
      before.version,
    ]);
  });

  // Break caught: the exception invisible to the people who decide it, or the request's token not moving when what it shows has moved.
  it('shows the exception on the request, and moves the request’s token', async () => {
    const id = await single();
    const tokenBefore = await etagOf(ops, id);
    const approval = approvalOf(await ask(ops, id));

    const read = await ops.client.get(ONE(id));
    const shown = requestOf(read).one_package_exception;
    expect(shown).toMatchObject({
      id: approval.id,
      state: 'REQUESTED',
      requested_by: ops.identity.id,
      approved_by: null,
      decided_at: null,
      note: NOTE,
      recipient: {
        name: 'Kofi Recipient',
        phone: '+233244000111',
        location: { address: 'House 7, Adenta Housing Down', landmark: 'Near the market' },
      },
      single_package_fee: null,
    });
    expect(shown?.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(requestOf(read).one_package_exception_id).toBeNull();
    expect(read.header('etag')).not.toBe(tokenBefore);
  });

  // Break caught: the approver's queue not listing what waits for it, or listing what does not (section 35.2.4).
  it('lists the request in the approver’s queue, filtered by the exception’s state', async () => {
    const waiting = await single();
    const plain = await single();
    await ask(ops, waiting);

    const queued = await ops.client.get(
      `${API}/pickup-requests?one_package_exception_state=REQUESTED&page_size=100`,
    );
    expect(queued.status).toBe(200);
    const items = (queued.json() as { items: { id: string; one_package_exception: unknown }[] })
      .items;
    const ids = items.map((item) => item.id);
    expect(ids).toContain(waiting);
    expect(ids).not.toContain(plain);
    expect(items.find((item) => item.id === waiting)?.one_package_exception).toMatchObject({
      state: 'REQUESTED',
    });

    const approved = await ops.client.get(
      `${API}/pickup-requests?one_package_exception_state=APPROVED&page_size=100`,
    );
    expect(
      (approved.json() as { items: { id: string }[] }).items.map((item) => item.id),
    ).not.toContain(waiting);
    // The request without one carries none.
    const read = await ops.client.get(ONE(plain));
    expect(requestOf(read).one_package_exception).toBeNull();
  });

  // Break caught: a single package confirmed because an exception was merely asked for (AC-03: rejected until it is approved).
  it('does not make the request confirmable: confirming before the approval is PICKUP_MINIMUM_NOT_MET', async () => {
    const id = await single();
    await ask(ops, id);
    const answer = await confirm(ops, id);
    expect([answer.status, codeOf(answer)]).toEqual([422, 'PICKUP_MINIMUM_NOT_MET']);
    expect((await requestRowOf(id)).state).toBe('PENDING');
  });

  // Break caught: the request left unrecorded, recorded as an enhanced event, or in the wrong name or hub.
  it('writes pickup.exception.requested in the same transaction, as the Ops member, with the hub and the vendor', async () => {
    const id = await single();
    const approval = approvalOf(await ask(ops, id));
    expect(await eventsOf(id, 'pickup.exception.requested')).toEqual([
      {
        actor_id: ops.identity.id,
        enhanced: false,
        object_id: id,
        previous_state: null,
        resulting_state: null,
        before_after: null,
        related_ids: { exception_id: approval.id },
        detail: { exception_state: 'REQUESTED' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
  });

  // Break caught: an exception without its recipient (name, phone, delivery address are mandatory for a single package, section 21.1), or
  // with a recipient the platform cannot ring or deliver to, or a note that explains nothing.
  it.each([
    ['no recipient', { recipient: undefined }, 400, 'VALIDATION_FAILED'],
    ['no note', { note: undefined }, 400, 'VALIDATION_FAILED'],
    [
      'a recipient with no name',
      { recipient: recipient({ name: undefined }) },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a recipient with no phone',
      { recipient: recipient({ phone: undefined }) },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a recipient with no location',
      { recipient: recipient({ location: undefined }) },
      400,
      'VALIDATION_FAILED',
    ],
    ['a blank recipient name', { recipient: recipient({ name: '   ' }) }, 400, 'VALIDATION_FAILED'],
    [
      'a phone that is not a number',
      { recipient: recipient({ phone: 'call me' }) },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a blank delivery address',
      { recipient: recipient({ location: { address: '  ' } }) },
      400,
      'VALIDATION_FAILED',
    ],
    ['a member the contract does not name', { extra: 1 }, 400, 'VALIDATION_FAILED'],
    ['a blank note', { note: '   ' }, 422, 'REASON_REQUIRED'],
    [
      'a note the ledger would not keep',
      { note: 'Ring him on +233244123456' },
      400,
      'VALIDATION_FAILED',
    ],
  ])('refuses %s and makes nothing', async (_name, over, status, code) => {
    const id = await single();
    const answer = await ask(ops, id, body(over));
    expect([answer.status, codeOf(answer)]).toEqual([status, code]);
    await expectNothingMade(id);
  });

  // Break caught: an exception for a booking that needs none, or that can no longer be changed by it, or a second live one.
  it('is for a pending request of one package that has no live exception, and nothing else', async () => {
    const standard = await single({ packages: 3 });
    const cancelled = await single({ state: 'CANCELLED' });
    const confirmedStandard = await single({ packages: 2, state: 'CONFIRMED' });
    for (const id of [standard, cancelled, confirmedStandard]) {
      const answer = await ask(ops, id);
      expect([answer.status, codeOf(answer)], id).toEqual([409, 'STATE_CONFLICT']);
      await expectNothingMade(id);
    }

    const id = await single();
    expect((await ask(ops, id)).status).toBe(201);
    const again = await ask(opsTwo, id);
    expect([again.status, codeOf(again)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await exceptionsOf(id)).toHaveLength(1);
    // Once approved it is live as well.
    expect((await approve(opsTwo, id)).status).toBe(200);
    expect(codeOf(await ask(ops, id))).toBe('STATE_CONFLICT');
  });

  // Break caught: the request read outside its lock, so that an exception raised by another writer while this one waits is not seen and a
  // second live exception is made beside it (the unique index is the backstop; the answer is STATE_CONFLICT, not a failure). The race is
  // made, not hoped for.
  it('judges the request under its lock: an exception raised while it waits is seen by it', async () => {
    const id = await single();
    const held = await holdingPickupRequest(routes.database, id);
    let asking: Promise<TestResponse> | undefined;
    try {
      asking = ask(ops, id);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the request', asking);
      await held.client.query(
        `insert into one_package_exception (id, pickup_request_id, requested_by, note, recipient_name, recipient_phone, recipient_location)
         values ($1, $2, $3, 'raised meanwhile', 'Kofi', '+233244000111', '{"address":"x"}'::jsonb)`,
        [randomUUID(), id, opsTwo.identity.id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await asking?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await asking;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await exceptionsOf(id)).toHaveLength(1);
    expect((await exceptionsOf(id))[0]?.note).toBe('raised meanwhile');
  });

  // Break caught: a refused exception blocking a new one for the same request.
  it('allows a new request after a refused one', async () => {
    const id = await single();
    const first = approvalOf(await ask(ops, id));
    await routes.admin.query(
      `update one_package_exception set state = 'REJECTED', approved_by = $2, decided_at = now() where id = $1`,
      [first.id, opsTwo.identity.id],
    );
    const second = await ask(ops, id);
    expect(second.status).toBe(201);
    expect(approvalOf(second).id).not.toBe(first.id);
    // The request shows the live one, not the refused history.
    expect(requestOf(await ops.client.get(ONE(id))).one_package_exception?.state).toBe('REQUESTED');
  });

  // Break caught: two members of the office raising the exception at once, a second live one slipping in beside the first.
  it('makes exactly one of two concurrent requests and tells the other STATE_CONFLICT', async () => {
    const id = await single();
    const [first, second] = await Promise.all([ask(ops, id), ask(opsTwo, id)]);
    const outcomes = [first, second]
      .map((each) =>
        each.status === 201 ? '201' : `${String(each.status)} ${String(codeOf(each))}`,
      )
      .sort();
    expect(outcomes).toEqual(['201', '409 STATE_CONFLICT']);
    expect(await exceptionsOf(id)).toHaveLength(1);
  });

  // Break caught: a vendor raising the exception (it holds no such key, AC-03), a holder of other keys, or the office outside its hubs.
  it('is Ops’s: a vendor and another bundle are refused, a request of another hub is out of scope', async () => {
    const id = await single();
    const asVendor = await browserOne.post(ASK(id), body(), {});
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const asFinance = await ask(finance, id);
    expect([asFinance.status, codeOf(asFinance)]).toEqual([403, 'PERMISSION_DENIED']);
    const anonymous = await routes.browser().post(ASK(id), body(), { origin: OPS });
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);

    const elsewhere = await single({}, vendorInB, HUB_B);
    const outside = await ask(ops, elsewhere);
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await ask(ops, randomUUID());
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    const malformed = await ask(ops, 'not-a-uuid');
    expect([malformed.status, codeOf(malformed)]).toEqual([400, 'VALIDATION_FAILED']);
    await expectNothingMade(id);
    await expectNothingMade(elsewhere);
  });

  it('lets Senior Ops and a Platform Admin raise it as well, in their own name', async () => {
    const bySenior = approvalOf(await ask(senior, await single()));
    const byAdmin = approvalOf(await ask(admin, await single()));
    expect(bySenior.requested_by).toBe(senior.identity.id);
    expect(byAdmin.requested_by).toBe(admin.identity.id);
  });
});

describe('approveOnePackageException: any holder of the approval decides it (AC-SLICE-001-03)', () => {
  // Break caught: an exception approved on a request that has been cancelled since it was asked for (it stays REQUESTED, and the request
  // leaves the approver's queue for that reason, AC-QSUM-12): the approval is answered STATE_CONFLICT, as the contract declares, and not as
  // a server error from the guard of a cancelled request. Nothing is decided: the exception stays asked for, the request is unlinked, and no
  // approval is recorded.
  it('is STATE_CONFLICT for a request that is not pending any more, and decides nothing', async () => {
    const id = await single();
    const raised = approvalOf(await ask(ops, id));
    await routes.admin.query(
      `update pickup_request set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $2 where id = $1`,
      [id, ops.identity.id],
    );

    const answer = await approve(opsTwo, id);

    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    const [stored] = await exceptionsOf(id);
    expect(stored).toMatchObject({ id: raised.id, state: 'REQUESTED', approved_by: null });
    expect((await requestRowOf(id)).one_package_exception_id).toBeNull();
    expect(await eventsOf(id, 'pickup.exception.approved')).toEqual([]);
    expect(await eventsOf(id, 'pickup.request.single_package_approved')).toEqual([]);
  });

  // Break caught: an approval that does not make the request confirmable, records no approver, or snapshots no fee (it becomes due on acceptance).
  it('approves it, links it to the request, snapshots the GH₵20 fee as due, and lets the request be confirmed', async () => {
    const id = await single();
    const raised = approvalOf(await ask(ops, id));
    const answer = await approve(opsTwo, id);

    expect(answer.status).toBe(200);
    expect(approvalOf(answer)).toMatchObject({
      id: raised.id,
      state: 'APPROVED',
      requested_by: ops.identity.id,
      approved_by: opsTwo.identity.id,
      note: NOTE,
    });
    const [stored] = await exceptionsOf(id);
    expect(stored).toMatchObject({ state: 'APPROVED', approved_by: opsTwo.identity.id });
    expect(stored?.decided_at).toBeInstanceOf(Date);
    // The fee is due, as the setting stood: the amount, the key and the version, and not a live pointer to the setting.
    expect(stored?.single_package_fee_snapshot).toEqual({
      amount_minor: 2000,
      setting_key: 'single_package_pickup_fee',
      effective_version: '1',
    });
    expect((await requestRowOf(id)).one_package_exception_id).toBe(raised.id);

    const read = requestOf(await ops.client.get(ONE(id)));
    expect(read.one_package_exception_id).toBe(raised.id);
    expect(read.one_package_exception).toMatchObject({
      state: 'APPROVED',
      approved_by: opsTwo.identity.id,
      single_package_fee: { amount_minor: 2000, currency: 'GHS' },
    });
    expect(read.one_package_exception?.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const confirmed = await confirm(ops, id);
    expect(confirmed.status).toBe(200);
    expect(requestOf(confirmed).state).toBe('CONFIRMED');
  });

  // Break caught: a single package confirmed on an approval the booking does not carry (an approved exception that nothing linked to the
  // request is no approval of this booking; the operation always links, and another writer might not).
  it('confirms only on the exception the booking carries: an approved one that is not linked is no approval', async () => {
    const id = await single();
    const raised = approvalOf(await ask(ops, id));
    await routes.admin.query(
      `update one_package_exception set state = 'APPROVED', approved_by = $2, decided_at = now() where id = $1`,
      [raised.id, opsTwo.identity.id],
    );
    expect((await requestRowOf(id)).one_package_exception_id).toBeNull();
    const answer = await confirm(ops, id);
    expect([answer.status, codeOf(answer)]).toEqual([422, 'PICKUP_MINIMUM_NOT_MET']);
    expect((await requestRowOf(id)).state).toBe('PENDING');
  });

  // Break caught: the approving actor and the key not audited (every Ops Staff member holds the key since 29 October, so the actor is the audit),
  // or a fee reported as posted when nothing posted it (posting to a statement or a prepayment gate is SLICE-011's).
  it('records who approved and under which key, at the enhanced tier, and posts no fee', async () => {
    const id = await single();
    const raised = approvalOf(await ask(ops, id));
    expect((await approve(senior, id)).status).toBe(200);

    expect(await eventsOf(id, 'pickup.exception.approved')).toEqual([
      {
        actor_id: senior.identity.id,
        enhanced: true,
        object_id: id,
        previous_state: null,
        resulting_state: null,
        before_after: {
          exception_state: { before: 'REQUESTED', after: 'APPROVED' },
          one_package_exception_id: { before: null, after: raised.id },
        },
        related_ids: { exception_id: raised.id, requested_by: ops.identity.id },
        detail: { permission: 'pickup.exception.approve', grant_tier: 'S' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
    const sibling = await eventsOf(id, 'pickup.request.single_package_approved');
    expect(sibling).toHaveLength(1);
    expect(sibling[0]).toMatchObject({ actor_id: senior.identity.id, enhanced: true });
    // The fee is recorded as due on the exception; its posting is another slice's, so nothing claims it was posted.
    expect(await eventsOf(id, 'pickup.request.single_package_fee_posted')).toEqual([]);
  });

  // Break caught: Ops Staff, Senior Ops or a Platform Admin unable to approve (any holder does, AC-03), or the tier misrecorded.
  it('lets Ops Staff, Senior Ops and a Platform Admin approve, each in their own name', async () => {
    for (const [who, tier] of [
      [opsTwo, 'A'],
      [senior, 'S'],
      [admin, 'P'],
    ] as const) {
      const id = await single();
      await ask(ops, id);
      expect((await approve(who, id)).status, tier).toBe(200);
      expect((await eventsOf(id, 'pickup.exception.approved'))[0]).toMatchObject({
        actor_id: who.identity.id,
        detail: { permission: 'pickup.exception.approve', grant_tier: tier },
      });
    }
  });

  // Break caught: a requester approving their own request (SELF_APPROVAL_FORBIDDEN), or the Platform Admin held to a rule it is exempt from.
  it('refuses the requester as SELF_APPROVAL_FORBIDDEN, unless the requester is a Platform Admin', async () => {
    for (const who of [ops, senior]) {
      const id = await single();
      await ask(who, id);
      const answer = await approve(who, id);
      expect([answer.status, codeOf(answer)]).toEqual([422, 'SELF_APPROVAL_FORBIDDEN']);
      expect((await exceptionsOf(id))[0]?.state).toBe('REQUESTED');
      expect(await eventsOf(id, 'pickup.exception.approved')).toEqual([]);
      expect((await requestRowOf(id)).one_package_exception_id).toBeNull();
    }
    const own = await single();
    await ask(admin, own);
    const approved = await approve(admin, own);
    expect(approved.status).toBe(200);
    expect(approvalOf(approved)).toMatchObject({
      state: 'APPROVED',
      requested_by: admin.identity.id,
      approved_by: admin.identity.id,
    });
  });

  // Break caught: a user without the key approving (AC-03: PERMISSION_DENIED), a vendor approving its own request's exception, or a hub crossed.
  it('is refused to a vendor and to a bundle without the key, and a request of another hub is out of scope', async () => {
    const id = await single();
    await ask(ops, id);
    const asVendor = await browserOne.post(APPROVE(id), undefined, {});
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const asFinance = await approve(finance, id);
    expect([asFinance.status, codeOf(asFinance)]).toEqual([403, 'PERMISSION_DENIED']);
    const anonymous = await routes.browser().post(APPROVE(id), undefined, { origin: OPS });
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    const outside = await approve(opsB, id);
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await approve(ops, randomUUID());
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    const malformed = await approve(ops, 'not-a-uuid');
    expect([malformed.status, codeOf(malformed)]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await exceptionsOf(id))[0]?.state).toBe('REQUESTED');
  });

  // Break caught: an approval of something that is not waiting (no exception, one already decided), or an approval taken twice.
  it('approves only an exception that is waiting, once', async () => {
    const none = await single();
    const noException = await approve(ops, none);
    expect([noException.status, codeOf(noException)]).toEqual([409, 'STATE_CONFLICT']);

    const id = await single();
    await ask(ops, id);
    expect((await approve(opsTwo, id)).status).toBe(200);
    const again = await approve(senior, id);
    expect([again.status, codeOf(again)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await eventsOf(id, 'pickup.exception.approved')).toHaveLength(1);

    const refused = await single();
    const raised = approvalOf(await ask(ops, refused));
    await routes.admin.query(
      `update one_package_exception set state = 'REJECTED', approved_by = $2, decided_at = now() where id = $1`,
      [raised.id, opsTwo.identity.id],
    );
    const afterRefusal = await approve(senior, refused);
    expect([afterRefusal.status, codeOf(afterRefusal)]).toEqual([409, 'STATE_CONFLICT']);
  });

  // Break caught: two approvers deciding at once, the second silently overwriting the first or approving twice.
  it('lets exactly one of two concurrent approvals succeed and tells the other STATE_CONFLICT', async () => {
    const id = await single();
    await ask(ops, id);
    const [first, second] = await Promise.all([approve(opsTwo, id), approve(senior, id)]);
    const outcomes = [first, second]
      .map((each) =>
        each.status === 200 ? '200' : `${String(each.status)} ${String(codeOf(each))}`,
      )
      .sort();
    expect(outcomes).toEqual(['200', '409 STATE_CONFLICT']);
    expect(await eventsOf(id, 'pickup.exception.approved')).toHaveLength(1);
  });

  // Break caught: the state of the exception read outside the request's lock, so that an exception refused while the approval waited is
  // approved on the strength of the earlier read. The race is made, not hoped for (the row is held, the approval is seen waiting).
  it('judges the exception under the request’s lock: one refused while the approval waits is not approved', async () => {
    const id = await single();
    const raised = approvalOf(await ask(ops, id));
    const held = await holdingPickupRequest(routes.database, id);
    let approving: Promise<TestResponse> | undefined;
    try {
      approving = approve(opsTwo, id);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the approval', approving);
      await held.client.query(
        `update one_package_exception set state = 'REJECTED', approved_by = $2, decided_at = now() where id = $1`,
        [raised.id, senior.identity.id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await approving?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await approving;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await exceptionsOf(id))[0]?.state).toBe('REJECTED');
    expect((await requestRowOf(id)).one_package_exception_id).toBeNull();
    expect(await eventsOf(id, 'pickup.exception.approved')).toEqual([]);
  });

  // Break caught: the exception judged on the earlier read only, so that one decided by a writer that does not hold the request (it has its
  // own row) while the approval waits is approved on the strength of what was read before.
  it('judges the exception under its own lock: one decided by another writer while the approval waits is not approved', async () => {
    const id = await single();
    const raised = approvalOf(await ask(ops, id));
    const held = await holdingOnePackageException(routes.database, raised.id);
    let approving: Promise<TestResponse> | undefined;
    try {
      approving = approve(opsTwo, id);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the approval', approving);
      await held.client.query(
        `update one_package_exception set state = 'REJECTED', approved_by = $2, decided_at = now() where id = $1`,
        [raised.id, senior.identity.id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await approving?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await approving;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await exceptionsOf(id))[0]?.state).toBe('REJECTED');
    expect((await requestRowOf(id)).one_package_exception_id).toBeNull();
    expect(await eventsOf(id, 'pickup.exception.approved')).toEqual([]);
  });

  // Break caught: a hub with no fee refusing the approval (an operational decision is never held hostage to commercial configuration), or a
  // fee read again later and repriced under an approval that was already given.
  it('approves where the hub has no fee and records that; and does not reprice an approval when the fee changes', async () => {
    const elsewhere = await single({}, vendorInB, HUB_B);
    await ask(opsB, elsewhere);
    const noFee = await approve(await routes.actor(BUNDLE_IDS.opsStaff, HUB_B), elsewhere);
    expect(noFee.status).toBe(200);
    expect((await exceptionsOf(elsewhere))[0]?.single_package_fee_snapshot).toBeNull();
    expect((await eventsOf(elsewhere, 'pickup.exception.approved'))[0]?.detail).toMatchObject({
      fee_check: 'SETTING_MISSING',
    });
    expect(
      requestOf(await opsB.client.get(ONE(elsewhere))).one_package_exception?.single_package_fee,
    ).toBeNull();

    const id = await single();
    await ask(ops, id);
    expect((await approve(opsTwo, id)).status).toBe(200);
    await setHubSetting(routes.admin, HUB_A, 'single_package_pickup_fee', 3500, 'pesewas');
    try {
      expect(
        requestOf(await ops.client.get(ONE(id))).one_package_exception?.single_package_fee,
      ).toEqual({ amount_minor: 2000, currency: 'GHS' });
      // A later approval is priced at the version then in force.
      const later = await single();
      await ask(ops, later);
      expect((await approve(opsTwo, later)).status).toBe(200);
      expect((await exceptionsOf(later))[0]?.single_package_fee_snapshot).toEqual({
        amount_minor: 3500,
        setting_key: 'single_package_pickup_fee',
        effective_version: '2',
      });
    } finally {
      await setHubSetting(routes.admin, HUB_A, 'single_package_pickup_fee', 2000, 'pesewas');
    }
  });
});

describe('the estimate of a single package with an approved exception names its destination', () => {
  // Break caught: an estimate invented for an address no zone is known for (the alias data is the owner's to supply; none is seeded).
  it('is none while the delivery address belongs to no known zone', async () => {
    const id = await single();
    await ask(
      ops,
      id,
      body({ recipient: recipient({ location: { address: 'Plot 9, Somewhere Unmapped' } }) }),
    );
    await approve(opsTwo, id);
    const confirmed = await confirm(ops, id);
    expect(confirmed.status).toBe(200);
    expect(requestOf(confirmed).indicative_estimate).toBeNull();
  });

  // Break caught: the pickup fee left out, the in-area fee not applied, or the destination's fee not the one for the service day.
  it.each([
    [
      'an in-area doorstep',
      'House 7, Adenta Housing Down',
      WEDNESDAY,
      'SERVICE_AREA_BASE_FEE',
      3500,
    ],
    [
      'a corridor on its batch day',
      'Junction, Amasaman Junction',
      FRIDAY,
      'SERVICE_AREA_BASE_FEE',
      3500,
    ],
    [
      'a corridor off its batch day',
      'Junction, Amasaman Junction',
      WEDNESDAY,
      'CORRIDOR_OFF_DAY_FEE',
      7000,
    ],
  ])(
    'prices %s as the fee that applies there plus the single-package pickup fee',
    async (_name, address, date, kind, delivery) => {
      const id = await single({ serviceDate: date });
      await ask(ops, id, body({ recipient: recipient({ location: { address } }) }));
      await approve(opsTwo, id);
      const confirmed = await confirm(ops, id);
      expect(confirmed.status).toBe(200);
      const estimate = requestOf(confirmed).indicative_estimate;
      expect(estimate).toMatchObject({
        status: 'AVAILABLE',
        total: { amount_minor: delivery + 2000, currency: 'GHS' },
      });
      expect(
        estimate?.components.map((each) => [each.kind, each.quantity, each.amount.amount_minor]),
      ).toEqual([
        [kind, 1, delivery],
        ['SINGLE_PACKAGE_PICKUP_FEE', 1, 2000],
      ]);
    },
  );
});

describe('the approval travels with the booking', () => {
  // Break caught: the clone of a rescheduled single package needing a second approval, or a second fee (it is the same booking and the same trip).
  it('is carried into the clone of a late booking’s reschedule, which Ops can confirm without asking again', async () => {
    const id = await single({ serviceDate: past });
    const raised = approvalOf(await ask(ops, id));
    expect((await approve(opsTwo, id)).status).toBe(200);
    const late = await confirm(ops, id);
    expect(late.status).toBe(200);
    expect(requestOf(late).cutoff_exception_state).toBe('PENDING_OPS_REVIEW');

    const rescheduled = await ops.client.post(
      CUTOFF(id),
      { decision: 'RESCHEDULE_NEXT_DAY', note: 'The run for the day is built' },
      {
        origin: OPS,
        headers: { 'If-Match': await etagOf(ops, id), 'Idempotency-Key': randomUUID() },
      },
    );
    expect(rescheduled.status).toBe(200);
    const cloneId = requestOf(rescheduled).replacement_request_id ?? '';
    expect((await requestRowOf(cloneId)).one_package_exception_id).toBe(raised.id);
    const cloneRead = requestOf(await ops.client.get(ONE(cloneId)));
    expect(cloneRead.one_package_exception).toMatchObject({ id: raised.id, state: 'APPROVED' });

    const confirmedClone = await confirm(ops, cloneId);
    expect(confirmedClone.status).toBe(200);
    expect(requestOf(confirmedClone).state).toBe('CONFIRMED');
    // One approval, one exception, one fee.
    expect(await exceptionsOf(cloneId)).toEqual([]);
    expect(await exceptionsOf(id)).toHaveLength(1);
  });
});

// The owner's decision of 29 October 2026: a vendor reads the exception of its own request as an outcome only. It sees the state, when it
// was asked for and decided, the recipient it gave and the fee that became due; it never sees Ops's internal note or the ids of the staff
// who asked for and approved it. Both audiences read one representation of the request, so the token a vendor holds is the token Ops holds.
describe('what a vendor reads of its own exception: the outcome only', () => {
  const CANCEL = (id: string) => `${API}/pickup-requests/${id}/cancel`;
  const LIST = `${API}/pickup-requests?page_size=100`;
  const REASON = 'FIXTURE_VENDOR_VIEW_CANCEL';
  const INTERNAL = 'Internal: the vendor asked us twice, approve it';
  const OUTCOME_KEYS = [
    'decided_at',
    'id',
    'recipient',
    'requested_at',
    'single_package_fee',
    'state',
  ];

  beforeAll(async () => {
    await routes.admin.query(
      `insert into reason_code (code, domain, label, attribution) values ($1, 'PICKUP_CANCELLATION', 'Fixture', 'CUSTOMER')`,
      [REASON],
    );
  });

  /** A request of one package whose exception was asked for with an internal note and approved. */
  const approved = async (): Promise<string> => {
    const id = await single();
    expect((await ask(ops, id, body({ note: INTERNAL }))).status).toBe(201);
    expect((await approve(opsTwo, id)).status).toBe(200);
    return id;
  };
  const exceptionOf = (response: TestResponse): Record<string, unknown> | null =>
    (response.json() as { one_package_exception: Record<string, unknown> | null })
      .one_package_exception;

  // Break caught: the vendor answered with the exception as Ops reads it, the internal note and two staff ids included.
  it('answers a vendor with the state, the times, the recipient and the fee, and no note and no staff id', async () => {
    const id = await approved();
    const read = await browserOne.get(ONE(id));
    expect(read.status).toBe(200);
    const exception = exceptionOf(read);
    expect(Object.keys(exception ?? {}).toSorted()).toEqual(OUTCOME_KEYS);
    expect(exception).toMatchObject({
      state: 'APPROVED',
      recipient: { name: 'Kofi Recipient', phone: '+233244000111' },
      single_package_fee: { amount_minor: 2000, currency: 'GHS' },
    });
    expect(read.text).not.toContain(INTERNAL);
    const staffIds = [...(await exceptionsOf(id))].flatMap((row) => [
      row.requested_by,
      row.approved_by,
    ]);
    for (const staffId of staffIds) expect(read.text).not.toContain(staffId ?? 'none');
  });

  // Break caught: the redaction applied to every audience, which would hide from Ops the note and the ids it needs to decide.
  it('still answers Ops with the whole exception', async () => {
    const id = await approved();
    const exception = exceptionOf(await ops.client.get(ONE(id)));
    expect(Object.keys(exception ?? {}).toSorted()).toEqual(
      [...OUTCOME_KEYS, 'approved_by', 'note', 'requested_by'].toSorted(),
    );
    expect(exception).toMatchObject({ note: INTERNAL });
  });

  // Break caught: the list redacting less than the read, a second way to the note.
  it('leaves the note and the ids out of a vendor’s list as well', async () => {
    const id = await approved();
    const list = await browserOne.get(LIST);
    expect(list.status).toBe(200);
    const items = (list.json() as { items: { id: string; one_package_exception: object | null }[] })
      .items;
    const mine = items.find((item) => item.id === id);
    expect(Object.keys(mine?.one_package_exception ?? {}).toSorted()).toEqual(OUTCOME_KEYS);
    expect(list.text).not.toContain(INTERNAL);
  });

  // Break caught: a token computed over what each audience is shown, so that the token a vendor read is refused when it comes back, or
  // Ops and the vendor hold different tokens for one request.
  it('hands the vendor the token Ops holds, and the vendor’s cancellation with it succeeds and answers without the note', async () => {
    const id = await approved();
    const vendorEtag = (await browserOne.get(ONE(id))).header('etag');
    expect(vendorEtag).not.toBeNull();
    expect(vendorEtag).toBe(await etagOf(ops, id));
    const cancelled = await browserOne.post(
      CANCEL(id),
      { reason_code: REASON },
      { headers: { 'If-Match': vendorEtag ?? '', 'Idempotency-Key': randomUUID() } },
    );
    expect(cancelled.status).toBe(200);
    expect(Object.keys(exceptionOf(cancelled) ?? {}).toSorted()).toEqual(OUTCOME_KEYS);
    expect(cancelled.text).not.toContain(INTERNAL);
  });
});
