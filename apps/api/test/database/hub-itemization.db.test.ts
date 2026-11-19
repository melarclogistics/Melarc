import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { addCalendarDays, hubCalendarDate } from '../../src/platform/time/hub-calendar.js';
import { weekdayOf } from '../../src/pricing/price-calculation.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { SERVICE_ZONES } from '../../src/tools/seed/hub-configuration.js';
import { countIntake, handOver } from './support/handed-over.js';
import {
  declareIntakeEvidence,
  intakeEvidenceBody,
  pendingIntakeEvidence,
  storedIntakeEvidence,
} from './support/intake-evidence.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertPickupRequest, pickupRequestRow, setFinancialStanding } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, OPS, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.36, `itemizeOrder` (`hub.intake.itemize`; `AC-SLICE-001-47` to `-50`, `-53`, `-54`, `-56`, `-58`, `-59`, `-90` and `-104`; features/hub/itemization.md sections 5.1, 5.2 and 5.4; Run D, D-D6; migration 0110),
 * against the real application and a real PostgreSQL. Each claim:
 *
 * - **The body is closed and the price is the server's** (`AC-SLICE-001-47`): a price, a total, a margin, a surcharge or a zone is `VALIDATION_FAILED`; the carrier's cost is the one amount, accepted in the covered
 *   third-party mode alone, with its waybill, and the server adds the hub's margin and the size surcharge to it (`-59`).
 * - **The order is made for a parcel and frozen when the parcel has arrived** (`-90`): one order for a parcel, the intake moves to ITEMIZING at the first, the order and its first commitment are one change whose SLA
 *   clock is the moment custody passed (`-56`); a retry under the same key makes nothing twice.
 * - **An order for a parcel not yet checked in waits** (`-104`): calculated and not frozen, confirmed when the vendor is finished or the missing parcel is found, never refused at the check-in for a price.
 * - **Every refusal of the price is raised when the order is made**, each with its code and its status (`-48` to `-50`, `-53`, `-54`, `-58`), and the events say who judged the size and what was transcribed.
 */
const INTAKES = `${API}/hub-intakes`;
const ONE = (id: string) => `${INTAKES}/${id}`;
const ORDERS = (id: string) => `${ONE(id)}/orders`;
const FINISH = (id: string) => `${ONE(id)}/check-in`;
const ARRIVAL = (parcel: string) => `${API}/intake-parcels/${parcel}/arrival`;

const [ZONE_A, ZONE_B] = SERVICE_ZONES.filter((zone) => zone.serviceArea === 'ACCRA_TEMA');
const KASOA = SERVICE_ZONES.find((zone) => zone.serviceArea === 'KASOA_CORRIDOR');
if (ZONE_A === undefined || ZONE_B === undefined || KASOA === undefined) {
  throw new Error('The seed has the zones the tests use');
}

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let officer: Actor;
let otherHub: Actor;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  // The addresses the server can place (the real aliases are the Product Owner's to supply, OB-S1-02): two Accra places that meet in one address, and the Kasoa corridor.
  for (const [alias, zone] of [
    ['madina', ZONE_A],
    ['adenta', ZONE_B],
    ['kasoa', KASOA],
  ] as const) {
    await routes.admin.query(
      `insert into service_zone_alias (id, hub_id, zone_id, alias, kind) values ($1, $2, $3, $4, 'AREA')`,
      [randomUUID(), HUB_A, zone.id, alias],
    );
  }
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
}, 300_000);

// A session is allowed 120 requests a minute: each test is made by officers of its own, as the people of a hub are.
beforeEach(async () => {
  officer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  otherHub = await routes.actor(BUNDLE_IDS.opsStaff, HUB_B);
});

afterAll(async () => {
  await routes.stop();
});

interface Parcel {
  readonly id: string;
  readonly state: string;
}

/** An element of a list the test has just built: absent only when the test itself is wrong. */
const present = <T>(list: readonly T[], index: number): T => {
  const found = list[index];
  if (found === undefined) throw new Error(`the list has no element ${String(index)}`);
  return found;
};
interface Order {
  readonly id: string;
  readonly code: string;
  readonly pickup_intake_id: string;
  readonly intake_parcel_id: string | null;
  readonly intake_parcel_state: string | null;
  readonly commercial_state: string | null;
  readonly fulfilment_state: string;
  readonly size_class: string;
  readonly size_class_selected_by: string | null;
  readonly carrier_cost?: { amount_minor: number; currency: string };
  readonly locked_price: { amount_minor: number; currency: string } | null;
  readonly is_high_value: boolean;
  readonly lane: string;
  readonly commercial_mode: string | null;
  readonly derived_delivery_date: string | null;
  readonly requested_delivery_date: string | null;
  readonly destination_zone_resolution: string;
  readonly destination_zone_snapshot: Record<string, unknown>;
  readonly origin_zone_snapshot: Record<string, unknown>;
  readonly price_components_snapshot: {
    total_minor: number;
    components: { kind: string; amount_minor: number; hub_id: string; setting_key?: string }[];
  };
  readonly payer_allocation?: { sender_minor: number; recipient_minor: number };
  readonly recipient: { name: string; phone: string; location: { address: string } };
  readonly serial_imei: string | null;
}

interface Arranged {
  readonly id: string;
  readonly requestId: string;
  readonly stopId: string;
  readonly parcels: readonly Parcel[];
  readonly custody: Date;
}

const read = async (
  actor: Actor,
  id: string,
): Promise<{ intake: { parcels?: Parcel[]; state: string }; etag: string }> => {
  const response = await actor.client.get(ONE(id));
  expect(response.status).toBe(200);
  return {
    intake: response.json() as { parcels?: Parcel[]; state: string },
    etag: response.header('etag') ?? '',
  };
};

const finishAllHere = async (actor: Actor, id: string, count: number): Promise<TestResponse> =>
  actor.client.post(
    FINISH(id),
    { all_arrived: true, confirmed_count: count },
    {
      origin: OPS,
      headers: { 'If-Match': (await read(actor, id)).etag, 'Idempotency-Key': randomUUID() },
    },
  );

const finishAsTapped = async (actor: Actor, id: string): Promise<TestResponse> =>
  actor.client.post(
    FINISH(id),
    { all_arrived: false },
    {
      origin: OPS,
      headers: { 'If-Match': (await read(actor, id)).etag, 'Idempotency-Key': randomUUID() },
    },
  );

const tap = (actor: Actor, parcel: string, arrived: boolean): Promise<TestResponse> =>
  actor.client.request('PUT', ARRIVAL(parcel), { body: { arrived }, origin: OPS });

/** The moment custody passed, as the handshake of the stop's collection records it. */
const custodyMoment = (): Date => new Date(Date.now() - 3 * 60 * 60 * 1000);

/** A photo intake whose vendor's check-in is open: every parcel expected, the custody handshake confirmed. */
async function opened(count = 3): Promise<Arranged> {
  const done = await handOver(routes, vendor, days, { collected: [count], photos: true });
  const id = done.intakes[0]?.id ?? '';
  const stopId = done.run.stops[0]?.id ?? '';
  const custody = custodyMoment();
  await routes.admin.query(
    `update collection_record set handshake_channel = 'PORTAL', handshake_confirmed_at = $2 where pickup_stop_id = $1`,
    [stopId, custody],
  );
  const { intake } = await read(officer, id);
  return {
    id,
    requestId: done.run.stops[0]?.requestId ?? '',
    stopId,
    parcels: intake.parcels ?? [],
    custody,
  };
}

/** A photo intake whose vendor is finished with "All N here": every parcel arrived and the intake cleared for itemization. */
async function cleared(count = 3): Promise<Arranged> {
  const intake = await opened(count);
  const finished = await finishAllHere(officer, intake.id, count);
  expect(finished.status).toBe(200);
  const { intake: after } = await read(officer, intake.id);
  expect(after.state).toBe('READY_FOR_ITEMIZATION');
  return { ...intake, parcels: after.parcels ?? [] };
}

/** An intake counted blind (the stop was let through without photos), counted and cleared. */
async function blind(declared = 3): Promise<Arranged> {
  const done = await handOver(routes, vendor, days, {
    collected: [declared],
    declared: [declared],
  });
  const id = done.intakes[0]?.id ?? '';
  const stopId = done.run.stops[0]?.id ?? '';
  const custody = custodyMoment();
  await routes.admin.query(
    `update collection_record set handshake_channel = 'PORTAL', handshake_confirmed_at = $2 where pickup_stop_id = $1`,
    [stopId, custody],
  );
  const counted = await countIntake(officer, id, declared);
  expect(counted.status).toBe(200);
  return { id, requestId: done.run.stops[0]?.requestId ?? '', stopId, parcels: [], custody };
}

/** The body of an order for a parcel that the server places by its alias (Madina is a zone of Accra & Tema), which the officer judged SMALL. */
const body = (
  parcel: string | null,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...(parcel === null ? {} : { parcel_id: parcel }),
  recipient: {
    name: 'Ama Mensah',
    phone: '024 123 4567',
    location: { address: '12 Madina Estate, near the market' },
  },
  size_class: 'SMALL',
  ...over,
});

/** The officer itemizes, on the `ETag` of the read unless the test says otherwise. */
async function itemize(
  actor: Actor,
  intakeId: string,
  given: unknown,
  over: { etag?: string | null; key?: string | null } = {},
): Promise<TestResponse> {
  const etag = over.etag === undefined ? (await read(actor, intakeId)).etag : over.etag;
  return actor.client.post(ORDERS(intakeId), given, {
    origin: OPS,
    headers: {
      ...(etag === null ? {} : { 'If-Match': etag }),
      ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
    },
  });
}

const orderOf = (response: TestResponse): Order => {
  expect(response.status, response.text).toBe(201);
  return response.json() as Order;
};

const refusal = (response: TestResponse): [number, string | undefined, string | undefined] => {
  const parsed = response.json() as {
    code?: string;
    details?: { rule?: string; violations?: { rule?: string }[] };
  };
  return [
    response.status,
    parsed.code,
    parsed.details?.rule ?? parsed.details?.violations?.[0]?.rule,
  ];
};

/** The first violation of a refused body: where, and by which rule. */
const firstViolation = (
  response: TestResponse,
): [number, string | undefined, string | undefined] => {
  const parsed = response.json() as {
    details?: { violations?: { pointer?: string; rule?: string }[] };
  };
  const first = parsed.details?.violations?.[0];
  return [response.status, first?.pointer, first?.rule];
};

const orderRow = async (id: string) =>
  (
    await routes.rows<{
      commercial_state: string | null;
      locked_price_minor: number | null;
      is_high_value: boolean;
      intake_parcel_id: string | null;
      payer_allocation: { sender_minor: number; recipient_minor: number } | null;
    }>(
      `select commercial_state, locked_price_minor, is_high_value, intake_parcel_id, payer_allocation from "order" where id = $1`,
      [id],
    )
  )[0];
