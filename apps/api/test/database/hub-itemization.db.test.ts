import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { sql } from 'drizzle-orm';
import { parse } from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { locateContract } from '../../src/platform/contract/locate-contract.js';
import type { TextMessageSender } from '../../src/platform/auth/ports/text-message-sender.port.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { ConfigurationReader } from '../../src/platform/settings/configuration-reader.js';
import {
  NotificationLane,
  OPEN_POLICY,
} from '../../src/platform/notifications/notification-lane.js';
import { NotificationStore } from '../../src/platform/notifications/notification-store.js';
import {
  render,
  templateOf,
  wordingDigest,
  type Template,
} from '../../src/platform/notifications/templates.js';
import { checkOrderSurplus, isClear } from '../../src/tools/database/order-surplus-check.js';
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
import {
  backendPidOf,
  waitForBlockedBackend,
  waitUntilBlockedBy,
  waitUntilTrue,
} from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertPickupRequest, pickupRequestRow, setFinancialStanding } from './support/pickups.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { staffContext, vendorContext } from './support/rls-fixture.js';
import { seedHubConfiguration } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor } from './support/test-database.js';
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
  routes = await startVendorRoutes({
    // The races of the review of 20 November 2026 hold a lock until the test has seen the operation wait for it: the test ends the wait and not a bound, so the lock bound is
    // lengthened for this application alone. Nothing here tests a timeout.
    env: {
      DATABASE_LOCK_TIMEOUT_MS: '20000',
      DATABASE_STATEMENT_TIMEOUT_MS: '25000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '30000',
    },
  });
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
  // A collection of more than a few parcels is photographed by one statement and not one request at a time (a rider's session is allowed 120 requests a minute).
  const done = await handOver(routes, vendor, days, {
    collected: [count],
    photos: true,
    bulkPhotos: count > 12,
  });
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

/** A token that no preview gave: for a body the preview refuses, which is saved as it is so that the save meets the refusal the test is about. */
const NO_PREVIEW = '0'.repeat(64);

/**
 * The body of a save with the `terms_token` of its preview, as a screen reads it before it saves (the review of 20 November 2026, finding 3): the officer saves what was previewed. A body that has a token
 * already, or is no object, is left as it is.
 */
async function reviewedItemization(
  actor: Actor,
  intakeId: string,
  given: unknown,
): Promise<unknown> {
  if (typeof given !== 'object' || given === null || 'reviewed_terms' in given) return given;
  const preview = await actor.client.post(`${ONE(intakeId)}/orders/preview`, given, {
    origin: OPS,
  });
  const token =
    preview.status === 200 ? (preview.json() as { terms_token: string }).terms_token : NO_PREVIEW;
  return { ...given, reviewed_terms: token };
}

/** The same for an amendment, through the preview of an amendment. */
async function reviewedAmendment(actor: Actor, orderId: string, given: unknown): Promise<unknown> {
  if (typeof given !== 'object' || given === null || 'reviewed_terms' in given) return given;
  // The preview takes what an amendment changes, without the reason and the token that are the save's.
  const patch = Object.fromEntries(
    Object.entries(given).filter(([member]) => member !== 'note' && member !== 'reviewed_terms'),
  );
  const preview = await actor.client.post(`${API}/orders/${orderId}/amendment-preview`, patch, {
    origin: OPS,
  });
  const token =
    preview.status === 200 ? (preview.json() as { terms_token: string }).terms_token : NO_PREVIEW;
  return { ...given, reviewed_terms: token };
}

/** The officer itemizes, on the `ETag` of the read unless the test says otherwise, and on the terms of the preview of the same body unless it says `review: false`. */
async function itemize(
  actor: Actor,
  intakeId: string,
  given: unknown,
  over: { etag?: string | null; key?: string | null; review?: boolean } = {},
): Promise<TestResponse> {
  const etag = over.etag === undefined ? (await read(actor, intakeId)).etag : over.etag;
  const sent = over.review === false ? given : await reviewedItemization(actor, intakeId, given);
  return actor.client.post(ORDERS(intakeId), sent, {
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
/** The officer's own high-value flag as the database holds it (null: made before it was kept apart). */
const orderManualFlag = async (id: string): Promise<boolean | null | undefined> =>
  (
    await routes.rows<{ is_high_value_manual: boolean | null }>(
      `select is_high_value_manual from "order" where id = $1`,
      [id],
    )
  )[0]?.is_high_value_manual;

/**
 * A new version of a hub setting, effective now (as the owner changes a rate or a band, with the guards put aside as the other tests arrange a world the application cannot make); the answer puts the
 * setting back as it was.
 */
async function newSettingVersion(
  key: string,
  scopeRef: string,
  value: unknown,
): Promise<() => Promise<void>> {
  await routes.admin.query('begin');
  await routes.admin.query('set local session_replication_role = replica');
  const made = await routes.admin.query<{ id: string }>(
    `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
     select gen_random_uuid(), hub_id, setting_key, scope_ref, version + 1, $3::jsonb, unit, clock_timestamp() - interval '1 second', created_by
       from hub_setting where hub_id = $1 and setting_key = $2 and scope_ref = $4 order by version desc limit 1
     returning id`,
    [HUB_A, key, JSON.stringify(value), scopeRef],
  );
  await routes.admin.query('commit');
  const id = made.rows[0]?.id;
  return async () => {
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query('delete from hub_setting where id = $1', [id]);
    await routes.admin.query('commit');
  };
}

/** An order as the staff read it, with the history beside it (`getOrder`). */
const readOrderView = async (
  actor: Actor,
  id: string,
): Promise<Order & { amendments: unknown[]; reversal: unknown; price_status?: string }> =>
  (await actor.client.get(`${API}/orders/${id}`)).json() as Order & {
    amendments: unknown[];
    reversal: unknown;
    price_status?: string;
  };
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
    // A retry sends the request it sent: the same body, with the token it was given.
    const sent = await reviewedItemization(officer, intake.id, body(parcel.id));
    const first = await itemize(officer, intake.id, sent, { etag, key, review: false });
    const made = orderOf(first);
    const again = await itemize(officer, intake.id, sent, { etag, key, review: false });
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
  /** The assessment token of the closure the officer read (the review of 20 November 2026, finding 6): the approved exception is closed against it. */
  const assessmentOf = async (actor: Actor, id: string): Promise<string> => {
    const response = await actor.client.get(`${ONE(id)}/closure`);
    return response.status === 200
      ? (response.json() as { assessment_token: string }).assessment_token
      : NO_PREVIEW;
  };
  const closeIntake = async (
    actor: Actor,
    id: string,
    body?: unknown,
    over: { etag?: string | null; key?: string | null; review?: boolean } = {},
  ): Promise<TestResponse> => {
    const etag = over.etag === undefined ? (await read(actor, id)).etag : over.etag;
    // An exception is closed against the assessment the officer read, as a screen does it, unless the test says that none was read.
    const given = body as { parity_exception?: unknown; reviewed_assessment?: string } | undefined;
    const sent =
      over.review !== false &&
      given?.parity_exception !== undefined &&
      given.reviewed_assessment === undefined
        ? { ...given, reviewed_assessment: await assessmentOf(actor, id) }
        : body;
    return actor.client.post(CLOSE(id), sent, {
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

  // Break caught: an intake whose orders were all made early is not itemizing when the vendor is finished and they are confirmed (OB-S1-142: the state says what the work is), or cannot then be closed.
  it('begins itemizing when the first order made early is confirmed, and closes when every order was made early', async () => {
    const intake = await opened(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id)));
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect((await tap(officer, b.id, true)).status).toBe(200);
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    // The confirmation of the first order began the itemizing; it did not wait for the close to say so.
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
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

  // Break caught: a summary that gives staff the price whatever their pricing grant (the operational summary is under `pickup.read` and the money under `pricing.read`, at the hub of the intake), a price left out as a zero,
  // a zero left out as no price, or a price withheld from the owning vendor and from the staff whose pricing grant does reach the hub.
  it('gives staff a price only where their own pricing grant reaches the intake’s hub, leaves it out (never as zero) where it does not, and keeps the vendor’s view (OB-S1-155)', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const first = orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id)));
    await close(officer, intake.id);
    const prices = async (actor: Actor): Promise<{ id: string; locked_price?: unknown }[]> => {
      const seen = await actor.client.get(SUMMARY(intake.id));
      expect(seen.status, seen.text).toBe(200);
      return (seen.json() as { orders: { id: string; locked_price?: unknown }[] }).orders;
    };
    // A reader of every hub's operational summary whose pricing grant is its own hub's (and one that holds no pricing grant at all).
    const pickupEverywhere = await newBundle(routes.admin, [
      grant('pickup.read', 'all'),
      grant('pricing.read', 'own'),
    ]);
    const pickupOnly = await newBundle(routes.admin, [grant('pickup.read', 'own')]);
    for (const reader of [
      await routes.actor(pickupOnly, HUB_A),
      await routes.actor(pickupEverywhere, HUB_B),
    ]) {
      const orders = await prices(reader);
      expect(orders).toHaveLength(2);
      for (const order of orders) expect(order).not.toHaveProperty('locked_price');
    }
    // The same grants at the intake's own hub, and the officer of the hub (who holds both keys there): the prices.
    for (const reader of [await routes.actor(pickupEverywhere, HUB_A), officer]) {
      const orders = await prices(reader);
      expect(orders).toHaveLength(2);
      for (const order of orders) {
        expect(order.locked_price).toEqual({ amount_minor: 3500, currency: 'GHS' });
      }
    }
    // The owning vendor reads what it always read.
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    const seenByVendor = (await browser.get(SUMMARY(intake.id))).json() as {
      orders: { locked_price?: unknown }[];
    };
    expect(seenByVendor.orders.map((order) => order.locked_price)).toEqual([
      { amount_minor: 3500, currency: 'GHS' },
      { amount_minor: 3500, currency: 'GHS' },
    ]);
    // A price that is zero is a price (the guards put aside, as the other tests arrange a world the application cannot make): shown to whom the grant reaches, and left out for whom it does not.
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query('update "order" set locked_price_minor = 0 where id = $1', [first.id]);
    await routes.admin.query('commit');
    const zero = (await prices(officer)).find((order) => order.id === first.id);
    expect(zero?.locked_price).toEqual({ amount_minor: 0, currency: 'GHS' });
    const hidden = (await prices(await routes.actor(pickupOnly, HUB_A))).find(
      (order) => order.id === first.id,
    );
    expect(hidden).not.toHaveProperty('locked_price');
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
    for (const withheld of [
      'recipient',
      'serial_imei',
      'size_class_selected_by',
      'carrier_cost',
      'price_components_snapshot',
      'responsible_hub_id',
      'destination_zone_snapshot',
    ]) {
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

  // Break caught: a payer edit refused for the run having started (it moves no rider and is the only way, before the freeze, to say who pays for parcels not yet itemized), or one that does not reach the order.
  it('is allowed once the run has started, until an order is frozen: the arrangement it says is the one the order freezes with, and a closed intake refuses it', async () => {
    const intake = await opened(1);
    const [only] = intake.parcels as [Parcel];
    const edited = await amendAs(
      officer.client,
      OPS,
      intake.requestId,
      { payer: { payer_intent: 'SENDER_PAYS_FULL' }, note: 'The vendor will pay on the phone' },
      await etagOf(officer.client, intake.requestId),
    );
    expect(edited.status, edited.text).toBe(200);
    expect((await finishAllHere(officer, intake.id, 1)).status).toBe(200);
    const made = orderOf(await itemize(officer, intake.id, body(only.id)));
    expect(made.payer_allocation).toEqual({ sender_minor: 3500, recipient_minor: 0 });
    expect(made.commercial_state).toBe('PAYMENT_REQUIRED');
    // Once the intake is closed nothing is left to say.
    const closed = await officer.client.post(`${ONE(intake.id)}/close`, undefined, {
      origin: OPS,
      headers: {
        'If-Match': (await read(officer, intake.id)).etag,
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(closed.status, closed.text).toBe(200);
    const refused = await amendAs(
      officer.client,
      OPS,
      intake.requestId,
      { payer: { payer_intent: 'RECIPIENT_PAYS' } },
      await etagOf(officer.client, intake.requestId),
    );
    expect(refusal(refused)[1]).toBe('STATE_CONFLICT');
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

describe('the worklist, the progress and the closure assessment of an intake (the review of 19 November 2026, OB-S1-147)', () => {
  interface WorklistRow {
    readonly work_state: string;
    readonly parcel: { id: string; ordinal: number; origin: string; state: string } | null;
    readonly order: {
      id: string;
      code: string;
      confirmed: boolean;
      payment_required: boolean;
      commercial_state: string | null;
    } | null;
  }
  interface Worklist {
    readonly intake_id: string;
    readonly intake_state: string;
    readonly receiving_mode: string;
    readonly progress: Record<string, number>;
    readonly items: WorklistRow[];
    readonly next_page_token: string | null;
  }
  interface Closure {
    readonly intake_state: string;
    readonly received: number;
    readonly ordered: number;
    readonly unpriced: number;
    readonly payment_required: number;
    readonly outstanding_count: number;
    readonly outstanding_parcels: { parcel_id: string }[];
    readonly closed_at: string | null;
    readonly can_close: boolean;
    readonly needs_exception: boolean;
    readonly blockers: string[];
    readonly payment_still_required: boolean;
  }
  const worklist = async (actor: Actor, id: string, query = ''): Promise<Worklist> => {
    const response = await actor.client.get(`${ORDERS(id)}${query}`);
    expect(response.status, response.text).toBe(200);
    return response.json() as Worklist;
  };
  const closure = async (actor: Actor, id: string): Promise<Closure> => {
    const response = await actor.client.get(`${ONE(id)}/closure`);
    expect(response.status, response.text).toBe(200);
    return response.json() as Closure;
  };
  const payFull = { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } };

  // Break caught: counts of the page and not of the intake; a worklist that opens the money (price, portions, phone) under hub.read; a page token that skips or repeats a parcel; a view that is not the server's.
  it('counts the whole intake beside each page, filters by what is left to do and shows no money', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    let list = await worklist(officer, intake.id);
    expect(list).toMatchObject({
      intake_id: intake.id,
      receiving_mode: 'PHOTO_CHECK_IN',
      progress: {
        received: 3,
        awaiting_arrival: 0,
        needs_order: 3,
        prepared: 0,
        itemized: 0,
        payment_required: 0,
        missing: 0,
        orders: 0,
      },
    });
    expect(list.items.map((item) => item.work_state)).toEqual([
      'NEEDS_ORDER',
      'NEEDS_ORDER',
      'NEEDS_ORDER',
    ]);
    expect(list.items.map((item) => item.parcel?.id)).toEqual([a.id, b.id, c.id]);

    orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id, payFull)));
    list = await worklist(officer, intake.id);
    expect(list.progress).toEqual({
      received: 3,
      awaiting_arrival: 0,
      needs_order: 1,
      prepared: 0,
      itemized: 2,
      payment_required: 1,
      missing: 0,
      orders: 2,
    });
    expect(list.items.map((item) => item.work_state)).toEqual([
      'ITEMIZED',
      'ITEMIZED',
      'NEEDS_ORDER',
    ]);
    const needs = await worklist(officer, intake.id, '?view=needs_order');
    expect(needs.items.map((item) => item.parcel?.id)).toEqual([c.id]);
    const paying = await worklist(officer, intake.id, '?view=payment_required');
    expect(paying.items).toHaveLength(1);
    expect(paying.items[0]?.order).toMatchObject({
      payment_required: true,
      commercial_state: 'PAYMENT_REQUIRED',
      confirmed: true,
    });
    expect((await worklist(officer, intake.id, '?view=itemized')).items).toHaveLength(2);
    // hub.read does not open the money: no price, portion, payer or phone is anywhere in the answer.
    expect(JSON.stringify(list)).not.toMatch(/amount_minor|locked_price|payer|phone|allocation/i);

    // A page of one, followed by its token: each parcel once, in order, and the counts of the whole intake on every page.
    const seen: (string | undefined)[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const page: Worklist = await worklist(
        officer,
        intake.id,
        `?page_size=1${token === null ? '' : `&page_token=${token}`}`,
      );
      expect(page.progress.orders).toBe(2);
      expect(page.items).toHaveLength(1);
      seen.push(page.items[0]?.parcel?.id);
      token = page.next_page_token;
      pages += 1;
    } while (token !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([a.id, b.id, c.id]);
  });

  // Break caught: an early order shown as arrived, or as itemized before its arrival is committed; a parcel of the same intake that is still expected shown as needing an order.
  it('tells an order prepared before its parcel arrived from one that is confirmed, and an expected parcel from one that needs an order', async () => {
    const intake = await opened(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    let list = await worklist(officer, intake.id);
    expect(list.progress).toEqual({
      received: 0,
      awaiting_arrival: 2,
      needs_order: 0,
      prepared: 1,
      itemized: 0,
      payment_required: 0,
      missing: 0,
      orders: 1,
    });
    expect(list.items.map((item) => item.work_state)).toEqual(['PREPARED', 'AWAITING_ARRIVAL']);
    expect(list.items[0]?.order).toMatchObject({ confirmed: false, commercial_state: null });
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    list = await worklist(officer, intake.id);
    expect(list.items.map((item) => item.work_state)).toEqual(['ITEMIZED', 'NEEDS_ORDER']);
    expect(list.progress).toMatchObject({ received: 2, itemized: 1, prepared: 0, needs_order: 1 });
  });

  // Break caught: a parcel the vendor was finished without counted as received, or left out of the worklist so that nothing says it is outstanding.
  it('lists a missing parcel as missing and counts it apart from the received ones', async () => {
    const intake = await opened(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect((await finishAsTapped(officer, intake.id)).status).toBe(200);
    const list = await worklist(officer, intake.id);
    expect(list.progress).toMatchObject({ received: 1, missing: 1, needs_order: 1 });
    const missing = await worklist(officer, intake.id, '?view=missing');
    expect(missing.items.map((item) => [item.parcel?.id, item.work_state])).toEqual([
      [b.id, 'MISSING'],
    ]);
  });

  // Break caught: a blind-count intake that shows no work, or one with a parcel the intake does not have.
  it('lists the orders of an intake counted blind, with no parcel, against the count', async () => {
    const intake = await blind(3);
    orderOf(await itemize(officer, intake.id, body(null)));
    const list = await worklist(officer, intake.id);
    expect(list.receiving_mode).toBe('BLIND_COUNT');
    expect(list.progress).toEqual({
      received: 3,
      awaiting_arrival: 0,
      needs_order: 2,
      prepared: 0,
      itemized: 1,
      payment_required: 0,
      missing: 0,
      orders: 1,
    });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ work_state: 'ITEMIZED', parcel: null });
  });

  // Break caught: a read of another hub's intake, a malformed query answered as a server error, and a reader who does not hold hub.read.
  it('refuses another hub, a malformed query and a reader without the key', async () => {
    const intake = await cleared(1);
    expect(refusal(await otherHub.client.get(ORDERS(intake.id)))[1]).toBe('HUB_SCOPE_VIOLATION');
    expect((await officer.client.get(ORDERS(randomUUID()))).status).toBe(404);
    for (const query of [
      '?view=bogus',
      '?page_size=0',
      '?page_size=abc',
      '?page_size=1000',
      '?page_token=not-a-token',
    ]) {
      const refused = await officer.client.get(`${ORDERS(intake.id)}${query}`);
      expect([query, refused.status, (refused.json() as { code?: string }).code]).toEqual([
        query,
        400,
        'VALIDATION_FAILED',
      ]);
    }
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    expect(refusal(await finance.client.get(ORDERS(intake.id)))[1]).toBe('PERMISSION_DENIED');
  });

  // Break caught: a close read that says "closed" with a received parcel unordered; no named parcel; payment clearance implied; a number a screen must compute.
  it('says what a close would find: the parcels still without an order, the exception, and that payment is still owed', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    let found = await closure(officer, intake.id);
    expect(found).toMatchObject({
      intake_state: 'ITEMIZING',
      received: 2,
      ordered: 1,
      unpriced: 0,
      outstanding_count: 1,
      can_close: false,
      needs_exception: true,
      blockers: [],
      payment_still_required: false,
    });
    expect(found.outstanding_parcels.map((parcel) => parcel.parcel_id)).toEqual([b.id]);
    orderOf(await itemize(officer, intake.id, body(b.id, payFull)));
    found = await closure(officer, intake.id);
    expect(found).toMatchObject({
      ordered: 2,
      outstanding_count: 0,
      payment_required: 1,
      can_close: true,
      needs_exception: false,
      payment_still_required: true,
    });
    expect(found.outstanding_parcels).toEqual([]);
    const closed = await officer.client.post(`${ONE(intake.id)}/close`, undefined, {
      origin: OPS,
      headers: {
        'If-Match': (await read(officer, intake.id)).etag,
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(closed.status, closed.text).toBe(200);
    found = await closure(officer, intake.id);
    expect(found).toMatchObject({
      intake_state: 'CLOSED',
      can_close: false,
      blockers: ['intake_not_ready'],
      payment_still_required: true,
    });
    expect(found.closed_at).not.toBeNull();
  });

  // Break caught: an intake whose check-in is open offered a close.
  it('refuses to offer a close while the vendor is still being checked in', async () => {
    const intake = await opened(1);
    expect(await closure(officer, intake.id)).toMatchObject({
      can_close: false,
      needs_exception: false,
      blockers: ['intake_not_ready'],
    });
    expect(refusal(await otherHub.client.get(`${ONE(intake.id)}/closure`))[1]).toBe(
      'HUB_SCOPE_VIOLATION',
    );
    expect((await officer.client.get(`${ONE(randomUUID())}/closure`)).status).toBe(404);
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    expect(refusal(await finance.client.get(`${ONE(intake.id)}/closure`))[1]).toBe(
      'PERMISSION_DENIED',
    );
  });
});

describe('the reads of a payer correction (the review of 19 November 2026, finding A)', () => {
  interface Correction {
    readonly id: string;
    readonly order_id: string;
    readonly order_code: string;
    readonly state: string;
    readonly requested_by: string;
    readonly requested_by_name: string | null;
    readonly approved_by: string | null;
    readonly approved_by_name: string | null;
    readonly total: { amount_minor: number; currency: string };
    readonly previous_allocation: { sender_minor: number; recipient_minor: number };
    readonly proposed_allocation: { sender_minor: number; recipient_minor: number };
    readonly proposed_commercial_state: string;
    readonly order_commercial_state: string | null;
    readonly resulting_allocation: { sender_minor: number; recipient_minor: number } | null;
    readonly resulting_commercial_state: string | null;
  }
  const CORRECTIONS = `${API}/payer-corrections`;
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  const frozen = async (intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL'): Promise<Order> => {
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
  const ask = async (orderId: string, proposed: Record<string, unknown>): Promise<TestResponse> => {
    const etag = (await officer.client.get(ORDER(orderId))).header('etag') ?? '';
    return officer.client.post(
      `${ORDER(orderId)}/payer-correction`,
      { proposed, note: 'The vendor agreed on the phone' },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );
  };

  // Break caught: a checker with no way to open the request after a reload; a proposal the reader must work out; a history that forgets what was approved; an ETag that is not the one the decision takes.
  it('lets the checker find a pending correction, read it in actual amounts with its ETag, decide it, and read what was approved', async () => {
    const made = await frozen('RECIPIENT_PAYS');
    const asked = await ask(made.id, { payer_intent: 'SENDER_PAYS_FULL' });
    expect(asked.status, asked.text).toBe(201);
    const askedBody = asked.json() as Correction;
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);

    const queue = await senior.client.get(CORRECTIONS);
    expect(queue.status, queue.text).toBe(200);
    const queued = (queue.json() as { items: Correction[] }).items.find(
      (item) => item.id === askedBody.id,
    );
    expect(queued).toMatchObject({
      order_id: made.id,
      order_code: made.code,
      state: 'REQUESTED',
      total: { amount_minor: 3500, currency: 'GHS' },
      previous_allocation: { sender_minor: 0, recipient_minor: 3500 },
      proposed_allocation: { sender_minor: 3500, recipient_minor: 0 },
      proposed_commercial_state: 'PAYMENT_REQUIRED',
      order_commercial_state: 'NO_VENDOR_CHARGE',
      requested_by: officer.identity.id,
      resulting_allocation: null,
    });
    expect(typeof queued?.requested_by_name).toBe('string');

    const opened = await senior.client.get(`${CORRECTIONS}/${askedBody.id}`);
    expect(opened.status, opened.text).toBe(200);
    // The ETag the decision takes is the one the maker was given and the one a reload gives: stable across readers.
    expect(opened.header('etag')).toBe(asked.header('etag'));
    const decided = await senior.client.post(
      `${CORRECTIONS}/${askedBody.id}/decision`,
      { decision: 'APPROVE' },
      {
        origin: OPS,
        headers: { 'If-Match': opened.header('etag') ?? '', 'Idempotency-Key': randomUUID() },
      },
    );
    expect(decided.status, decided.text).toBe(200);

    const after = (await senior.client.get(`${CORRECTIONS}/${askedBody.id}`)).json() as Correction;
    expect(after).toMatchObject({
      state: 'APPROVED',
      approved_by: senior.identity.id,
      resulting_allocation: { sender_minor: 3500, recipient_minor: 0 },
      resulting_commercial_state: 'PAYMENT_REQUIRED',
      total: { amount_minor: 3500 },
    });
    expect(typeof after.approved_by_name).toBe('string');
    const idsOf = async (query: string): Promise<string[]> =>
      (
        (await senior.client.get(`${CORRECTIONS}${query}`)).json() as { items: Correction[] }
      ).items.map((item) => item.id);
    expect(await idsOf('')).not.toContain(askedBody.id);
    expect(await idsOf('?state=APPROVED')).toContain(askedBody.id);
    expect(await idsOf('?state=all')).toContain(askedBody.id);
    expect(await idsOf(`?state=all&order_id=${made.id}`)).toEqual([askedBody.id]);
  });

  // Break caught: a percentage left for the reader to work out; a split shown with a wrong rounding.
  it('resolves a split into the amounts of the locked price before anyone decides it', async () => {
    const made = await frozen('RECIPIENT_PAYS');
    const asked = await ask(made.id, {
      payer_intent: 'SPLIT',
      split_basis: 'PERCENTAGE',
      split_sender_percentage: 50,
    });
    expect(asked.status, asked.text).toBe(201);
    const detail = asked.json() as Correction;
    expect(detail.proposed_allocation).toEqual({ sender_minor: 1750, recipient_minor: 1750 });
    expect(detail.proposed_commercial_state).toBe('PAYMENT_REQUIRED');
    const zero = await ask((await frozen('SENDER_PAYS_FULL')).id, {
      payer_intent: 'RECIPIENT_PAYS',
    });
    expect((zero.json() as Correction).proposed_commercial_state).toBe('NO_VENDOR_CHARGE');
  });

  // Break caught: a page of corrections that skips or repeats one, or a queue that is not oldest first.
  it('pages the queue oldest first, each correction once, with the token of the page', async () => {
    const first = (
      await ask((await frozen('RECIPIENT_PAYS')).id, { payer_intent: 'SENDER_PAYS_FULL' })
    ).json() as Correction;
    const second = (
      await ask((await frozen('RECIPIENT_PAYS')).id, { payer_intent: 'SENDER_PAYS_FULL' })
    ).json() as Correction;
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const response = await senior.client.get(
        `${CORRECTIONS}?page_size=1${token === null ? '' : `&page_token=${token}`}`,
      );
      const page = response.json() as { items: Correction[]; next_page_token: string | null };
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((item) => item.id));
      token = page.next_page_token;
      pages += 1;
    } while (token !== null && pages < 50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.indexOf(first.id)).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf(first.id)).toBeLessThan(seen.indexOf(second.id));
  });

  // Break caught: a correction of another hub opened by an officer who is not in it, a reader without the key, a malformed query answered as a server error.
  it('refuses another hub, a reader without the key and a malformed query', async () => {
    const made = await frozen('RECIPIENT_PAYS');
    const asked = (await ask(made.id, { payer_intent: 'SENDER_PAYS_FULL' })).json() as Correction;
    expect(refusal(await otherHub.client.get(`${CORRECTIONS}/${asked.id}`))[1]).toBe(
      'HUB_SCOPE_VIOLATION',
    );
    expect(
      ((await otherHub.client.get(CORRECTIONS)).json() as { items: Correction[] }).items.map(
        (item) => item.id,
      ),
    ).not.toContain(asked.id);
    // A hub outside the grant is an empty page, whatever it holds.
    expect((await officer.client.get(`${CORRECTIONS}?hub_id=${HUB_B}&state=all`)).json()).toEqual({
      items: [],
      next_page_token: null,
    });
    expect((await officer.client.get(`${CORRECTIONS}/${randomUUID()}`)).status).toBe(404);
    for (const query of [
      '?state=bogus',
      '?order_id=1',
      '?hub_id=1',
      '?page_size=0',
      '?page_token=x',
    ]) {
      expect([query, (await officer.client.get(`${CORRECTIONS}${query}`)).status]).toEqual([
        query,
        400,
      ]);
    }
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    expect(refusal(await finance.client.get(CORRECTIONS))[1]).toBe('PERMISSION_DENIED');
    expect(refusal(await finance.client.get(`${CORRECTIONS}/${asked.id}`))[1]).toBe(
      'PERMISSION_DENIED',
    );
  });
});

describe('the read of an order is one coherent record (the review of 19 November 2026, finding D)', () => {
  // Break caught: the order read in one statement and its version in another, so that a correction committing between them gives old contents with a new version.
  it('reads the order and its version in one statement', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(only.id)));
    const traced = await routes.kit.trace(() => officer.client.get(`${API}/orders/${made.id}`));
    expect(traced.result.status).toBe(200);
    // One statement reads the order and its version together; none reads the version alone.
    const reads = traced.statements.filter((statement) => statement.includes('"order"'));
    expect(reads.length, reads.join('\n---\n')).toBeGreaterThan(0);
    expect(reads.filter((statement) => /\bversion\b/i.test(statement))).toHaveLength(1);
    expect(
      traced.statements.some((statement) => /select\s+version\s+from\s+"order"/i.test(statement)),
    ).toBe(false);
  });
});

describe('previewOrder: what confirming would give, written nowhere (the review of 19 November 2026, step 3)', () => {
  interface Preview {
    readonly will_confirm: string;
    readonly quote_policy: string;
    readonly price: { total: { amount_minor: number }; components: { kind: string }[] };
    readonly high_value_surcharge: { amount_minor: number } | null;
    readonly delivery: { default_date: string; committed_date: string };
    readonly payer: {
      source: string;
      payer_intent: string;
      sender: { amount_minor: number };
      recipient: { amount_minor: number };
      commercial_state_after_confirmation: string;
    };
  }
  const PREVIEW = (id: string): string => `${ORDERS(id)}/preview`;
  const preview = (actor: Actor, id: string, given: unknown): Promise<TestResponse> =>
    actor.client.post(PREVIEW(id), given, { origin: OPS });
  const orderCount = async (): Promise<number> =>
    Number(
      (await routes.rows<{ n: string }>(`select count(*)::text as n from "order"`))[0]?.n ?? '0',
    );

  // Break caught: a preview that writes an order, that differs from the order it previews, or that is answered for a body the order would refuse.
  it('answers the price, the promise and who pays, writes nothing, and is the order that is then made', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const before = await orderCount();
    const shown = await preview(officer, intake.id, body(a.id));
    expect(shown.status, shown.text).toBe(200);
    const view = shown.json() as Preview;
    expect(view).toMatchObject({
      will_confirm: 'ON_CONFIRMATION',
      quote_policy: 'PROTECTED_UNTIL_AMENDED',
      price: { total: { amount_minor: 3500 } },
      payer: {
        source: 'REQUEST',
        sender: { amount_minor: 0 },
        recipient: { amount_minor: 3500 },
        commercial_state_after_confirmation: 'NO_VENDOR_CHARGE',
      },
    });
    expect(view.price.components.map((component) => component.kind)).toContain(
      'SERVICE_AREA_BASE_FEE',
    );
    expect(await orderCount()).toBe(before);
    // The vendor pays: the preview says who pays what, and the state the gate would take the order to.
    const paying = (
      await preview(
        officer,
        intake.id,
        body(b.id, { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } }),
      )
    ).json() as Preview;
    expect(paying.payer).toMatchObject({
      source: 'ORDER',
      sender: { amount_minor: 3500 },
      recipient: { amount_minor: 0 },
      commercial_state_after_confirmation: 'PAYMENT_REQUIRED',
    });
    // What is previewed is what is made.
    const made = orderOf(await itemize(officer, intake.id, body(a.id)));
    expect(made.locked_price?.amount_minor).toBe(view.price.total.amount_minor);
    expect(made.derived_delivery_date).toBe(view.delivery.default_date);
  });

  // Break caught: a parcel that waits for its arrival previewed as confirmed now.
  it('says an order for a parcel that is still expected is confirmed when its arrival is committed', async () => {
    const intake = await opened(1);
    const [only] = intake.parcels as [Parcel];
    const shown = (await preview(officer, intake.id, body(only.id))).json() as Preview;
    expect(shown.will_confirm).toBe('WHEN_ARRIVAL_IS_COMMITTED');
  });

  // Break caught: a preview that answers where the order would be refused, so that the officer meets the refusal only at the act that cannot be taken back.
  it('refuses as the order would, and to the people the order would refuse', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const noSize = { ...body(only.id) };
    delete (noSize as { size_class?: string }).size_class;
    expect(refusal(await preview(officer, intake.id, noSize))[1]).toBe('SIZE_CLASS_REQUIRED');
    expect(refusal(await preview(officer, intake.id, body(null)))).toEqual([
      400,
      'VALIDATION_FAILED',
      'parcel_required',
    ]);
    orderOf(await itemize(officer, intake.id, body(only.id)));
    expect(refusal(await preview(officer, intake.id, body(only.id)))).toEqual([
      409,
      'STATE_CONFLICT',
      'parcel_ordered',
    ]);
    expect(refusal(await preview(otherHub, intake.id, body(only.id)))[1]).toBe(
      'HUB_SCOPE_VIOLATION',
    );
    expect((await preview(officer, randomUUID(), body(only.id))).status).toBe(404);
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    expect(refusal(await preview(finance, intake.id, body(only.id)))[1]).toBe('PERMISSION_DENIED');
  });
});

