import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  insertAdHocSender,
  insertPickupRequest,
  operatingDay,
  pickupRequestRow,
  holdingPickupRequest,
  setFinancialStanding,
  setHubSetting,
} from './support/pickups.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import { liftProviderCeiling } from './support/provider-ceiling.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.15, `confirmPickupRequest` against the real application and a real PostgreSQL (`AC-SLICE-001-01`, `-03`, `-04`, `-10`; pickup-request.md
 * sections 5.1 and 5.2; state-machines.md section 3): `PENDING` to `CONFIRMED` by Ops under `If-Match`, the guards revalidated under the
 * request's lock, the indicative estimate, and a booking past the hub's cutoff confirmed and queued for review, never refused.
 *
 * The cutoff is judged on the database's clock, so the tests that depend on it use a service date that has passed (late for everyone, at
 * any hour) or one ahead (on time for everyone), and the settings themselves (the next version of the grace window, an unset cutoff) for
 * the rest; the hours around the cutoff are proved by the pure function's own test with explicit instants.
 */
const ONE = (id: string) => `${API}/pickup-requests/${id}`;
const CONFIRM = (id: string) => `${API}/pickup-requests/${id}/confirm`;
const SUNDAY = '2026-11-08';
const CUTOFF_UNIT = 'time of day, Africa/Accra';

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
  // The race of the lock test holds a row until the test has seen the confirmation wait for it: the test ends the wait and not a bound, so
  // the database's lock bound is lengthened for this application alone. Nothing here tests a timeout.
  routes = await startVendorRoutes({
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
  await seedHubConfiguration(routes.database);
  // This file confirms dozens of requests from a few officers' sessions inside a minute; the ceiling of the operations that cause a text is proven elsewhere.
  await liftProviderCeiling(routes.admin);
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

/** A `PENDING` request of three packages by the first vendor in hub A for a date ahead, unless the test says otherwise. */
const arrange = async (
  over: Parameters<typeof pickupRequestRow>[2] = {},
  vendor: ArrangedVendor = vendorOne,
  hub: string = HUB_A,
): Promise<string> =>
  (
    await insertPickupRequest(
      routes.admin,
      pickupRequestRow(vendor.row.organizationId, hub, { serviceDate: ahead, ...over }),
    )
  ).id;

const etagOf = async (actor: Actor, id: string): Promise<string> => {
  const read = await actor.client.get(ONE(id));
  expect(read.status).toBe(200);
  const etag = read.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
};

const confirm = (actor: Actor, id: string, ifMatch?: string): Promise<TestResponse> =>
  actor.client.post(CONFIRM(id), undefined, {
    origin: OPS,
    headers: ifMatch === undefined ? {} : { 'If-Match': ifMatch },
  });

interface Confirmed {
  readonly id: string;
  readonly state: string;
  readonly confirmed_at: string | null;
  readonly cutoff_exception_state: string | null;
  readonly cancellation_charge: unknown;
  readonly cancellation_charge_outcome: unknown;
  readonly indicative_estimate: {
    readonly status: string;
    readonly provisional: boolean;
    readonly total: { amount_minor: number; currency: string } | null;
    readonly assumes_size_class: string;
    readonly components: readonly Record<string, unknown>[];
  } | null;
}
const bodyOf = (response: TestResponse): Confirmed => response.json() as Confirmed;

interface StoredRow {
  readonly state: string;
  readonly version: number;
  readonly confirmed_by: string | null;
  readonly cutoff_exception_state: string | null;
}
const rowOf = async (id: string): Promise<StoredRow> => {
  const [row] = await routes.rows<StoredRow>(
    `select state, version, confirmed_by, cutoff_exception_state from pickup_request where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such request');
  return row;
};

interface Event {
  readonly actor_id: string | null;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly enhanced: boolean;
  readonly detail: Record<string, unknown>;
  readonly responsible_hub_id: string | null;
  readonly vendor_organization_id: string | null;
}
const eventsOf = (id: string, code = 'pickup.request.confirmed'): Promise<Event[]> =>
  routes.rows<Event>(
    `select actor_id, previous_state, resulting_state, enhanced, detail, responsible_hub_id, vendor_organization_id
       from audit_event where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, id],
  );

interface Envelope {
  readonly event_type: string;
  readonly aggregate_type: string;
  readonly responsible_hub_id: string;
  readonly vendor_organization_id: string | null;
  readonly rider_id: string | null;
  readonly originating_principal_type: string;
  readonly originating_principal_id: string;
  readonly operation_id: string;
  readonly relay_state: string;
  readonly payload: Record<string, unknown>;
}
/** The outbox envelopes of an aggregate (S1.12): written by the act, read by the lane of the worker. */
const envelopesOf = (id: string): Promise<Envelope[]> =>
  routes.rows<Envelope>(
    `select event_type, aggregate_type, responsible_hub_id, vendor_organization_id, rider_id, originating_principal_type,
            originating_principal_id, operation_id, relay_state, payload
       from outbox where aggregate_id = $1 order by created_at, id`,
    [id],
  );

/** A refusal changed nothing: the request is as it was, at the same version, with no confirmation recorded, and no envelope written. */
const expectUntouched = async (id: string): Promise<void> => {
  const row = await rowOf(id);
  expect([row.state, row.version, row.confirmed_by, row.cutoff_exception_state]).toEqual([
    'PENDING',
    1,
    null,
    null,
  ]);
  expect(await eventsOf(id)).toEqual([]);
  expect(await envelopesOf(id)).toEqual([]);
};

describe('a standard request is confirmed (AC-SLICE-001-01)', () => {
  // Break caught: a confirmation that leaves the request PENDING, omits or mislabels the estimate, creates a charge, or skips the audit.
  it('moves it to CONFIRMED with a provisional estimate of the base fee times the packages and no charge', async () => {
    const id = await arrange({ packages: 3 });
    const answer = await confirm(ops, id, await etagOf(ops, id));

    expect(answer.status).toBe(200);
    const request = bodyOf(answer);
    expect(request).toMatchObject({
      id,
      state: 'CONFIRMED',
      cutoff_exception_state: null,
      cancellation_charge: null,
      cancellation_charge_outcome: null,
    });
    expect(request.confirmed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(request.indicative_estimate).toMatchObject({
      status: 'AVAILABLE',
      provisional: true,
      total: { amount_minor: 10_500, currency: 'GHS' },
      assumes_size_class: 'SMALL',
    });
    expect(request.indicative_estimate?.components).toEqual([
      {
        kind: 'SERVICE_AREA_BASE_FEE',
        hub_id: HUB_A,
        setting_key: 'service_area_base_fee',
        effective_version: '1',
        quantity: 3,
        amount: { amount_minor: 10_500, currency: 'GHS' },
      },
    ]);
    // It is a quote of nothing: no price member, no credit and no charge anywhere in the answer.
    for (const priced of ['"price', '"quote', '"amount_due', '"credit']) {
      expect(answer.text, priced).not.toContain(priced);
    }
  });

  // Break caught: the stored request not what the answer said, the actor not recorded, or the version not moved for the next mutation.
  it('records who confirmed it and when, and moves the version that the next mutation must name', async () => {
    const id = await arrange();
    const answer = await confirm(ops, id, await etagOf(ops, id));
    expect(answer.status).toBe(200);

    const row = await rowOf(id);
    expect(row).toMatchObject({
      state: 'CONFIRMED',
      version: 2,
      confirmed_by: ops.identity.id,
      cutoff_exception_state: null,
    });
    // The ETag of the answer is the one a fresh read hands out for the confirmed request.
    expect(answer.header('etag')).toBe(await etagOf(ops, id));
    // What the read shows is what the answer said, but for the estimate only an operation that computes it carries.
    const read = (await ops.client.get(ONE(id))).json() as Record<string, unknown>;
    expect(read).toEqual({ ...bodyOf(answer), indicative_estimate: null });
  });

  // Break caught: a confirmed request that never reaches the pool the manifest draws from (AC-01: it appears in the unmanifested pool).
  it('puts the request in the unmanifested pool', async () => {
    const id = await arrange();
    expect((await confirm(ops, id, await etagOf(ops, id))).status).toBe(200);

    const pool = await ops.client.get(`${API}/pickup-requests?state=CONFIRMED&manifested=false`);
    expect(pool.status).toBe(200);
    const ids = (pool.json() as { items: { id: string }[] }).items.map((item) => item.id);
    expect(ids).toContain(id);
  });

  // Break caught: the confirmation written outside the transaction of the act, or as the wrong actor, or at the enhanced tier.
  it('writes pickup.request.confirmed in the same transaction, as the Ops member, with the hub and the vendor', async () => {
    const id = await arrange();
    expect((await confirm(ops, id, await etagOf(ops, id))).status).toBe(200);

    expect(await eventsOf(id)).toEqual([
      {
        actor_id: ops.identity.id,
        previous_state: 'PENDING',
        resulting_state: 'CONFIRMED',
        enhanced: false,
        detail: { cutoff_check: 'ON_TIME' },
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
      },
    ]);
  });

  // Break caught (S1.12): the notification written outside the act's transaction, as another principal, with a scope the request does not
  // have, or with something personal in it.
  it('writes the outbox envelope of the confirmation in the same transaction, as the Ops member, with the hub and the vendor of the request', async () => {
    const id = await arrange();
    expect((await confirm(ops, id, await etagOf(ops, id))).status).toBe(200);

    expect(await envelopesOf(id)).toEqual([
      {
        event_type: 'pickup.request.confirmed',
        aggregate_type: 'PICKUP_REQUEST',
        responsible_hub_id: HUB_A,
        vendor_organization_id: vendorOne.row.organizationId,
        rider_id: null,
        originating_principal_type: 'STAFF',
        originating_principal_id: ops.identity.id,
        operation_id: 'confirmPickupRequest',
        relay_state: 'PENDING',
        payload: {},
      },
    ]);
  });

  // Break caught: an envelope for a confirmation that did not happen, or one written twice for one that did.
  it('writes no envelope for a confirmation that is refused, and one only for the confirmation that succeeds', async () => {
    const stale = await arrange();
    const token = await etagOf(ops, stale);
    expect((await confirm(ops, stale, token)).status).toBe(200);
    expect(await envelopesOf(stale)).toHaveLength(1);
    // The token is spent: the second confirmation is refused and leaves the one envelope there was.
    expect((await confirm(opsTwo, stale, token)).status).toBeGreaterThanOrEqual(400);
    expect(await envelopesOf(stale)).toHaveLength(1);

    const single = await arrange({ packages: 1 });
    expect((await confirm(ops, single, await etagOf(ops, single))).status).toBe(422);
    expect(await envelopesOf(single)).toEqual([]);
  });

  it('confirms an ad-hoc sender’s request as it confirms a vendor’s, with no vendor on the record', async () => {
    const sender = await insertAdHocSender(routes.admin, { state: 'REUSABLE' });
    const id = await arrange({
      intent: 'ADHOC_SENDER',
      vendorOrganizationId: null,
      adHocSenderId: sender.id,
      packages: 2,
    });
    const answer = await confirm(ops, id, await etagOf(ops, id));
    expect(answer.status).toBe(200);
    expect(bodyOf(answer).indicative_estimate?.total).toEqual({
      amount_minor: 7_000,
      currency: 'GHS',
    });
    expect((await eventsOf(id))[0]?.vendor_organization_id).toBeNull();
    expect((await envelopesOf(id)).map((each) => each.vendor_organization_id)).toEqual([null]);
  });
});

describe('a late booking is confirmed and queued, never refused (AC-SLICE-001-04)', () => {
  // Break caught: a booking past the cutoff refused (BOOKING_CUTOFF_PASSED is withdrawn) or confirmed without the review flag.
  it('confirms a request whose cutoff has passed and queues it for Ops review', async () => {
    const id = await arrange({ serviceDate: past });
    const answer = await confirm(ops, id, await etagOf(ops, id));

    expect(answer.status).toBe(200);
    expect(bodyOf(answer)).toMatchObject({
      state: 'CONFIRMED',
      cutoff_exception_state: 'PENDING_OPS_REVIEW',
    });
    expect(await rowOf(id)).toMatchObject({
      state: 'CONFIRMED',
      cutoff_exception_state: 'PENDING_OPS_REVIEW',
    });
    expect((await eventsOf(id))[0]?.detail).toEqual({ cutoff_check: 'LATE' });
    // A late booking still carries its estimate: queued for review does not mean unpriced.
    expect(bodyOf(answer).indicative_estimate?.status).toBe('AVAILABLE');
  });

  // Break caught: a hub with no cutoff queueing or refusing bookings (a second hub starts with none: settings.md section 33.4).
  it('does not queue or refuse a booking of a hub that has no cutoff, and records that it had none', async () => {
    const id = await arrange({ serviceDate: past }, vendorInB, HUB_B);
    const answer = await confirm(opsB, id, await etagOf(opsB, id));

    expect(answer.status).toBe(200);
    expect(bodyOf(answer)).toMatchObject({ state: 'CONFIRMED', cutoff_exception_state: null });
    expect((await eventsOf(id))[0]?.detail).toMatchObject({ cutoff_check: 'SETTING_MISSING' });
    // The estimate of a hub with no fees says it is unavailable and why, and the confirmation went on.
    expect(bodyOf(answer).indicative_estimate).toMatchObject({
      status: 'UNAVAILABLE_SETTING_MISSING',
      total: null,
    });
  });

  // Break caught: a malformed cutoff blocking a booking as a missing one must not, or being read as some time of day.
  it('treats a cutoff that is not a time of day as none, and records it', async () => {
    await setHubSetting(routes.admin, HUB_A, 'booking_cutoff_time', 'half past ten', CUTOFF_UNIT);
    try {
      const id = await arrange({ serviceDate: past });
      const answer = await confirm(ops, id, await etagOf(ops, id));
      expect(answer.status).toBe(200);
      expect(bodyOf(answer).cutoff_exception_state).toBeNull();
      expect((await eventsOf(id))[0]?.detail).toMatchObject({ cutoff_check: 'SETTING_INVALID' });
    } finally {
      await setHubSetting(routes.admin, HUB_A, 'booking_cutoff_time', '10:00', CUTOFF_UNIT);
    }
  });

  describe('the grace window of a vendor that has settled', () => {
    // A window of a week reaches back over the date a test can reach, whatever the day it runs on; the saved value comes back after.
    beforeAll(async () => {
      await setHubSetting(
        routes.admin,
        HUB_A,
        'vendor_credit_grace_window_minutes',
        7 * 24 * 60,
        'minutes',
      );
    });
    afterAll(async () => {
      await setHubSetting(routes.admin, HUB_A, 'vendor_credit_grace_window_minutes', 60, 'minutes');
      await routes.admin.query(`delete from vendor_financial_standing`);
    });

    // Break caught: the grace window ignored (MSC-DEC-254), or given to a vendor that has not settled, or to a sender that is no vendor.
    it('is given to a settled vendor, withheld from an overdue one, and never given to a walk-in', async () => {
      const settled = await arrange({ serviceDate: past });
      expect((await confirm(ops, settled, await etagOf(ops, settled))).status).toBe(200);
      expect(await rowOf(settled)).toMatchObject({ cutoff_exception_state: null });
      expect((await eventsOf(settled))[0]?.detail).toEqual({ cutoff_check: 'ON_TIME_IN_GRACE' });

      await setFinancialStanding(routes.admin, vendorOne.row.organizationId, 'OVERDUE');
      const overdue = await arrange({ serviceDate: past });
      const refusedGrace = await confirm(ops, overdue, await etagOf(ops, overdue));
      expect(refusedGrace.status).toBe(200);
      expect(bodyOf(refusedGrace).cutoff_exception_state).toBe('PENDING_OPS_REVIEW');
      expect((await eventsOf(overdue))[0]?.detail).toEqual({ cutoff_check: 'LATE' });

      await setFinancialStanding(routes.admin, vendorOne.row.organizationId, 'GOOD');
      const sender = await insertAdHocSender(routes.admin, { state: 'REUSABLE' });
      const walkIn = await arrange({
        serviceDate: past,
        intent: 'ADHOC_SENDER',
        vendorOrganizationId: null,
        adHocSenderId: sender.id,
      });
      expect(
        bodyOf(await confirm(ops, walkIn, await etagOf(ops, walkIn))).cutoff_exception_state,
      ).toBe('PENDING_OPS_REVIEW');
    });
  });
});

describe('the guards are revalidated when the request is confirmed', () => {
  // Break caught: a single package confirmed with no exception (AC-03: the confirmation is rejected until the exception is approved).
  it('refuses a single package with no exception as PICKUP_MINIMUM_NOT_MET and changes nothing', async () => {
    const id = await arrange({ packages: 1 });
    const answer = await confirm(ops, id, await etagOf(ops, id));
    expect([answer.status, codeOf(answer)]).toEqual([422, 'PICKUP_MINIMUM_NOT_MET']);
    await expectUntouched(id);
  });

  // Break caught: a Sunday confirmed because the date was valid when the request was made.
  it('refuses a Sunday service date as SERVICE_DATE_NOT_PERMITTED and changes nothing', async () => {
    const id = await arrange({ serviceDate: SUNDAY });
    const answer = await confirm(ops, id, await etagOf(ops, id));
    expect([answer.status, codeOf(answer)]).toEqual([422, 'SERVICE_DATE_NOT_PERMITTED']);
    await expectUntouched(id);
  });

  // Break caught: a vendor suspended after it booked still having its requests confirmed.
  it('refuses a suspended sender as SENDER_SUSPENDED, leaving the request PENDING', async () => {
    const vendor = await routes.vendor();
    const id = await arrange({}, vendor);
    await routes.admin.query(
      `update vendor_organization set operational_status = 'SUSPENDED' where id = $1`,
      [vendor.row.organizationId],
    );
    const answer = await confirm(ops, id, await etagOf(ops, id));
    expect([answer.status, codeOf(answer)]).toEqual([422, 'SENDER_SUSPENDED']);
    await expectUntouched(id);
  });

  // Break caught: the cap applied one attempt early or late, or lifted without an extension (AC-07).
  it('holds the attempt cap: the third attempt confirms, the fourth does not without an extension, and an extension lifts it', async () => {
    const third = await arrange({ attemptNumber: 3 });
    expect((await confirm(ops, third, await etagOf(ops, third))).status).toBe(200);

    const fourth = await arrange({ attemptNumber: 4 });
    const refused = await confirm(ops, fourth, await etagOf(ops, fourth));
    expect([refused.status, codeOf(refused)]).toEqual([422, 'PICKUP_ATTEMPT_LIMIT_REACHED']);
    await expectUntouched(fourth);

    const extended = await arrange({ attemptNumber: 4, attemptExtensionId: randomUUID() });
    expect((await confirm(ops, extended, await etagOf(ops, extended))).status).toBe(200);
  });

  // Break caught: an unset cap blocking a confirmation, or being read as zero attempts.
  it('does not block on a hub that has no attempt cap, and records that it had none', async () => {
    const id = await arrange({ attemptNumber: 5 }, vendorInB, HUB_B);
    expect((await confirm(opsB, id, await etagOf(opsB, id))).status).toBe(200);
    expect((await eventsOf(id))[0]?.detail).toMatchObject({ attempt_cap_check: 'SETTING_MISSING' });
  });

  // Break caught: the guards run in an order other than the contract's, so a client is told the wrong first problem.
  it('reports the first broken rule in the contract’s order', async () => {
    const vendor = await routes.vendor();
    await routes.admin.query(
      `update vendor_organization set operational_status = 'SUSPENDED' where id = $1`,
      [vendor.row.organizationId],
    );
    const minimumFirst = await arrange(
      { packages: 1, serviceDate: SUNDAY, attemptNumber: 9 },
      vendor,
    );
    expect(codeOf(await confirm(ops, minimumFirst, await etagOf(ops, minimumFirst)))).toBe(
      'PICKUP_MINIMUM_NOT_MET',
    );
    const dateSecond = await arrange({ serviceDate: SUNDAY, attemptNumber: 9 }, vendor);
    expect(codeOf(await confirm(ops, dateSecond, await etagOf(ops, dateSecond)))).toBe(
      'SERVICE_DATE_NOT_PERMITTED',
    );
    const suspendedThird = await arrange({ attemptNumber: 9 }, vendor);
    expect(codeOf(await confirm(ops, suspendedThird, await etagOf(ops, suspendedThird)))).toBe(
      'SENDER_SUSPENDED',
    );
  });
});

describe('the version it is confirmed under (AC-SLICE-001-10)', () => {
  // Break caught: two Ops users who read the same request both confirming it, the second silently overwriting the first.
  it('lets exactly one of two concurrent confirmations succeed and tells the other STATE_CONFLICT', async () => {
    const id = await arrange();
    const etag = await etagOf(ops, id);
    expect(await etagOf(opsTwo, id)).toBe(etag);

    const [first, second] = await Promise.all([confirm(ops, id, etag), confirm(opsTwo, id, etag)]);

    // (An answer of 200 is the request itself, whose own `code` is its operational code; the error code is read only from a refusal.)
    const outcomes = [first, second]
      .map((each) =>
        each.status === 200 ? '200' : `${String(each.status)} ${String(codeOf(each))}`,
      )
      .sort();
    expect(outcomes).toEqual(['200', '409 STATE_CONFLICT']);
    expect(await rowOf(id)).toMatchObject({ state: 'CONFIRMED', version: 2 });
    expect(await eventsOf(id)).toHaveLength(1);
  });

  // Break caught: the version compared outside the request's lock (or no lock at all), so that a change committed while the
  // confirmation waits is not seen by it and the request is confirmed on a token that no longer names it. The race is made, not hoped
  // for: the row is held from another connection, the confirmation is seen waiting on it by the server, the row changes, the lock ends.
  it('compares the version under the lock: a change committed while the confirmation waits is seen by it', async () => {
    const id = await arrange();
    const etag = await etagOf(ops, id);
    const held = await holdingPickupRequest(routes.database, id);
    let confirming: Promise<TestResponse> | undefined;
    try {
      confirming = confirm(ops, id, etag);
      await waitUntilBlockedBy(routes.admin, held.pid, 'the confirmation', confirming);
      await held.client.query(
        `update pickup_request set secondary_phone = '+233200000008' where id = $1`,
        [id],
      );
      await held.client.query('commit');
    } catch (error) {
      await held.client.query('rollback').catch(() => undefined);
      await confirming?.catch(() => undefined);
      throw error;
    } finally {
      await held.client.end();
    }
    const answer = await confirming;
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await rowOf(id)).state).toBe('PENDING');
    expect(await eventsOf(id)).toEqual([]);
  });

  // Break caught: the token of a request that has moved still accepted, or a confirmed request confirmed twice.
  it('refuses the old token once the request has been confirmed', async () => {
    const id = await arrange();
    const etag = await etagOf(ops, id);
    expect((await confirm(ops, id, etag)).status).toBe(200);

    const again = await confirm(opsTwo, id, etag);
    expect([again.status, codeOf(again)]).toEqual([409, 'STATE_CONFLICT']);
    // Even the current token cannot confirm what is already confirmed.
    const current = await confirm(opsTwo, id, await etagOf(opsTwo, id));
    expect([current.status, codeOf(current)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await eventsOf(id)).toHaveLength(1);
  });

  // Break caught: a change to the request that is not a state change slipping past the token (the version is of the record, not the state).
  it('refuses a token that was read before any other change to the request', async () => {
    const id = await arrange();
    const etag = await etagOf(ops, id);
    await routes.admin.query(
      `update pickup_request set secondary_phone = '+233200000009' where id = $1`,
      [id],
    );

    const answer = await confirm(ops, id, etag);
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await rowOf(id)).state).toBe('PENDING');
  });

  // Break caught: a missing, weak or foreign token accepted, so that a client that never read the request can confirm it.
  it('refuses a missing token, a weak one and the token of another request', async () => {
    const id = await arrange();
    const other = await arrange();
    const etag = await etagOf(ops, id);

    const missing = await confirm(ops, id);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
    for (const wrong of [`W/${etag}`, etag.slice(1, -1), await etagOf(ops, other), '*']) {
      const answer = await confirm(ops, id, wrong);
      expect([answer.status, codeOf(answer)], wrong).toEqual([409, 'STATE_CONFLICT']);
    }
    await expectUntouched(id);
    expect((await confirm(ops, id, etag)).status).toBe(200);
  });

  // Break caught: a cancelled request confirmed with its own current token.
  it('refuses a cancelled request even with its current token', async () => {
    const id = await arrange({ state: 'CANCELLED' });
    const answer = await confirm(ops, id, await etagOf(ops, id));
    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect((await rowOf(id)).state).toBe('CANCELLED');
  });
});