const intakeState = async (id: string): Promise<string | undefined> =>
  (await routes.rows<{ state: string }>(`select state from pickup_intake where id = $1`, [id]))[0]
    ?.state;
const eventsOf = async (orderId: string): Promise<string[]> =>
  (
    await routes.rows<{ event_code: string }>(
      `select event_code from audit_event where object_id = $1 and event_code like any (array['hub.intake.itemized', 'pricing.%']) order by recorded_at, id`,
      [orderId],
    )
  ).map((row) => row.event_code);
const countOrders = async (intakeId: string): Promise<number> =>
  Number(
    (
      await routes.rows<{ n: string }>(
        `select count(*)::text as n from "order" where pickup_intake_id = $1`,
        [intakeId],
      )
    )[0]?.n,
  );

describe('the body is closed and the price is the server’s (AC-SLICE-001-47)', () => {
  // Break caught: a price, a total, a margin, a surcharge or a zone that a client can send and the server believes; the schema must refuse every one before anything is judged.
  it.each([
    'price',
    'locked_price',
    'total',
    'total_minor',
    'margin',
    'outside_accra_margin',
    'size_class_surcharge',
    'surcharge',
    'destination_zone',
    'destination_zone_id',
    'zone_id',
    'price_components_snapshot',
    'commercial_state',
  ])('refuses a body that carries %s', async (member) => {
    const intake = await cleared(1);
    const parcel = present(intake.parcels, 0);
    const response = await itemize(officer, intake.id, body(parcel.id, { [member]: 100 }));
    expect(response.status).toBe(400);
    expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(await countOrders(intake.id)).toBe(0);
  });

  // Break caught: the carrier's cost accepted for a doorstep order or a Station Drop, or without its waybill, or priced at the client's own margin.
  it('accepts the carrier’s cost in the covered third-party mode alone, with its waybill, and adds the hub’s margin and surcharge itself (AC-SLICE-001-59)', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    const waybill = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const money = { amount_minor: 5000, currency: 'GHS' };
    const covered = {
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
      recipient: { name: 'Kofi', phone: '0201112233', location: { address: 'Adum, Kumasi' } },
    };
    // Not for a doorstep order, nor for a Station Drop.
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(a.id, { carrier_cost: money, carrier_waybill_evidence_id: waybill }),
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED', 'not_allowed']);
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(a.id, {
            ...covered,
            commercial_mode: 'STATION_DROP',
            carrier_cost: money,
            carrier_waybill_evidence_id: waybill,
          }),
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED', 'not_allowed']);
    // The mode needs the cost, and the cost needs its waybill.
    expect(refusal(await itemize(officer, intake.id, body(a.id, covered)))).toEqual([
      422,
      'CARRIER_COST_REQUIRED',
      undefined,
    ]);
    expect(
      refusal(await itemize(officer, intake.id, body(a.id, { ...covered, carrier_cost: money }))),
    ).toEqual([422, 'CARRIER_COST_REQUIRED', 'waybill_required']);
    // A LARGE parcel to Kumasi: cost + margin + surcharge, all the hub's.
    const made = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, {
          ...covered,
          size_class: 'LARGE',
          carrier_cost: money,
          carrier_waybill_evidence_id: waybill,
        }),
      ),
    );
    expect(made).toMatchObject({
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
      carrier_cost: money,
      commercial_state: 'NO_VENDOR_CHARGE',
    });
    expect(made.locked_price).toEqual({ amount_minor: 5000 + 3000 + 3000, currency: 'GHS' });
    expect(made.price_components_snapshot.components.map((component) => component.kind)).toEqual([
      'CARRIER_COST',
      'OUTSIDE_ACCRA_MARGIN',
      'SIZE_CLASS_SURCHARGE',
    ]);
    expect(
      made.price_components_snapshot.components.every((component) => component.hub_id === HUB_A),
    ).toBe(true);
    // A Station Drop is the flat fee, whatever the size.
    const drop = orderOf(
      await itemize(
        officer,
        intake.id,
        body(c.id, {
          lane: 'THIRD_PARTY_HANDOFF',
          commercial_mode: 'STATION_DROP',
          size_class: 'LARGE',
        }),
      ),
    );
    expect(drop.locked_price?.amount_minor).toBe(2000);
    // The enhanced events: who judged the size, and the cost transcribed from the waybill.
    expect(await eventsOf(made.id)).toEqual([
      'hub.intake.itemized',
      'pricing.price.calculated',
      'pricing.size_class.selected',
      'pricing.carrier_cost.captured',
      'pricing.price.locked',
    ]);
    const enhanced = await routes.rows<{
      event_code: string;
      enhanced: boolean;
      actor_id: string;
      detail: Record<string, unknown>;
    }>(
      `select event_code, enhanced, actor_id, detail from audit_event where object_id = $1 and event_code in ('pricing.size_class.selected', 'pricing.carrier_cost.captured') order by event_code`,
      [made.id],
    );
    expect(enhanced.map((row) => [row.event_code, row.enhanced, row.actor_id])).toEqual([
      ['pricing.carrier_cost.captured', true, officer.identity.id],
      ['pricing.size_class.selected', true, officer.identity.id],
    ]);
    expect(enhanced[0]?.detail).toMatchObject({ carrier_cost_minor: 5000 });
    expect(enhanced[1]?.detail).toMatchObject({ size_class: 'LARGE' });
  });
});

describe('an order for a parcel that has arrived (AC-SLICE-001-90, -56)', () => {
  // Break caught: an order that is not frozen, a size that is not recorded with the officer, the intake left at READY_FOR_ITEMIZATION, an order with no commitment, or a commitment whose clock is not custody.
  it('is priced, frozen and recorded with the officer, moves the intake to ITEMIZING, and has its first commitment written with it', async () => {
    const intake = await cleared(3);
    const parcel = present(intake.parcels, 0);
    const made = orderOf(
      await itemize(
        officer,
        intake.id,
        body(parcel.id, { destination_zone_authorization: undefined }),
      ),
    );
    expect(made).toMatchObject({
      pickup_intake_id: intake.id,
      intake_parcel_id: parcel.id,
      intake_parcel_state: 'ARRIVED',
      commercial_state: 'NO_VENDOR_CHARGE',
      fulfilment_state: 'AWAITING_RECIPIENT_CONFIRMATION',
      size_class: 'SMALL',
      size_class_selected_by: officer.identity.id,
      lane: 'DOORSTEP',
      commercial_mode: null,
      is_high_value: false,
      destination_zone_resolution: 'SERVER_RESOLVED',
    });
    expect(made.code).toMatch(/^[A-Z]{3}-OR-/);
    expect(made.locked_price).toEqual({ amount_minor: 3500, currency: 'GHS' });
    expect(made.recipient).toMatchObject({ name: 'Ama Mensah', phone: '+233241234567' });
    expect(made.payer_allocation).toBeDefined();
    expect(
      made.payer_allocation &&
        made.payer_allocation.sender_minor + made.payer_allocation.recipient_minor,
    ).toBe(3500);
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    expect(await eventsOf(made.id)).toEqual([
      'hub.intake.itemized',
      'pricing.price.calculated',
      'pricing.size_class.selected',
      'pricing.price.locked',
    ]);
    // The first commitment: written with the order, sequence 1, its clock the moment custody passed and its dates the order's own.
    const commitments = await routes.rows<{
      sequence: number;
      sla_start_at: Date;
      default_date: Date;
      committed_date: Date;
      committed_window_start: string;
      committed_window_end: string;
      superseded_at: Date | null;
    }>(
      `select sequence, sla_start_at, default_date, committed_date, committed_window_start::text, committed_window_end::text, superseded_at from delivery_commitment where order_id = $1`,
      [made.id],
    );
    expect(commitments).toHaveLength(1);
    expect(commitments[0]?.sequence).toBe(1);
    expect(commitments[0]?.sla_start_at.getTime()).toBe(intake.custody.getTime());
    expect(commitments[0]?.committed_window_start).toBe('10:00:00');
    expect(commitments[0]?.committed_window_end).toBe('16:00:00');
    // The promise counts from custody: the first day after custody's day on which the hub delivers, never a Sunday.
    expect(made.derived_delivery_date).not.toBeNull();
    expect((made.derived_delivery_date ?? '') > hubCalendarDate(intake.custody)).toBe(true);
    expect(weekdayOf(made.derived_delivery_date ?? '')).not.toBe('SUN');
  });

  // Break caught: the booking's estimate overwritten by the frozen price, or the frozen price shown as the estimate (AC-SLICE-001-56): both are kept and distinct.
  it('keeps the booking’s estimate beside the frozen price, and a LARGE parcel outside the service area costs more than it', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const [request] = await routes.rows<{ estimate_snapshot: { total_minor?: number } | null }>(
      `select estimate_snapshot from pickup_request where id = $1`,
      [intake.requestId],
    );
    const waybill = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const inArea = orderOf(await itemize(officer, intake.id, body(a.id)));
    const outside = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, {
          lane: 'THIRD_PARTY_HANDOFF',
          commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
          size_class: 'LARGE',
          carrier_cost: { amount_minor: 5000, currency: 'GHS' },
          carrier_waybill_evidence_id: waybill,
          recipient: { name: 'Kofi', phone: '0201112233', location: { address: 'Kumasi' } },
        }),
      ),
    );
    const [after] = await routes.rows<{ estimate_snapshot: unknown }>(
      `select estimate_snapshot from pickup_request where id = $1`,
      [intake.requestId],
    );
    // The request's own estimate is untouched by either order, and the price of the one outside the service area is above the flat fee the estimate assumed.
    expect(after?.estimate_snapshot).toEqual(request?.estimate_snapshot);
    expect(inArea.locked_price?.amount_minor).toBe(3500);
    expect(
      (outside.locked_price?.amount_minor ?? 0) > (inArea.locked_price?.amount_minor ?? 0),
    ).toBe(true);
  });

  // Break caught: one parcel with two orders, a parcel of another intake ordered, a missing parcel priced, a photo order without a parcel or a blind one with it.
  it('is one order for a parcel of its own intake, and refuses what the database refuses, naming the rule', async () => {
    const intake = await cleared(3);
    const other = await cleared(1);
    const [a] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    expect(refusal(await itemize(officer, intake.id, body(a.id)))).toEqual([
      409,
      'STATE_CONFLICT',
      'parcel_ordered',
    ]);
    expect(refusal(await itemize(officer, intake.id, body(present(other.parcels, 0).id)))).toEqual([
      400,
      'VALIDATION_FAILED',
      'unknown_parcel',
    ]);
    expect(refusal(await itemize(officer, intake.id, body(randomUUID())))).toEqual([
      400,
      'VALIDATION_FAILED',
      'unknown_parcel',
    ]);
    expect(refusal(await itemize(officer, intake.id, body(null)))).toEqual([
      400,
      'VALIDATION_FAILED',
      'parcel_required',
    ]);
    const counted = await blind(2);
    expect(
      refusal(await itemize(officer, counted.id, body(present(intake.parcels, 1).id))),
    ).toEqual([400, 'VALIDATION_FAILED', 'parcel_not_allowed']);
    // A missing parcel (the vendor finished as tapped) has no order, and an intake in reconciliation is not ordered from.
    const short = await opened(2);
    const [tapped, notTapped] = short.parcels as [Parcel, Parcel];
    expect((await tap(officer, tapped.id, true)).status).toBe(200);
    expect((await finishAsTapped(officer, short.id)).status).toBe(200);
    expect(refusal(await itemize(officer, short.id, body(notTapped.id)))).toEqual([
      409,
      'STATE_CONFLICT',
      'parcel_missing',
    ]);
    expect(refusal(await itemize(officer, short.id, body(tapped.id)))).toEqual([
      409,
      'STATE_CONFLICT',
      'reconciliation_open',
    ]);
  });

  // Break caught: an order of an intake counted blind that is refused for having no parcel, or its first order not moving the intake.
  it('is made for an intake counted blind with no parcel, and the intake moves to ITEMIZING', async () => {
    const intake = await blind(3);
    const made = orderOf(await itemize(officer, intake.id, body(null)));
    expect(made.intake_parcel_id).toBeNull();
    expect(made.intake_parcel_state).toBeNull();
    expect(made.commercial_state).toBe('NO_VENDOR_CHARGE');
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    // Orders of a blind intake are not one-to-one with anything.
    expect(orderOf(await itemize(officer, intake.id, body(null))).id).not.toBe(made.id);
  });
});