describe('amendOrder: an order is prepared before it is confirmed (the review of 19 November 2026, findings B and C)', () => {
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  const etagOfOrder = async (actor: Actor, id: string): Promise<string> => {
    const response = await actor.client.get(ORDER(id));
    expect(response.status, response.text).toBe(200);
    return response.header('etag') ?? '';
  };
  const amend = async (
    actor: Actor,
    id: string,
    given: unknown,
    over: { etag?: string | null; key?: string | null; review?: boolean } = {},
  ): Promise<TestResponse> => {
    const etag = over.etag === undefined ? await etagOfOrder(actor, id) : over.etag;
    return actor.client.request('PATCH', ORDER(id), {
      body: over.review === false ? given : await reviewedAmendment(actor, id, given),
      origin: OPS,
      headers: {
        ...(etag === null ? {} : { 'If-Match': etag }),
        ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
      },
    });
  };
  interface Read extends Order {
    readonly amendments: { note: string; changed: string[] }[];
    readonly reversal: { note: string } | null;
    readonly version?: number;
  }
  const readOrder = async (actor: Actor, id: string): Promise<Read> =>
    (await actor.client.get(ORDER(id))).json() as Read;
  const earlyOrder = async (): Promise<{ intake: Arranged; made: Order; parcel: Parcel }> => {
    const intake = await opened(2);
    const [parcel] = intake.parcels as [Parcel, Parcel];
    return { intake, parcel, made: orderOf(await itemize(officer, intake.id, body(parcel.id))) };
  };

  // Break caught: a wrong phone number noticed before the parcel arrives that no operation can correct; an edit that is not recorded; or one that does not reach the order that is then confirmed.
  it('corrects an order made before its parcel arrived, records it, and the correction is what is then confirmed', async () => {
    const { intake, made } = await earlyOrder();
    expect(made.commercial_state).toBeNull();
    const etag = await etagOfOrder(officer, made.id);
    const amended = await amend(
      officer,
      made.id,
      {
        note: 'The officer mistyped the number from the photo',
        recipient: {
          name: 'Ama Mensah',
          phone: '024 765 4321',
          location: { address: '12 Madina Estate, near the market' },
        },
      },
      { etag },
    );
    expect(amended.status, amended.text).toBe(200);
    const after = amended.json() as Order;
    expect(after.recipient.phone).toBe('+233247654321');
    // The ETag it answers is the one a read gives of the new state, and the old one is stale.
    expect(amended.header('etag')).toBe(await etagOfOrder(officer, made.id));
    expect(amended.header('etag')).not.toBe(etag);
    expect(
      refusal(await amend(officer, made.id, { note: 'again', size_class: 'MEDIUM' }, { etag })),
    ).toEqual([409, 'STATE_CONFLICT', 'stale']);
    // Recorded: who, why and which members (never their values), on the staff read; and in the ledger, enhanced.
    const read = await readOrder(officer, made.id);
    expect(read.amendments).toHaveLength(1);
    expect(read.amendments[0]).toMatchObject({
      note: 'The officer mistyped the number from the photo',
      changed: ['recipient'],
    });
    const events = await routes.rows<{ event_code: string; enhanced: boolean }>(
      `select event_code, enhanced from audit_event where object_id = $1 and event_code = 'order.amendment.recorded'`,
      [made.id],
    );
    expect(events).toEqual([{ event_code: 'order.amendment.recorded', enhanced: true }]);
    // The vendor is finished: the order is confirmed with the corrected recipient and the price it was calculated at.
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    const confirmed = await readOrder(officer, made.id);
    expect(confirmed.recipient.phone).toBe('+233247654321');
    expect(confirmed.locked_price?.amount_minor).toBe(3500);
  });

  // Break caught: the interval between a run that has started and the freeze, where neither the request nor the order can say who pays.
  it('changes who pays for one order before it freezes, and the freeze uses it', async () => {
    const { intake, made } = await earlyOrder();
    const amended = await amend(officer, made.id, {
      note: 'The vendor will pay this one',
      payer_override: { payer_intent: 'SENDER_PAYS_FULL' },
    });
    expect(amended.status, amended.text).toBe(200);
    expect((amended.json() as { payer_override: { payer_intent: string } }).payer_override).toEqual(
      {
        payer_intent: 'SENDER_PAYS_FULL',
      },
    );
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    const confirmed = await readOrder(officer, made.id);
    expect(confirmed.commercial_state).toBe('PAYMENT_REQUIRED');
    expect(confirmed.payer_allocation).toEqual({ sender_minor: 3500, recipient_minor: 0 });
    // And back to the request's own arrangement, with null, while it still waits.
    const other = await earlyOrder();
    await amend(officer, other.made.id, {
      note: 'asked',
      payer_override: { payer_intent: 'SENDER_PAYS_FULL' },
    });
    const cleared_ = await amend(officer, other.made.id, {
      note: 'asked again',
      payer_override: null,
    });
    expect(cleared_.status, cleared_.text).toBe(200);
    expect((cleared_.json() as { payer_override: unknown }).payer_override).toBeNull();
  });

  // Break caught: an edit that is not a reason, that changes nothing, that is replayed twice, or that is let in for a confirmed order.
  it('needs a reason and a change, makes nothing twice, and never edits a confirmed order', async () => {
    const { intake, made } = await earlyOrder();
    expect(refusal(await amend(officer, made.id, { note: '   ', size_class: 'MEDIUM' }))[1]).toBe(
      'REASON_REQUIRED',
    );
    const unchanged = await amend(officer, made.id, { note: 'nothing', size_class: 'SMALL' });
    expect(refusal(unchanged)).toEqual([400, 'VALIDATION_FAILED', 'no_change']);
    const key = randomUUID();
    const etag = await etagOfOrder(officer, made.id);
    // A retry sends the request it sent: the same body, with the token it was given.
    const sent = await reviewedAmendment(officer, made.id, { note: 'larger', size_class: 'LARGE' });
    const first = await amend(officer, made.id, sent, { etag, key, review: false });
    expect(first.status, first.text).toBe(200);
    const replay = await amend(officer, made.id, sent, { etag, key, review: false });
    expect(replay.status).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await readOrder(officer, made.id)).amendments).toHaveLength(1);
    // A body that is not an amendment: a price is never accepted.
    expect(
      refusal(
        await amend(officer, made.id, {
          note: 'x',
          locked_price: { amount_minor: 1, currency: 'GHS' },
        }),
      )[1],
    ).toBe('VALIDATION_FAILED');
    // Confirmed: the vendor is finished.
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    expect(
      refusal(await amend(officer, made.id, { note: 'too late', size_class: 'MEDIUM' })),
    ).toEqual([409, 'STATE_CONFLICT', 'order_confirmed']);
    // An order made for an arrived parcel is confirmed when it is made.
    const [, b] = intake.parcels as [Parcel, Parcel];
    const second = orderOf(await itemize(officer, intake.id, body(b.id)));
    expect(
      refusal(await amend(officer, second.id, { note: 'too late', size_class: 'MEDIUM' }))[2],
    ).toBe('order_confirmed');
  });

  // Break caught: an edit by an officer outside the hub, by one who does not hold the key, or one that writes the content of an order with no record behind it.
  it('is for the officers of the hub who itemize, and the database holds it for every writer', async () => {
    const { intake, made } = await earlyOrder();
    expect(
      refusal(
        await amend(
          otherHub,
          made.id,
          { note: 'x', size_class: 'MEDIUM' },
          { etag: await etagOfOrder(officer, made.id) },
        ),
      )[1],
    ).toBe('HUB_SCOPE_VIOLATION');
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    expect(
      refusal(
        await amend(
          finance,
          made.id,
          { note: 'x', size_class: 'MEDIUM' },
          { etag: await etagOfOrder(officer, made.id) },
        ),
      )[1],
    ).toBe('PERMISSION_DENIED');
    expect(
      (await amend(officer, randomUUID(), { note: 'x', size_class: 'MEDIUM' }, { etag: '"AAAA"' }))
        .status,
    ).toBe(404);
    // No other writer can change what was transcribed, nor the promise, without the record of an amendment.
    for (const change of [
      `update "order" set size_class = 'LARGE' where id = $1`,
      `update "order" set recipient = jsonb_set(recipient, '{name}', '"Someone Else"') where id = $1`,
      `update delivery_commitment set committed_date = committed_date + 1 where order_id = $1`,
    ]) {
      await expect(routes.admin.query(change, [made.id]), change).rejects.toMatchObject({
        code: '23514',
      });
    }
    expect((await readOrder(officer, made.id)).size_class).toBe('SMALL');
    expect(await intakeState(intake.id)).toBe('AWAITING_COUNT');
  });
});