describe('who may confirm, and which request', () => {
  // Break caught: Ops confirming a request of a hub outside its grant, or told it does not exist when it does.
  it('tells Ops a request outside its hubs from one that does not exist', async () => {
    const id = await arrange({}, vendorInB, HUB_B);
    const outside = await confirm(ops, id, await etagOf(opsB, id));
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const none = await confirm(ops, randomUUID(), '"x"');
    expect([none.status, codeOf(none)]).toEqual([404, 'NOT_FOUND']);
    expect((await rowOf(id)).state).toBe('PENDING');
  });

  // Break caught: a vendor confirming its own request (V1: confirmation is Ops's), or a holder of other keys confirming.
  it('refuses a vendor, a holder of another bundle’s keys and a caller with no session', async () => {
    const id = await arrange();
    const etag = await etagOf(ops, id);
    const asVendor = await browserOne.post(CONFIRM(id), undefined, {
      headers: { 'If-Match': etag },
    });
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);

    const finance = await routes.actor(BUNDLE_IDS.finance, null);
    const asFinance = await confirm(finance, id, etag);
    expect([asFinance.status, codeOf(asFinance)]).toEqual([403, 'PERMISSION_DENIED']);

    const anonymous = await routes.browser().post(CONFIRM(id), undefined, {
      origin: OPS,
      headers: { 'If-Match': etag },
    });
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    await expectUntouched(id);
  });

  it('refuses an id that is not a UUID as a validation failure', async () => {
    const answer = await confirm(ops, 'not-a-uuid', '"x"');
    expect([answer.status, codeOf(answer)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: a Senior Ops or Platform Admin, who hold the key by the bundles, not able to confirm.
  it('lets Senior Ops and a Platform Admin confirm as well', async () => {
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const id = await arrange();
    expect((await confirm(senior, id, await etagOf(senior, id))).status).toBe(200);
    const admin = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
    const other = await arrange();
    expect((await confirm(admin, other, await etagOf(admin, other))).status).toBe(200);
  });
});