describe('the zone, the size and the date (AC-SLICE-001-48 to -50, -58)', () => {
  // Break caught: a zone the server could not place priced anyway, an ambiguous address resolved by guesswork, a selection that overrides a clean resolution, or a selection that names no zone of the hub.
  it('is resolved by the server, or by the selection it needed, and refused otherwise', async () => {
    const intake = await cleared(5);
    const parcels = intake.parcels as Parcel[];
    const at = (n: number) => present(parcels, n);
    const place = (address: string) => ({
      name: 'Ama',
      phone: '0241234567',
      location: { address },
    });
    // Placed by its alias.
    const placed = orderOf(await itemize(officer, intake.id, body(at(0).id)));
    expect(placed.destination_zone_snapshot).toMatchObject({
      zone_id: ZONE_A.id,
      alias: 'madina',
      service_area: 'ACCRA_TEMA',
    });
    // Not placed: blocked, with the code that names it and the status the contract gives it.
    expect(
      refusal(
        await itemize(officer, intake.id, body(at(1).id, { recipient: place('Kumasi, Adum') })),
      ),
    ).toEqual([422, 'SETTING_MISSING', 'destination_zone_unresolved']);
    // Ambiguous: two zones of the hub match the address as well as each other.
    const ambiguous = await itemize(
      officer,
      intake.id,
      body(at(1).id, { recipient: place('Madina Adenta road') }),
    );
    expect(refusal(ambiguous)).toEqual([400, 'VALIDATION_FAILED', 'destination_zone_ambiguous']);
    expect(
      (ambiguous.json() as { details: { candidates: unknown[] } }).details.candidates,
    ).toHaveLength(2);
    // The selection it needed is recorded as such, with its note; one it did not need is refused; one that names no zone of the hub is refused.
    const chosen = orderOf(
      await itemize(
        officer,
        intake.id,
        body(at(1).id, {
          recipient: place('Madina Adenta road'),
          destination_zone_authorization: {
            zone_id: ZONE_B.id,
            note: 'The sender phoned from Adenta',
          },
        }),
      ),
    );
    expect(chosen.destination_zone_resolution).toBe('EXPLICITLY_AUTHORIZED');
    expect(chosen.destination_zone_snapshot).toMatchObject({
      zone_id: ZONE_B.id,
      authorization_note: 'The sender phoned from Adenta',
    });
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(at(2).id, {
            destination_zone_authorization: { zone_id: KASOA.id, note: 'cheaper' },
          }),
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED', 'destination_zone_resolved']);
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(at(2).id, {
            recipient: place('Kumasi'),
            destination_zone_authorization: { zone_id: randomUUID(), note: 'x' },
          }),
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED', 'destination_zone_not_available']);
    // Every order of the intake carries the one origin zone (the request's, resolved once).
    expect(chosen.origin_zone_snapshot).toEqual(placed.origin_zone_snapshot);
  });

  // Break caught: a default size, a size derived from anything, the size refused only after the other refusals, or an order priced with no officer behind its size (AC-SLICE-001-58).
  it('has the officer select the size, and refuses an order with none before anything else is judged', async () => {
    const intake = await cleared(1);
    const parcel = present(intake.parcels, 0);
    const refused = await itemize(
      officer,
      intake.id,
      body(parcel.id, {
        size_class: undefined,
        recipient: { name: 'Ama', phone: '0241234567', location: { address: 'Kumasi' } },
      }),
    );
    expect(refusal(refused)).toEqual([422, 'SIZE_CLASS_REQUIRED', 'size_class_required']);
    expect(await countOrders(intake.id)).toBe(0);
    expect(await intakeState(intake.id)).toBe('READY_FOR_ITEMIZATION');
  });

  // Break caught: a corridor priced at one fee on every day, its off-day request refused, a Sunday promised, or an express request accepted (AC-SLICE-001-48).
  it('prices a corridor on its batch day and off it, refuses a Sunday and a day before the next working day', async () => {
    const intake = await cleared(4);
    const [a, b, c, d] = intake.parcels as [Parcel, Parcel, Parcel, Parcel];
    const kasoa = { name: 'Esi', phone: '0201234567', location: { address: 'Plot 4, Kasoa' } };
    const batch = orderOf(await itemize(officer, intake.id, body(a.id, { recipient: kasoa })));
    expect(weekdayOf(batch.derived_delivery_date ?? '')).toBe('FRI');
    expect(batch.locked_price?.amount_minor).toBe(3500);
    expect(batch.price_components_snapshot.components.map((component) => component.kind)).toEqual([
      'SERVICE_AREA_BASE_FEE',
    ]);
    // A day that is neither a Friday nor a Sunday, after custody: the corridor's off-day fee, accepted and priced and never refused.
    let requested = addCalendarDays(hubCalendarDate(intake.custody), 1);
    while (weekdayOf(requested) === 'FRI' || weekdayOf(requested) === 'SUN')
      requested = addCalendarDays(requested, 1);
    const off = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { recipient: kasoa, requested_delivery_date: requested }),
      ),
    );
    expect(off.locked_price?.amount_minor).toBe(8000);
    expect(off.requested_delivery_date).toBe(requested);
    expect(off.price_components_snapshot.components.map((component) => component.kind)).toEqual([
      'CORRIDOR_OFF_DAY_FEE',
    ]);
    // A Sunday, and the custody day itself.
    let sunday = addCalendarDays(hubCalendarDate(intake.custody), 1);
    while (weekdayOf(sunday) !== 'SUN') sunday = addCalendarDays(sunday, 1);
    expect(
      refusal(await itemize(officer, intake.id, body(c.id, { requested_delivery_date: sunday }))),
    ).toEqual([422, 'SERVICE_DATE_NOT_PERMITTED', undefined]);
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(d.id, { requested_delivery_date: hubCalendarDate(intake.custody) }),
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED', 'requested_before_default']);
    // A request that is not a calendar date is not a date: the body's schema refuses it first (the service's own check is the second line).
    expect(
      firstViolation(
        await itemize(officer, intake.id, body(d.id, { requested_delivery_date: '2026-02-30' })),
      ),
    ).toEqual([400, '/requested_delivery_date', 'format']);
  });
});

describe('serialized goods and a high-value parcel (AC-SLICE-001-53, -54)', () => {
  // Break caught: serialized goods itemized with no serial or IMEI, or one that is blank; the serial dropped from the order.
  it('needs the serial or IMEI of serialized goods', async () => {
    const intake = await cleared(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    expect(
      (await itemize(officer, intake.id, body(a.id, { is_serialized_goods: true }))).status,
    ).toBe(400);
    expect(
      (
        await itemize(
          officer,
          intake.id,
          body(a.id, { is_serialized_goods: true, serial_imei: '   ' }),
        )
      ).status,
    ).toBe(400);
    const made = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { is_serialized_goods: true, serial_imei: '356938035643809' }),
      ),
    );
    expect(made.serial_imei).toBe('356938035643809');
  });

  /** The booking recorded the sender's acknowledgement of the liability cap (a value above the threshold was declared at booking). */
  const acknowledged = (requestId: string) =>
    routes.admin.query(
      `update pickup_request set declared_value_minor = 100000, liability_cap_acknowledged_at = now(),
              liability_cap_snapshot = '{"amount_minor":30000,"setting_key":"liability_cap_amount","effective_version":"UNVERSIONED"}'::jsonb where id = $1`,
      [requestId],
    );

  // Break caught: a value above the threshold itemized without the acknowledgement at booking, a high-value parcel with no evidence or with evidence that is not stored, the surcharge missing or not its own component,
  // an officer's own flag ignored, or a parcel at the threshold flagged.
  it('is flagged automatically, needs stored evidence, and carries its surcharge as its own component', async () => {
    const intake = await cleared(5);
    const [a, b, c, d, e] = intake.parcels as [Parcel, Parcel, Parcel, Parcel, Parcel];
    // Declared above the threshold at itemization, never acknowledged at booking.
    expect(
      refusal(await itemize(officer, intake.id, body(a.id, { declared_value_minor: 90000 }))),
    ).toEqual([422, 'VALUE_DECLARATION_REQUIRED', 'declaration_required']);
    await acknowledged(intake.requestId);
    // Above the first band with no evidence, then with evidence that is not stored.
    expect(
      refusal(await itemize(officer, intake.id, body(a.id, { declared_value_minor: 90000 }))),
    ).toEqual([422, 'REASON_REQUIRED', 'high_value_evidence_required']);
    const pending = await pendingIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(a.id, { declared_value_minor: 90000, evidence_ids: [pending] }),
        ),
      ),
    ).toEqual([422, 'EVIDENCE_NOT_STORED', undefined]);
    // With stored evidence: flagged, and the band's surcharge is stacked on the fee as a component of its own.
    const stored = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const high = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, { declared_value_minor: 90000, evidence_ids: [stored] }),
      ),
    );
    expect(high.is_high_value).toBe(true);
    expect(high.locked_price?.amount_minor).toBe(3500 + 1000);
    expect(high.price_components_snapshot.components.at(-1)).toMatchObject({
      kind: 'HIGH_VALUE_SURCHARGE',
      amount_minor: 1000,
      setting_key: 'MELARC_HIGH_VALUE_TIERS',
      hub_id: HUB_A,
    });
    // The second band, and the same piece of evidence cited twice in one order.
    const second = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(b.id, { declared_value_minor: 300000, evidence_ids: [second, second] }),
        ),
      ),
    ).toEqual([400, 'VALIDATION_FAILED', 'unique']);
    const top = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { declared_value_minor: 300000, evidence_ids: [second] }),
      ),
    );
    expect(top.locked_price?.amount_minor).toBe(3500 + 2000);
    // An officer may flag a lower-value parcel, which needs the evidence too and pays no surcharge.
    expect(refusal(await itemize(officer, intake.id, body(c.id, { is_high_value: true })))).toEqual(
      [422, 'REASON_REQUIRED', 'high_value_evidence_required'],
    );
    const third = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const flagged = orderOf(
      await itemize(officer, intake.id, body(c.id, { is_high_value: true, evidence_ids: [third] })),
    );
    expect(flagged.is_high_value).toBe(true);
    expect(flagged.locked_price?.amount_minor).toBe(3500);
    // At the threshold: not high value.
    const at = orderOf(
      await itemize(officer, intake.id, body(d.id, { declared_value_minor: 50000 })),
    );
    expect(at.is_high_value).toBe(false);
    // Evidence of another purpose, or of another intake, is not evidence of an itemization.
    const condition = await storedIntakeEvidence(routes, officer, intake.id, 'CONDITION');
    expect(
      refusal(
        await itemize(
          officer,
          intake.id,
          body(e.id, { is_high_value: true, evidence_ids: [condition] }),
        ),
      ),
    ).toEqual([422, 'EVIDENCE_NOT_STORED', undefined]);
  });
});