describe('reverseOrderArrival: a mistaken arrival is corrected, never erased (the review of 19 November 2026, finding E)', () => {
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  const senior = async (): Promise<Actor> => routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  const reverse = async (
    actor: Actor,
    id: string,
    given: unknown,
    over: { etag?: string | null; key?: string | null } = {},
  ): Promise<TestResponse> => {
    const etag =
      over.etag === undefined
        ? ((await actor.client.get(ORDER(id))).header('etag') ?? '')
        : over.etag;
    return actor.client.post(`${ORDER(id)}/arrival-reversal`, given, {
      origin: OPS,
      headers: {
        ...(etag === null ? {} : { 'If-Match': etag }),
        ...(over.key === null ? {} : { 'Idempotency-Key': over.key ?? randomUUID() }),
      },
    });
  };
  const parcelState = async (id: string): Promise<string | undefined> =>
    (await routes.rows<{ state: string }>(`select state from intake_parcel where id = $1`, [id]))[0]
      ?.state;

  // Break caught: a reversal that erases the order or its price, that leaves the parcel present, that leaves the count as it was, or that leaves the intake itemizing over a parcel that is not there.
  it('keeps the order and its price, takes the parcel back, recomputes the count and returns the intake to reconciliation', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const first = orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id)));
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    const boss = await senior();
    const reversed = await reverse(boss, first.id, { note: 'The parcel was never on the table' });
    expect(reversed.status, reversed.text).toBe(200);
    expect(reversed.json()).toMatchObject({
      order_id: first.id,
      intake_id: intake.id,
      parcel_id: a.id,
      commercial_state: 'REVERSED',
      previous_commercial_state: 'NO_VENDOR_CHARGE',
      parcel_state: 'MISSING',
      previous_intake_state: 'ITEMIZING',
      intake_state: 'RECONCILIATION_REQUIRED',
      received_before: 2,
      received_after: 1,
    });
    expect(await parcelState(a.id)).toBe('MISSING');
    expect(await intakeState(intake.id)).toBe('RECONCILIATION_REQUIRED');
    // The order keeps its locked price, its portions and its trail.
    const kept = (await boss.client.get(ORDER(first.id))).json() as Order & {
      reversal: { note: string } | null;
    };
    expect(kept).toMatchObject({
      commercial_state: 'REVERSED',
      locked_price: { amount_minor: 3500 },
      payer_allocation: { sender_minor: 0, recipient_minor: 3500 },
    });
    expect(kept.reversal?.note).toBe('The parcel was never on the table');
    // The worklist and the close tell the truth about it.
    const list = (await officer.client.get(ORDERS(intake.id))).json() as {
      progress: Record<string, number>;
      items: { work_state: string }[];
    };
    expect(list.progress).toMatchObject({ received: 1, missing: 1, itemized: 1, orders: 1 });
    expect(list.items.map((item) => item.work_state)).toEqual(['MISSING', 'ITEMIZED']);
    const events = await routes.rows<{ event_code: string; enhanced: boolean }>(
      `select event_code, enhanced from audit_event where object_id = $1 and event_code = 'order.arrival.reversed'`,
      [first.id],
    );
    expect(events).toEqual([{ event_code: 'order.arrival.reversed', enhanced: true }]);
    // A parcel that is found again may be ordered afresh once the case is closed: the reversed order is history and does not hold the parcel (the key is on the orders that stand).
    const key = await routes.rows<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'order_parcel_key'`,
    );
    expect(key[0]?.indexdef).toMatch(/WHERE.*REVERSED/);
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect(await parcelState(a.id)).toBe('ARRIVED');
    // The case is still open, so the found parcel waits to be ordered: the intake is not cleared.
    expect(refusal(await itemize(officer, intake.id, body(a.id)))[2]).toBe('reconciliation_open');
  });

  // Break caught: a reversal by Ops Staff, for a stale view, with no reason, twice, for an order that was never confirmed, for a closed intake or a blind count.
  it('is the senior’s, with a reason, once, and only while nothing downstream has happened', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(a.id)));
    const boss = await senior();
    expect(refusal(await reverse(officer, made.id, { note: 'x' }))[1]).toBe('PERMISSION_DENIED');
    expect(refusal(await reverse(boss, made.id, { note: '  ' }))[1]).toBe('REASON_REQUIRED');
    expect(refusal(await reverse(boss, made.id, { note: 'x' }, { etag: '"AAAA"' }))).toEqual([
      409,
      'STATE_CONFLICT',
      'stale',
    ]);
    expect(refusal(await reverse(otherHub, made.id, { note: 'x' }))[1]).toBe('PERMISSION_DENIED');
    expect((await reverse(boss, randomUUID(), { note: 'x' }, { etag: '"AAAA"' })).status).toBe(404);
    // A payer correction waiting for its decision holds the order.
    const corrected = await officer.client.post(
      `${ORDER(made.id)}/payer-correction`,
      { proposed: { payer_intent: 'SENDER_PAYS_FULL' }, note: 'The vendor will pay' },
      {
        origin: OPS,
        headers: {
          'If-Match': (await officer.client.get(ORDER(made.id))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(corrected.status, corrected.text).toBe(201);
    const held = await reverse(boss, made.id, { note: 'x' });
    expect(refusal(held)[2], held.text).toBe('correction_open');
    // An order that is not confirmed has no arrival to reverse: it is amended.
    const waiting = await opened(1);
    const [only] = waiting.parcels as [Parcel];
    const early = orderOf(await itemize(officer, waiting.id, body(only.id)));
    expect(refusal(await reverse(boss, early.id, { note: 'x' }))[2]).toBe('order_not_confirmed');
    // Once, and not in a closed intake.
    const second = orderOf(await itemize(officer, intake.id, body(b.id)));
    expect((await reverse(boss, second.id, { note: 'The wrong parcel was ticked' })).status).toBe(
      200,
    );
    expect(refusal(await reverse(boss, second.id, { note: 'again' }))[2]).toBe('already_reversed');
    const closedIntake = await cleared(1);
    const [lone] = closedIntake.parcels as [Parcel];
    const lastOrder = orderOf(await itemize(officer, closedIntake.id, body(lone.id)));
    const closed = await officer.client.post(`${ONE(closedIntake.id)}/close`, undefined, {
      origin: OPS,
      headers: {
        'If-Match': (await read(officer, closedIntake.id)).etag,
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(closed.status, closed.text).toBe(200);
    expect(refusal(await reverse(boss, lastOrder.id, { note: 'too late' }))[2]).toBe(
      'intake_closed',
    );
    const blindIntake = await blind(2);
    const blindOrder = orderOf(await itemize(officer, blindIntake.id, body(null)));
    expect(refusal(await reverse(boss, blindOrder.id, { note: 'x' }))[2]).toBe(
      'blind_count_intake',
    );
  });

  // Break caught: a writer who moves the order, the parcel or the intake the way a reversal does, with no record of one.
  it('is held by the database for every writer: the record of the reversal must stand beside each move', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(only.id)));
    for (const change of [
      `update "order" set commercial_state = 'REVERSED' where id = '${made.id}'`,
      `update intake_parcel set state = 'MISSING' where id = '${only.id}'`,
      `update pickup_intake set state = 'RECONCILIATION_REQUIRED' where id = '${intake.id}'`,
    ]) {
      await expect(routes.admin.query(change), change).rejects.toMatchObject({ code: '23514' });
    }
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    expect(await parcelState(only.id)).toBe('ARRIVED');
  });
});

describe('the completion of an intake is told in the transaction of the close (OB-S1-143)', () => {
  const envelopes = (requestId: string) =>
    routes.rows<{
      event_type: string;
      aggregate_type: string;
      operation_id: string;
      originating_principal_type: string;
      payload: { intake?: string };
    }>(
      `select event_type, aggregate_type, operation_id, originating_principal_type, payload from outbox where aggregate_id = $1 and event_type = 'intake.completed'`,
      [requestId],
    );

  // Break caught: a close that leaves no message for the sender or the vendor, one that writes it twice, or one that writes it for a close that was refused.
  it('writes one envelope for the request when the intake is closed, and none for a close that is refused', async () => {
    const refused = await cleared(2);
    const [first] = refused.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, refused.id, body(first.id)));
    const short = await officer.client.post(`${ONE(refused.id)}/close`, undefined, {
      origin: OPS,
      headers: {
        'If-Match': (await read(officer, refused.id)).etag,
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(refusal(short)[1]).toBe('PARITY_NOT_MET');
    expect(await envelopes(refused.requestId)).toEqual([]);

    const done = await cleared(1);
    const [only] = done.parcels as [Parcel];
    orderOf(
      await itemize(
        officer,
        done.id,
        body(only.id, { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } }),
      ),
    );
    const key = randomUUID();
    const etag = (await read(officer, done.id)).etag;
    const closed = await officer.client.post(`${ONE(done.id)}/close`, undefined, {
      origin: OPS,
      headers: { 'If-Match': etag, 'Idempotency-Key': key },
    });
    expect(closed.status, closed.text).toBe(200);
    // The same close again, with the same key, replays the answer and writes nothing more.
    const replay = await officer.client.post(`${ONE(done.id)}/close`, undefined, {
      origin: OPS,
      headers: { 'If-Match': etag, 'Idempotency-Key': key },
    });
    expect(replay.status).toBe(200);
    const rows = await envelopes(done.requestId);
    expect(rows).toEqual([
      {
        event_type: 'intake.completed',
        aggregate_type: 'PICKUP_REQUEST',
        operation_id: 'closeHubIntake',
        originating_principal_type: 'STAFF',
        payload: { intake: done.id },
      },
    ]);
  });
});

describe('a parcel that is found again after its arrival was reversed is ordered afresh (the review of 19 November 2026, finding E)', () => {
  const ORDER = (id: string): string => `${API}/orders/${id}`;

  // Break caught: the reversed order still counted as the parcel's order, so that the close finds more orders than parcels, the vendor is shown an order that was taken back, or the parcel can never be ordered again.
  it('keeps the reversed order as history: the parcel is ordered again, the close finds parity, and the vendor never sees the reversed order', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const first = orderOf(await itemize(officer, intake.id, body(a.id)));
    const kept = orderOf(await itemize(officer, intake.id, body(b.id)));
    const boss = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const reversed = await boss.client.post(
      `${ORDER(first.id)}/arrival-reversal`,
      { note: 'The wrong parcel was ticked' },
      {
        origin: OPS,
        headers: {
          'If-Match': (await boss.client.get(ORDER(first.id))).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(reversed.status, reversed.text).toBe(200);
    // It was there after all: found while the case is open.
    expect((await tap(officer, a.id, true)).status).toBe(200);
    let list = (await officer.client.get(ORDERS(intake.id))).json() as {
      progress: Record<string, number>;
      items: {
        work_state: string;
        order: { id: string } | null;
        reversed_order: { id: string } | null;
      }[];
    };
    // The reversed order is shown as history beside a parcel that has none that stands.
    expect(list.items[0]).toMatchObject({
      work_state: 'NEEDS_ORDER',
      order: null,
      reversed_order: { id: first.id },
    });
    expect(list.progress).toMatchObject({ received: 2, needs_order: 1, orders: 1 });
    // The senior accepts the count: the case is closed, and the parcel is ordered afresh.
    const cleared_ = await boss.client.post(
      `${ONE(intake.id)}/discrepancy`,
      { outcome: 'ACCEPTED', note: 'The parcel was found on the table' },
      { origin: OPS, headers: { 'If-Match': (await read(boss, intake.id)).etag } },
    );
    expect(cleared_.status, cleared_.text).toBe(200);
    const again = orderOf(await itemize(officer, intake.id, body(a.id)));
    expect(again.id).not.toBe(first.id);
    expect(again.commercial_state).toBe('NO_VENDOR_CHARGE');
    list = (await officer.client.get(ORDERS(intake.id))).json() as typeof list;
    expect(list.items[0]).toMatchObject({
      work_state: 'ITEMIZED',
      order: { id: again.id },
      reversed_order: { id: first.id },
    });
    expect(list.progress).toMatchObject({ received: 2, itemized: 2, needs_order: 0, orders: 2 });
    // The close counts the orders that stand: two orders for two parcels, the reversed one not among them.
    const assessed = (await officer.client.get(`${ONE(intake.id)}/closure`)).json() as {
      ordered: number;
      can_close: boolean;
    };
    expect(assessed).toMatchObject({ ordered: 2, can_close: true });
    const closed = await officer.client.post(`${ONE(intake.id)}/close`, undefined, {
      origin: OPS,
      headers: {
        'If-Match': (await read(officer, intake.id)).etag,
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(closed.status, closed.text).toBe(200);
    // The vendor is shown the orders that stand and none that was taken back.
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    const summary = await browser.get(`${ONE(intake.id)}/summary`);
    expect(summary.status, summary.text).toBe(200);
    const ids = (summary.json() as { orders: { id: string }[] }).orders.map((order) => order.id);
    expect(ids.toSorted()).toEqual([again.id, kept.id].toSorted());
    expect(ids).not.toContain(first.id);
    // Nor does the vendor read the order that was taken back by its identifier (the review of 20 November 2026): to the vendor it does not exist; the staff's read says what happened.
    expect((await browser.get(`${API}/orders/${first.id}`)).status).toBe(404);
    expect((await readOrderView(boss, first.id)).commercial_state).toBe('REVERSED');
    expect((await browser.get(`${API}/orders/${again.id}`)).status).toBe(200);
  });
});

// ---- THE REVIEW OF 20 NOVEMBER 2026 ------------------------------------------------------------------------------------------------------------------------------------------------

/** The work a test waits for, or a failure that says it never started: for the race tests, which start an operation inside a `try` and wait for it after it. */
const started = <T>(work: Promise<T> | undefined): Promise<T> =>
  work ?? Promise.reject(new Error('the work under test did not start'));

/**
 * A lock on the audit table that a test holds so that an operation stops part-way: the audit write is the last thing an act does, after it has locked and written its rows, so an act held there still
 * holds every row it took. The test starts the second operation, sees it wait for the first, and lets go.
 */
async function holdingTheAuditTable(): Promise<{
  readonly client: ReturnType<typeof clientFor>;
  readonly pid: number;
}> {
  const client = clientFor(routes.database.urlFor('postgres'));
  await client.connect();
  await client.query('begin');
  await client.query('lock table audit_event in share mode');
  return { client, pid: await backendPidOf(client) };
}

describe('a payer edit and the first freeze meet one after the other (the review of 20 November 2026, finding 2)', () => {
  const requestEtag = async (actor: Actor, id: string): Promise<string> => {
    const response = await actor.client.get(`${API}/pickup-requests/${id}`);
    expect(response.status, response.text).toBe(200);
    return response.header('etag') ?? '';
  };
  const edit = (actor: Actor, requestId: string, etag: string): Promise<TestResponse> =>
    actor.client.post(
      `${API}/pickup-requests/${requestId}/amend`,
      { payer: { payer_intent: 'SENDER_PAYS_FULL' }, note: 'The vendor will pay on the phone' },
      { origin: OPS, headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() } },
    );
  const payerOf = async (requestId: string): Promise<string | undefined> =>
    (
      await routes.rows<{ default_payer_intent: string }>(
        `select default_payer_intent from pickup_request where id = $1`,
        [requestId],
      )
    )[0]?.default_payer_intent;

  // Break caught: a freeze that reads the request's payer without the lock the edit holds, so that an order is frozen to the arrangement that the edit, committing a moment later, has just replaced.
  it('makes a freeze that meets an edit in flight wait for it, and freeze with the arrangement the edit left', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const editor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const etag = await requestEtag(editor, intake.requestId);
    const gate = await holdingTheAuditTable();
    let editing: Promise<TestResponse> | undefined;
    let freezing: Promise<TestResponse> | undefined;
    try {
      // The edit has the request, has changed it and waits to write its audit event, so it has not committed.
      editing = edit(editor, intake.requestId, etag);
      const editorPid = await waitForBlockedBackend(
        routes.admin,
        gate.pid,
        'the payer edit',
        editing,
      );
      freezing = itemize(officer, intake.id, body(only.id));
      await waitUntilBlockedBy(routes.admin, editorPid, 'the freeze', freezing);
      await gate.client.query('commit');
    } catch (error) {
      await gate.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([editing, freezing]);
      throw error;
    } finally {
      await gate.client.end();
    }
    expect((await started(editing)).status).toBe(200);
    // The officer had previewed the order before the edit committed: the freeze, which waited for the edit and read the arrangement it left, is not what the officer was shown. It is refused, with the terms
    // as they are now (the sender pays), and nothing is frozen to either arrangement.
    const refused = await started(freezing);
    expect(refusal(refused)).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
    expect(await countOrders(intake.id)).toBe(0);
    const current = (
      refused.json() as {
        details: {
          current_terms: {
            terms_token: string;
            payer: {
              source: string;
              sender: { amount_minor: number };
              commercial_state_after_confirmation: string;
            };
          };
        };
      }
    ).details.current_terms;
    expect(current.payer).toMatchObject({
      source: 'REQUEST',
      sender: { amount_minor: 3500 },
      commercial_state_after_confirmation: 'PAYMENT_REQUIRED',
    });
    // The officer reads them and confirms them: the order freezes with the arrangement the edit left.
    const made = orderOf(
      await itemize(officer, intake.id, body(only.id, { reviewed_terms: current.terms_token })),
    );
    expect(made.payer_allocation).toEqual({ sender_minor: 3500, recipient_minor: 0 });
    expect(made.commercial_state).toBe('PAYMENT_REQUIRED');
  });

  // Break caught: an edit that does not meet a freeze that has read the payer and not yet committed, so that the arrangement changes beside an order already frozen to the one before.
  it('makes an edit that meets a freeze in flight wait for it, and refuse for the price being frozen', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const editor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const etag = await requestEtag(editor, intake.requestId);
    const before = await payerOf(intake.requestId);
    const gate = await holdingTheAuditTable();
    let editing: Promise<TestResponse> | undefined;
    let freezing: Promise<TestResponse> | undefined;
    try {
      // The freeze has read the arrangement and frozen the order, and waits to write its audit event, so it has not committed.
      freezing = itemize(officer, intake.id, body(only.id));
      const freezerPid = await waitForBlockedBackend(
        routes.admin,
        gate.pid,
        'the freeze',
        freezing,
      );
      editing = edit(editor, intake.requestId, etag);
      await waitUntilBlockedBy(routes.admin, freezerPid, 'the payer edit', editing);
      await gate.client.query('commit');
    } catch (error) {
      await gate.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([editing, freezing]);
      throw error;
    } finally {
      await gate.client.end();
    }
    const made = orderOf(await started(freezing));
    expect(made.commercial_state).toBe('NO_VENDOR_CHARGE');
    expect(refusal(await started(editing))).toEqual([409, 'STATE_CONFLICT', 'price_frozen']);
    expect(await payerOf(intake.requestId)).toBe(before);
  });

  // Break caught: the freeze of the orders that waited (the vendor is finished) that reads the arrangement without the lock the edit holds. It has no review of its own and the lock of `melarc.hold_request_payer` is
  // not taken on its way, so the lock of the freeze itself is all that stands between it and the arrangement an edit is changing.
  it('makes the confirmation of the orders that waited meet an edit in flight, and freeze with the arrangement it left', async () => {
    const intake = await opened(1);
    const [only] = intake.parcels as [Parcel];
    const waiting = orderOf(await itemize(officer, intake.id, body(only.id)));
    expect(waiting.locked_price).toBeNull();
    const editor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const etag = await requestEtag(editor, intake.requestId);
    const gate = await holdingTheAuditTable();
    let editing: Promise<TestResponse> | undefined;
    let finishing: Promise<TestResponse> | undefined;
    try {
      editing = edit(editor, intake.requestId, etag);
      const editorPid = await waitForBlockedBackend(
        routes.admin,
        gate.pid,
        'the payer edit',
        editing,
      );
      finishing = finishAllHere(officer, intake.id, 1);
      await waitUntilBlockedBy(routes.admin, editorPid, 'the confirmation', finishing);
      await gate.client.query('commit');
    } catch (error) {
      await gate.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([editing, finishing]);
      throw error;
    } finally {
      await gate.client.end();
    }
    expect((await started(editing)).status).toBe(200);
    const finished = await started(finishing);
    expect(finished.status, finished.text).toBe(200);
    // The quote it held is the price (protected); who pays is the arrangement the edit left.
    expect(await orderRow(waiting.id)).toMatchObject({
      locked_price_minor: 3500,
      commercial_state: 'PAYMENT_REQUIRED',
      payer_allocation: { sender_minor: 3500, recipient_minor: 0 },
    });
  });

  // Break caught: `melarc.hold_request_payer` that holds nothing (a function that says it takes the lock of the freeze and does not), or that is open to a key that does not itemize.
  it('holds the request for share for whoever calls the function, so that an edit that comes meanwhile waits for it, and refuses any other key', async () => {
    const intake = await cleared(1);
    const editor = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const etag = await requestEtag(editor, intake.requestId);
    const context = (key: string) => ({
      ...staffContext([HUB_A]),
      authorizationKey: key,
      correlationId: randomUUID(),
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      held = resolve;
    });
    const transaction = routes.built.service.transactionWithContext(
      context('hub.intake.itemize'),
      async (tx) => {
        await tx.execute(sql`select melarc.hold_request_payer(${intake.id}::uuid)`);
        const pid = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]?.pid;
        held(Number(pid));
        await released;
      },
    );
    let editing: Promise<TestResponse> | undefined;
    try {
      const pid = await holding;
      editing = edit(editor, intake.requestId, etag);
      await waitUntilBlockedBy(routes.admin, pid, 'the payer edit', editing);
    } finally {
      release();
      await transaction;
    }
    expect((await started(editing)).status).toBe(200);
    // A key that does not itemize is not let hold it.
    await expect(
      routes.built.service.transactionWithContext(context('hub.read'), async (tx) => {
        await tx.execute(sql`select melarc.hold_request_payer(${intake.id}::uuid)`);
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // Break caught: the arrangement calculated for the officer before the request is held, so that an edit can commit between what the officer is shown and what is frozen, with a token that still matches.
  it('takes the lock on the arrangement before it calculates who pays, and calculates it before it makes the order', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const reviewed = await reviewedItemization(officer, intake.id, body(only.id));
    const traced = await routes.kit.trace(async () =>
      officer.client.post(ORDERS(intake.id), reviewed, {
        origin: OPS,
        headers: {
          'If-Match': (await read(officer, intake.id)).etag,
          'Idempotency-Key': randomUUID(),
        },
      }),
    );
    expect(traced.result.status, traced.result.text).toBe(201);
    const at = (needle: string): number =>
      traced.statements.findIndex((statement) => statement.includes(needle));
    expect(at('melarc.hold_request_payer')).toBeGreaterThan(-1);
    expect(at('melarc.hold_request_payer')).toBeLessThan(at('melarc.payer_preview'));
    expect(at('melarc.payer_preview')).toBeLessThan(at('melarc.itemize_order'));
    // The rates are compared once both locks are held: the payer's first (the review of 22 November 2026, finding 5).
    const compared = traced.statements.findLastIndex((statement) =>
      statement.includes('hub_configuration_fingerprint'),
    );
    expect(at('melarc.hold_request_payer')).toBeLessThan(compared);
    expect(compared).toBeLessThan(at('melarc.payer_preview'));
  });
});

describe('the read of an order is one snapshot (the review of 20 November 2026, finding 6)', () => {
  // Break caught: an order read in one statement and its history in the next, so that an amendment committed between them is shown as history beside an order that does not have it.
  it('shows the order and its history as they were at one moment when an amendment commits between the two reads', async () => {
    const intake = await opened(1);
    const [only] = intake.parcels as [Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(only.id)));
    const side = clientFor(routes.database.urlFor('postgres'));
    await side.connect();
    let reading: Promise<TestResponse> | undefined;
    try {
      await side.query('begin');
      await side.query('lock table order_amendment in access exclusive mode');
      const pid = await backendPidOf(side);
      reading = officer.client.get(`${API}/orders/${made.id}`);
      await waitUntilBlockedBy(routes.admin, pid, 'the read of the order', reading);
      // While the read waits for the history, another officer's amendment is written and committed (by a writer the guards would refuse: the test plays that officer).
      await side.query('set local session_replication_role = replica');
      await side.query(
        `insert into order_amendment (id, order_id, responsible_hub_id, amended_by, order_version, note, before, after)
         values ($1, $2, $3, $4, 1, 'a size noticed late', '{"size_class":"SMALL"}', '{"size_class":"LARGE"}')`,
        [randomUUID(), made.id, HUB_A, officer.identity.id],
      );
      await side.query(`update "order" set size_class = 'LARGE' where id = $1`, [made.id]);
      await side.query('commit');
    } catch (error) {
      await side.query('rollback').catch(() => undefined);
      await Promise.allSettled([reading]);
      throw error;
    } finally {
      await side.end();
    }
    const response = await started(reading);
    expect(response.status, response.text).toBe(200);
    const shown = response.json() as Order & { amendments: unknown[] };
    // One moment: either the order as it was with no amendment, or the order as it became with its amendment. Never the one beside the other.
    expect(
      shown.amendments.length === 0 ? shown.size_class === 'SMALL' : shown.size_class === 'LARGE',
    ).toBe(true);
  });
});

describe('amendOrder keeps what the officer judged and what the declaration says apart (the review of 20 November 2026, finding 4)', () => {
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  const amend = async (actor: Actor, id: string, given: unknown): Promise<TestResponse> => {
    const read = await actor.client.get(ORDER(id));
    expect(read.status, read.text).toBe(200);
    return actor.client.request('PATCH', ORDER(id), {
      body: await reviewedAmendment(actor, id, given),
      origin: OPS,
      headers: { 'If-Match': read.header('etag') ?? '', 'Idempotency-Key': randomUUID() },
    });
  };
  const acknowledge = (requestId: string) =>
    routes.admin.query(
      `update pickup_request set declared_value_minor = 100000, liability_cap_acknowledged_at = now(),
              liability_cap_snapshot = '{"amount_minor":30000,"setting_key":"liability_cap_amount","effective_version":"UNVERSIONED"}'::jsonb where id = $1`,
      [requestId],
    );
  const place = (address: string) => ({
    name: 'Ama Mensah',
    phone: '024 123 4567',
    location: { address },
  });

  // Break caught: an order that stays high-value, with its evidence still required, after the declaration that made it so is corrected below the band; an officer's own flag lost when a declaration comes and goes; a flag that cannot be withdrawn.
  it('recomputes the status the declaration gives, and keeps the officer’s own flag until the officer withdraws it', async () => {
    const intake = await opened(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    await acknowledge(intake.requestId);
    const evidence = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const declared = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, { declared_value_minor: 90000, evidence_ids: [evidence] }),
      ),
    );
    expect(declared.is_high_value).toBe(true);
    const lowered = await amend(officer, declared.id, {
      note: 'The declaration was mistyped',
      declared_value_minor: 30000,
    });
    expect(lowered.status, lowered.text).toBe(200);
    expect((lowered.json() as Order).is_high_value).toBe(false);

    const second = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const flagged = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { is_high_value: true, evidence_ids: [second] }),
      ),
    );
    expect(flagged.is_high_value).toBe(true);
    // A declaration above the band comes and goes: the officer's own flag is still there.
    expect(
      (await amend(officer, flagged.id, { note: 'declared', declared_value_minor: 90000 })).status,
    ).toBe(200);
    const down = await amend(officer, flagged.id, {
      note: 'declared lower',
      declared_value_minor: 20000,
    });
    expect(down.status, down.text).toBe(200);
    expect((down.json() as Order).is_high_value).toBe(true);
    // The officer withdraws the flag: nothing else makes the parcel high-value.
    const withdrawn = await amend(officer, flagged.id, {
      note: 'not high value after all',
      is_high_value: false,
    });
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect((withdrawn.json() as Order).is_high_value).toBe(false);
  });

  // Break caught: an officer's flag that the database lets stand beside an order that is not high-value, so that "the officer flagged it" and "it is not high-value" are both on one row.
  it('holds, for every writer, that the officer’s flag makes the order high-value', async () => {
    const intake = await opened(1);
    const [parcel] = intake.parcels as [Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(parcel.id)));
    expect(await orderManualFlag(made.id)).toBe(false);
    await routes.admin.query('begin');
    try {
      // With the triggers put aside, so that only the constraint is asked.
      await routes.admin.query('set local session_replication_role = replica');
      await expect(
        routes.admin.query(`update "order" set is_high_value_manual = true where id = $1`, [
          made.id,
        ]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'order_manual_flag_is_high_value' });
    } finally {
      await routes.admin.query('rollback');
    }
  });

  // Break caught: a band that moved since the order was made read as the officer's own flag, so that an amendment of something else pins the parcel as high-value for ever; or a flag the officer gave lost when the band moves.
  it('recomputes the status of the declaration under the bands as they are, and a band that moved does not turn it into the officer’s flag', async () => {
    const intake = await opened(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    await acknowledge(intake.requestId);
    const evidence = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const byDeclaration = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, { declared_value_minor: 90000, evidence_ids: [evidence] }),
      ),
    );
    const second = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const byTheOfficer = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { declared_value_minor: 90000, is_high_value: true, evidence_ids: [second] }),
      ),
    );
    expect(byDeclaration.is_high_value).toBe(true);
    expect(byTheOfficer.is_high_value).toBe(true);
    // The owner moves the first band above what was declared.
    const restore = await newSettingVersion('MELARC_HIGH_VALUE_TIERS', '', [
      { above_minor: 150000, surcharge_minor: 1000 },
      { above_minor: 250000, surcharge_minor: 2000 },
    ]);
    try {
      // An amendment of something else recalculates the order under the bands as they are: the declaration no longer makes it high-value, and nothing else did.
      const resized = await amend(officer, byDeclaration.id, {
        note: 'larger',
        size_class: 'MEDIUM',
      });
      expect(resized.status, resized.text).toBe(200);
      expect(resized.json() as Order).toMatchObject({ is_high_value: false });
      expect(await orderManualFlag(byDeclaration.id)).toBe(false);
      // The officer's own flag is the officer's, whatever the bands do.
      const kept = await amend(officer, byTheOfficer.id, { note: 'larger', size_class: 'MEDIUM' });
      expect(kept.status, kept.text).toBe(200);
      expect(kept.json() as Order).toMatchObject({ is_high_value: true });
      expect(await orderManualFlag(byTheOfficer.id)).toBe(true);
    } finally {
      await restore();
    }
  });

  // Break caught: the choice of a zone, justified for one address, priced onto another; or kept against an address the server now places itself.
  it('keeps the choice of a zone for the address it justified and asks again for another address that needs one', async () => {
    const intake = await opened(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    const authorization = { zone_id: ZONE_A.id, note: 'The sender phoned from Madina' };
    const unplaced = place('Plot 7, behind the old cinema');
    const authorized = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, { recipient: unplaced, destination_zone_authorization: authorization }),
      ),
    );
    expect(authorized.destination_zone_resolution).toBe('EXPLICITLY_AUTHORIZED');
    // Another officer's amendment of something else keeps the choice with the address it was made for.
    const sized = await amend(officer, authorized.id, { note: 'larger', size_class: 'MEDIUM' });
    expect(sized.status, sized.text).toBe(200);
    expect((sized.json() as Order).destination_zone_resolution).toBe('EXPLICITLY_AUTHORIZED');
    // The address becomes one the server places: the old choice does not stay attached and refuse the amendment.
    const placed = await amend(officer, authorized.id, {
      note: 'The recipient lives in Madina',
      recipient: place('3 Madina Estate'),
    });
    expect(placed.status, placed.text).toBe(200);
    expect((placed.json() as Order).destination_zone_resolution).toBe('SERVER_RESOLVED');
    // The address becomes another one the server cannot place: the old choice does not follow it, and the officer is asked to choose again.
    const other = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { recipient: unplaced, destination_zone_authorization: authorization }),
      ),
    );
    const moved = await amend(officer, other.id, {
      note: 'Another street',
      recipient: place('Another street nobody has heard of'),
    });
    expect(refusal(moved)).toEqual([422, 'SETTING_MISSING', 'destination_zone_unresolved']);
    const chosen = await amend(officer, other.id, {
      note: 'Another street',
      recipient: place('Another street nobody has heard of'),
      destination_zone_authorization: { zone_id: ZONE_B.id, note: 'The sender phoned from Adenta' },
    });
    expect(chosen.status, chosen.text).toBe(200);
    expect((chosen.json() as Order).destination_zone_snapshot).toMatchObject({
      zone_id: ZONE_B.id,
    });
  });
});

describe('the worklist tells one story (the review of 20 November 2026, finding 5)', () => {
  interface Listed {
    readonly progress: Record<string, number | null>;
    readonly items: { readonly work_state: string }[];
    readonly next_page_token: string | null;
  }
  const worklist = async (actor: Actor, id: string, query = ''): Promise<Listed> => {
    const response = await actor.client.get(`${ORDERS(id)}${query}`);
    expect(response.status, response.text).toBe(200);
    return response.json() as Listed;
  };
  const VIEWS = [
    'needs_order',
    'awaiting_arrival',
    'prepared',
    'itemized',
    'payment_required',
    'missing',
  ] as const;

  // Break caught: a count the screen shows that no view opens, so that "2 still expected" opens a list of one.
  it('has, for each view, a count of the whole intake that is the number of rows that view opens', async () => {
    const intake = await opened(4);
    const [a, , c] = intake.parcels as [Parcel, Parcel, Parcel, Parcel];
    // One parcel expected with an order made early, one expected with none, one arrived with none, one expected with none.
    orderOf(await itemize(officer, intake.id, body(a.id)));
    expect((await tap(officer, c.id, true)).status).toBe(200);
    const whole = await worklist(officer, intake.id, '?page_size=100');
    expect(whole.progress).toMatchObject({ awaiting_arrival: 3, needs_order: 1, prepared: 1 });
    for (const view of VIEWS) {
      const opened_ = await worklist(officer, intake.id, `?view=${view}&page_size=100`);
      expect(opened_.items, view).toHaveLength(Number(whole.progress[view]));
    }
    // The finish confirms the early order and marks the rest missing: the same holds.
    expect((await finishAsTapped(officer, intake.id)).status).toBe(200);
    const after = await worklist(officer, intake.id, '?page_size=100');
    for (const view of VIEWS) {
      const opened_ = await worklist(officer, intake.id, `?view=${view}&page_size=100`);
      expect(opened_.items, view).toHaveLength(Number(after.progress[view]));
    }
  });

  // Break caught: "0 received" for a blind count nobody has committed, which reads as a shortage of every parcel.
  it('does not say that nothing was received by a blind count that is not committed', async () => {
    const done = await handOver(routes, vendor, days, { collected: [3], declared: [3] });
    const id = done.intakes[0]?.id ?? '';
    const list = await worklist(officer, id);
    expect(list.progress.received).toBeNull();
    expect(list.progress.needs_order).toBeNull();
    const assessed = (await officer.client.get(`${ONE(id)}/closure`)).json() as {
      received: number | null;
      outstanding_count: number | null;
      can_close: boolean;
    };
    expect(assessed.received).toBeNull();
    expect(assessed.outstanding_count).toBeNull();
    expect(assessed.can_close).toBe(false);
  });

  // Break caught: an intake of more than a hundred parcels that a screen cannot work through: a count that is a page's, a page that skips or repeats a parcel, a list of the parcels that are outstanding cut off at the
  // hundred that the close names with nothing to reach the rest, or a cap on the parcels or the photos of an intake.
  it('stays workable for an intake of more than a hundred parcels, a page at a time', async () => {
    const intake = await cleared(130);
    expect(intake.parcels).toHaveLength(130);
    const first = await worklist(officer, intake.id, '?view=needs_order&page_size=100');
    expect(first.progress).toMatchObject({ received: 130, needs_order: 130, orders: 0 });
    expect(first.items).toHaveLength(100);
    expect(first.next_page_token).not.toBeNull();
    const second = await worklist(
      officer,
      intake.id,
      `?view=needs_order&page_size=100&page_token=${first.next_page_token ?? ''}`,
    );
    expect(second.items).toHaveLength(30);
    expect(second.next_page_token).toBeNull();
    const seen = [...first.items, ...second.items].map(
      (item) => (item as unknown as { parcel: { id: string } }).parcel.id,
    );
    expect(new Set(seen).size).toBe(130);
    // The close names a hundred and says how many there are; the rest is the worklist's, which has just been paged through.
    const assessed = (await officer.client.get(`${ONE(intake.id)}/closure`)).json() as {
      outstanding_count: number;
      outstanding_parcels: unknown[];
      assessment_token: string;
    };
    expect(assessed.outstanding_count).toBe(130);
    expect(assessed.outstanding_parcels).toHaveLength(100);
    // An order for a parcel that is not among the hundred named moves what the senior read all the same.
    const last = present(intake.parcels, intake.parcels.length - 1);
    orderOf(await itemize(officer, intake.id, body(last.id)));
    const after = (await officer.client.get(`${ONE(intake.id)}/closure`)).json() as {
      outstanding_count: number;
      outstanding_parcels: unknown[];
      assessment_token: string;
    };
    expect(after.outstanding_count).toBe(129);
    expect(after.assessment_token).not.toBe(assessed.assessment_token);
  }, 120_000);
});

describe('the officer saves what the officer was shown (the review of 20 November 2026, finding 3)', () => {
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  interface Preview {
    readonly terms_token: string;
    readonly status: string;
    readonly order_id: string | null;
    readonly order_version: number | null;
    readonly will_confirm: string;
    readonly validation: { evidence: string };
    readonly price: { total: { amount_minor: number } };
    readonly current: { total: { amount_minor: number }; is_high_value: boolean } | null;
    readonly payer: {
      sender: { amount_minor: number };
      commercial_state_after_confirmation: string;
    };
  }
  const previewOf = (actor: Actor, intakeId: string, given: unknown): Promise<TestResponse> =>
    actor.client.post(`${ONE(intakeId)}/orders/preview`, given, { origin: OPS });
  const amendmentPreview = (actor: Actor, orderId: string, given: unknown): Promise<TestResponse> =>
    actor.client.post(`${ORDER(orderId)}/amendment-preview`, given, { origin: OPS });
  const amendRaw = async (actor: Actor, orderId: string, given: unknown): Promise<TestResponse> =>
    actor.client.request('PATCH', ORDER(orderId), {
      body: given,
      origin: OPS,
      headers: {
        'If-Match': (await actor.client.get(ORDER(orderId))).header('etag') ?? '',
        'Idempotency-Key': randomUUID(),
      },
    });
  /**
   * The base fee of the hub's service area goes up to GH₵40 for what is calculated from now on (a new version, as the owner changes a rate); the answer puts it back.
   */
  const raiseBaseFee = async (): Promise<() => Promise<void>> => {
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    const made = await routes.admin.query<{ id: string }>(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
       select gen_random_uuid(), hub_id, setting_key, scope_ref, version + 1, jsonb_set(value, '{amount_minor}', '4000'::jsonb), unit, clock_timestamp() - interval '1 second', created_by
         from hub_setting where hub_id = $1 and setting_key = 'service_area_base_fee' and scope_ref = 'ACCRA_TEMA' order by version desc limit 1
       returning id`,
      [HUB_A],
    );
    await routes.admin.query('commit');
    const id = made.rows[0]?.id;
    return async () => {
      await routes.admin.query('begin');
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query('delete from hub_setting where id = $1', [id]);
      await routes.admin.query('commit');
    };
  };

  // Break caught: a save that is not the officer's reading of anything: no token needed, so that an order is made on terms nobody was shown.
  it('requires, of every save, the token of its preview, and of an amendment its reason', async () => {
    const whole = await cleared(1);
    const [only] = whole.parcels as [Parcel];
    expect(
      firstViolation(await itemize(officer, whole.id, body(only.id), { review: false })),
    ).toEqual([400, '/reviewed_terms', 'required']);
    expect(await countOrders(whole.id)).toBe(0);
    const early = await opened(1);
    const [parcel] = early.parcels as [Parcel];
    const made = orderOf(await itemize(officer, early.id, body(parcel.id)));
    const shown = (
      await amendmentPreview(officer, made.id, { size_class: 'MEDIUM' })
    ).json() as Preview;
    expect(
      firstViolation(await amendRaw(officer, made.id, { note: 'larger', size_class: 'MEDIUM' })),
    ).toEqual([400, '/reviewed_terms', 'required']);
    expect(
      firstViolation(
        await amendRaw(officer, made.id, {
          size_class: 'MEDIUM',
          reviewed_terms: shown.terms_token,
        }),
      ),
    ).toEqual([400, '/note', 'required']);
    // A token is of the terms the officer was shown (the price, who pays, the promise, the evidence), not of each member of the patch: the preview of an amendment that makes the order go to a station
    // (another price) is not the terms of an amendment that does not, and is refused; the preview of another size that changes no term is the same terms, and is not.
    const station = (
      await amendmentPreview(officer, made.id, {
        lane: 'THIRD_PARTY_HANDOFF',
        commercial_mode: 'STATION_DROP',
      })
    ).json() as Preview;
    expect(station.terms_token).not.toBe(shown.terms_token);
    expect(
      refusal(
        await amendRaw(officer, made.id, {
          note: 'larger',
          size_class: 'LARGE',
          reviewed_terms: station.terms_token,
        }),
      ),
    ).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
    expect(
      (
        await amendRaw(officer, made.id, {
          note: 'larger',
          size_class: 'MEDIUM',
          reviewed_terms: shown.terms_token,
        })
      ).status,
    ).toBe(200);
  });

  // Break caught: a preview of an amendment that is the preview of a new order (`parcel_ordered`), that does not show the quote the order holds, or that is not the token its save is judged by.
  it('previews an amendment beside the quote the order holds, and the save is made on that token', async () => {
    const intake = await opened(2);
    const [parcel] = intake.parcels as [Parcel, Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(parcel.id)));
    // The parcel has an order: as a new order it is refused, as an amendment it is previewed.
    expect(refusal(await previewOf(officer, intake.id, body(parcel.id)))).toEqual([
      409,
      'STATE_CONFLICT',
      'parcel_ordered',
    ]);
    const shown = await amendmentPreview(officer, made.id, {
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'STATION_DROP',
    });
    expect(shown.status, shown.text).toBe(200);
    const terms = shown.json() as Preview;
    expect(terms).toMatchObject({
      status: 'CURRENT_PREVIEW',
      order_id: made.id,
      will_confirm: 'WHEN_ARRIVAL_IS_COMMITTED',
      price: { total: { amount_minor: 2000 } },
      current: { total: { amount_minor: 3500 } },
    });
    expect(terms.order_version).toEqual(expect.any(Number));
    // A preview writes nothing.
    expect((await orderRow(made.id))?.locked_price_minor).toBeNull();
    expect((await readOrderView(officer, made.id)).amendments).toHaveLength(0);
    const saved = await amendRaw(officer, made.id, {
      note: 'It goes to a station',
      lane: 'THIRD_PARTY_HANDOFF',
      commercial_mode: 'STATION_DROP',
      reviewed_terms: terms.terms_token,
    });
    expect(saved.status, saved.text).toBe(200);
    expect((saved.json() as Order).price_components_snapshot.total_minor).toBe(2000);
    expect((saved.json() as Order & { price_status: string }).price_status).toBe('EARLY_QUOTE');
    // What the amendment of a confirmed order would give is refused as the save refuses it.
    expect((await finishAllHere(officer, intake.id, 2)).status).toBe(200);
    expect(refusal(await amendmentPreview(officer, made.id, { size_class: 'LARGE' }))).toEqual([
      409,
      'STATE_CONFLICT',
      'order_confirmed',
    ]);
    expect(
      ((await readOrderView(officer, made.id)) as Order & { price_status: string }).price_status,
    ).toBe('FROZEN');
  });

  // Break caught: a preview that does not judge the evidence as the save does, so that "it is fine" is followed by a refusal, and a preview that says nothing of what it checked.
  it('judges the evidence an order cites as the save does, and says what it verified', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    await routes.admin.query(
      `update pickup_request set declared_value_minor = 100000, liability_cap_acknowledged_at = now(),
              liability_cap_snapshot = '{"amount_minor":30000,"setting_key":"liability_cap_amount","effective_version":"UNVERSIONED"}'::jsonb where id = $1`,
      [intake.requestId],
    );
    const none = (await previewOf(officer, intake.id, body(a.id))).json() as Preview;
    expect(none.validation).toEqual({ evidence: 'NONE_CITED' });
    const pending = await pendingIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    expect(
      refusal(
        await previewOf(
          officer,
          intake.id,
          body(b.id, { declared_value_minor: 90000, evidence_ids: [pending] }),
        ),
      ),
    ).toEqual([422, 'EVIDENCE_NOT_STORED', undefined]);
    const condition = await storedIntakeEvidence(routes, officer, intake.id, 'CONDITION');
    expect(
      refusal(
        await previewOf(
          officer,
          intake.id,
          body(b.id, { declared_value_minor: 90000, evidence_ids: [condition] }),
        ),
      ),
    ).toEqual([422, 'EVIDENCE_NOT_STORED', undefined]);
    const stored = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const verified = (
      await previewOf(
        officer,
        intake.id,
        body(c.id, { declared_value_minor: 90000, evidence_ids: [stored] }),
      )
    ).json() as Preview;
    expect(verified.validation).toEqual({ evidence: 'VERIFIED' });
    // The save of that preview is made, and is the same order.
    const made = orderOf(
      await itemize(
        officer,
        intake.id,
        body(c.id, {
          declared_value_minor: 90000,
          evidence_ids: [stored],
          reviewed_terms: verified.terms_token,
        }),
      ),
    );
    expect(made.is_high_value).toBe(true);
  });

  // Break caught: a save that goes ahead on a rate that is not the one the officer saw, or one that refuses and does not say what the terms are now.
  it('refuses a save on rates that changed since the preview, shows the terms as they are and makes the order on those the officer then confirms', async () => {
    const intake = await cleared(1);
    const [only] = intake.parcels as [Parcel];
    const shown = (await previewOf(officer, intake.id, body(only.id))).json() as Preview;
    expect(shown.price.total.amount_minor).toBe(3500);
    const restore = await raiseBaseFee();
    try {
      const refused = await itemize(
        officer,
        intake.id,
        body(only.id, { reviewed_terms: shown.terms_token }),
      );
      expect(refusal(refused)).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
      const now = (refused.json() as { details: { current_terms: Preview } }).details.current_terms;
      expect(now.price.total.amount_minor).toBe(4000);
      expect(now.terms_token).not.toBe(shown.terms_token);
      expect(await countOrders(intake.id)).toBe(0);
      const made = orderOf(
        await itemize(officer, intake.id, body(only.id, { reviewed_terms: now.terms_token })),
      );
      expect(made.locked_price?.amount_minor).toBe(4000);
    } finally {
      await restore();
    }
  });

  // Break caught: an early quote that follows the rates (the owner's protected quote of OB-S1-148 lost), or an amendment whose preview does not show what the refresh would change.
  it('keeps the quote of an order made early through a change of rates, and shows the difference an amendment would make', async () => {
    const intake = await opened(1);
    const [parcel] = intake.parcels as [Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(parcel.id)));
    expect(made.price_components_snapshot.total_minor).toBe(3500);
    const restore = await raiseBaseFee();
    try {
      const shown = (
        await amendmentPreview(officer, made.id, { size_class: 'MEDIUM' })
      ).json() as Preview;
      expect(shown.current?.total.amount_minor).toBe(3500);
      expect(shown.price.total.amount_minor).toBe(4000);
      // Confirmed without an amendment, the order is frozen at the quote it holds.
      expect((await finishAllHere(officer, intake.id, 1)).status).toBe(200);
      expect((await orderRow(made.id))?.locked_price_minor).toBe(3500);
    } finally {
      await restore();
    }
  });
});