describe('an order that waits for its parcel (AC-SLICE-001-104)', () => {
  // Break caught: an early order that is frozen or priced before its parcel is checked in, that moves the intake, that is confirmed by a tap the officer may undo, or whose confirmation is refused at the check-in.
  it('is calculated and not frozen, is confirmed when the vendor is finished, and is never refused at the check-in', async () => {
    const intake = await opened(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    const waiting = orderOf(await itemize(officer, intake.id, body(a.id)));
    expect(waiting).toMatchObject({
      intake_parcel_id: a.id,
      intake_parcel_state: 'EXPECTED',
      commercial_state: null,
      locked_price: null,
    });
    expect(waiting.payer_allocation).toBeUndefined();
    expect(waiting.price_components_snapshot.total_minor).toBe(3500);
    expect(await intakeState(intake.id)).toBe('AWAITING_COUNT');
    expect(await eventsOf(waiting.id)).toEqual([
      'hub.intake.itemized',
      'pricing.price.calculated',
      'pricing.size_class.selected',
    ]);
    // A second early order, for a parcel that will not arrive.
    const left = orderOf(await itemize(officer, intake.id, body(b.id)));
    // A tap is not a confirmation (the officer may take it back), and an untap leaves the order as it was.
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect((await orderRow(waiting.id))?.commercial_state).toBeNull();
    expect((await tap(officer, a.id, false)).status).toBe(200);
    expect((await tap(officer, a.id, true)).status).toBe(200);
    // The vendor is finished as tapped: the parcel that arrived is confirmed at the price that was calculated, the one that did not stays unpriced.
    expect((await finishAsTapped(officer, intake.id)).status).toBe(200);
    expect(await orderRow(waiting.id)).toMatchObject({
      commercial_state: 'NO_VENDOR_CHARGE',
      locked_price_minor: 3500,
    });
    expect((await orderRow(waiting.id))?.payer_allocation).not.toBeNull();
    expect(await orderRow(left.id)).toMatchObject({
      commercial_state: null,
      locked_price_minor: null,
    });
    expect(await eventsOf(waiting.id)).toEqual([
      'hub.intake.itemized',
      'pricing.price.calculated',
      'pricing.size_class.selected',
      'pricing.price.locked',
    ]);
    const locked = await routes.rows<{ detail: { confirmed_by_check_in?: boolean } }>(
      `select detail from audit_event where object_id = $1 and event_code = 'pricing.price.locked'`,
      [waiting.id],
    );
    expect(locked[0]?.detail.confirmed_by_check_in).toBe(true);
    // The parcel that was missing is found: its order is confirmed then.
    expect((await tap(officer, b.id, true)).status).toBe(200);
    expect(await orderRow(left.id)).toMatchObject({
      commercial_state: 'NO_VENDOR_CHARGE',
      locked_price_minor: 3500,
    });
    // A parcel whose order is priced is not taken back.
    expect((await tap(officer, a.id, false)).status).toBe(409);
  });

  // Break caught: an early order for a parcel already checked in, or one made after the vendor is finished, with the wrong rule named.
  it('is for a parcel not yet checked in, and a parcel already tapped is ordered once the vendor is cleared', async () => {
    const intake = await opened(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect(refusal(await itemize(officer, intake.id, body(a.id)))).toEqual([
      409,
      'STATE_CONFLICT',
      'check_in_open',
    ]);
  });
});

describe('the retry, the ETag and the keys', () => {
  // Break caught: a retry that makes a second order or a second commitment, a replay that is not the first answer byte for byte, or a key reused for another request that is answered as a replay.
  it('answers a retry under the same key with the first answer and makes nothing twice', async () => {
    const intake = await cleared(2);
    const parcel = present(intake.parcels, 0);
    const key = randomUUID();
    const etag = (await read(officer, intake.id)).etag;
    const first = await itemize(officer, intake.id, body(parcel.id), { etag, key });
    const made = orderOf(first);
    const again = await itemize(officer, intake.id, body(parcel.id), { etag, key });
    expect(again.status).toBe(201);
    expect(again.text).toBe(first.text);
    expect(await countOrders(intake.id)).toBe(1);
    expect(
      Number(
        (
          await routes.rows<{ n: string }>(
            `select count(*)::text as n from delivery_commitment where order_id = $1`,
            [made.id],
          )
        )[0]?.n,
      ),
    ).toBe(1);
    expect(await eventsOf(made.id)).toEqual([
      'hub.intake.itemized',
      'pricing.price.calculated',
      'pricing.size_class.selected',
      'pricing.price.locked',
    ]);
    // The same key for another request is a conflict, not a replay.
    const other = await itemize(officer, intake.id, body(present(intake.parcels, 1).id), {
      etag,
      key,
    });
    expect(refusal(other)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT', undefined]);
  });

  // Break caught: an order made on an ETag that is missing, weak, another intake's or out of date, or a missing Idempotency-Key accepted (a receiving officer retrying over a flaky connection).
  it('is refused on a missing, weak, stale or foreign ETag and without a key', async () => {
    const intake = await cleared(3);
    const other = await cleared(1);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    const current = (await read(officer, intake.id)).etag;
    // A token that is missing is a request that is not well formed; one that is weak, another intake's or not a token at all is a token the intake is not at.
    expect(
      refusal(await itemize(officer, intake.id, body(a.id), { etag: null })).slice(0, 2),
    ).toEqual([400, 'VALIDATION_FAILED']);
    for (const etag of [`W/${current}`, '"nonsense"', (await read(officer, other.id)).etag]) {
      expect(refusal(await itemize(officer, intake.id, body(a.id), { etag })), etag).toEqual([
        409,
        'STATE_CONFLICT',
        'stale',
      ]);
    }
    expect((await itemize(officer, intake.id, body(a.id), { key: null })).status).toBe(400);
    // The first order moves the intake: the ETag read before it is stale for the next, and the one read again is not.
    orderOf(await itemize(officer, intake.id, body(a.id), { etag: current }));
    expect(refusal(await itemize(officer, intake.id, body(b.id), { etag: current }))).toEqual([
      409,
      'STATE_CONFLICT',
      'stale',
    ]);
    expect((await itemize(officer, intake.id, body(b.id))).status).toBe(201);
    expect(await countOrders(intake.id)).toBe(2);
  });

  // Break caught: two officers ordering one parcel at once both succeeding (two priced orders for one physical parcel).
  it('makes one order when two officers order the same parcel at once', async () => {
    const intake = await cleared(2);
    const parcel = present(intake.parcels, 0);
    const second = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const etag = (await read(officer, intake.id)).etag;
    const [one, two] = await Promise.all([
      itemize(officer, intake.id, body(parcel.id), { etag }),
      itemize(second, intake.id, body(parcel.id), { etag }),
    ]);
    expect([one.status, two.status].toSorted()).toEqual([201, 409]);
    expect(await countOrders(intake.id)).toBe(1);
  });

  // Break caught: an order made by a session without the key, for another hub's intake, for one that does not exist, or by a vendor.
  it('is for the officers of the hub who hold the key, and nobody else', async () => {
    const intake = await cleared(1);
    const parcel = present(intake.parcels, 0);
    const { etag } = await read(officer, intake.id);
    expect(refusal(await itemize(otherHub, intake.id, body(parcel.id), { etag }))[1]).toBe(
      'HUB_SCOPE_VIOLATION',
    );
    expect((await itemize(officer, randomUUID(), body(parcel.id), { etag })).status).toBe(404);
    // A session that reads the intake and does not hold the key to itemize is refused at the guard, before the body is read.
    const readOnly = await routes.actor(
      await newBundle(routes.admin, [grant('hub.read', 'own')]),
      HUB_A,
    );
    const refused = await itemize(readOnly, intake.id, body(parcel.id));
    expect(refusal(refused).slice(0, 2)).toEqual([403, 'PERMISSION_DENIED']);
    expect(await countOrders(intake.id)).toBe(0);
  });
});

describe('a hub with no configuration (AC-SLICE-001-50)', () => {
  // Break caught: an order priced at another hub's fee, or at cost, for a hub that has set none: it is refused visibly, and the code says which of the two it is.
  it('refuses an order for a hub with no approved fee or margin, naming the setting and never borrowing another hub’s', async () => {
    const done = await handOver(routes, vendor, days, {
      collected: [2],
      photos: true,
      hubId: HUB_B,
    });
    const id = done.intakes[0]?.id ?? '';
    await routes.admin.query(
      `update collection_record set handshake_channel = 'PORTAL', handshake_confirmed_at = now() - interval '3 hours' where pickup_stop_id = $1`,
      [done.run.stops[0]?.id],
    );
    const { intake } = await read(otherHub, id);
    const parcels = intake.parcels ?? [];
    expect((await finishAllHere(otherHub, id, 2)).status).toBe(200);
    const [a, b] = parcels as [Parcel, Parcel];
    const zone = { zone_id: ZONE_A.id, note: 'The hub has no zone of its own' };
    // A doorstep order: the zone the officer names is not a zone of this hub.
    expect(
      refusal(await itemize(otherHub, id, body(a.id, { destination_zone_authorization: zone })))[0],
    ).toBe(400);
    expect(refusal(await itemize(otherHub, id, body(a.id)))).toEqual([
      422,
      'SETTING_MISSING',
      'destination_zone_unresolved',
    ]);
    // A third-party order: the margin is the hub's own, and it has none.
    const waybill = await storedIntakeEvidence(routes, otherHub, id, 'ITEMIZATION');
    const covered = body(b.id, {
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
      carrier_cost: { amount_minor: 5000, currency: 'GHS' },
      carrier_waybill_evidence_id: waybill,
    });
    expect(refusal(await itemize(otherHub, id, covered))).toEqual([
      422,
      'MARGIN_NOT_CONFIGURED',
      undefined,
    ]);
    expect(await countOrders(id)).toBe(0);
  });
});

describe('the evidence of an itemization', () => {
  // Break caught: itemization evidence declared for an intake that is not open to itemizing, by a key that is not the officer's, or read by the wrong purpose.
  it('is declared by the officer who itemizes, while the intake is open to itemizing, and refused otherwise', async () => {
    const open = await opened(2);
    // While the vendor is being checked in, the order waits and its evidence is declared.
    const declared = await declareIntakeEvidence(
      officer,
      intakeEvidenceBody(open.id, 'ITEMIZATION'),
    );
    expect(declared.status).toBe(200);
    // An intake in reconciliation is not open to itemizing.
    const short = await opened(2);
    expect((await tap(officer, present(short.parcels, 0).id, true)).status).toBe(200);
    expect((await finishAsTapped(officer, short.id)).status).toBe(200);
    expect(
      refusal(await declareIntakeEvidence(officer, intakeEvidenceBody(short.id, 'ITEMIZATION'))),
    ).toEqual([409, 'STATE_CONFLICT', 'itemization_not_open']);
  });
});

describe('what goes with what, and what a state says before a price does', () => {
  // Break caught: a price refused before a state (an officer told to choose a size for a parcel that is missing or already has its order), the order of the repo's other services reversed.
  it('tells a state before a reason: a parcel that has its order or is missing is told so whatever else is wrong with the body', async () => {
    const intake = await cleared(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    expect(
      refusal(await itemize(officer, intake.id, body(a.id, { size_class: undefined }))),
    ).toEqual([409, 'STATE_CONFLICT', 'parcel_ordered']);
    const short = await opened(2);
    const [tapped, notTapped] = short.parcels as [Parcel, Parcel];
    expect((await tap(officer, tapped.id, true)).status).toBe(200);
    expect((await finishAsTapped(officer, short.id)).status).toBe(200);
    expect(
      refusal(await itemize(officer, short.id, body(notTapped.id, { size_class: undefined }))),
    ).toEqual([409, 'STATE_CONFLICT', 'parcel_missing']);
  });

  // Break caught: a lane with the wrong mode accepted, which would price a doorstep order as a third-party one or the reverse; and a value the record cannot hold accepted.
  it('refuses a lane with the wrong mode, a number the record cannot hold and a blank name or address', async () => {
    const intake = await cleared(1);
    const parcel = present(intake.parcels, 0);
    const refused = async (over: Record<string, unknown>) =>
      refusal(await itemize(officer, intake.id, body(parcel.id, over)));
    expect(await refused({ lane: 'DOORSTEP', commercial_mode: 'STATION_DROP' })).toEqual([
      400,
      'VALIDATION_FAILED',
      'not_allowed',
    ]);
    expect(await refused({ lane: 'THIRD_PARTY_HANDOFF' })).toEqual([
      400,
      'VALIDATION_FAILED',
      'required',
    ]);
    expect(await refused({ declared_value_minor: 2_000_000_001 })).toEqual([
      400,
      'VALIDATION_FAILED',
      'range',
    ]);
    expect(
      await refused({
        recipient: { name: '  ', phone: '0241234567', location: { address: 'Madina' } },
      }),
    ).toEqual([400, 'VALIDATION_FAILED', 'required']);
    expect(
      await refused({ recipient: { name: 'Ama', phone: '12', location: { address: 'Madina' } } }),
    ).toEqual([400, 'VALIDATION_FAILED', 'format']);
    expect(await refused({ carrier_waybill_evidence_id: randomUUID() })).toEqual([
      400,
      'VALIDATION_FAILED',
      'not_allowed',
    ]);
    expect(await countOrders(intake.id)).toBe(0);
  });

  // Break caught: the parcel-level override of the payer arrangement ignored, applied as a portion of a price the client never saw, or accepted with the fields of another kind.
  it('takes a parcel-level payer arrangement as an intent, and the server resolves it into portions of the frozen price', async () => {
    const intake = await cleared(4);
    const [a, b, c, d] = intake.parcels as [Parcel, Parcel, Parcel, Parcel];
    const recipientPays = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, { payer_override: { payer_intent: 'RECIPIENT_PAYS' } }),
      ),
    );
    expect(recipientPays.payer_allocation).toEqual({ sender_minor: 0, recipient_minor: 3500 });
    const split = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, {
          payer_override: {
            payer_intent: 'SPLIT',
            split_basis: 'PERCENTAGE',
            split_sender_percentage: 25,
          },
        }),
      ),
    );
    expect(split.payer_allocation).toEqual({ sender_minor: 875, recipient_minor: 2625 });
    const fixed = orderOf(
      await itemize(
        officer,
        intake.id,
        body(c.id, {
          payer_override: {
            payer_intent: 'SPLIT',
            split_basis: 'FIXED_AMOUNT',
            split_sender_amount: { amount_minor: 1000, currency: 'GHS' },
          },
        }),
      ),
    );
    expect(fixed.payer_allocation).toEqual({ sender_minor: 1000, recipient_minor: 2500 });
    for (const [override, where, rule] of [
      [{ payer_intent: 'SPLIT' }, '/payer_override/split_basis', 'required'],
      [
        { payer_intent: 'SPLIT', split_basis: 'PERCENTAGE' },
        '/payer_override/split_sender_percentage',
        'required',
      ],
      [
        { payer_intent: 'SPLIT', split_basis: 'FIXED_AMOUNT' },
        '/payer_override/split_sender_amount',
        'required',
      ],
      [
        {
          payer_intent: 'SPLIT',
          split_basis: 'FIXED_AMOUNT',
          split_sender_amount: { amount_minor: 100, currency: 'GHS' },
          split_sender_percentage: 10,
        },
        '/payer_override/split_sender_percentage',
        'not_allowed',
      ],
      [
        { payer_intent: 'RECIPIENT_PAYS', split_basis: 'PERCENTAGE', split_sender_percentage: 10 },
        '/payer_override',
        'split_not_allowed',
      ],
    ] as const) {
      expect(
        firstViolation(await itemize(officer, intake.id, body(d.id, { payer_override: override }))),
        JSON.stringify(override),
      ).toEqual([400, where, rule]);
    }
  });

  // Break caught: the confirmation missing from the senior's correction, so that a parcel brought back by the senior leaves its order unpriced for ever.
  it('confirms the order of a parcel that a senior’s correction brings back', async () => {
    const intake = await opened(2);
    const [tapped, notTapped] = intake.parcels as [Parcel, Parcel];
    const early = orderOf(await itemize(officer, intake.id, body(notTapped.id)));
    expect((await tap(officer, tapped.id, true)).status).toBe(200);
    expect((await finishAsTapped(officer, intake.id)).status).toBe(200);
    expect((await orderRow(early.id))?.commercial_state).toBeNull();
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const { etag } = await read(senior, intake.id);
    const corrected = await senior.client.post(
      `${ONE(intake.id)}/correction`,
      {
        reason: 'The parcel was on the next table',
        parcel_changes: [{ parcel_id: notTapped.id, state: 'ARRIVED' }],
      },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );
    expect(corrected.status, corrected.text).toBe(200);
    expect(await orderRow(early.id)).toMatchObject({
      commercial_state: 'NO_VENDOR_CHARGE',
      locked_price_minor: 3500,
    });
  });

  // Break caught: an order promised from nothing when the moment custody passed cannot be read, or one left behind by the refusal.
  it('is refused, with no order, when the stop’s collection was never confirmed (COMMITMENT_SOURCE_UNRESOLVED)', async () => {
    const done = await handOver(routes, vendor, days, { collected: [1], photos: true });
    const id = done.intakes[0]?.id ?? '';
    expect((await finishAllHere(officer, id, 1)).status).toBe(200);
    const { intake } = await read(officer, id);
    const parcel = present(intake.parcels ?? [], 0);
    expect(refusal(await itemize(officer, id, body(parcel.id)))[0]).toBe(422);
    expect((await itemize(officer, id, body(parcel.id))).json()).toMatchObject({
      code: 'COMMITMENT_SOURCE_UNRESOLVED',
    });
    expect(await countOrders(id)).toBe(0);
    expect(await intakeState(id)).toBe('READY_FOR_ITEMIZATION');
  });
});

describe('the commercial gate (S1.37, AC-SLICE-001-65, -66)', () => {
  const gateEvents = async (orderId: string): Promise<string[]> =>
    (
      await routes.rows<{ event_code: string }>(
        `select event_code from audit_event where object_id = $1 and event_code like 'order.%' order by recorded_at, id`,
        [orderId],
      )
    ).map((row) => row.event_code);

  // Break caught: the gate that asks the account before the amount, so that an overdue vendor's recipient-pays parcel is stopped for a debt nobody owes (AC-SLICE-001-65).
  it('clears a recipient-pays order of an OVERDUE vendor with no charge: the amount is tested first and the account is never consulted', async () => {
    await setFinancialStanding(routes.admin, vendor.row.organizationId, 'OVERDUE');
    try {
      const intake = await cleared(1);
      const [parcel] = intake.parcels as [Parcel];
      const made = orderOf(
        await itemize(
          officer,
          intake.id,
          body(parcel.id, { payer_override: { payer_intent: 'RECIPIENT_PAYS' } }),
        ),
      );
      expect(made.commercial_state).toBe('NO_VENDOR_CHARGE');
      expect(made.payer_allocation).toEqual({ sender_minor: 0, recipient_minor: 3500 });
      expect(await gateEvents(made.id)).toEqual(['order.commercial.cleared_no_charge']);
    } finally {
      await setFinancialStanding(routes.admin, vendor.row.organizationId, 'GOOD');
    }
  });

  // Break caught: the gate that reads the request's intent and not the resolved amount: a split that resolves to nothing and a parcel-level override that moves the whole fee reach the same place (AC-SLICE-001-66).
  it('reads the resolved amount and not the intent: a split that resolves to zero and a parcel override both clear with no charge', async () => {
    const intake = await cleared(3);
    const [a, , c] = intake.parcels as [Parcel, Parcel, Parcel];
    // 0.01% of GH₵35.00 is a third of a pesewa: the sender's portion rounds to zero, and no floor is applied (domain-model §5.2.1).
    const splitToZero = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, {
          payer_override: {
            payer_intent: 'SPLIT',
            split_basis: 'PERCENTAGE',
            split_sender_percentage: 0.01,
          },
        }),
      ),
    );
    expect(splitToZero.payer_allocation).toEqual({ sender_minor: 0, recipient_minor: 3500 });
    expect(splitToZero.commercial_state).toBe('NO_VENDOR_CHARGE');
    const moved = orderOf(
      await itemize(
        officer,
        intake.id,
        body(c.id, { payer_override: { payer_intent: 'RECIPIENT_PAYS' } }),
      ),
    );
    expect(moved.commercial_state).toBe('NO_VENDOR_CHARGE');
    for (const order of [splitToZero, moved]) {
      expect(await gateEvents(order.id)).toEqual(['order.commercial.cleared_no_charge']);
    }
  });

  // Break caught: a vendor portion above zero that clears, or that is reserved against an allowance that D-12 does not build: it asks for payment, and is blocked from dispatch readiness.
  it('takes a vendor portion above zero to PAYMENT_REQUIRED, whole or split, and records it', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const full = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } }),
      ),
    );
    expect(full.payer_allocation).toEqual({ sender_minor: 3500, recipient_minor: 0 });
    expect(full.commercial_state).toBe('PAYMENT_REQUIRED');
    const split = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, {
          payer_override: {
            payer_intent: 'SPLIT',
            split_basis: 'PERCENTAGE',
            split_sender_percentage: 25,
          },
        }),
      ),
    );
    expect(split.commercial_state).toBe('PAYMENT_REQUIRED');
    for (const order of [full, split]) {
      expect(await gateEvents(order.id)).toEqual(['order.payment.required']);
    }
    // The event states what the gate read: the resolved portions.
    const detail = (
      await routes.rows<{ detail: Record<string, unknown> }>(
        `select detail from audit_event where object_id = $1 and event_code = 'order.payment.required'`,
        [split.id],
      )
    )[0]?.detail;
    expect(detail).toMatchObject({
      commercial_state: 'PAYMENT_REQUIRED',
      sender_minor: 875,
      recipient_minor: 2625,
    });
  });

  // Break caught: an order that waited for its parcel and is confirmed at the check-in with the gate left out, so that it sits at PRICED for ever.
  it('runs when a waiting order is confirmed at the check-in, in the same change as the freeze', async () => {
    const intake = await opened(2);
    const [tapped, notTapped] = intake.parcels as [Parcel, Parcel];
    const paying = orderOf(
      await itemize(
        officer,
        intake.id,
        body(tapped.id, { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } }),
      ),
    );
    const clearing = orderOf(
      await itemize(
        officer,
        intake.id,
        body(notTapped.id, { payer_override: { payer_intent: 'RECIPIENT_PAYS' } }),
      ),
    );
    expect(paying.commercial_state).toBeNull();
    expect(clearing.commercial_state).toBeNull();
    expect(await gateEvents(paying.id)).toEqual([]);
    expect((await tap(officer, tapped.id, true)).status).toBe(200);
    expect((await tap(officer, notTapped.id, true)).status).toBe(200);
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    expect((await orderRow(paying.id))?.commercial_state).toBe('PAYMENT_REQUIRED');
    expect((await orderRow(clearing.id))?.commercial_state).toBe('NO_VENDOR_CHARGE');
    expect(await gateEvents(paying.id)).toEqual(['order.payment.required']);
    expect(await gateEvents(clearing.id)).toEqual(['order.commercial.cleared_no_charge']);
  });
});