describe('the close is made against what the senior read (the review of 20 November 2026, finding 6)', () => {
  interface Assessed {
    readonly assessment_token: string;
    readonly outstanding_count: number;
    readonly can_close: boolean;
  }
  const assessment = async (actor: Actor, id: string): Promise<Assessed> =>
    (await actor.client.get(`${ONE(id)}/closure`)).json() as Assessed;
  const closeWith = async (actor: Actor, id: string, body_: unknown): Promise<TestResponse> =>
    actor.client.post(`${ONE(id)}/close`, body_, {
      origin: OPS,
      headers: { 'If-Match': (await read(actor, id)).etag, 'Idempotency-Key': randomUUID() },
    });

  // Break caught: a reason for a shortage of three, accepted for a shortage of two because an order was added while the senior wrote it; the intake's own ETag does not move with an order, so it could not say so.
  it('refuses the exception when an order was added since the senior read the assessment, and shows the assessment as it is', async () => {
    const intake = await cleared(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const read_ = await assessment(senior, intake.id);
    expect(read_.outstanding_count).toBe(2);
    const etagBefore = (await read(senior, intake.id)).etag;
    // Another officer orders a second parcel while the senior writes the reason.
    orderOf(await itemize(officer, intake.id, body(b.id)));
    // The intake's own token did not move: it could not have told.
    expect((await read(senior, intake.id)).etag).toBe(etagBefore);
    const refused = await closeWith(senior, intake.id, {
      reviewed_assessment: read_.assessment_token,
      parity_exception: { note: 'Two parcels are still on the rider’s bike' },
    });
    expect(refusal(refused)).toEqual([409, 'STATE_CONFLICT', 'assessment_changed']);
    const current = (refused.json() as { details: { current_assessment: Assessed } }).details
      .current_assessment;
    expect(current.outstanding_count).toBe(1);
    expect(current.assessment_token).not.toBe(read_.assessment_token);
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    // The senior reads it and closes against it.
    const closed = await closeWith(senior, intake.id, {
      reviewed_assessment: current.assessment_token,
      parity_exception: { note: 'One parcel is still on the rider’s bike' },
    });
    expect(closed.status, closed.text).toBe(200);
    expect(await intakeState(intake.id)).toBe('CLOSED');
  });

  // Break caught: the same, with the two officers at work at once and not one after the other: the close that meets an order being made waits for it (the intake's lock) and then judges what the senior read against
  // what is there, and neither refuses to wait nor closes on the earlier reading.
  it('waits for an order that is being made, and then refuses the exception written for the intake as it was', async () => {
    const intake = await cleared(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const read_ = await assessment(senior, intake.id);
    const gate = await holdingTheAuditTable();
    let ordering: Promise<TestResponse> | undefined;
    let closing: Promise<TestResponse> | undefined;
    try {
      // The order is made and waits to write its audit event, holding the intake.
      ordering = itemize(officer, intake.id, body(b.id));
      const orderingPid = await waitForBlockedBackend(
        routes.admin,
        gate.pid,
        'the order',
        ordering,
      );
      closing = closeWith(senior, intake.id, {
        reviewed_assessment: read_.assessment_token,
        parity_exception: { note: 'Two parcels are still on the rider’s bike' },
      });
      await waitUntilBlockedBy(routes.admin, orderingPid, 'the close', closing);
      await gate.client.query('commit');
    } catch (error) {
      await gate.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([ordering, closing]);
      throw error;
    } finally {
      await gate.client.end();
    }
    orderOf(await started(ordering));
    expect(refusal(await started(closing))).toEqual([409, 'STATE_CONFLICT', 'assessment_changed']);
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
  });

  // Break caught: an exception that needs no reading, a token that is judged only for the exception, or a close that is judged against another intake's assessment.
  it('requires the token with the exception, judges it whenever it is given, and refuses another intake’s', async () => {
    const intake = await cleared(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    // The body is a close that has parity or the exception **with** its token (the review of 21 November 2026, finding 4): the exception without it is no body of either kind.
    expect(
      firstViolation(
        await closeWith(senior, intake.id, {
          parity_exception: { note: 'One is on the rider’s bike' },
        }),
      ),
    ).toEqual([400, '', 'oneOf']);
    // The officer who holds the close alone is told that the exception is the senior's, with the token in hand.
    expect(
      refusal(
        await closeWith(officer, intake.id, {
          reviewed_assessment: (await assessment(senior, intake.id)).assessment_token,
          parity_exception: { note: 'One is on the rider’s bike' },
        }),
      )[1],
    ).toBe('INSUFFICIENT_AUTHORITY');
    const other = await cleared(1);
    const [only] = other.parcels as [Parcel];
    orderOf(await itemize(officer, other.id, body(only.id)));
    // A close that has parity needs none, and judges one that is given.
    expect(
      refusal(
        await closeWith(officer, other.id, {
          reviewed_assessment: (await assessment(senior, intake.id)).assessment_token,
        }),
      ),
    ).toEqual([409, 'STATE_CONFLICT', 'assessment_changed']);
    expect(await intakeState(other.id)).toBe('ITEMIZING');
    expect(
      (
        await closeWith(officer, other.id, {
          reviewed_assessment: (await assessment(senior, other.id)).assessment_token,
        })
      ).status,
    ).toBe(200);
  });
});

describe('the completion of an intake reaches the vendor in words that are true of every close (the review of 20 November 2026, finding 1)', () => {
  let worker: BuiltService;
  beforeAll(() => {
    worker = buildService(routes.database, { poolMax: 3, login: WORKER_RUNTIME_ROLE });
  });
  afterAll(async () => {
    await worker.close();
  });

  /** The same words as a draft: nobody approved them. The owner approved these on 22 November 2026 (OB-S1-153), so the mechanism that holds a draft back is shown with the approval taken off. */
  const asDraft = (kind: string, version: number): Template | undefined => {
    const found = templateOf(kind, version);
    return found === undefined
      ? undefined
      : { ...found, approvedBy: null, approvedOn: null, approvedDigest: null };
  };
  /** One tick of the notification lane of the delivery worker that only relays what the closes wrote: the lane of the worker's own login, over the same database. */
  const relay = async (templates?: (kind: string, version: number) => Template | undefined) => {
    const sender: TextMessageSender = {
      send: () => Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: 'ref' }),
      status: () => Promise.resolve({ state: 'PENDING' }),
    };
    const lane = new NotificationLane({
      store: new NotificationStore({
        database: worker.service,
        clock: new SystemClock(),
        workerId: 'itemization-test',
      }),
      sender,
      policy: OPEN_POLICY,
      logger: worker.logs.logger,
      ...(templates === undefined ? {} : { templates }),
      leaseMs: 30_000,
      firstReceiptCheckMs: 0,
      receiptHoldMs: 60_000,
      random: () => 0.5,
      batch: { envelopes: 200, sends: 0, receipts: 0 },
    });
    return lane.runOnce(new AbortController().signal);
  };
  const entriesOf = (requestId: string) =>
    routes.rows<{
      message_kind: string;
      template_version: number;
      audience: string;
      channel: string;
      state: string;
      suppression_reason: string | null;
      parameters: Record<string, string>;
    }>(
      `select message_kind, template_version, audience, channel, state, suppression_reason, parameters from notification where subject_id = $1 order by message_kind`,
      [requestId],
    );
  const envelopesOf = async (requestId: string): Promise<number> =>
    Number(
      (
        await routes.rows<{ n: string }>(
          `select count(*)::text as n from outbox where aggregate_id = $1 and event_type = 'intake.completed'`,
          [requestId],
        )
      )[0]?.n,
    );
  /** A close with every order, or with the approved exception, as the officer or the senior makes it. */
  const close = async (
    actor: Actor,
    intakeId: string,
    exception?: string,
    key = randomUUID(),
  ): Promise<TestResponse> => {
    const etag = (await read(actor, intakeId)).etag;
    const sent =
      exception === undefined
        ? undefined
        : {
            reviewed_assessment: (
              (await actor.client.get(`${ONE(intakeId)}/closure`)).json() as {
                assessment_token: string;
              }
            ).assessment_token,
            parity_exception: { note: exception },
          };
    return actor.client.post(`${ONE(intakeId)}/close`, sent, {
      origin: OPS,
      headers: { 'If-Match': etag, 'Idempotency-Key': key },
    });
  };

  // Break caught: a message that is held back for one kind of close and sent for another, a close that writes it twice (a retry), or words that say more than a close with the exception makes true.
  it('is written once for each close, a retry included, and says the same of a close with every order as of one with the exception', async () => {
    const whole = await cleared(1);
    const [only] = whole.parcels as [Parcel];
    orderOf(await itemize(officer, whole.id, body(only.id)));
    const key = randomUUID();
    expect((await close(officer, whole.id, undefined, key)).status).toBe(200);
    // The retry is answered as the first was, and writes nothing.
    expect((await close(officer, whole.id, undefined, key)).status).toBe(200);
    const short = await cleared(3);
    const [a, b] = short.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, short.id, body(a.id)));
    orderOf(await itemize(officer, short.id, body(b.id)));
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    expect((await close(senior, short.id, 'One parcel is on the rider’s bike')).status).toBe(200);
    expect(await envelopesOf(whole.requestId)).toBe(1);
    expect(await envelopesOf(short.requestId)).toBe(1);

    // The owner has approved the words (22 November 2026): the entry of the vendor is shown, and it is the same for both closes.
    await relay();
    const [first] = await entriesOf(whole.requestId);
    const [second] = await entriesOf(short.requestId);
    expect(first).toMatchObject({
      message_kind: 'INTAKE_COMPLETED_VENDOR_FEED',
      template_version: 2,
      audience: 'VENDOR_FEED',
      channel: 'FEED',
      state: 'DELIVERED',
      suppression_reason: null,
      parameters: {},
    });
    expect(second).toEqual(first);
    // What it says: that the hub has finished checking in the pickup, and nothing that the close with the exception makes untrue.
    const approved = templateOf('INTAKE_COMPLETED_VENDOR_FEED', 2);
    if (approved === undefined) throw new Error('the completion entry has no wording');
    expect(approved.approvedBy).toBe('Mathias Elorm, Product Owner');
    expect(approved.approvedDigest).toBe(wordingDigest(approved));
    const words = render(approved, {
      code: 'ABC',
    });
    expect(words).toBe('Our hub has finished checking in pickup ABC.');
    expect(words).not.toMatch(/order|parcel|listed|paid|cleared|delivery|summary|link/i);
  });

  // Break caught: a draft shown to a vendor as if the owner had approved it, because the feed has no provider to stand in front of it.
  it('does not show the vendor an entry whose words nobody approved, and holds it back with its reason', async () => {
    const whole = await cleared(1);
    const [only] = whole.parcels as [Parcel];
    orderOf(await itemize(officer, whole.id, body(only.id)));
    expect((await close(officer, whole.id)).status).toBe(200);
    await relay(asDraft);
    expect(await entriesOf(whole.requestId)).toMatchObject([
      {
        message_kind: 'INTAKE_COMPLETED_VENDOR_FEED',
        state: 'SUPPRESSED',
        suppression_reason: 'WORDING_NOT_APPROVED',
        parameters: {},
      },
    ]);
  });

  // Break caught (OB-S1-153): a promise of a summary that the vendor cannot reach from the entry. The entry's subject is the pickup request and it carries no parameter; the summary is the intake's, and nothing the
  // vendor can read of the request names the intake, so the words promise no link until one works.
  it('names no intake on the entry, and the vendor cannot reach the summary from the request alone', async () => {
    const whole = await cleared(1);
    const [only] = whole.parcels as [Parcel];
    orderOf(await itemize(officer, whole.id, body(only.id)));
    expect((await close(officer, whole.id)).status).toBe(200);
    await relay();
    const [entry] = await routes.rows<{
      subject_type: string;
      subject_id: string;
      parameters: unknown;
    }>(`select subject_type, subject_id, parameters from notification where subject_id = $1`, [
      whole.requestId,
    ]);
    expect(entry).toMatchObject({ subject_type: 'PICKUP_REQUEST', subject_id: whole.requestId });
    expect(JSON.stringify(entry)).not.toContain(whole.id);
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    const request = await browser.get(`${API}/pickup-requests/${whole.requestId}`);
    expect(request.status, request.text).toBe(200);
    expect(request.text).not.toContain(whole.id);
    // The summary itself is the vendor's, by the intake's identifier.
    expect((await browser.get(`${ONE(whole.id)}/summary`)).status).toBe(200);
  });
});