describe('the close of an intake (S1.38, AC-SLICE-001-40, -51, -52)', () => {
  const CLOSE = (id: string): string => `${ONE(id)}/close`;
  const closeIntake = async (
    actor: Actor,
    id: string,
    body?: unknown,
    over: { etag?: string | null; key?: string | null } = {},
  ): Promise<TestResponse> => {
    const etag = over.etag === undefined ? (await read(actor, id)).etag : over.etag;
    return actor.client.post(CLOSE(id), body, {
      origin: OPS,
      headers: {
        ...(etag === null ? {} : { 'If-Match': etag }),
        ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
      },
    });
  };
  const closedFacts = async (id: string) =>
    (
      await routes.rows<{
        state: string;
        closed_at: Date | null;
        closed_by: string | null;
        parity_exception_id: string | null;
        parity_exception_note: string | null;
      }>(
        `select state, closed_at, closed_by, parity_exception_id, parity_exception_note from pickup_intake where id = $1`,
        [id],
      )
    )[0];
  const closeEvents = async (id: string): Promise<{ code: string; enhanced: boolean }[]> =>
    (
      await routes.rows<{ event_code: string; enhanced: boolean }>(
        `select event_code, enhanced from audit_event where object_id = $1 and event_code like 'hub.intake.closed%' order by recorded_at, id`,
        [id],
      )
    ).map((row) => ({ code: row.event_code, enhanced: row.enhanced }));

  // Break caught: parity counted against the declaration or against the orders cleared for dispatch, so that an intake with a PAYMENT_REQUIRED order is refused, or the close made with no facts.
  it('closes an intake whose arrived parcels each have an order, a PAYMENT_REQUIRED one included (AC-SLICE-001-51, -52)', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } }),
      ),
    );
    orderOf(await itemize(officer, intake.id, body(c.id)));
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    const key = randomUUID();
    const closed = await closeIntake(officer, intake.id, undefined, { key });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.json()).toMatchObject({ id: intake.id, state: 'CLOSED' });
    expect(closed.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(await closedFacts(intake.id)).toMatchObject({
      state: 'CLOSED',
      closed_by: officer.identity.id,
      parity_exception_id: null,
      parity_exception_note: null,
    });
    expect((await closedFacts(intake.id))?.closed_at).toBeInstanceOf(Date);
    expect(await closeEvents(intake.id)).toEqual([{ code: 'hub.intake.closed', enhanced: false }]);
    // The retry is the first answer and makes nothing twice; another key on a closed intake is the state, told by name.
    const replay = await closeIntake(officer, intake.id, undefined, {
      key,
      etag: closed.header('etag') ?? '',
    });
    expect(replay.status).toBe(200);
    expect(replay.json()).toEqual(closed.json());
    expect(await closeEvents(intake.id)).toHaveLength(1);
    const again = await closeIntake(officer, intake.id);
    expect(refusal(again)).toEqual([409, 'STATE_CONFLICT', 'already_closed']);
  });

  // Break caught: an intake cleared for itemizing whose orders were all made early cannot be closed because it never reached ITEMIZING (OB-S1-142).
  it('closes an intake that is still READY_FOR_ITEMIZATION through ITEMIZING, when every order was made early', async () => {
    const intake = await opened(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id)));
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect((await tap(officer, b.id, true)).status).toBe(200);
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    expect(await intakeState(intake.id)).toBe('READY_FOR_ITEMIZATION');
    const closed = await closeIntake(officer, intake.id);
    expect(closed.status, closed.text).toBe(200);
    expect(await intakeState(intake.id)).toBe('CLOSED');
    expect((await closeEvents(intake.id))[0]).toMatchObject({ code: 'hub.intake.closed' });
  });

  // Break caught: a close that does not count the orders against the parcels the hub received, or one that goes ahead with a short count and no exception.
  it('is refused with PARITY_NOT_MET, naming both numbers, when the orders are fewer than the parcels received', async () => {
    const intake = await cleared(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id)));
    const refused = await closeIntake(officer, intake.id);
    expect(refusal(refused)).toEqual([422, 'PARITY_NOT_MET', 'parity_not_met']);
    expect(refused.json()).toMatchObject({
      details: { received_count: 3, itemized_count: 2 },
    });
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    expect((await closedFacts(intake.id))?.closed_at).toBeNull();
    expect(await closeEvents(intake.id)).toEqual([]);
  });

  // Break caught: the exception open to an officer who holds the close alone, a blank reason accepted, an exception recorded for an intake that has parity, or no record of it.
  it('closes without parity only by the approved exception: Senior Ops, a reason in words, and never for an intake that has parity', async () => {
    const intake = await cleared(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id)));
    const exception = {
      parity_exception: { note: 'The third parcel was left on the rider’s bike' },
    };
    // The key is held and the tier is not.
    expect(refusal(await closeIntake(officer, intake.id, exception))).toEqual([
      403,
      'INSUFFICIENT_AUTHORITY',
      'close_exception_required',
    ]);
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    // A blank reason is told before anything else is judged.
    expect(
      refusal(await closeIntake(senior, intake.id, { parity_exception: { note: '   ' } }))[1],
    ).toBe('REASON_REQUIRED');
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    const closed = await closeIntake(senior, intake.id, exception);
    expect(closed.status, closed.text).toBe(200);
    const facts = await closedFacts(intake.id);
    expect(facts).toMatchObject({
      state: 'CLOSED',
      closed_by: senior.identity.id,
      parity_exception_note: 'The third parcel was left on the rider’s bike',
    });
    expect(facts?.parity_exception_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await closeEvents(intake.id)).toEqual([
      { code: 'hub.intake.closed_exception', enhanced: true },
    ]);
    // An exception for an intake that has parity is not what the exception is for.
    const whole = await cleared(1);
    const [only] = whole.parcels as [Parcel];
    orderOf(await itemize(officer, whole.id, body(only.id)));
    expect(firstViolation(await closeIntake(senior, whole.id, exception))).toEqual([
      400,
      '/parity_exception',
      'exception_not_needed',
    ]);
    expect(await intakeState(whole.id)).toBe('ITEMIZING');
  });

  // Break caught: a close that skips the stale token, the key, the hub or the state it is told by.
  it('takes the intake’s ETag and a key, keeps to the officer’s hubs, and is refused before the count is cleared', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    orderOf(await itemize(officer, intake.id, body(only.id)));
    expect((await closeIntake(officer, intake.id, undefined, { etag: null })).status).toBe(400);
    expect(refusal(await closeIntake(officer, intake.id, undefined, { etag: '"AAAA"' }))).toEqual([
      409,
      'STATE_CONFLICT',
      'stale',
    ]);
    expect((await closeIntake(officer, intake.id, undefined, { key: null })).status).toBe(400);
    expect(refusal(await closeIntake(otherHub, intake.id, undefined, { etag: '"x"' }))[1]).toBe(
      'HUB_SCOPE_VIOLATION',
    );
    const waiting = await opened(1);
    expect(refusal(await closeIntake(officer, waiting.id))).toEqual([
      409,
      'STATE_CONFLICT',
      'check_in_open',
    ]);
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
  });
});