describe('the closes that left work are found again (OB-S1-151; the review of 20 November 2026)', () => {
  interface Left {
    readonly intake_id: string;
    readonly intake_code: string;
    readonly pickup_request_id: string;
    readonly responsible_hub_id: string;
    readonly receiving_mode: string;
    readonly closed_at: string;
    readonly closed_by: string;
    readonly exception_note: string | null;
    readonly received: number;
    readonly ordered: number;
    readonly outstanding_count: number;
  }
  interface Queue {
    readonly items: Left[];
    readonly next_page_token: string | null;
  }
  const QUEUE = `${API}/hub-intake-exceptions`;
  const queue = (actor: Actor, query = ''): Promise<TestResponse> =>
    actor.client.get(`${QUEUE}${query}`);
  const exceptionClose = async (
    actor: Actor,
    intakeId: string,
    note: string,
  ): Promise<TestResponse> => {
    const token = (
      (await actor.client.get(`${ONE(intakeId)}/closure`)).json() as { assessment_token: string }
    ).assessment_token;
    return actor.client.post(
      `${ONE(intakeId)}/close`,
      { reviewed_assessment: token, parity_exception: { note } },
      {
        origin: OPS,
        headers: {
          'If-Match': (await read(actor, intakeId)).etag,
          'Idempotency-Key': randomUUID(),
        },
      },
    );
  };
  /** Every page of the queue the caller reads, in order. */
  const everything = async (actor: Actor): Promise<Left[]> => {
    const seen: Left[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const response = await queue(
        actor,
        `?page_size=2${token === null ? '' : `&page_token=${token}`}`,
      );
      expect(response.status, response.text).toBe(200);
      const page = response.json() as Queue;
      seen.push(...page.items);
      token = page.next_page_token;
      pages += 1;
    } while (token !== null && pages < 100);
    return seen;
  };

  // Break caught: a close with the exception that leaves nothing a senior can find again; a routine close, or one that left nothing, in the queue; a queue that is not newest first or that does not say what was left, why and by whom.
  it('lists the intakes closed with the exception that still have work left, newest first, with what remained and why, and no close that left none', async () => {
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const first = await cleared(3);
    const [a] = first.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, first.id, body(a.id)));
    expect(
      (await exceptionClose(senior, first.id, 'Two parcels are on the rider’s bike')).status,
    ).toBe(200);
    // A routine close leaves nothing: it is not here.
    const clean = await cleared(1);
    const [only] = clean.parcels as [Parcel];
    orderOf(await itemize(officer, clean.id, body(only.id)));
    expect(
      (
        await officer.client.post(`${ONE(clean.id)}/close`, undefined, {
          origin: OPS,
          headers: {
            'If-Match': (await read(officer, clean.id)).etag,
            'Idempotency-Key': randomUUID(),
          },
        })
      ).status,
    ).toBe(200);
    // An intake counted blind is here too, with no parcels to name.
    const counted = await blind(3);
    orderOf(await itemize(officer, counted.id, body(null)));
    expect(
      (await exceptionClose(senior, counted.id, 'The other two were never unloaded')).status,
    ).toBe(200);
    const mine = new Map([
      [first.id, 'PHOTO_CHECK_IN'],
      [counted.id, 'BLIND_COUNT'],
    ]);
    const all = await everything(senior);
    const found = all.filter((item) => mine.has(item.intake_id));
    expect(found.every((item) => item.intake_code.length > 0)).toBe(true);
    // Newest close first: the blind intake was closed after the photo intake.
    expect(found.map((item) => item.intake_id)).toEqual([counted.id, first.id]);
    expect(found.map((item) => item.receiving_mode)).toEqual(['BLIND_COUNT', 'PHOTO_CHECK_IN']);
    expect(found.find((item) => item.intake_id === first.id)).toMatchObject({
      pickup_request_id: first.requestId,
      responsible_hub_id: HUB_A,
      closed_by: senior.identity.id,
      exception_note: 'Two parcels are on the rider’s bike',
      received: 3,
      ordered: 1,
      outstanding_count: 2,
    });
    expect(found.find((item) => item.intake_id === counted.id)).toMatchObject({
      received: 3,
      ordered: 1,
      outstanding_count: 2,
    });
    expect(all.map((item) => item.intake_id)).not.toContain(clean.id);
    // The closes are in order, whatever the page.
    const moments = all.map((item) => item.closed_at);
    expect(moments).toEqual(moments.toSorted().toReversed());
    expect(new Set(all.map((item) => item.intake_id)).size).toBe(all.length);
    // A close that has nothing left is not in the queue: what is left is counted now. The count of the blind intake is brought down to its one order (by a writer the guards would refuse: the test arranges
    // a world the application cannot make), and it is gone, while the other stays.
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query('update pickup_intake set physical_count = 1 where id = $1', [
      counted.id,
    ]);
    await routes.admin.query('commit');
    const after = (await everything(senior)).map((item) => item.intake_id);
    expect(after).not.toContain(counted.id);
    expect(after).toContain(first.id);
  });

  // Break caught: a queue that is anyone's: an officer who may not close with the exception, another hub's senior, or a question that is not one.
  it('is the senior’s of the hub alone, and refuses a page that is not one', async () => {
    expect(refusal(await queue(officer))[1]).toBe('PERMISSION_DENIED');
    const elsewhere = await routes.actor(BUNDLE_IDS.seniorOps, HUB_B);
    const first = await cleared(2);
    const [a] = first.parcels as [Parcel, Parcel];
    orderOf(await itemize(officer, first.id, body(a.id)));
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    expect((await exceptionClose(senior, first.id, 'One is on the rider’s bike')).status).toBe(200);
    expect((await everything(senior)).map((item) => item.intake_id)).toContain(first.id);
    // Another hub's senior reads the queue of their own hub, and this intake is not in it.
    expect((await everything(elsewhere)).map((item) => item.intake_id)).not.toContain(first.id);
    for (const query of ['?page_size=0', '?page_size=abc', '?page_size=1000', '?page_token=AAAA']) {
      const refused = await queue(senior, query);
      expect([query, refused.status, (refused.json() as { code?: string }).code]).toEqual([
        query,
        400,
        'VALIDATION_FAILED',
      ]);
    }
    // The Platform Admin reads every hub's, and the read of a hub that is not their own is audited.
    const boss = await routes.platformAdmin();
    expect((await everything(boss)).map((item) => item.intake_id)).toContain(first.id);
  });
});

// ---- THE REVIEW OF 21 NOVEMBER 2026 ------------------------------------------------------------------------------------------------------------------------------------------------

/** What `previewOrder` and `previewOrderAmendment` answer, as far as these tests read it. */
interface Shown {
  readonly terms_token: string;
  readonly will_confirm: string;
  readonly cited_evidence: { high_value: string[]; carrier_waybill: string | null };
  readonly price: { total: { amount_minor: number } };
  readonly current: {
    cited_evidence: { high_value: string[]; carrier_waybill: string | null };
  } | null;
}

const previewOf = async (actor: Actor, intakeId: string, given: unknown): Promise<Shown> => {
  const response = await actor.client.post(`${ONE(intakeId)}/orders/preview`, given, {
    origin: OPS,
  });
  expect(response.status, response.text).toBe(200);
  return response.json() as Shown;
};

const amendmentPreviewOf = async (
  actor: Actor,
  orderId: string,
  given: unknown,
): Promise<Shown> => {
  const response = await actor.client.post(`${API}/orders/${orderId}/amendment-preview`, given, {
    origin: OPS,
  });
  expect(response.status, response.text).toBe(200);
  return response.json() as Shown;
};