describe('the summary of a closed intake and the read of an order (S1.38, AC-SLICE-001-46, -56)', () => {
  const SUMMARY = (id: string): string => `${ONE(id)}/summary`;
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  const close = async (actor: Actor, id: string): Promise<void> => {
    const closed = await actor.client.post(`${ONE(id)}/close`, undefined, {
      origin: OPS,
      headers: { 'If-Match': (await read(actor, id)).etag, 'Idempotency-Key': randomUUID() },
    });
    expect(closed.status, closed.text).toBe(200);
  };

  // Break caught: a summary that carries a count, a declaration, a discrepancy, evidence or an adjudication; one served before the intake is closed; or one served to another vendor.
  it('gives the vendor the orders of its closed intake and nothing of the receiving side, and nobody else’s', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const first = orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } }),
      ),
    );
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    // Not closed: an intake that does not exist, to the vendor and to the staff alike.
    expect((await browser.get(SUMMARY(intake.id))).status).toBe(404);
    expect((await officer.client.get(SUMMARY(intake.id))).status).toBe(404);
    await close(officer, intake.id);
    const seen = await browser.get(SUMMARY(intake.id));
    expect(seen.status, seen.text).toBe(200);
    const summary = seen.json() as {
      intake_id: string;
      closed_at: string;
      orders: Record<string, unknown>[];
    };
    expect(summary.intake_id).toBe(intake.id);
    expect(summary.orders).toHaveLength(2);
    expect(summary.orders[0]).toMatchObject({
      id: first.id,
      code: first.code,
      recipient_name: 'Ama Mensah',
      size_class: 'SMALL',
      locked_price: { amount_minor: 3500, currency: 'GHS' },
      commercial_state: 'NO_VENDOR_CHARGE',
    });
    expect(summary.orders[1]).toMatchObject({ commercial_state: 'PAYMENT_REQUIRED' });
    // The omission is the guard: nothing of the receiving side is in what the vendor reads.
    for (const secret of [
      'physical_count',
      'rider_declared_count',
      'count_variance',
      'condition',
      'evidence',
      'parity_exception',
      'finding',
      'adjudicat',
      'parcel_photo',
    ]) {
      expect(seen.text, secret).not.toContain(secret);
    }
    // The staff of the hub read it too; another hub's officer is told it is another hub's.
    const staffSees = await officer.client.get(SUMMARY(intake.id));
    expect(staffSees.status, staffSees.text).toBe(200);
    expect(refusal(await otherHub.client.get(SUMMARY(intake.id)))[1]).toBe('HUB_SCOPE_VIOLATION');
    // Another vendor's browser sees an intake that does not exist.
    const stranger = await routes.vendor();
    const foreign = routes.browser(stranger.device.credential.token);
    expect(
      (await routes.signIn(foreign, stranger.row.accountIdentifier, stranger.secret)).status,
    ).toBe(200);
    expect((await foreign.get(SUMMARY(intake.id))).status).toBe(404);
  });

  // Break caught: an order read that shows a vendor the recipient, the serial, who judged the size or the carrier's cost, that serves another vendor's order, or whose ETag does not move with the order.
  it('reads an order: all of it for the staff of its hub, the vendor’s part for the vendor, and another vendor’s is no order', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const made = orderOf(
      await itemize(
        officer,
        intake.id,
        body(only.id, { is_serialized_goods: true, serial_imei: '356938035643809' }),
      ),
    );
    const staffRead = await officer.client.get(ORDER(made.id));
    expect(staffRead.status, staffRead.text).toBe(200);
    expect(staffRead.json()).toMatchObject({
      id: made.id,
      locked_price: { amount_minor: 3500, currency: 'GHS' },
      commercial_state: 'NO_VENDOR_CHARGE',
      serial_imei: '356938035643809',
      size_class_selected_by: officer.identity.id,
      recipient: { name: 'Ama Mensah' },
    });
    expect(staffRead.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect((await officer.client.get(ORDER(made.id))).header('etag')).toBe(
      staffRead.header('etag'),
    );
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    const vendorRead = await browser.get(ORDER(made.id));
    expect(vendorRead.status, vendorRead.text).toBe(200);
    const shown = vendorRead.json() as Record<string, unknown>;
    expect(shown).toMatchObject({
      id: made.id,
      locked_price: { amount_minor: 3500, currency: 'GHS' },
    });
    for (const withheld of ['recipient', 'serial_imei', 'size_class_selected_by', 'carrier_cost']) {
      expect(shown, withheld).not.toHaveProperty(withheld);
    }
    expect(vendorRead.header('etag')).not.toBe(staffRead.header('etag'));
    const stranger = await routes.vendor();
    const foreign = routes.browser(stranger.device.credential.token);
    expect(
      (await routes.signIn(foreign, stranger.row.accountIdentifier, stranger.secret)).status,
    ).toBe(200);
    expect((await foreign.get(ORDER(made.id))).status).toBe(404);
    expect(refusal(await otherHub.client.get(ORDER(made.id)))[1]).toBe('HUB_SCOPE_VIOLATION');
    expect((await officer.client.get(ORDER(randomUUID()))).status).toBe(404);
  });
});

describe('the payer correction after the price froze (S1.39, AC-SLICE-001-55, -66)', () => {
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  const orderEtag = async (actor: Actor, id: string): Promise<string> => {
    const read = await actor.client.get(ORDER(id));
    expect(read.status, read.text).toBe(200);
    return read.header('etag') ?? '';
  };
  const request = async (
    actor: Actor,
    orderId: string,
    given: unknown,
    over: { etag?: string | null; key?: string | null } = {},
  ): Promise<TestResponse> => {
    const etag = over.etag === undefined ? await orderEtag(actor, orderId) : over.etag;
    return actor.client.post(`${ORDER(orderId)}/payer-correction`, given, {
      origin: OPS,
      headers: {
        ...(etag === null ? {} : { 'If-Match': etag }),
        ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
      },
    });
  };
  const decide = async (
    actor: Actor,
    correctionId: string,
    given: unknown,
    etag: string | null,
    key: string = randomUUID(),
  ): Promise<TestResponse> =>
    actor.client.post(`${API}/payer-corrections/${correctionId}/decision`, given, {
      origin: OPS,
      headers: { ...(etag === null ? {} : { 'If-Match': etag }), 'Idempotency-Key': key },
    });
  const correctionEvents = async (
    orderId: string,
  ): Promise<{ code: string; enhanced: boolean }[]> =>
    (
      await routes.rows<{ event_code: string; enhanced: boolean }>(
        `select event_code, enhanced from audit_event where object_id = $1 and event_code like 'pricing.correction.%' order by recorded_at, id`,
        [orderId],
      )
    ).map((row) => ({ code: row.event_code, enhanced: row.enhanced }));
  const proposal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    proposed: { payer_intent: 'SENDER_PAYS_FULL' },
    note: 'The vendor agreed to pay the whole fee on the phone',
    ...over,
  });
  const frozenOrder = async (
    intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL' = 'RECIPIENT_PAYS',
  ): Promise<Order> => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    return orderOf(
      await itemize(
        officer,
        intake.id,
        body(only.id, { payer_override: { payer_intent: intent } }),
      ),
    );
  };

  // Break caught: a correction that rewrites the locked price, that is not held until a checker decides, that does not re-run the gate, or whose history is incomplete.
  it('is asked by the maker and decided by another officer: the portions move, the locked price does not, and the gate runs again from them', async () => {
    const made = await frozenOrder('RECIPIENT_PAYS');
    expect(made.commercial_state).toBe('NO_VENDOR_CHARGE');
    const etagBefore = await orderEtag(officer, made.id);
    const asked = await request(officer, made.id, proposal());
    expect(asked.status, asked.text).toBe(201);
    const correction = asked.json() as {
      id: string;
      state: string;
      requested_by: string;
      previous_allocation: { sender_minor: number; recipient_minor: number };
      proposed: { payer_intent: string };
    };
    expect(correction).toMatchObject({
      state: 'REQUESTED',
      requested_by: officer.identity.id,
      previous_allocation: { sender_minor: 0, recipient_minor: 3500 },
      proposed: { payer_intent: 'SENDER_PAYS_FULL' },
    });
    // Asked, nothing has moved.
    expect((await orderRow(made.id))?.payer_allocation).toMatchObject({
      sender_minor: 0,
      recipient_minor: 3500,
    });
    expect(await orderEtag(officer, made.id)).toBe(etagBefore);
    // One request is open for an order at a time; the maker is not the checker's key.
    expect(refusal(await request(officer, made.id, proposal()))).toEqual([
      409,
      'STATE_CONFLICT',
      'correction_open',
    ]);
    const correctionEtag = asked.header('etag') ?? '';
    expect(correctionEtag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(
      refusal(await decide(officer, correction.id, { decision: 'APPROVE' }, correctionEtag))[1],
    ).toBe('PERMISSION_DENIED');
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    // A token that is not the correction's, and a decision that is not one.
    expect(refusal(await decide(senior, correction.id, { decision: 'APPROVE' }, '"AAAA"'))).toEqual(
      [409, 'STATE_CONFLICT', 'stale'],
    );
    expect(
      (await decide(senior, correction.id, { decision: 'MAYBE' }, correctionEtag)).status,
    ).toBe(400);
    const decided = await decide(senior, correction.id, { decision: 'APPROVE' }, correctionEtag);
    expect(decided.status, decided.text).toBe(200);
    expect(decided.json()).toMatchObject({
      state: 'APPROVED',
      approved_by: senior.identity.id,
      resulting_commercial_state: 'PAYMENT_REQUIRED',
    });
    // The locked price is the same, the portions are the new ones, and the gate ran again from them.
    const after = await orderRow(made.id);
    expect(after).toMatchObject({ commercial_state: 'PAYMENT_REQUIRED', locked_price_minor: 3500 });
    expect(after?.payer_allocation).toMatchObject({ sender_minor: 3500, recipient_minor: 0 });
    expect(await orderEtag(officer, made.id)).not.toBe(etagBefore);
    expect(await correctionEvents(made.id)).toEqual([
      { code: 'pricing.correction.requested', enhanced: false },
      { code: 'pricing.correction.approved', enhanced: true },
      { code: 'pricing.correction.applied', enhanced: false },
    ]);
    // Decided once.
    expect(
      refusal(
        await decide(senior, correction.id, { decision: 'REJECT' }, decided.header('etag') ?? ''),
      ),
    ).toEqual([409, 'STATE_CONFLICT', 'already_decided']);
    // And the history: the request keeps what the order had.
    const kept = await routes.rows<{
      previous_allocation: { sender_minor: number };
      resulting_allocation: { sender_minor: number };
    }>(`select previous_allocation, resulting_allocation from payer_correction where id = $1`, [
      correction.id,
    ]);
    expect(kept[0]).toMatchObject({
      previous_allocation: { sender_minor: 0 },
      resulting_allocation: { sender_minor: 3500 },
    });
  });

  // Break caught: a checker who may be the maker, or a Platform Admin who may not, or a blank reason, or a stale order token.
  it('is not approved by its own maker unless a Platform Admin, wants a reason, and takes the order’s token', async () => {
    const made = await frozenOrder('RECIPIENT_PAYS');
    expect(refusal(await request(officer, made.id, proposal({ note: '   ' })))[1]).toBe(
      'REASON_REQUIRED',
    );
    expect(refusal(await request(officer, made.id, proposal(), { etag: '"AAAA"' }))).toEqual([
      409,
      'STATE_CONFLICT',
      'stale',
    ]);
    expect((await request(officer, made.id, proposal(), { key: null })).status).toBe(400);
    expect(
      (await request(officer, made.id, { ...proposal(), proposed: { payer_intent: 'SPLIT' } }))
        .status,
    ).toBe(400);
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const own = await request(senior, made.id, proposal());
    expect(own.status, own.text).toBe(201);
    const ownId = (own.json() as { id: string }).id;
    expect(
      refusal(await decide(senior, ownId, { decision: 'APPROVE' }, own.header('etag') ?? '')),
    ).toEqual([422, 'SELF_APPROVAL_FORBIDDEN', undefined]);
    expect((await orderRow(made.id))?.commercial_state).toBe('NO_VENDOR_CHARGE');
    // A Platform Admin may decide what it asked.
    const admin = await routes.platformAdmin();
    const second = await frozenOrder('RECIPIENT_PAYS');
    const adminAsk = await request(admin, second.id, proposal());
    expect(adminAsk.status, adminAsk.text).toBe(201);
    const approved = await decide(
      admin,
      (adminAsk.json() as { id: string }).id,
      { decision: 'APPROVE' },
      adminAsk.header('etag') ?? '',
    );
    expect(approved.status, approved.text).toBe(200);
    expect((await orderRow(second.id))?.commercial_state).toBe('PAYMENT_REQUIRED');
  });

  // Break caught: a rejection that changes the order, or one that leaves the order closed to a new request.
  it('changes nothing when it is rejected, and the order may be asked about again', async () => {
    const made = await frozenOrder('SENDER_PAYS_FULL');
    expect(made.commercial_state).toBe('PAYMENT_REQUIRED');
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const asked = await request(
      officer,
      made.id,
      proposal({ proposed: { payer_intent: 'RECIPIENT_PAYS' } }),
    );
    expect(asked.status, asked.text).toBe(201);
    const id = (asked.json() as { id: string }).id;
    const rejected = await decide(
      senior,
      id,
      { decision: 'REJECT', note: 'The vendor pays' },
      asked.header('etag') ?? '',
    );
    expect(rejected.status, rejected.text).toBe(200);
    expect(rejected.json()).toMatchObject({ state: 'REJECTED', resulting_commercial_state: null });
    expect(await orderRow(made.id)).toMatchObject({
      commercial_state: 'PAYMENT_REQUIRED',
      locked_price_minor: 3500,
    });
    expect((await orderRow(made.id))?.payer_allocation).toMatchObject({ sender_minor: 3500 });
    expect((await correctionEvents(made.id)).map((event) => event.code)).toEqual([
      'pricing.correction.requested',
      'pricing.correction.rejected',
    ]);
    const again = await request(
      officer,
      made.id,
      proposal({ proposed: { payer_intent: 'RECIPIENT_PAYS' } }),
    );
    expect(again.status, again.text).toBe(201);
  });

  // Break caught: a correction asked for an order whose price is not frozen yet (nothing to share), or portions that round down where the freeze rounds to the pesewa, half up.
  it('is refused for an order that waits for its parcel, and shares the price to the pesewa as the freeze does', async () => {
    const early = await opened(1);
    const [parcel] = early.parcels as [Parcel];
    const waiting = orderOf(await itemize(officer, early.id, body(parcel.id)));
    expect(waiting.commercial_state).toBeNull();
    expect(refusal(await request(officer, waiting.id, proposal()))).toEqual([
      409,
      'STATE_CONFLICT',
      'order_not_frozen',
    ]);
    const made = await frozenOrder('RECIPIENT_PAYS');
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const asked = await request(
      officer,
      made.id,
      proposal({
        proposed: {
          payer_intent: 'SPLIT',
          split_basis: 'PERCENTAGE',
          split_sender_percentage: 33.33,
        },
      }),
    );
    expect(asked.status, asked.text).toBe(201);
    const decided = await decide(
      senior,
      (asked.json() as { id: string }).id,
      { decision: 'APPROVE' },
      asked.header('etag') ?? '',
    );
    expect(decided.status, decided.text).toBe(200);
    // 33.33% of GH₵35.00 is 1166.55 pesewas: the sender's side rounds half up to 1167, the recipient's is the rest.
    expect((await orderRow(made.id))?.payer_allocation).toMatchObject({
      sender_minor: 1167,
      recipient_minor: 2333,
    });
    expect((await orderRow(made.id))?.commercial_state).toBe('PAYMENT_REQUIRED');
  });

  // Break caught: the gate re-run by the intent and not by the resolved amount: a split that resolves to zero must clear the order with no charge, as it does at the freeze (AC-SLICE-001-66).
  it('re-runs the gate from the resolved amount: a split that resolves to zero clears the order, the zero branch first', async () => {
    const made = await frozenOrder('SENDER_PAYS_FULL');
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const asked = await request(
      officer,
      made.id,
      proposal({
        proposed: {
          payer_intent: 'SPLIT',
          split_basis: 'PERCENTAGE',
          split_sender_percentage: 0.01,
        },
      }),
    );
    expect(asked.status, asked.text).toBe(201);
    const decided = await decide(
      senior,
      (asked.json() as { id: string }).id,
      { decision: 'APPROVE' },
      asked.header('etag') ?? '',
    );
    expect(decided.status, decided.text).toBe(200);
    expect(decided.json()).toMatchObject({ resulting_commercial_state: 'NO_VENDOR_CHARGE' });
    expect((await orderRow(made.id))?.payer_allocation).toMatchObject({
      sender_minor: 0,
      recipient_minor: 3500,
    });
  });
});

describe('the payer edit before the price freezes (S1.39, AC-SLICE-001-55)', () => {
  const AMEND = (id: string): string => `${API}/pickup-requests/${id}/amend`;
  const etagOf = async (client: { get: (path: string) => Promise<TestResponse> }, id: string) => {
    const read = await client.get(`${API}/pickup-requests/${id}`);
    expect(read.status, read.text).toBe(200);
    return read.header('etag') ?? '';
  };
  const arrange = async (state: 'PENDING' | 'CONFIRMED'): Promise<string> =>
    (
      await insertPickupRequest(
        routes.admin,
        pickupRequestRow(vendor.row.organizationId, HUB_A, { state }),
      )
    ).id;
  const amendAs = async (
    client: { post: (path: string, body: unknown, options: object) => Promise<TestResponse> },
    origin: string | undefined,
    id: string,
    given: unknown,
    etag: string,
  ): Promise<TestResponse> =>
    client.post(AMEND(id), given, {
      ...(origin === undefined ? {} : { origin }),
      headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
    });

  // Break caught: an edit that is refused for the people it is for, allowed for those it is not, or one that writes a portion of a price; and an origin edit that pretends to work.
  it('lets a vendor edit its own pending request and Ops a pending or confirmed one, by intent, and refuses what is not built by name', async () => {
    const pending = await arrange('PENDING');
    const confirmed = await arrange('CONFIRMED');
    const payer = { payer: { payer_intent: 'SENDER_PAYS_FULL' } };
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    // The vendor's own pending request: the arrangement is the intent, kept as it was given.
    const vendorEdit = await amendAs(
      browser,
      undefined,
      pending,
      payer,
      await etagOf(browser, pending),
    );
    expect(vendorEdit.status, vendorEdit.text).toBe(200);
    expect(vendorEdit.json()).toMatchObject({
      id: pending,
      default_payer_intent: 'SENDER_PAYS_FULL',
    });
    expect(vendorEdit.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    // A confirmed request is not the vendor's to edit: it is Ops's.
    expect(
      refusal(
        await amendAs(
          browser,
          undefined,
          confirmed,
          payer,
          await etagOf(officer.client, confirmed),
        ),
      )[1],
    ).toBe('PERMISSION_DENIED');
    const opsEdit = await amendAs(
      officer.client,
      OPS,
      confirmed,
      {
        payer: { payer_intent: 'SPLIT', split_basis: 'PERCENTAGE', split_sender_percentage: 25 },
        note: 'The vendor asked for a quarter on the phone',
      },
      await etagOf(officer.client, confirmed),
    );
    expect(opsEdit.status, opsEdit.text).toBe(200);
    expect(opsEdit.json()).toMatchObject({ default_payer_intent: 'SPLIT' });
    // Another hub's officer, a stale token, and what is not built.
    expect(
      refusal(
        await amendAs(
          otherHub.client,
          OPS,
          confirmed,
          payer,
          await etagOf(officer.client, confirmed),
        ),
      )[1],
    ).toBe('HUB_SCOPE_VIOLATION');
    expect(refusal(await amendAs(officer.client, OPS, confirmed, payer, '"AAAA"'))).toEqual([
      409,
      'STATE_CONFLICT',
      undefined,
    ]);
    const fresh = await etagOf(officer.client, confirmed);
    expect(
      firstViolation(
        await amendAs(officer.client, OPS, confirmed, { primary_phone: '0241234567' }, fresh),
      ),
    ).toEqual([400, '/primary_phone', 'not_built']);
    expect(
      firstViolation(
        await amendAs(
          officer.client,
          OPS,
          confirmed,
          { pickup_location: { address: 'Madina' } },
          fresh,
        ),
      ),
    ).toEqual([400, '/pickup_location', 'not_built']);
    expect(
      firstViolation(await amendAs(officer.client, OPS, confirmed, { note: 'x' }, fresh)),
    ).toEqual([400, '/payer', 'required']);
    // A stranger's request is one that does not exist to another vendor.
    const stranger = await routes.vendor();
    const foreign = routes.browser(stranger.device.credential.token);
    expect(
      (await routes.signIn(foreign, stranger.row.accountIdentifier, stranger.secret)).status,
    ).toBe(200);
    expect((await amendAs(foreign, undefined, pending, payer, '"AAAA"')).status).toBe(404);
  });

  // Break caught: an edit of a request whose run has started, which is no longer Ops's to change under the rider's feet.
  it('is refused once the run that holds the request has started', async () => {
    const intake = await opened(1);
    const refused = await amendAs(
      officer.client,
      OPS,
      intake.requestId,
      { payer: { payer_intent: 'SENDER_PAYS_FULL' } },
      await etagOf(officer.client, intake.requestId),
    );
    expect(refusal(refused)).toEqual([409, 'STATE_CONFLICT', 'run_started']);
  });

  // Break caught: an edit of the arrangement once the price is frozen, which the contract makes a correction.
  it('is refused once an order of the request is frozen: after the freeze the same edit is a correction', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    orderOf(await itemize(officer, intake.id, body(only.id)));
    const refused = await amendAs(
      officer.client,
      OPS,
      intake.requestId,
      { payer: { payer_intent: 'SENDER_PAYS_FULL' } },
      await etagOf(officer.client, intake.requestId),
    );
    expect(refusal(refused)).toEqual([409, 'STATE_CONFLICT', 'price_frozen']);
  });
});