describe('a blind intake takes no more orders than the parcels it received (the review of 21 November 2026, finding 1)', () => {
  interface Assessed {
    readonly assessment_token: string;
    readonly received: number | null;
    readonly ordered: number;
    readonly outstanding_count: number | null;
    readonly excess_count: number;
    readonly can_close: boolean;
    readonly needs_exception: boolean;
    readonly blockers: string[];
  }
  const assessment = async (actor: Actor, id: string): Promise<Assessed> =>
    (await actor.client.get(`${ONE(id)}/closure`)).json() as Assessed;
  const closeWith = async (actor: Actor, id: string, body_: unknown): Promise<TestResponse> =>
    actor.client.post(`${ONE(id)}/close`, body_, {
      origin: OPS,
      headers: { 'If-Match': (await read(actor, id)).etag, 'Idempotency-Key': randomUUID() },
    });

  // Break caught: a third order for an intake that received two parcels, which the close then accepts as a shortage of nothing and the exception queue never lists.
  it('refuses the order that has no place left, in the preview as in the save, and makes none', async () => {
    const intake = await blind(2);
    orderOf(await itemize(officer, intake.id, body(null)));
    orderOf(await itemize(officer, intake.id, body(null)));
    const preview = await officer.client.post(`${ONE(intake.id)}/orders/preview`, body(null), {
      origin: OPS,
    });
    expect(refusal(preview)).toEqual([409, 'STATE_CONFLICT', 'orders_exceed_received']);
    expect(refusal(await itemize(officer, intake.id, body(null)))).toEqual([
      409,
      'STATE_CONFLICT',
      'orders_exceed_received',
    ]);
    expect(await countOrders(intake.id)).toBe(2);
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
  });

  // Break caught: two saves for the last place that both read two orders and both make one (a check that is not made under the intake's lock).
  it('lets exactly one of two simultaneous saves have the last place', async () => {
    const intake = await blind(2);
    orderOf(await itemize(officer, intake.id, body(null)));
    const second = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const answers = await Promise.all([
      itemize(officer, intake.id, body(null)),
      itemize(second, intake.id, body(null)),
    ]);
    expect(answers.map((answer) => answer.status).toSorted()).toEqual([201, 409]);
    const lost = answers.find((answer) => answer.status === 409);
    if (lost === undefined) throw new Error('one of the two saves was refused');
    expect(refusal(lost)).toEqual([409, 'STATE_CONFLICT', 'orders_exceed_received']);
    expect(await countOrders(intake.id)).toBe(2);
  });

  // Break caught: a close that accepts more orders than parcels as "no shortage", with the senior's exception, and a vendor summary that then lists three priced orders for two parcels.
  it('shows a surplus that already stands, refuses to close over it with or without the exception, and says what is wrong', async () => {
    const intake = await blind(2);
    orderOf(await itemize(officer, intake.id, body(null)));
    orderOf(await itemize(officer, intake.id, body(null)));
    // A state the application cannot make any more (a count lowered under the orders, arranged as the other tests arrange a world it cannot make).
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(`update pickup_intake set physical_count = 1 where id = $1`, [
      intake.id,
    ]);
    await routes.admin.query('commit');
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const found = await assessment(senior, intake.id);
    expect(found).toMatchObject({
      received: 1,
      ordered: 2,
      outstanding_count: 0,
      excess_count: 1,
      can_close: false,
      needs_exception: false,
    });
    expect(found.blockers).toContain('orders_exceed_received');
    expect(
      refusal(
        await closeWith(senior, intake.id, {
          reviewed_assessment: found.assessment_token,
          parity_exception: { note: 'One order too many' },
        }),
      ),
    ).toEqual([409, 'STATE_CONFLICT', 'orders_exceed_received']);
    expect(refusal(await closeWith(officer, intake.id, {}))).toEqual([
      409,
      'STATE_CONFLICT',
      'orders_exceed_received',
    ]);
    expect(await intakeState(intake.id)).toBe('ITEMIZING');
    // No summary is made of an intake that is not closed.
    expect((await officer.client.get(`${API}/hub-intakes/${intake.id}/summary`)).status).toBe(404);
  });

  // Break caught: a limit that is a constant and not the count that was received.
  it('lets every parcel received have its order, and the close that follows has parity', async () => {
    const intake = await blind(4);
    for (let each = 0; each < 4; each += 1) {
      orderOf(await itemize(officer, intake.id, body(null)));
    }
    const found = await assessment(officer, intake.id);
    expect(found).toMatchObject({ received: 4, ordered: 4, excess_count: 0, can_close: true });
    expect((await closeWith(officer, intake.id, {})).status).toBe(200);
  });

  // Break caught (OB-S1-161): an inventory that looks at open intakes only (the queue of shortages misses an older surplus and a closed one), that counts an order whose arrival was reversed, or that lists an
  // intake whose orders stand within its count; or one that writes.
  it('finds a surplus that already stands, in an open and in a closed blind intake, and lists nothing that is within its count', async () => {
    const open = await blind(2);
    orderOf(await itemize(officer, open.id, body(null)));
    orderOf(await itemize(officer, open.id, body(null)));
    const closed = await blind(2);
    orderOf(await itemize(officer, closed.id, body(null)));
    orderOf(await itemize(officer, closed.id, body(null)));
    expect((await closeWith(officer, closed.id, {})).status).toBe(200);
    const within = await blind(3);
    orderOf(await itemize(officer, within.id, body(null)));
    // A state the application cannot make any more (the counts lowered under the orders, arranged as the other tests arrange a world it cannot make).
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(`update pickup_intake set physical_count = 1 where id = $1`, [
      open.id,
    ]);
    await routes.admin.query(`update pickup_intake set physical_count = 1 where id = $1`, [
      closed.id,
    ]);
    await routes.admin.query('commit');
    const before = await countOrders(open.id);
    const report = await checkOrderSurplus(routes.admin);
    expect(report.tables).toBe(true);
    const surplus = (id: string) => report.surpluses.find((each) => each.intakeId === id);
    expect(surplus(open.id)).toMatchObject({
      state: 'ITEMIZING',
      receivedCount: 1,
      standingOrders: 2,
      surplus: 1,
      closedAt: null,
    });
    expect(surplus(closed.id)).toMatchObject({
      state: 'CLOSED',
      receivedCount: 1,
      standingOrders: 2,
      surplus: 1,
    });
    expect(surplus(closed.id)?.closedAt).not.toBeNull();
    expect(surplus(within.id)).toBeUndefined();
    expect(isClear(report)).toBe(false);
    // It only reads: nothing was written.
    expect(await countOrders(open.id)).toBe(before);
    expect(await intakeState(closed.id)).toBe('CLOSED');
  });
});

describe('the officer confirms which attachment was shown (the review of 21 November 2026, finding 2)', () => {
  /** The booking recorded the sender's acknowledgement of the liability cap (a value above the threshold was declared at booking). */
  const acknowledged = (requestId: string) =>
    routes.admin.query(
      `update pickup_request set declared_value_minor = 100000, liability_cap_acknowledged_at = now(),
              liability_cap_snapshot = '{"amount_minor":30000,"setting_key":"liability_cap_amount","effective_version":"UNVERSIONED"}'::jsonb where id = $1`,
      [requestId],
    );

  // Break caught: a token that says "verified" and not which records, so that two different valid photos of the same parcel are one set of terms.
  it('gives two orders that cite different stored evidence different terms, and names the evidence', async () => {
    const intake = await cleared(1);
    const [a] = intake.parcels as [Parcel];
    await acknowledged(intake.requestId);
    const first = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const second = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const high = (evidence: string[]) =>
      body(a.id, { declared_value_minor: 90000, evidence_ids: evidence });
    const one = await previewOf(officer, intake.id, high([first]));
    const other = await previewOf(officer, intake.id, high([second]));
    expect(one.terms_token).not.toBe(other.terms_token);
    expect(one.cited_evidence).toEqual({ high_value: [first], carrier_waybill: null });
    expect(other.cited_evidence).toEqual({ high_value: [second], carrier_waybill: null });
    // Two records are not one, and the same two in the other order are the same set.
    const both = await previewOf(officer, intake.id, high([first, second]));
    const swapped = await previewOf(officer, intake.id, high([second, first]));
    expect(both.terms_token).not.toBe(one.terms_token);
    expect(both.terms_token).toBe(swapped.terms_token);
    // The save of the order with the record the officer was not shown is refused, with the terms that name the record it would cite.
    const refused = await itemize(officer, intake.id, {
      ...high([second]),
      reviewed_terms: one.terms_token,
    });
    expect(refusal(refused)).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
    expect(
      (refused.json() as { details: { current_terms: Shown } }).details.current_terms
        .cited_evidence,
    ).toEqual({ high_value: [second], carrier_waybill: null });
    expect(await countOrders(intake.id)).toBe(0);
    orderOf(
      await itemize(officer, intake.id, { ...high([second]), reviewed_terms: other.terms_token }),
    );
  });

  // Break caught: the same for the waybill of a covered third-party order, which is a record of its own.
  it('tells the waybill apart too', async () => {
    const intake = await cleared(1);
    const [a] = intake.parcels as [Parcel];
    const first = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const second = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const covered = (waybill: string) =>
      body(a.id, {
        lane: 'THIRD_PARTY_HANDOFF',
        commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
        recipient: { name: 'Kofi', phone: '0201112233', location: { address: 'Adum, Kumasi' } },
        carrier_cost: { amount_minor: 5000, currency: 'GHS' },
        carrier_waybill_evidence_id: waybill,
      });
    const one = await previewOf(officer, intake.id, covered(first));
    const other = await previewOf(officer, intake.id, covered(second));
    expect(one.terms_token).not.toBe(other.terms_token);
    expect(one.cited_evidence).toEqual({ high_value: [], carrier_waybill: first });
    expect(other.cited_evidence).toEqual({ high_value: [], carrier_waybill: second });
  });

  // Break caught: the same for an amendment, and the preview of one that does not show the evidence the order holds now.
  it('tells the evidence of an amendment apart, and shows the evidence the order holds now', async () => {
    const intake = await opened(1);
    const [a] = intake.parcels as [Parcel];
    await acknowledged(intake.requestId);
    const first = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const second = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const third = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const made = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, { declared_value_minor: 90000, evidence_ids: [first] }),
      ),
    );
    const toSecond = await amendmentPreviewOf(officer, made.id, { evidence_ids: [second] });
    const toThird = await amendmentPreviewOf(officer, made.id, { evidence_ids: [third] });
    expect(toSecond.terms_token).not.toBe(toThird.terms_token);
    expect(toSecond.cited_evidence.high_value).toEqual([second]);
    expect(toSecond.current?.cited_evidence).toEqual({
      high_value: [first],
      carrier_waybill: null,
    });
  });
});

describe('an amendment is not a confirmation, and says when the quote becomes final (the review of 21 November 2026, finding 3)', () => {
  const ORDER = (id: string): string => `${API}/orders/${id}`;
  const amendRaw = async (actor: Actor, orderId: string, given: unknown): Promise<TestResponse> =>
    actor.client.request('PATCH', ORDER(orderId), {
      body: given,
      origin: OPS,
      headers: {
        'If-Match': (await actor.client.get(ORDER(orderId))).header('etag') ?? '',
        'Idempotency-Key': randomUUID(),
      },
    });

  // Break caught: "on confirmation" told of an amendment while the parcel is tapped and the check-in is open, when saving the amendment leaves the quote an early quote that only the commit of the arrival makes final.
  it('says the quote becomes final when the arrival is committed, while the parcel is expected, tapped, untapped and tapped again', async () => {
    const intake = await opened(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(a.id)));
    expect(
      (await amendmentPreviewOf(officer, made.id, { size_class: 'MEDIUM' })).will_confirm,
    ).toBe('WHEN_ARRIVAL_IS_COMMITTED');
    expect((await tap(officer, a.id, true)).status).toBe(200);
    const shown = await amendmentPreviewOf(officer, made.id, { size_class: 'MEDIUM' });
    expect(shown.will_confirm).toBe('WHEN_ARRIVAL_IS_COMMITTED');
    const saved = await amendRaw(officer, made.id, {
      note: 'A medium parcel',
      size_class: 'MEDIUM',
      reviewed_terms: shown.terms_token,
    });
    expect(saved.status, saved.text).toBe(200);
    expect(await orderRow(made.id)).toMatchObject({
      commercial_state: null,
      locked_price_minor: null,
    });
    expect((await readOrderView(officer, made.id)).price_status).toBe('EARLY_QUOTE');
    // The tap is taken back, and the amendment is still not a confirmation.
    expect((await tap(officer, a.id, false)).status).toBe(200);
    expect((await amendmentPreviewOf(officer, made.id, { size_class: 'LARGE' })).will_confirm).toBe(
      'WHEN_ARRIVAL_IS_COMMITTED',
    );
    expect(await orderRow(made.id)).toMatchObject({
      commercial_state: null,
      locked_price_minor: null,
    });
    // The arrival is committed: the order is final, at the quote the amendment left.
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect((await finishAsTapped(officer, intake.id)).status).toBe(200);
    const final = await orderRow(made.id);
    expect(final?.locked_price_minor).toBe(
      (await readOrderView(officer, made.id)).price_components_snapshot.total_minor,
    );
    expect((await readOrderView(officer, made.id)).price_status).toBe('FROZEN');
  });

  // Break caught: the word of a preview of a new order for a parcel that waits being the word of an amendment, or the other way about.
  it('keeps the word of an order that is made for a parcel that has arrived: confirmed when it is saved', async () => {
    const intake = await cleared(1);
    const [a] = intake.parcels as [Parcel];
    expect((await previewOf(officer, intake.id, body(a.id))).will_confirm).toBe('ON_CONFIRMATION');
    const waiting = await opened(1);
    const [b] = waiting.parcels as [Parcel];
    expect((await previewOf(officer, waiting.id, body(b.id))).will_confirm).toBe(
      'WHEN_ARRIVAL_IS_COMMITTED',
    );
  });
});

describe('a save is judged on the rates and the payer of the moment it holds its locks (the review of 21 November 2026, finding 5)', () => {
  /** The base fee of the hub's service area goes up to GH₵40 (a new version, as the owner changes a rate); the answer puts it back. */
  const raiseBaseFee = async (): Promise<() => Promise<void>> => {
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    const made = await routes.admin.query<{ id: string }>(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
       select gen_random_uuid(), hub_id, setting_key, scope_ref, version + 1, jsonb_set(value, '{amount_minor}', '4000'::jsonb), unit, clock_timestamp() - interval '1 second', created_by
         from hub_setting where hub_id = $1 and setting_key = 'service_area_base_fee' and scope_ref = 'ACCRA_TEMA' order by version desc limit 1
       returning id`,
      [HUB_A],
    );
    await routes.admin.query('commit');
    const id = made.rows[0]?.id;
    return async () => {
      await routes.admin.query('begin');
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query('delete from hub_setting where id = $1', [id]);
      await routes.admin.query('commit');
    };
  };

  // Break caught: a save that waited for the intake with the rates it read before it waited, and made an order at a price that was no longer the hub's when the order was made, on a token that matched it.
  it('refuses an order whose rates moved while the save waited for the intake, and shows the new terms', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    const second = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const waiting = await reviewedItemization(officer, intake.id, body(c.id));
    const etag = (await read(officer, intake.id)).etag;
    const gate = await holdingTheAuditTable();
    let holding: Promise<TestResponse> | undefined;
    let saving: Promise<TestResponse> | undefined;
    const restore = { current: (): Promise<void> => Promise.resolve() };
    try {
      // The first save has the intake and waits to write its audit event.
      holding = itemize(second, intake.id, body(b.id));
      const holderPid = await waitForBlockedBackend(
        routes.admin,
        gate.pid,
        'the first save',
        holding,
      );
      // The second has read the rates and waits for the intake.
      saving = officer.client.post(ORDERS(intake.id), waiting, {
        origin: OPS,
        headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
      });
      await waitUntilBlockedBy(routes.admin, holderPid, 'the second save', saving);
      // The rates move while it waits.
      restore.current = await raiseBaseFee();
      await gate.client.query('commit');
    } catch (error) {
      await gate.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([holding, saving]);
      await restore.current();
      throw error;
    } finally {
      await gate.client.end();
    }
    try {
      orderOf(await started(holding));
      const answer = await started(saving);
      expect(refusal(answer)).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
      expect(
        (answer.json() as { details: { current_terms: Shown } }).details.current_terms.price.total
          .amount_minor,
      ).toBe(4000);
      expect(await countOrders(intake.id)).toBe(2);
    } finally {
      await restore.current();
    }
  });

  // Break caught: the same for an amendment.
  it('refuses an amendment whose rates moved while the save waited, and the quote the order holds stays as it was', async () => {
    const intake = await opened(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(a.id)));
    const second = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const shown = await amendmentPreviewOf(officer, made.id, { size_class: 'MEDIUM' });
    const orderEtag = (await officer.client.get(`${API}/orders/${made.id}`)).header('etag') ?? '';
    const gate = await holdingTheAuditTable();
    let holding: Promise<TestResponse> | undefined;
    let saving: Promise<TestResponse> | undefined;
    const restore = { current: (): Promise<void> => Promise.resolve() };
    try {
      holding = itemize(second, intake.id, body(b.id));
      const holderPid = await waitForBlockedBackend(
        routes.admin,
        gate.pid,
        'the first save',
        holding,
      );
      saving = officer.client.request('PATCH', `${API}/orders/${made.id}`, {
        body: { note: 'A medium parcel', size_class: 'MEDIUM', reviewed_terms: shown.terms_token },
        origin: OPS,
        headers: { 'If-Match': orderEtag, 'Idempotency-Key': randomUUID() },
      });
      await waitUntilBlockedBy(routes.admin, holderPid, 'the amendment', saving);
      restore.current = await raiseBaseFee();
      await gate.client.query('commit');
    } catch (error) {
      await gate.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([holding, saving]);
      await restore.current();
      throw error;
    } finally {
      await gate.client.end();
    }
    try {
      orderOf(await started(holding));
      expect(refusal(await started(saving))).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
      expect((await readOrderView(officer, made.id)).price_components_snapshot.total_minor).toBe(
        3500,
      );
    } finally {
      await restore.current();
    }
  });

  // Break caught: a save of an amendment that calculates who pays without holding the request, as the save of an order does.
  it('holds the request’s payer before it calculates who pays, in an amendment as in an order', async () => {
    const intake = await opened(1);
    const [a] = intake.parcels as [Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(a.id)));
    const shown = await amendmentPreviewOf(officer, made.id, { size_class: 'MEDIUM' });
    const orderEtag = (await officer.client.get(`${API}/orders/${made.id}`)).header('etag') ?? '';
    const traced = await routes.kit.trace(async () =>
      officer.client.request('PATCH', `${API}/orders/${made.id}`, {
        body: { note: 'A medium parcel', size_class: 'MEDIUM', reviewed_terms: shown.terms_token },
        origin: OPS,
        headers: { 'If-Match': orderEtag, 'Idempotency-Key': randomUUID() },
      }),
    );
    expect(traced.result.status, traced.result.text).toBe(200);
    const at = (needle: string): number =>
      traced.statements.findIndex((statement) => statement.includes(needle));
    expect(at('melarc.hold_request_payer')).toBeGreaterThan(-1);
    expect(at('melarc.hold_request_payer')).toBeLessThan(at('melarc.payer_preview'));
    expect(at('melarc.payer_preview')).toBeLessThan(at('melarc.amend_order'));
    // And the rates are compared once both locks are held, never before the payer's (the review of 22 November 2026, finding 5).
    const compared = traced.statements.findLastIndex((statement) =>
      statement.includes('hub_configuration_fingerprint'),
    );
    expect(at('melarc.hold_request_payer')).toBeLessThan(compared);
    expect(compared).toBeLessThan(at('melarc.payer_preview'));
  });
});

describe('a save is judged on the configuration in force when it holds both its locks (the review of 22 November 2026, finding 5; OB-S1-163)', () => {
  /**
   * A new version of the base fee of the hub's service area, in force from `shiftSeconds` after the database's now (a negative number: already), as the owner changes a rate with the guards put aside; the answer
   * puts the setting back as it was.
   */
  const newBaseFee = async (
    amountMinor: number,
    shiftSeconds: number,
  ): Promise<{ readonly id: string; readonly restore: () => Promise<void> }> => {
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    const made = await routes.admin.query<{ id: string }>(
      `insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
       select gen_random_uuid(), hub_id, setting_key, scope_ref, version + 1, jsonb_set(value, '{amount_minor}', to_jsonb($2::int)), unit, clock_timestamp() + make_interval(secs => $3::float8), created_by
         from hub_setting where hub_id = $1 and setting_key = 'service_area_base_fee' and scope_ref = 'ACCRA_TEMA' order by version desc limit 1
       returning id`,
      [HUB_A, amountMinor, shiftSeconds],
    );
    await routes.admin.query('commit');
    const id = made.rows[0]?.id ?? '';
    return {
      id,
      restore: async () => {
        await routes.admin.query('begin');
        await routes.admin.query('set local session_replication_role = replica');
        await routes.admin.query('delete from hub_setting where id = $1', [id]);
        await routes.admin.query('commit');
      },
    };
  };

  /** The company-wide declaration threshold, changed as the owner changes it with the guards put aside (the original is 50,000 pesewas). */
  const setThreshold = async (valueMinor: number): Promise<void> => {
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update setting set value = $1::jsonb where key = 'value_declaration_threshold'`,
      [JSON.stringify(valueMinor)],
    );
    await routes.admin.query('commit');
  };

  /** A lock on a request's row that a test holds, so that a save stops where it asks to hold the request's payer. */
  const holdingTheRequest = async (
    requestId: string,
  ): Promise<{ readonly client: ReturnType<typeof clientFor>; readonly pid: number }> => {
    const client = clientFor(routes.database.urlFor('postgres'));
    await client.connect();
    await client.query('begin');
    await client.query('select id from pickup_request where id = $1 for update', [requestId]);
    return { client, pid: await backendPidOf(client) };
  };

  const baseFeeOf = (config: { setting: (key: string, scope?: string) => { value: unknown } }) =>
    (config.setting('service_area_base_fee', 'ACCRA_TEMA').value as { amount_minor: number })
      .amount_minor;

  /** The digest, asked as an officer who itemizes asks it (and so as the save asks it). */
  const asStaff = async (at: string): Promise<string> =>
    routes.built.service.transactionWithContext(
      {
        ...staffContext([HUB_A]),
        authorizationKey: 'hub.intake.itemize',
        correlationId: randomUUID(),
      },
      async (tx) =>
        String(
          (
            await tx.execute(
              sql`select melarc.hub_configuration_fingerprint(${HUB_A}::uuid, ${at}::timestamptz) as fingerprint`,
            )
          ).rows[0]?.fingerprint,
        ),
    );

  // Break caught: the digest of what is STORED (every row of the hub's settings), which does not change when a version that was stored takes effect, so that a save that waited for the intake carries the rate it read
  // before and makes an order, on a token that matches it, at a price that is no longer the hub's.
  it('refuses an order whose rate took effect while the save waited, though nothing stored changed', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    const second = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    // A version of the fee that is stored and not in force yet: it takes effect six seconds from now, on the database's clock.
    const scheduled = await newBaseFee(4000, 6);
    try {
      const waiting = await reviewedItemization(officer, intake.id, body(c.id));
      const etag = (await read(officer, intake.id)).etag;
      const gate = await holdingTheAuditTable();
      let holding: Promise<TestResponse> | undefined;
      let saving: Promise<TestResponse> | undefined;
      try {
        holding = itemize(second, intake.id, body(b.id));
        const holderPid = await waitForBlockedBackend(
          routes.admin,
          gate.pid,
          'the first save',
          holding,
        );
        saving = officer.client.post(ORDERS(intake.id), waiting, {
          origin: OPS,
          headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
        });
        await waitUntilBlockedBy(routes.admin, holderPid, 'the second save', saving);
        // The save has read the rates (GH₵35: the new version is not in force) and waits for the intake. What the test is about is the version taking effect meanwhile, so it says if it had not begun to wait before.
        const early = await routes.admin.query<{ early: boolean }>(
          `select clock_timestamp() < effective_from as early from hub_setting where id = $1`,
          [scheduled.id],
        );
        expect(
          early.rows[0]?.early,
          'the version took effect before the second save began to wait: the machine is too slow for the lead of this test',
        ).toBe(true);
        // The version takes effect on the database's clock while the save waits: nothing stored changes.
        await waitUntilTrue(
          routes.admin,
          `select clock_timestamp() >= effective_from as ready from hub_setting where id = $1`,
          [scheduled.id],
          'the version taking effect',
        );
        await gate.client.query('commit');
      } catch (error) {
        await gate.client.query('rollback').catch(() => undefined);
        await Promise.allSettled([holding, saving]);
        throw error;
      } finally {
        await gate.client.end();
      }
      orderOf(await started(holding));
      const answer = await started(saving);
      expect(refusal(answer)).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
      expect(
        (answer.json() as { details: { current_terms: Shown } }).details.current_terms.price.total
          .amount_minor,
      ).toBe(4000);
      expect(await countOrders(intake.id)).toBe(2);
    } finally {
      await scheduled.restore();
    }
  });

  // Break caught: a digest that is not of the instant it is asked at (the reader that pairs the rates selected at its instant with a digest of rows that already hold a later version), or a digest that does not
  // change when the version takes effect.
  it('is the digest of what is in force at an instant: a stored version that is not in force yet is not in it, and the moment it takes effect is', async () => {
    const reader = new ConfigurationReader(routes.built.service);
    const before = await reader.forHub(HUB_A, undefined, true);
    expect(baseFeeOf(before)).toBe(3500);
    const scheduled = await newBaseFee(4000, 6);
    try {
      // The row is stored and committed. The configuration at the instant before it, read now, is what it was: the same rate, and the same digest (the digest of the stored rows would have changed).
      const same = await reader.forHub(HUB_A, before.at, true);
      expect(baseFeeOf(same)).toBe(3500);
      expect(same.fingerprint).toBe(before.fingerprint);
      expect(await asStaff(before.at.toISOString())).toBe(before.fingerprint);
      await waitUntilTrue(
        routes.admin,
        `select clock_timestamp() >= effective_from as ready from hub_setting where id = $1`,
        [scheduled.id],
        'the version taking effect',
      );
      const after = await reader.forHub(HUB_A, undefined, true);
      expect(baseFeeOf(after)).toBe(4000);
      expect(after.fingerprint).not.toBe(before.fingerprint);
      // The digest at the instant the save asks it at is the digest of the configuration the reader reads, as an officer and as the reader ask it.
      expect(await asStaff(after.at.toISOString())).toBe(after.fingerprint);
      expect(await asStaff(new Date().toISOString())).not.toBe(before.fingerprint);
    } finally {
      await scheduled.restore();
    }
    // Put back, the digest is what it was.
    expect((await reader.forHub(HUB_A, undefined, true)).fingerprint).toBe(before.fingerprint);
  });

  // Break caught: a digest that leaves out the company rules (the declaration threshold, which decides whether a booking acknowledgement is needed), or one that an officer's context and the reader do not ask alike
  // (every save would then be made again, and given up on).
  it('holds the company rules in the digest, and the configuration reader and an officer who itemizes ask it alike', async () => {
    const reader = new ConfigurationReader(routes.built.service);
    const original = await reader.forHub(HUB_A, undefined, true);
    try {
      await setThreshold(30000);
      const lowered = await reader.forHub(HUB_A, undefined, true);
      expect(lowered.fingerprint).not.toBe(original.fingerprint);
      expect(await asStaff(lowered.at.toISOString())).toBe(lowered.fingerprint);
    } finally {
      await setThreshold(50000);
    }
    expect((await reader.forHub(HUB_A, undefined, true)).fingerprint).toBe(original.fingerprint);
  });

  // Break caught: the configuration compared before the wait for the payer, so that a fee that changed during the wait is judged on the old rates and a token that matches them.
  it('refuses an order whose fee changed while the save waited for the request’s payer, the payer arrangement being the same', async () => {
    const intake = await cleared(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    const waiting = await reviewedItemization(officer, intake.id, body(a.id));
    const etag = (await read(officer, intake.id)).etag;
    const request = await holdingTheRequest(intake.requestId);
    let saving: Promise<TestResponse> | undefined;
    const restore = { current: (): Promise<void> => Promise.resolve() };
    try {
      saving = officer.client.post(ORDERS(intake.id), waiting, {
        origin: OPS,
        headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
      });
      // The save holds the intake and waits for the request's payer, which the other transaction holds for update (and changes nothing).
      await waitUntilBlockedBy(routes.admin, request.pid, 'the save', saving);
      restore.current = (await newBaseFee(4000, -1)).restore;
      await request.client.query('rollback');
    } catch (error) {
      await request.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([saving]);
      await restore.current();
      throw error;
    } finally {
      await request.client.end();
    }
    try {
      const answer = await started(saving);
      expect(refusal(answer)).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
      expect(
        (answer.json() as { details: { current_terms: Shown } }).details.current_terms.price.total
          .amount_minor,
      ).toBe(4000);
      expect(await countOrders(intake.id)).toBe(0);
    } finally {
      await restore.current();
    }
  });

  // Break caught: the same for an amendment, which holds the payer after the intake as the save of an order does.
  it('refuses an amendment whose fee changed while the save waited for the request’s payer, and the quote the order holds stays as it was', async () => {
    const intake = await opened(1);
    const [a] = intake.parcels as [Parcel];
    const made = orderOf(await itemize(officer, intake.id, body(a.id)));
    const shown = await amendmentPreviewOf(officer, made.id, { size_class: 'MEDIUM' });
    const orderEtag = (await officer.client.get(`${API}/orders/${made.id}`)).header('etag') ?? '';
    const request = await holdingTheRequest(intake.requestId);
    let saving: Promise<TestResponse> | undefined;
    const restore = { current: (): Promise<void> => Promise.resolve() };
    try {
      saving = officer.client.request('PATCH', `${API}/orders/${made.id}`, {
        body: { note: 'A medium parcel', size_class: 'MEDIUM', reviewed_terms: shown.terms_token },
        origin: OPS,
        headers: { 'If-Match': orderEtag, 'Idempotency-Key': randomUUID() },
      });
      await waitUntilBlockedBy(routes.admin, request.pid, 'the amendment', saving);
      restore.current = (await newBaseFee(4000, -1)).restore;
      await request.client.query('rollback');
    } catch (error) {
      await request.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([saving]);
      await restore.current();
      throw error;
    } finally {
      await request.client.end();
    }
    try {
      expect(refusal(await started(saving))).toEqual([409, 'STATE_CONFLICT', 'terms_changed']);
      expect((await readOrderView(officer, made.id)).price_components_snapshot.total_minor).toBe(
        3500,
      );
    } finally {
      await restore.current();
    }
  });

  // Break caught: the company rules read once, before the wait, so that an order is made on a declaration threshold that has been lowered and is refused no more than it was.
  it('refuses, with its own code, an order that a company rule changed while the save waited now forbids', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    const second = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    // GH₵400 declared: below the threshold (GH₵500), so no acknowledgement at booking is needed, and the officer reviews it.
    const waiting = await reviewedItemization(
      officer,
      intake.id,
      body(c.id, { declared_value_minor: 40000 }),
    );
    const etag = (await read(officer, intake.id)).etag;
    const gate = await holdingTheAuditTable();
    let holding: Promise<TestResponse> | undefined;
    let saving: Promise<TestResponse> | undefined;
    try {
      holding = itemize(second, intake.id, body(b.id));
      const holderPid = await waitForBlockedBackend(
        routes.admin,
        gate.pid,
        'the first save',
        holding,
      );
      saving = officer.client.post(ORDERS(intake.id), waiting, {
        origin: OPS,
        headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
      });
      await waitUntilBlockedBy(routes.admin, holderPid, 'the second save', saving);
      // The threshold is lowered to GH₵300 while it waits: the declaration is now above it, and the booking recorded no acknowledgement.
      await setThreshold(30000);
      await gate.client.query('commit');
    } catch (error) {
      await gate.client.query('rollback').catch(() => undefined);
      await Promise.allSettled([holding, saving]);
      await setThreshold(50000);
      throw error;
    } finally {
      await gate.client.end();
    }
    try {
      orderOf(await started(holding));
      expect(refusal(await started(saving))).toEqual([
        422,
        'VALUE_DECLARATION_REQUIRED',
        'declaration_required',
      ]);
      expect(await countOrders(intake.id)).toBe(2);
    } finally {
      await setThreshold(50000);
    }
  });

  // Break caught: a save that is made again without end when the configuration keeps moving, an answer of the bound that the screen cannot tell from another conflict, an attempt that leaves an idempotency record
  // behind (the retry would be answered with nothing), or a retry under the same key that makes the order twice.
  it('gives up after three moves of the configuration, says so, leaves nothing behind, and makes the order once under the same key when it holds still', async () => {
    const intake = await cleared(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    const key = randomUUID();
    const reviewed = await reviewedItemization(officer, intake.id, body(a.id));
    const etag = (await read(officer, intake.id)).etag;
    const send = (): Promise<TestResponse> =>
      officer.client.post(ORDERS(intake.id), reviewed, {
        origin: OPS,
        headers: { 'If-Match': etag, 'Idempotency-Key': key },
      });
    // Every attempt of this save moves the hub's fee inside its own transaction, as the record of the key is written (a definer owned by the superuser, so that the attempt cannot be told from a change committed by
    // another): the attempt is taken back and the change with it, and the next one finds the configuration it read, and moves it again.
    await routes.admin.query(
      `create function public.move_the_fee_of_this_save() returns trigger language plpgsql security definer as $$
       begin
         insert into hub_setting (id, hub_id, setting_key, scope_ref, version, value, unit, effective_from, created_by)
         select gen_random_uuid(), hub_id, setting_key, scope_ref, version + 1, jsonb_set(value, '{amount_minor}', '4000'::jsonb), unit, clock_timestamp() - interval '1 second', created_by
           from hub_setting where hub_id = '${HUB_A}' and setting_key = 'service_area_base_fee' and scope_ref = 'ACCRA_TEMA' order by version desc limit 1;
         return new;
       end $$`,
    );
    await routes.admin.query(
      `create trigger move_the_fee_of_this_save after insert on idempotency_record for each row when (new.idempotency_key = '${key}') execute function public.move_the_fee_of_this_save()`,
    );
    try {
      const gaveUp = await send();
      expect(refusal(gaveUp)).toEqual([409, 'STATE_CONFLICT', 'configuration_changing']);
      expect(await countOrders(intake.id)).toBe(0);
      expect(
        Number(
          (
            await routes.rows<{ count: string }>(
              `select count(*) as count from idempotency_record where idempotency_key = $1`,
              [key],
            )
          )[0]?.count,
        ),
      ).toBe(0);
    } finally {
      await routes.admin.query(`drop trigger move_the_fee_of_this_save on idempotency_record`);
      await routes.admin.query(`drop function public.move_the_fee_of_this_save()`);
    }
    // The configuration holds still: the same request under the same key is the order, made once, and a replay is that order.
    const made = orderOf(await send());
    expect(await countOrders(intake.id)).toBe(1);
    const replayed = await send();
    expect(replayed.status).toBe(201);
    expect((replayed.json() as Order).id).toBe(made.id);
    expect(await countOrders(intake.id)).toBe(1);
  });
});

describe('a close that is out of date says so, and the senior reads again (the review of 21 November 2026, finding 6)', () => {
  interface Assessed {
    readonly assessment_token: string;
    readonly intake_state: string;
    readonly closed_at: string | null;
    readonly parity_exception_note: string | null;
  }
  const assessment = async (actor: Actor, id: string): Promise<Assessed> =>
    (await actor.client.get(`${ONE(id)}/closure`)).json() as Assessed;
  const closeAgainst = (
    actor: Actor,
    id: string,
    etag: string,
    body_: unknown,
  ): Promise<TestResponse> =>
    actor.client.post(`${ONE(id)}/close`, body_, {
      origin: OPS,
      headers: { 'If-Match': etag, 'Idempotency-Key': randomUUID() },
    });

  // Break caught: a close that is answered as if the senior had read the intake as it is now, when both the version and the assessment are the ones the senior read before another officer closed it; and a screen that is
  // told nothing it can show of the closed intake.
  it('answers the original version with the original assessment as stale, and the reads then show the intake closed', async () => {
    const intake = await cleared(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    orderOf(await itemize(officer, intake.id, body(b.id)));
    const first = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const second = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const etag = (await read(first, intake.id)).etag;
    const read0 = await assessment(first, intake.id);
    // The other senior reads the same and closes first.
    const closed = await closeAgainst(second, intake.id, (await read(second, intake.id)).etag, {
      reviewed_assessment: (await assessment(second, intake.id)).assessment_token,
      parity_exception: { note: 'One parcel is still with the rider' },
    });
    expect(closed.status, closed.text).toBe(200);
    const late = await closeAgainst(first, intake.id, etag, {
      reviewed_assessment: read0.assessment_token,
      parity_exception: { note: 'One parcel is still with the rider' },
    });
    expect(refusal(late)).toEqual([409, 'STATE_CONFLICT', 'stale']);
    // What the screen shows instead: the intake as it is, closed, and what it was closed for.
    const now = await read(first, intake.id);
    expect(now.intake.state).toBe('CLOSED');
    expect(await assessment(first, intake.id)).toMatchObject({
      intake_state: 'CLOSED',
      parity_exception_note: 'One parcel is still with the rider',
    });
    expect((await assessment(first, intake.id)).closed_at).not.toBeNull();
  });

  // Break caught: the version judged after the assessment, so that a senior is shown a replacement assessment for an intake whose version they also did not read.
  it('judges the version before the assessment: the intake that changed in both says stale, and gives no assessment to close against', async () => {
    const intake = await cleared(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    orderOf(await itemize(officer, intake.id, body(a.id)));
    const first = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const second = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const etag = (await read(first, intake.id)).etag;
    const read0 = await assessment(first, intake.id);
    // Another officer orders two parcels (the assessment changes) and a senior reverses the arrival of one (the version changes).
    const wrongly = orderOf(await itemize(officer, intake.id, body(b.id)));
    orderOf(await itemize(officer, intake.id, body(c.id)));
    const reversed = await second.client.post(
      `${API}/orders/${wrongly.id}/arrival-reversal`,
      { note: 'The parcel did not come' },
      {
        origin: OPS,
        headers: {
          'If-Match': (await second.client.get(`${API}/orders/${wrongly.id}`)).header('etag') ?? '',
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(reversed.status, reversed.text).toBe(200);
    const stale = await closeAgainst(first, intake.id, etag, {
      reviewed_assessment: read0.assessment_token,
      parity_exception: { note: 'Two parcels are still with the rider' },
    });
    expect(refusal(stale)).toEqual([409, 'STATE_CONFLICT', 'stale']);
    expect((stale.json() as { details: Record<string, unknown> }).details).not.toHaveProperty(
      'current_assessment',
    );
  });
});

describe('the vendor’s version, the lock, and the version an order leaves (Run F, Part 1, item 1)', () => {
  const lockRow = async (id: string) =>
    (
      await routes.rows<{
        active_receiver_id: string | null;
        lock_acquired_at: Date | null;
        version: string;
      }>(
        `select active_receiver_id, lock_acquired_at, version::text as version from pickup_intake where id = $1`,
        [id],
      )
    )[0];
  /** What the receiving page does every minute while it is open: it takes the lock again (`acquireIntakeLock`). */
  const renewLock = (actor: Actor, id: string): Promise<TestResponse> =>
    actor.client.post(`${ONE(id)}/lock`, {}, { origin: OPS });

  // Break caught: a renewal of the lock that moves the version an early order is compared on, so that an order made from a page that was read more than a minute ago is refused as stale. The review's premise was the
  // version trigger of migration 0092; 0093 and 0103 left the lock out of what moves the version, and this holds that: the time of the lock moves, the version and the token do not.
  it('leaves an early order valid when the lock is renewed between the read and the save', async () => {
    const intake = await opened(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    expect((await renewLock(officer, intake.id)).status).toBe(200);
    const taken = await lockRow(intake.id);
    expect(taken?.active_receiver_id).not.toBeNull();
    const { etag } = await read(officer, intake.id);

    // The page that is open renews the lock, and the renewal rewrites the moment it was taken.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await renewLock(officer, intake.id)).status).toBe(200);
    const renewed = await lockRow(intake.id);
    expect(renewed?.lock_acquired_at?.getTime()).toBeGreaterThan(
      taken?.lock_acquired_at?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(renewed?.version).toBe(taken?.version);
    expect((await read(officer, intake.id)).etag).toBe(etag);

    // The save of the page that was read before the renewal is valid, and so is the next early order on the same read: an early order moves nothing the token is made of.
    expect((await itemize(officer, intake.id, body(a.id), { etag })).status).toBe(201);
    expect((await renewLock(officer, intake.id)).status).toBe(200);
    expect((await itemize(officer, intake.id, body(b.id), { etag })).status).toBe(201);
    expect((await read(officer, intake.id)).etag).toBe(etag);
  });

  // Break caught: a token that no longer judges anything (an order accepted on a read that the vendor's own check-in has overtaken): the vendor finished by another officer is a real change, and an early order
  // made from the page read before it is stale, with the lock renewed or not.
  it('still answers stale when the vendor really changed since the read', async () => {
    const intake = await opened(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    const { etag } = await read(officer, intake.id);
    const other = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    expect((await finishAsTapped(other, intake.id)).status).toBe(200);
    expect(refusal(await itemize(officer, intake.id, body(a.id), { etag }))).toEqual([
      409,
      'STATE_CONFLICT',
      'stale',
    ]);
    expect(await countOrders(intake.id)).toBe(0);
  });

  // Break caught: an answer that leaves the screen to read the vendor again before it can make the next order (the first order of a cleared vendor moves it from ready to being worked, so the token it
  // was read at is stale for the next order): the 201 carries the vendor's new token, a replay carries the vendor's token as it is then, and the next order is made on it with no read between.
  it('answers the vendor’s token as it is after the order, so the next order needs no read', async () => {
    const intake = await cleared(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    const before = (await read(officer, intake.id)).etag;
    const key = randomUUID();
    const sent = await reviewedItemization(officer, intake.id, body(a.id));
    const first = await itemize(officer, intake.id, sent, { etag: before, key, review: false });
    const made = orderOf(first);
    const after = first.header('intake-etag');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(after).toBe((await read(officer, intake.id)).etag);
    // The order's own representation has no token the vendor's could be taken for.
    expect(first.header('etag')).toBeNull();

    // The next order is made on that token, with no read of the vendor in between, and the token is the same after it (a second order moves nothing).
    const next = await itemize(officer, intake.id, body(b.id), { etag: after });
    expect(next.status, next.text).toBe(201);
    expect(next.header('intake-etag')).toBe(after);

    // A retry of the first answers the order it made and the vendor's token as it is at the retry.
    const again = await itemize(officer, intake.id, sent, { etag: before, key, review: false });
    expect(again.status).toBe(201);
    expect((again.json() as Order).id).toBe(made.id);
    expect(again.header('intake-etag')).toBe(after);
    expect(await countOrders(intake.id)).toBe(2);

    // An early order leaves the token where it was.
    const early = await opened(2);
    const [e] = early.parcels as [Parcel, Parcel];
    const waiting = await itemize(officer, early.id, body(e.id));
    expect(waiting.status).toBe(201);
    expect(waiting.header('intake-etag')).toBe((await read(officer, early.id)).etag);
  });
});

describe('the worklist finds the reversed order of a parcel by an index (Run F, Part 1, item 2)', () => {
  interface PlanNode {
    readonly 'Node Type': string;
    readonly 'Relation Name'?: string;
    readonly 'Index Name'?: string;
    readonly Filter?: string;
    readonly Plans?: readonly PlanNode[];
  }
  const nodesOf = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];

  /**
   * The plan of the statement the worklist runs: the body of the live function with its parameters given, as the administrator's connection plans it (the row-level policies the function's own role is held to add
   * conditions to every table, and are not in this plan; the index a lookup uses is the same).
   */
  async function planOfWorklist(intakeId: string, settings: string[] = []): Promise<PlanNode> {
    const source = await routes.rows<{ prosrc: string }>(
      `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'melarc' and p.proname = 'intake_worklist'`,
    );
    const match = /RETURN QUERY\s+([\s\S]*?);\s*END\s*$/i.exec(source[0]?.prosrc ?? '');
    expect(match, 'the worklist function is one statement that returns a query').not.toBeNull();
    const statement = (match?.[1] ?? '')
      .replace(/\bp_intake\b/g, `'${intakeId}'::uuid`)
      .replace(/\bp_view\b/g, `'all'::text`)
      .replace(/\bp_after_n\b/g, 'NULL::bigint')
      .replace(/\bp_after_id\b/g, 'NULL::uuid')
      .replace(/\bp_limit\b/g, '100');
    await routes.admin.query('begin');
    try {
      for (const setting of settings) await routes.admin.query(`set local ${setting}`);
      const planned = await routes.admin.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
        `explain (format json) ${statement}`,
      );
      const root = planned.rows[0]?.['QUERY PLAN'][0]?.Plan;
      if (root === undefined) throw new Error('the statement has no plan');
      return root;
    } finally {
      await routes.admin.query('rollback');
    }
  }

  /** Order rows of other intakes, as a hub that has been working for years holds them: copies of an order of the test, with the guards put aside as the other tests arrange a world the application cannot make. */
  async function fillTheOrderTable(from: string, rows: number): Promise<void> {
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `insert into "order"
       select (jsonb_populate_record(null::"order", to_jsonb(o) || jsonb_build_object('id', gen_random_uuid(), 'code', 'FILL-' || g, 'pickup_intake_id', gen_random_uuid(), 'intake_parcel_id', null))).*
         from "order" as o cross join generate_series(1, $2::int) as g where o.id = $1`,
      [from, rows],
    );
    await routes.admin.query('commit');
    await routes.admin.query('analyze "order"');
  }
  const emptyTheOrderTable = async (): Promise<void> => {
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(`delete from "order" where code like 'FILL-%'`);
    await routes.admin.query('commit');
  };

  // Break caught: a worklist that finds each parcel's reversed order by a scan of the whole order table, twice for every row of every page (the two scalar lookups of 0118 that no index could serve): in the plan of
  // the live function, with the table as large as a hub's years of orders and an intake of 150 parcels with orders and two that were taken back, no node scans the order table for them, and the partial index of 0121 is
  // the one the lookup uses. The worklist still answers the reversed order beside the parcel that has none that stands.
  it('reads the reversed orders of 150 parcels by index, with the order table at the size of years of work', async () => {
    const intake = await cleared(150);
    const parcels = intake.parcels.slice(0, 6);
    const made: Order[] = [];
    for (const parcel of parcels)
      made.push(orderOf(await itemize(officer, intake.id, body(parcel.id))));
    const boss = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    for (const order of made.slice(0, 2)) {
      const reversed = await boss.client.post(
        `${API}/orders/${order.id}/arrival-reversal`,
        { note: 'The wrong parcel was ticked' },
        {
          origin: OPS,
          headers: {
            'If-Match': (await boss.client.get(`${API}/orders/${order.id}`)).header('etag') ?? '',
            'Idempotency-Key': randomUUID(),
          },
        },
      );
      expect(reversed.status, reversed.text).toBe(200);
    }
    try {
      await fillTheOrderTable(present(made, 2).id, 20_000);

      // The plan the planner chooses, and the plan with every scan of a table put aside where an index can serve: neither reads the order table in full for the reversed orders.
      const chosen = nodesOf(await planOfWorklist(intake.id)).filter(
        (node) => node['Relation Name'] === 'order',
      );
      expect(
        chosen.filter(
          (node) =>
            node['Node Type'] === 'Seq Scan' && (node.Filter ?? '').includes("= 'REVERSED'"),
        ),
        'a sequential scan of the order table for a reversed order',
      ).toEqual([]);
      expect(chosen.some((node) => node['Index Name'] === 'order_reversed_parcel_idx')).toBe(true);
      const indexed = nodesOf(await planOfWorklist(intake.id, ['enable_seqscan = off'])).filter(
        (node) => node['Relation Name'] === 'order',
      );
      expect(
        indexed.filter((node) => node['Node Type'] === 'Seq Scan'),
        'a scan of the order table that no index serves',
      ).toEqual([]);

      // The worklist says what it said: the parcel has no order that stands, and the order that was taken back is shown beside it.
      const page = (
        await officer.client.get(`${ORDERS(intake.id)}?view=all&page_size=100`)
      ).json() as {
        items: {
          parcel: { id: string };
          order: { id: string } | null;
          reversed_order: { id: string } | null;
        }[];
      };
      expect(page.items).toHaveLength(100);
      for (const [index, order] of made.entries()) {
        const item = page.items.find((candidate) => candidate.parcel.id === parcels[index]?.id);
        expect(item?.reversed_order?.id ?? null, `parcel ${String(index)}`).toBe(
          index < 2 ? order.id : null,
        );
        expect(item?.order?.id ?? null, `parcel ${String(index)}`).toBe(
          index < 2 ? null : order.id,
        );
      }
    } finally {
      await emptyTheOrderTable();
    }
  }, 300_000);
});

describe('what the counts of an intake counted blind say (Run F, Part 1, item 3)', () => {
  const VIEWS = [
    'needs_order',
    'awaiting_arrival',
    'prepared',
    'itemized',
    'payment_required',
    'missing',
  ] as const;
  interface Listed {
    readonly progress: Record<string, number | null>;
    readonly items: readonly unknown[];
  }
  const listed = async (id: string, view: string): Promise<Listed> => {
    const response = await officer.client.get(`${ORDERS(id)}?view=${view}&page_size=100`);
    expect(response.status, response.text).toBe(200);
    return response.json() as Listed;
  };

  // Break caught: the contract's statement that every count is the number of rows of its view, which is false for the orders still to be made of a blind intake: the number is the count less the orders made (what a screen
  // says as "N more orders needed"), and the view of that name opens no rows (no parcel exists to list), while every other count of the intake is the number of rows of its own view. 5.119.0 states exactly that.
  it('is the orders still to be made, a number with no rows, and every other count is the rows of its view', async () => {
    const intake = await blind(4);
    orderOf(await itemize(officer, intake.id, body(null)));
    orderOf(await itemize(officer, intake.id, body(null)));
    const whole = await listed(intake.id, 'all');
    expect(whole.progress).toMatchObject({
      received: 4,
      orders: 2,
      needs_order: 2,
      awaiting_arrival: 0,
      missing: 0,
    });
    expect(whole.items).toHaveLength(2);
    // The number of the orders still to be made has no rows to open.
    expect((await listed(intake.id, 'needs_order')).items).toHaveLength(0);
    // Every other count is the rows of the view of its name.
    for (const view of VIEWS.filter((name) => name !== 'needs_order')) {
      expect((await listed(intake.id, view)).items, view).toHaveLength(
        Number(whole.progress[view]),
      );
    }
    // The last order leaves nothing to make, and the number says so.
    orderOf(await itemize(officer, intake.id, body(null)));
    orderOf(await itemize(officer, intake.id, body(null)));
    expect((await listed(intake.id, 'all')).progress).toMatchObject({ needs_order: 0, orders: 4 });
  });
});

describe('the zone an order keeps is declared by the contract (Run F, Part 1, item 4)', () => {
  /** The contract's own schema of the snapshot, compiled by the validator the application enforces the contract with. */
  function snapshotValidator() {
    const contract = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as {
      components: { schemas: Record<string, object | undefined> };
    };
    const schema = contract.components.schemas.DestinationZoneSnapshot;
    expect(schema, 'the contract declares DestinationZoneSnapshot').toBeDefined();
    const requireModule = createRequire(import.meta.url);
    const { Ajv2020 } = requireModule('ajv/dist/2020.js') as {
      Ajv2020: new (options: object) => {
        compile(schema: object): (value: unknown) => boolean;
      };
    };
    const addFormats = requireModule('ajv-formats') as (ajv: unknown) => unknown;
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    return ajv.compile(schema ?? {});
  }

  // Break caught: a snapshot that the screens read members from while the contract called it a free object: every snapshot the server writes (a zone placed by its alias, one an officer chose with a note, a parcel that
  // goes outside the service area) is held to the declaration, in the order's answer and in the preview's, and the declaration refuses what is not a snapshot (an unknown scope, a missing scope, a member nobody
  // declared, an area that is no area of the launch hub).
  it('holds the three snapshots the server writes, in the order and in its preview, and refuses what is none', async () => {
    const validate = snapshotValidator();
    const intake = await cleared(4);
    const [a, b, c, d] = intake.parcels as [Parcel, Parcel, Parcel, Parcel];
    const place = (address: string) => ({
      name: 'Ama',
      phone: '0241234567',
      location: { address },
    });

    const placed = orderOf(await itemize(officer, intake.id, body(a.id)));
    expect(validate(placed.destination_zone_snapshot)).toBe(true);
    expect(placed.destination_zone_snapshot).toMatchObject({
      scope: 'SERVICE_AREA',
      zone_name: ZONE_A.name,
      service_area: 'ACCRA_TEMA',
      alias: 'madina',
    });

    const chosen = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, {
          recipient: place('Madina Adenta road'),
          destination_zone_authorization: {
            zone_id: ZONE_B.id,
            note: 'The sender phoned from Adenta',
          },
        }),
      ),
    );
    expect(validate(chosen.destination_zone_snapshot)).toBe(true);
    expect(chosen.destination_zone_snapshot).toMatchObject({
      authorization_note: 'The sender phoned from Adenta',
    });

    const waybill = await storedIntakeEvidence(routes, officer, intake.id, 'ITEMIZATION');
    const outside = orderOf(
      await itemize(
        officer,
        intake.id,
        body(c.id, {
          lane: 'THIRD_PARTY_HANDOFF',
          commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
          recipient: place('Adum, Kumasi'),
          carrier_cost: { amount_minor: 5000, currency: 'GHS' },
          carrier_waybill_evidence_id: waybill,
        }),
      ),
    );
    expect(outside.destination_zone_snapshot).toEqual({ scope: 'OUTSIDE_SERVICE_AREA' });
    expect(validate(outside.destination_zone_snapshot)).toBe(true);

    // The preview of an order says the same of the zone it would keep.
    const preview = (
      await officer.client.post(`${ONE(intake.id)}/orders/preview`, body(d.id), { origin: OPS })
    ).json() as { destination_zone_snapshot: unknown };
    expect(validate(preview.destination_zone_snapshot)).toBe(true);

    expect(validate({})).toBe(false);
    expect(validate({ scope: 'SOMEWHERE' })).toBe(false);
    expect(validate({ scope: 'SERVICE_AREA', zone_colour: 'red' })).toBe(false);
    expect(validate({ scope: 'SERVICE_AREA', service_area: 'THE_MOON' })).toBe(false);
  });
});

describe('an order made early for a parcel that is then written off stays as a record (Run F, Part 1, D-S7-4; OB-S1-120)', () => {
  const written = async (): Promise<{
    intake: Arranged;
    early: Order;
    kept: Order[];
    boss: Actor;
    missing: Parcel;
  }> => {
    const intake = await opened(3);
    const [a, b, c] = intake.parcels as [Parcel, Parcel, Parcel];
    // An order made early for the parcel that does not come, and for the two that do.
    const early = orderOf(await itemize(officer, intake.id, body(b.id)));
    expect((await tap(officer, a.id, true)).status).toBe(200);
    expect((await tap(officer, c.id, true)).status).toBe(200);
    expect((await finishAsTapped(officer, intake.id)).status).toBe(200);
    const boss = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const decided = await boss.client.post(
      `${ONE(intake.id)}/discrepancy`,
      { outcome: 'WRITTEN_OFF', note: 'Not found after a day’s search' },
      { origin: OPS, headers: { 'If-Match': (await read(boss, intake.id)).etag } },
    );
    expect(decided.status, decided.text).toBe(200);
    const kept = [
      orderOf(await itemize(officer, intake.id, body(a.id))),
      orderOf(await itemize(officer, intake.id, body(c.id))),
    ];
    return { intake, early, kept, boss, missing: b };
  };

  // Break caught: after a write-off, an early order that is priced and frozen by a late tap, counted by the progress or by the close, shown in the vendor's summary, or told to a vendor as a charge: the order is a record
  // of what the officer prepared, with no price that stands, and the vendor who reads it is told the parcel was not received. Two parcels arrive and are ordered, and the close has parity without it.
  it('is never frozen, counted or summarised, and the vendor is told the parcel was not received', async () => {
    const { intake, early, kept, boss, missing } = await written();
    expect(await orderRow(early.id)).toMatchObject({
      commercial_state: null,
      locked_price_minor: null,
    });
    // A tap after the write-off does not bring the parcel back and freeze its order.
    const late = await tap(officer, missing.id, true);
    expect(await orderRow(early.id)).toMatchObject({
      commercial_state: null,
      locked_price_minor: null,
    });
    expect([late.status].every((status) => status === 200 || status === 409)).toBe(true);

    // The worklist keeps the record beside its parcel, as missing, and the counts leave it out.
    const list = (
      await officer.client.get(`${ORDERS(intake.id)}?view=all&page_size=100`)
    ).json() as {
      progress: Record<string, number | null>;
      items: { work_state: string; parcel: { id: string } | null; order: { id: string } | null }[];
    };
    expect(list.items.find((item) => item.parcel?.id === missing.id)).toMatchObject({
      work_state: 'MISSING',
      order: { id: early.id },
    });
    expect(list.progress).toMatchObject({ missing: 1, orders: 2, itemized: 2, needs_order: 0 });

    // The close has parity: the two parcels that arrived have their orders, and the record of the one that did not is not among them.
    const closed = await officer.client.post(`${ONE(intake.id)}/close`, undefined, {
      origin: OPS,
      headers: {
        'If-Match': (await read(officer, intake.id)).etag,
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(closed.status, closed.text).toBe(200);

    // The vendor is shown the two orders that stand, and reads the record of the third: no price, nothing to pay, and the parcel was not received.
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    const summary = (await browser.get(`${ONE(intake.id)}/summary`)).json() as {
      orders: { id: string }[];
    };
    expect(summary.orders.map((order) => order.id).toSorted()).toEqual(
      kept.map((order) => order.id).toSorted(),
    );
    const seen = await browser.get(`${API}/orders/${early.id}`);
    expect(seen.status, seen.text).toBe(200);
    const shown = seen.json() as Record<string, unknown>;
    expect(shown).toMatchObject({
      intake_parcel_state: 'MISSING',
      commercial_state: null,
      locked_price: null,
    });
    expect(shown).not.toHaveProperty('payer_allocation');
    expect(shown).not.toHaveProperty('price_components_snapshot');
    // The staff read the same record, and a price they are shown is the early quote, said so.
    expect(await readOrderView(boss, early.id)).toMatchObject({
      intake_parcel_state: 'MISSING',
      price_status: 'EARLY_QUOTE',
      locked_price: null,
    });
  });
});

describe('the state of a parcel is told to the vendor of its order and to nobody else (Run F, Part 1, D-S7-4; migration 0122)', () => {
  const stateAs = async (
    context: Parameters<typeof routes.built.service.transactionWithContext>[0],
    orderId: string,
  ): Promise<string | null> =>
    routes.built.service.transactionWithContext(context, async (tx) => {
      const found = await tx.execute(
        sql`select melarc.vendor_order_parcel_state(${orderId}::uuid) as state`,
      );
      return (found.rows[0] as { state: string | null }).state;
    });

  // Break caught: a function that tells any vendor the state of any parcel (another vendor's included), that answers a staff caller or a vendor asking under another key, or that reads the parcel of an order that was
  // taken back: the function answers the state of the parcel of the vendor's OWN order, and refuses everyone else; the owner's policy on the parcels names the vendor's organisation through its order.
  it('answers the vendor of the order and refuses another vendor, a staff caller and another key', async () => {
    const intake = await opened(2);
    const [a] = intake.parcels as [Parcel, Parcel];
    const early = orderOf(await itemize(officer, intake.id, body(a.id)));
    const key = (organisation: string) => ({
      ...vendorContext(organisation),
      authorizationKey: 'pricing.read',
      correlationId: randomUUID(),
    });
    // The vendor of the order is told the parcel is still expected; another vendor is told nothing; neither is told by a staff session or under another key.
    expect(await stateAs(key(vendor.row.organizationId), early.id)).toBe('EXPECTED');
    const other = await routes.vendor();
    expect(await stateAs(key(other.row.organizationId), early.id)).toBeNull();
    await expect(
      stateAs(
        { ...staffContext([HUB_A]), authorizationKey: 'pricing.read', correlationId: randomUUID() },
        early.id,
      ),
    ).rejects.toThrow();
    await expect(
      stateAs(
        {
          ...vendorContext(vendor.row.organizationId),
          authorizationKey: 'pickup.read',
          correlationId: randomUUID(),
        },
        early.id,
      ),
    ).rejects.toThrow();
    // The vendor cannot select the parcels themselves, whatever the function does: the policy admits the owner alone.
    const direct = await routes.built.service.transactionWithContext(
      key(vendor.row.organizationId),
      async (tx) =>
        (await tx.execute(sql`select count(*)::int as n from intake_parcel`)).rows[0] as {
          n: number;
        },
    );
    expect(direct.n).toBe(0);
  });
});

describe('a vendor sees who pays what on its own orders (Run F, Part 1, D-S7-10; OB-S1-144)', () => {
  const SUMMARY = (id: string): string => `${ONE(id)}/summary`;
  const close = async (actor: Actor, id: string): Promise<TestResponse> =>
    actor.client.post(`${ONE(id)}/close`, undefined, {
      origin: OPS,
      headers: { 'If-Match': (await read(actor, id)).etag, 'Idempotency-Key': randomUUID() },
    });
  interface Shown {
    id: string;
    locked_price?: { amount_minor: number };
    payer_allocation?: { sender_minor: number; recipient_minor: number };
  }
  const summaryOf = async (actor: { get: (path: string) => Promise<TestResponse> }, id: string) => {
    const seen = await actor.get(SUMMARY(id));
    expect(seen.status, seen.text).toBe(200);
    return (seen.json() as { orders: Shown[] }).orders;
  };

  // Break caught: a vendor who is shown the price of its orders and not who pays it (the vendor's portion and the recipient's), a portion that is shown where the price is not (an amount is money: left out, never a zero),
  // or a portion of the summary that is not the one `getOrder` reads. The first order is paid by its recipient and the second by its sender: the amounts add up to the locked price, whoever reads them.
  it('carries the portions beside the price in the summary and in the order, and where the price is left out so are they', async () => {
    const intake = await cleared(2);
    const [a, b] = intake.parcels as [Parcel, Parcel];
    const recipientPays = orderOf(await itemize(officer, intake.id, body(a.id)));
    const senderPays = orderOf(
      await itemize(
        officer,
        intake.id,
        body(b.id, { payer_override: { payer_intent: 'SENDER_PAYS_FULL' } }),
      ),
    );
    expect((await close(officer, intake.id)).status).toBe(200);

    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    const mine = await summaryOf(browser, intake.id);
    const portions = new Map(mine.map((order) => [order.id, order.payer_allocation]));
    expect(portions.get(recipientPays.id)).toEqual({ sender_minor: 0, recipient_minor: 3500 });
    expect(portions.get(senderPays.id)).toEqual({ sender_minor: 3500, recipient_minor: 0 });
    for (const order of mine) {
      const shown = order.payer_allocation;
      expect((shown?.sender_minor ?? -1) + (shown?.recipient_minor ?? 0)).toBe(
        order.locked_price?.amount_minor,
      );
    }
    // The order the vendor reads by itself says the same.
    for (const order of [recipientPays, senderPays]) {
      const read = (await browser.get(`${API}/orders/${order.id}`)).json() as Shown;
      expect(read.payer_allocation).toEqual(portions.get(order.id));
    }
    // Staff are told them where the price is shown, and where it is left out so are the portions.
    for (const order of await summaryOf(officer.client, intake.id)) {
      expect(order.payer_allocation).toEqual(portions.get(order.id));
    }
    const pickupOnly = await newBundle(routes.admin, [grant('pickup.read', 'own')]);
    for (const order of await summaryOf(
      (await routes.actor(pickupOnly, HUB_A)).client,
      intake.id,
    )) {
      expect(order).not.toHaveProperty('locked_price');
      expect(order).not.toHaveProperty('payer_allocation');
    }
  });
});

describe('the zones of the hub an intake belongs to (Run F, Part 1, D-S7-5; OB-S1-165)', () => {
  const ZONES = (id: string): string => `${ONE(id)}/destination-zones`;
  interface Offered {
    items: { zone_id: string; name: string }[];
  }

  // Break caught: a form that cannot offer the choice of a zone for an address no zone matches (the officer who knows the zone cannot say it), a list that carries another hub's zones, an inactive zone or more of a zone
  // than its identifier and its name, one that is read by a session without the key to itemize, by a vendor or for an intake of another hub, or an unknown intake that is answered as an empty list.
  it('lists the active zones of the intake’s hub by name and nothing more, for the officers who itemize, and the officer’s choice is then accepted', async () => {
    const intake = await opened(2);
    const expected = await routes.rows<{ id: string; name: string }>(
      `select id, name from service_zone where hub_id = $1 and active order by name, id`,
      [HUB_A],
    );
    expect(expected.length).toBeGreaterThanOrEqual(3);
    const listed = await officer.client.get(ZONES(intake.id));
    expect(listed.status, listed.text).toBe(200);
    const { items } = listed.json() as Offered;
    expect(items).toEqual(expected.map((zone) => ({ zone_id: zone.id, name: zone.name })));
    for (const item of items) expect(Object.keys(item).toSorted()).toEqual(['name', 'zone_id']);
    // No zone of another hub is in the list: every zone of it is a zone of this hub.
    const foreign = await routes.rows<{ id: string }>(
      `select id from service_zone where hub_id <> $1`,
      [HUB_A],
    );
    for (const zone of foreign) expect(items.map((item) => item.zone_id)).not.toContain(zone.id);

    // A zone that is not active is not offered (the guards put aside, as the other tests arrange a world the application cannot make), and is back when it is.
    const hidden = present(expected, 0);
    const setActive = async (active: boolean): Promise<void> => {
      await routes.admin.query('begin');
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query('update service_zone set active = $2 where id = $1', [
        hidden.id,
        active,
      ]);
      await routes.admin.query('commit');
    };
    await setActive(false);
    try {
      const without = (await officer.client.get(ZONES(intake.id))).json() as Offered;
      expect(without.items.map((item) => item.zone_id)).not.toContain(hidden.id);
      expect(without.items).toHaveLength(items.length - 1);
    } finally {
      await setActive(true);
    }

    // The choice the form then sends, for an address no zone matches, is the one the order is made with.
    const [a] = intake.parcels as [Parcel, Parcel];
    const chosen = present(items, items.length - 1);
    const refused = await itemize(
      officer,
      intake.id,
      body(a.id, {
        recipient: { name: 'Kofi', phone: '0201112233', location: { address: 'Adum, Kumasi' } },
      }),
    );
    expect(refusal(refused)).toEqual([422, 'SETTING_MISSING', 'destination_zone_unresolved']);
    const made = orderOf(
      await itemize(
        officer,
        intake.id,
        body(a.id, {
          recipient: { name: 'Kofi', phone: '0201112233', location: { address: 'Adum, Kumasi' } },
          destination_zone_authorization: {
            zone_id: chosen.zone_id,
            note: 'The sender phoned and said it is for this zone',
          },
        }),
      ),
    );
    expect(made.destination_zone_resolution).toBe('EXPLICITLY_AUTHORIZED');
    expect(made.destination_zone_snapshot).toMatchObject({ zone_id: chosen.zone_id });
  });

  // Break caught: a read of the zones for another hub's intake, for an unknown one or by a session that does not hold the key.
  it('is for the hub’s own officers who hold the key: another hub, an unknown intake, a reader without the key and a vendor are refused', async () => {
    const intake = await opened(1);
    expect(refusal(await otherHub.client.get(ZONES(intake.id)))[1]).toBe('HUB_SCOPE_VIOLATION');
    expect((await officer.client.get(ZONES(randomUUID()))).status).toBe(404);
    const readOnly = await routes.actor(
      await newBundle(routes.admin, [grant('hub.read', 'own')]),
      HUB_A,
    );
    expect(refusal(await readOnly.client.get(ZONES(intake.id))).slice(0, 2)).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    const browser = routes.browser(vendor.device.credential.token);
    expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
      200,
    );
    expect((await browser.get(ZONES(intake.id))).status).toBe(403);
  });
});
