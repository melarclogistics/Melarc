import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  toContextSettings,
  type SecurityContext,
} from '../../src/platform/database/transaction-context.js';
import { handOver } from './support/handed-over.js';
import { waitUntilBlockedBy } from './support/lock-wait.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { holdingPickupRequest } from './support/pickups.js';
import { seedHubConfiguration } from './support/seeded.js';
import { HUB_A, HUB_B } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.36 (`itemizeOrder`; migration 0110): the database layer of the order and its first commitment, against a real PostgreSQL. **What the database holds for every writer**
 * (features/hub/itemization.md sections 5.1, 5.2 and 5.4; domain-model.md section 6.7 and `DeliveryCommitment`; state-machines.md sections 7 and 8; `AC-SLICE-001-47` to `-59`, `-90`, `-104`):
 *
 * - **An order is made for a parcel of its own intake, once**, in the states of the machines of the intake and of the parcel (an order for an arrived parcel once the vendor is cleared; an order that
 *   waits for a parcel not yet checked in while the vendor's check-in is open; never for a missing or void parcel), with its hub, sender and moment the database's.
 * - **Its price is calculated when it is made and frozen when its parcel's arrival is committed**: a parcel that has arrived is frozen at once and moves the intake to ITEMIZING; an order that waits is
 *   confirmed by `freeze_orders` once the vendor is finished, to the price that was calculated, with portions resolved from the payer arrangement as it then stands; a locked price is never rewritten.
 * - **Its first promise is written with it**, at the moment custody passed (read from the collection, never the writer's), by a deferred key that makes an order without one impossible to commit.
 * - **A parcel whose order is priced is not taken back.**
 *
 * The operations run as the application's login with a staff context (the policies and the grants judge them as they do the application's); the guards run as the owner under each key, in
 * transactions that are rolled back, and what is deferred through the administrator's own transaction.
 */
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

const ITEMIZE = 'hub.intake.itemize';
const COUNT = 'hub.intake.count';
const OSD = 'hub.osd.adjudicate';
const READ = 'hub.read';

const staff = (
  key: string,
  hubs: readonly string[] | 'ALL' = [HUB_A],
  principalId: string = randomUUID(),
): SecurityContext => ({
  principalType: 'STAFF',
  principalId,
  sessionId: randomUUID(),
  surface: 'OPS_PORTAL',
  authorizationKey: key,
  hubScopeMode: hubs === 'ALL' ? 'ALL' : 'SET',
  authorizedHubIds: hubs === 'ALL' ? [] : [...hubs],
  correlationId: 'hub-orders',
});

interface Failure {
  readonly code: string | undefined;
  readonly message: string;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
}
type Result = { readonly rows: Record<string, unknown>[] } | Failure;
const failed = (result: Result): result is Failure => 'code' in result;

/** What a statement does as the application's login under a context: the rows it returned, or the SQLSTATE, the DETAIL and the HINT of the error the database raised. */
async function attemptAll(context: SecurityContext, texts: readonly string[]): Promise<Result> {
  try {
    const rows = await routes.built.service.transactionWithContext(context, async (tx) => {
      let last: unknown[] = [];
      for (const text of texts) last = (await tx.execute(sql.raw(text))).rows;
      return last as Record<string, unknown>[];
    });
    return { rows };
  } catch (error) {
    const server = serverErrorIn(error);
    return {
      code: server?.code ?? 'other',
      message: server?.message ?? String(error),
      detail: server?.detail,
      hint: server?.hint,
    };
  }
}
const attempt = (context: SecurityContext, text: string): Promise<Result> =>
  attemptAll(context, [text]);
const rowsOf = (result: Result): Record<string, unknown>[] => {
  if (failed(result)) throw new Error(`refused: ${result.code ?? '?'} ${result.message}`);
  return result.rows;
};
/** The refusal a rule of the database names: the SQLSTATE, the reason of the DETAIL (`reason=...`) and the rule of the HINT (`rule=...`). */
const refusal = (result: Result): [string | undefined, string | undefined, string | undefined] =>
  failed(result)
    ? [result.code, result.detail?.replace(/^reason=/, ''), result.hint?.replace(/^rule=/, '')]
    : ['none', undefined, undefined];

/** What statements do as the owner under a context, in a transaction that is always rolled back: `ran:<rows of the last>` or the SQLSTATE and the message of the refusal. */
async function asOwner(context: SecurityContext, texts: readonly string[]): Promise<string> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local role melarc_owner');
    for (const [name, value] of toContextSettings(context))
      await routes.admin.query('select set_config($1, $2, true)', [name, value]);
    let last = 0;
    for (const text of texts) last = (await routes.admin.query(text)).rowCount ?? 0;
    return `ran:${String(last)}`;
  } catch (error) {
    const server = serverErrorIn(error);
    return `${server?.code ?? 'other'}:${server?.message ?? String(error)}`;
  } finally {
    await routes.admin.query('rollback');
  }
}

/** What the administrator's transaction does, judged as the database judges its end: `committed` or the SQLSTATE and the constraint of the error. */
async function adminCommit(
  statements: readonly string[],
): Promise<
  { readonly code: string | undefined; readonly constraint: string | undefined } | 'committed'
> {
  await routes.admin.query('begin');
  try {
    for (const statement of statements) await routes.admin.query(statement);
    await routes.admin.query('commit');
    return 'committed';
  } catch (error) {
    await routes.admin.query('rollback').catch(() => undefined);
    const server = serverErrorIn(error);
    return { code: server?.code, constraint: server?.constraint };
  }
}

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
interface IntakeRow {
  readonly state: string;
  readonly version: number;
}
interface OrderRow {
  readonly id: string;
  readonly code: string;
  readonly pickup_intake_id: string;
  readonly responsible_hub_id: string;
  readonly intake_parcel_id: string | null;
  readonly vendor_organization_id: string | null;
  readonly ad_hoc_sender_id: string | null;
  readonly commercial_state: string | null;
  readonly fulfilment_state: string;
  readonly locked_price_minor: number | null;
  readonly locked_at: Date | null;
  readonly payer_allocation: {
    sender_minor: number;
    recipient_minor: number;
    payer_intent: string;
  } | null;
  readonly price_components_snapshot: { total_minor: number };
  readonly derived_delivery_date: string;
  readonly origin_zone_snapshot: Record<string, unknown>;
  readonly size_class: string;
  readonly size_class_selected_by: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly version: number;
  readonly is_high_value: boolean;
  readonly high_value_evidence_ids: string[];
  readonly carrier_waybill_evidence_id: string | null;
  readonly payer_override_applied: boolean;
  readonly initial_commitment_id: string;
}
interface CommitmentRow {
  readonly id: string;
  readonly order_id: string;
  readonly responsible_hub_id: string;
  readonly sequence: number;
  readonly default_date: string;
  readonly requested_date: string | null;
  readonly committed_date: string;
  readonly committed_window_start: string | null;
  readonly committed_window_end: string | null;
  readonly sla_start_at: Date;
  readonly superseded_at: Date | null;
}

const parcelsOf = (intakeId: string): Promise<Parcel[]> =>
  routes.rows<Parcel>(
    `select id, state from intake_parcel where pickup_intake_id = $1 order by ordinal`,
    [intakeId],
  );
const intakeOf = async (id: string): Promise<IntakeRow> => {
  const [row] = await routes.rows<IntakeRow>(
    `select state, version from pickup_intake where id = $1`,
    [id],
  );
  if (row === undefined) throw new Error('no such intake');
  return row;
};
const orderOf = async (id: string): Promise<OrderRow> => {
  const [row] = await routes.rows<OrderRow>(`select * from "order" where id = $1`, [id]);
  if (row === undefined) throw new Error('no such order');
  return row;
};
const commitmentsOf = (orderId: string): Promise<CommitmentRow[]> =>
  routes.rows<CommitmentRow>(
    `select id, order_id, responsible_hub_id, sequence, default_date::text, requested_date::text, committed_date::text, committed_window_start::text, committed_window_end::text,
            sla_start_at, superseded_at from delivery_commitment where order_id = $1 order by sequence`,
    [orderId],
  );

interface Arranged {
  readonly id: string;
  readonly requestId: string;
  readonly stopId: string;
  readonly parcels: readonly Parcel[];
  /** The moment custody passed: the handshake of the stop's collection record. */
  readonly custody: Date;
}

/**
 * A photo intake as the real handover leaves it (the vendor's check-in open: `AWAITING_COUNT`, every parcel `EXPECTED`), whose stop's collection has the handshake confirmed at a moment of its own,
 * which the commitment's SLA clock must be.
 */
async function photoIntake(count = 3, confirmed = true): Promise<Arranged> {
  const done = await handOver(routes, vendor, days, {
    collected: [count],
    declared: [count],
    photos: true,
  });
  const id = done.intakes[0]?.id ?? '';
  const stopId = done.run.stops[0]?.id ?? '';
  const custody = new Date(Date.now() - 3 * 60 * 60 * 1000);
  if (confirmed) {
    await routes.admin.query(
      `update collection_record set handshake_channel = 'PORTAL', handshake_confirmed_at = $2 where pickup_stop_id = $1`,
      [stopId, custody],
    );
  }
  return {
    id,
    requestId: done.run.stops[0]?.requestId ?? '',
    stopId,
    parcels: await parcelsOf(id),
    custody,
  };
}
/** A blind-count intake (the stop was let through without photos), arranged as counted and cleared for itemization. */
async function blindIntake(declared = 3, cleared = true): Promise<Arranged> {
  const done = await handOver(routes, vendor, days, {
    collected: [declared],
    declared: [declared],
  });
  const id = done.intakes[0]?.id ?? '';
  const stopId = done.run.stops[0]?.id ?? '';
  const custody = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await routes.admin.query(
    `update collection_record set handshake_channel = 'PORTAL', handshake_confirmed_at = $2 where pickup_stop_id = $1`,
    [stopId, custody],
  );
  if (cleared) rowsOf(await attempt(staff(COUNT), blindCount(id, declared)));
  return { id, requestId: done.run.stops[0]?.requestId ?? '', stopId, parcels: [], custody };
}

const tap = (parcel: string, arrived: boolean): string =>
  `select * from melarc.record_parcel_arrival('${parcel}', ${String(arrived)})`;
const finish = (intake: string, all: boolean, confirmed: number | null = null): string =>
  `select * from melarc.finish_check_in('${intake}', ${String(all)}, ${confirmed === null ? 'null' : String(confirmed)})`;
const blindCount = (intake: string, physical: number): string =>
  `select intake_id, rider_declared_count, parcel_photo_ids from melarc.commit_blind_count('${intake}', ${String(physical)})`;
const correct = (
  intake: string,
  reason: string,
  changes: readonly { parcel_id: string; state: string }[],
): string =>
  `select previous_state, resulting_state from melarc.correct_intake_count('${intake}', '${reason}', '${JSON.stringify(changes)}'::jsonb, null)`;
const freeze = (intake: string): string =>
  `select order_id, locked_price_minor from melarc.freeze_orders('${intake}')`;

/** A photo intake whose vendor is finished with "All N here": every parcel `ARRIVED` and the intake cleared for itemization. */
async function clearedPhotoIntake(count = 3): Promise<Arranged> {
  const intake = await photoIntake(count);
  rowsOf(await attempt(staff(COUNT), finish(intake.id, true, count)));
  expect((await intakeOf(intake.id)).state).toBe('READY_FOR_ITEMIZATION');
  return { ...intake, parcels: await parcelsOf(intake.id) };
}

const PRICE = (total = 3500, hub = HUB_A) => ({
  total_minor: total,
  currency: 'GHS',
  components: [
    {
      kind: 'SERVICE_AREA_BASE_FEE',
      amount_minor: total,
      hub_id: hub,
      setting_key: 'service_area_base_fee',
      scope_ref: 'ACCRA_TEMA',
      effective_version: 1,
    },
  ],
});

type Facts = Record<string, unknown>;
const facts = (parcel: string | null, overrides: Facts = {}): Facts => ({
  order_id: randomUUID(),
  code: `ORD-T${randomUUID().slice(0, 6).toUpperCase()}`,
  initial_commitment_id: randomUUID(),
  parcel_id: parcel,
  recipient: {
    name: 'Ama Mensah',
    phone: '+233200000001',
    location: { address: '12 Madina Estate' },
  },
  origin_zone_snapshot: { scope: 'SERVICE_AREA', zone_code: 'ORIGIN' },
  destination_zone_snapshot: {
    scope: 'SERVICE_AREA',
    zone_code: 'MADINA',
    service_area: 'ACCRA_TEMA',
  },
  destination_zone_resolution: 'SERVER_RESOLVED',
  declared_value_minor: null,
  is_serialized_goods: false,
  serial_imei: null,
  requested_delivery_date: null,
  derived_delivery_date: '2026-11-03',
  size_class: 'SMALL',
  carrier_cost_minor: null,
  carrier_waybill_evidence_id: null,
  is_high_value: false,
  high_value_evidence_ids: [],
  lane: 'DOORSTEP',
  commercial_mode: null,
  payer_override: null,
  price_components_snapshot: PRICE(),
  commitment: {
    default_date: '2026-11-03',
    requested_date: null,
    committed_date: '2026-11-03',
    window_start: '10:00',
    window_end: '16:00',
  },
  ...overrides,
});
const itemize = (intake: string, given: Facts): string =>
  `select order_id, previous_state, resulting_state, frozen from melarc.itemize_order('${intake}', '${JSON.stringify(given).replaceAll("'", "''")}'::jsonb)`;
const itemizer = staff(ITEMIZE, [HUB_A], randomUUID());

/** An order made for a parcel through the operation, as the application makes it. */
async function orderFor(
  intake: Arranged,
  parcel: Parcel | null,
  overrides: Facts = {},
  by: SecurityContext = itemizer,
): Promise<{ id: string; frozen: boolean; previous: string; resulting: string }> {
  const given = facts(parcel?.id ?? null, overrides);
  const [row] = rowsOf(await attempt(by, itemize(intake.id, given)));
  return {
    id: String(row?.order_id),
    frozen: row?.frozen === true,
    previous: String(row?.previous_state),
    resulting: String(row?.resulting_state),
  };
}

/** A piece of evidence about an intake, as the evidence operations leave it (arranged as the administrator with the guards off for the statement). */
async function intakeEvidence(
  intakeId: string,
  purpose: 'ITEMIZATION' | 'CONDITION' | 'OSD' = 'ITEMIZATION',
  state: 'STORED' | 'PENDING_UPLOAD' = 'STORED',
): Promise<string> {
  const id = randomUUID();
  const stored = state === 'STORED';
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `insert into evidence (id, owner_type, owner_id, purpose, captured_at, captured_by_actor, captured_by_principal_type, storage_ref, responsible_hub_id, access_rule, retention_policy,
                             state, content_type, byte_size, checksum_sha256, upload_ttl_seconds, upload_expires_at, uploaded_at, validated_signature, scanner, scanner_signature_version, scanned_at)
       values ($1, 'PICKUP_INTAKE', $2, $3, now() - interval '1 minute', $4, 'STAFF', 'ev/' || replace(gen_random_uuid()::text, '-', ''), $5, 'SUBJECT_READERS', 'PICKUP_INTAKE_EVIDENCE',
               $6, 'image/jpeg', 12, repeat('a', 64), 900, now() + interval '15 minutes',
               case when $7::boolean then now() end, case when $7::boolean then 'JPEG' end, case when $7::boolean then 'test' end, case when $7::boolean then '1' end, case when $7::boolean then now() end)`,
      [id, intakeId, purpose, randomUUID(), HUB_A, stored ? 'STORED' : 'PENDING_UPLOAD', stored],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
  return id;
}

/** The request's payer arrangement, as the sender left it (the vendor may edit it until the freeze). */
async function arrangePayer(
  requestId: string,
  intent: 'RECIPIENT_PAYS' | 'SENDER_PAYS_FULL' | 'SPLIT',
  split: {
    basis: 'FIXED_AMOUNT' | 'PERCENTAGE';
    amount?: number;
    percentage?: number;
  } | null = null,
): Promise<void> {
  await routes.admin.query(
    `update pickup_request set default_payer_intent = $2, split_basis = $3, split_sender_amount_minor = $4, split_sender_percentage = $5 where id = $1`,
    [requestId, intent, split?.basis ?? null, split?.amount ?? null, split?.percentage ?? null],
  );
}

describe('an order for a parcel that has arrived (AC-SLICE-001-90)', () => {
  // Break caught: an order that is not frozen when its parcel has arrived, a price that is not the one calculated, the intake left at READY_FOR_ITEMIZATION, or an order whose hub, sender, officer and
  // moment are the writer's and not the database's.
  it('is made and frozen in one change, moves the intake to ITEMIZING, and keeps who made it and what it was calculated at', async () => {
    const intake = await clearedPhotoIntake(3);
    const before = await intakeOf(intake.id);
    const parcel = present(intake.parcels, 0);
    const made = await orderFor(intake, parcel);
    expect(made).toMatchObject({
      frozen: true,
      previous: 'READY_FOR_ITEMIZATION',
      resulting: 'ITEMIZING',
    });
    const order = await orderOf(made.id);
    expect(order).toMatchObject({
      pickup_intake_id: intake.id,
      responsible_hub_id: HUB_A,
      intake_parcel_id: parcel.id,
      commercial_state: 'NO_VENDOR_CHARGE',
      fulfilment_state: 'AWAITING_RECIPIENT_CONFIRMATION',
      locked_price_minor: 3500,
      size_class: 'SMALL',
      size_class_selected_by: itemizer.principalId,
      created_by: itemizer.principalId,
      payer_override_applied: false,
    });
    expect(order.locked_at).toBeInstanceOf(Date);
    expect(order.price_components_snapshot.total_minor).toBe(3500);
    // The sender is the request's (exactly one), never the writer's.
    expect((order.vendor_organization_id === null) !== (order.ad_hoc_sender_id === null)).toBe(
      true,
    );
    const intakeNow = await intakeOf(intake.id);
    expect(intakeNow.state).toBe('ITEMIZING');
    expect(intakeNow.version).toBeGreaterThan(before.version);
  });

  // Break caught: a second order moving the intake again, one parcel with two orders, or the order made for another parcel's photo (AC-SLICE-001-90).
  it('is one order for a parcel: a second order for it is refused, and another parcel of the intake is ordered as well', async () => {
    const intake = await clearedPhotoIntake(3);
    const [first, second] = intake.parcels as [Parcel, Parcel, Parcel];
    await orderFor(intake, first);
    expect(refusal(await attempt(itemizer, itemize(intake.id, facts(first.id))))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'parcel_ordered',
    ]);
    const other = await orderFor(intake, second);
    expect(other).toMatchObject({ frozen: true, previous: 'ITEMIZING', resulting: 'ITEMIZING' });
    const rows = await routes.rows<{ intake_parcel_id: string }>(
      `select intake_parcel_id from "order" where pickup_intake_id = $1 order by created_at`,
      [intake.id],
    );
    expect(rows.map((row) => row.intake_parcel_id)).toEqual([first.id, second.id]);
  });

  // Break caught: a parcel of another intake ordered (a photo that is not this intake's), or a parcel the intake does not have.
  it('cannot be made for a parcel of another intake, or one that does not exist', async () => {
    const mine = await clearedPhotoIntake(2);
    const theirs = await clearedPhotoIntake(2);
    const foreign = present(theirs.parcels, 0);
    expect(refusal(await attempt(itemizer, itemize(mine.id, facts(foreign.id))))).toEqual([
      '23514',
      'VALIDATION_FAILED',
      'unknown_parcel',
    ]);
    expect(refusal(await attempt(itemizer, itemize(mine.id, facts(randomUUID()))))).toEqual([
      '23514',
      'VALIDATION_FAILED',
      'unknown_parcel',
    ]);
    expect(refusal(await attempt(itemizer, itemize(mine.id, facts(null))))).toEqual([
      '23514',
      'VALIDATION_FAILED',
      'parcel_required',
    ]);
  });

  // Break caught: an order for a parcel that was left out, taken back or never there, which would be priced and dispatched for nothing.
  it('is refused for a missing or a void parcel, naming which', async () => {
    const intake = await photoIntake(3);
    const [tapped, notTapped] = intake.parcels as [Parcel, Parcel, Parcel];
    rowsOf(await attempt(staff(COUNT), tap(tapped.id, true)));
    rowsOf(await attempt(staff(COUNT), finish(intake.id, false)));
    // The vendor is finished as tapped: the parcel not tapped is missing, and the intake is in reconciliation.
    expect((await parcelsOf(intake.id)).find((p) => p.id === notTapped.id)?.state).toBe('MISSING');
    expect(refusal(await attempt(itemizer, itemize(intake.id, facts(notTapped.id))))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'parcel_missing',
    ]);
  });

  // Break caught: an order made while the vendor is still being checked in for a parcel that is already tapped, or for an intake that is in reconciliation: the intake must be cleared first.
  it('is made once the vendor is cleared, never while the check-in is open or the case is in reconciliation', async () => {
    const open = await photoIntake(2);
    const [tapped] = open.parcels as [Parcel, Parcel];
    rowsOf(await attempt(staff(COUNT), tap(tapped.id, true)));
    expect(refusal(await attempt(itemizer, itemize(open.id, facts(tapped.id))))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'check_in_open',
    ]);
    const short = await photoIntake(2);
    rowsOf(await attempt(staff(COUNT), tap(present(short.parcels, 0).id, true)));
    rowsOf(await attempt(staff(COUNT), finish(short.id, false)));
    expect((await intakeOf(short.id)).state).toBe('RECONCILIATION_REQUIRED');
    expect(
      refusal(await attempt(itemizer, itemize(short.id, facts(present(short.parcels, 0).id)))),
    ).toEqual(['23514', 'STATE_CONFLICT', 'reconciliation_open']);
  });

  // Break caught: an order of a closed intake, made by a key that is not the officer's, or in the hubs of another grant.
  it('is made by the key to itemize alone, in the hubs of its grant', async () => {
    const intake = await clearedPhotoIntake(2);
    const parcel = present(intake.parcels, 0);
    for (const key of [COUNT, OSD, READ]) {
      expect(refusal(await attempt(staff(key), itemize(intake.id, facts(parcel.id)))), key).toEqual(
        ['42501', undefined, undefined],
      );
    }
    expect(
      refusal(await attempt(staff(ITEMIZE, [HUB_B]), itemize(intake.id, facts(parcel.id)))),
    ).toEqual(['42501', undefined, undefined]);
    expect(
      await routes.rows(`select 1 from "order" where pickup_intake_id = $1`, [intake.id]),
    ).toEqual([]);
    expect((await intakeOf(intake.id)).state).toBe('READY_FOR_ITEMIZATION');
  });
});

describe('an order for an intake counted blind', () => {
  // Break caught: a blind-count order that needs a parcel it cannot have, or one that is given a parcel (it has none to be one-to-one with), or one made before the count clears the intake.
  it('is made with no parcel, frozen at once, and refused a parcel or an uncleared intake', async () => {
    const blind = await blindIntake(3);
    expect((await intakeOf(blind.id)).state).toBe('READY_FOR_ITEMIZATION');
    const made = await orderFor(blind, null);
    expect(made).toMatchObject({
      frozen: true,
      previous: 'READY_FOR_ITEMIZATION',
      resulting: 'ITEMIZING',
    });
    expect((await orderOf(made.id)).intake_parcel_id).toBeNull();
    // Orders of a blind-count intake are not one-to-one with anything: a second is made, and neither blocks the other.
    expect((await orderFor(blind, null)).frozen).toBe(true);
    const photo = await clearedPhotoIntake(1);
    expect(
      refusal(await attempt(itemizer, itemize(blind.id, facts(present(photo.parcels, 0).id)))),
    ).toEqual(['23514', 'VALIDATION_FAILED', 'parcel_not_allowed']);
    const waiting = await blindIntake(3, false);
    expect(refusal(await attempt(itemizer, itemize(waiting.id, facts(null))))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'intake_not_counted',
    ]);
  });

  // Break caught (the review of 21 November 2026, finding 1): an order for a place that is not there, which the close then accepts with the approved exception as a shortage of nothing.
  it('has an order for no more parcels than the hub received, whatever the count', async () => {
    const small = await blindIntake(2);
    await orderFor(small, null);
    await orderFor(small, null);
    expect(refusal(await attempt(itemizer, itemize(small.id, facts(null))))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'orders_exceed_received',
    ]);
    // The limit is the count, not a number: every one of two hundred parcels received has its order, and the next has none.
    const large = await blindIntake(200);
    for (let each = 0; each < 200; each += 1) await orderFor(large, null);
    expect(refusal(await attempt(itemizer, itemize(large.id, facts(null))))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'orders_exceed_received',
    ]);
  }, 120_000);

  // Break caught (the same): a close that accepts a surplus, with the exception or without it, because it counts the orders against the count only for parity.
  it('is not closed over a surplus, with the exception or without it', async () => {
    const blind = await blindIntake(2);
    await orderFor(blind, null);
    await orderFor(blind, null);
    // A surplus the application cannot make any more (a count lowered under its orders), arranged as the other tests arrange a world the application cannot make.
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(`update pickup_intake set physical_count = 1 where id = $1`, [
      blind.id,
    ]);
    await routes.admin.query('commit');
    const closer = (key: string) => staff(key, [HUB_A], randomUUID());
    const withException = `select previous_state from melarc.close_intake('${blind.id}', '${randomUUID()}', 'One order too many')`;
    const without = `select previous_state from melarc.close_intake('${blind.id}', null, null)`;
    expect(refusal(await attempt(closer('hub.intake.close_exception'), withException))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'orders_exceed_received',
    ]);
    expect(refusal(await attempt(closer('hub.intake.close'), without))).toEqual([
      '23514',
      'STATE_CONFLICT',
      'orders_exceed_received',
    ]);
    expect((await intakeOf(blind.id)).state).toBe('ITEMIZING');
  });
});

describe('an order that waits for its parcel (AC-SLICE-001-104)', () => {
  // Break caught: an early order that is frozen or priced before its parcel is checked in, that moves the intake, or that is confirmed by a tap the officer may still take back.
  it('exists calculated and not frozen, moves nothing of the intake, and is not confirmed by a tap that can be undone', async () => {
    const intake = await photoIntake(3);
    const parcel = present(intake.parcels, 0);
    const before = await intakeOf(intake.id);
    const made = await orderFor(intake, parcel);
    expect(made).toMatchObject({
      frozen: false,
      previous: 'AWAITING_COUNT',
      resulting: 'AWAITING_COUNT',
    });
    const waiting = await orderOf(made.id);
    expect(waiting).toMatchObject({
      commercial_state: null,
      locked_price_minor: null,
      locked_at: null,
      payer_allocation: null,
    });
    expect(waiting.price_components_snapshot.total_minor).toBe(3500);
    expect(await intakeOf(intake.id)).toEqual(before);
    // The confirmation freezes nothing while the vendor's check-in is open, and a tap can be taken back.
    expect(rowsOf(await attempt(staff(COUNT), freeze(intake.id)))).toEqual([]);
    rowsOf(await attempt(staff(COUNT), tap(parcel.id, true)));
    expect(rowsOf(await attempt(staff(COUNT), freeze(intake.id)))).toEqual([]);
    rowsOf(await attempt(staff(COUNT), tap(parcel.id, false)));
    expect((await orderOf(made.id)).locked_at).toBeNull();
    // Not even for the key of the count the intake is judged by: no order is frozen while the vendor is open.
    expect(refusal(await attempt(staff(ITEMIZE), freeze(intake.id)))[0]).toBe('42501');
  });

  // Break caught: the confirmation not run when the vendor is finished, run for a parcel that did not arrive, or a price recalculated at the freeze (the price is the one calculated).
  it('is confirmed when the vendor is finished: the parcel that arrived is frozen at the price that was calculated, the one that did not stays unpriced', async () => {
    const intake = await photoIntake(3);
    const [arrives, stays] = intake.parcels as [Parcel, Parcel, Parcel];
    const early = await orderFor(intake, arrives, { price_components_snapshot: PRICE(4200) });
    const left = await orderFor(intake, stays);
    rowsOf(await attempt(staff(COUNT), tap(arrives.id, true)));
    rowsOf(await attempt(staff(COUNT), finish(intake.id, false)));
    // The vendor is finished as tapped (the other two are missing): in reconciliation, and the frozen order is the one whose parcel arrived.
    const confirmed = rowsOf(await attempt(staff(COUNT), freeze(intake.id)));
    expect(confirmed).toEqual([{ order_id: early.id, locked_price_minor: 4200 }]);
    expect(await orderOf(early.id)).toMatchObject({
      commercial_state: 'NO_VENDOR_CHARGE',
      locked_price_minor: 4200,
    });
    expect(await orderOf(left.id)).toMatchObject({
      commercial_state: null,
      locked_price_minor: null,
    });
    // A second confirmation changes nothing.
    expect(rowsOf(await attempt(staff(COUNT), freeze(intake.id)))).toEqual([]);
    // The parcel that was missing is found (tapped while the case is open): its order is confirmed then, and the intake stays in reconciliation.
    rowsOf(await attempt(staff(COUNT), tap(stays.id, true)));
    expect(rowsOf(await attempt(staff(COUNT), freeze(intake.id)))).toEqual([
      { order_id: left.id, locked_price_minor: 3500 },
    ]);
    expect((await intakeOf(intake.id)).state).toBe('RECONCILIATION_REQUIRED');
  });

  // Break caught: an order frozen by a key that has no act of confirming, or in a hub that is not the officer's.
  it('is confirmed by the receiver or the senior alone, in the hubs of the grant', async () => {
    const intake = await clearedPhotoIntake(1);
    for (const key of [READ, ITEMIZE]) {
      expect(refusal(await attempt(staff(key), freeze(intake.id)))[0], key).toBe('42501');
    }
    expect(refusal(await attempt(staff(COUNT, [HUB_B]), freeze(intake.id)))[0]).toBe('42501');
    expect(rowsOf(await attempt(staff(OSD), freeze(intake.id)))).toEqual([]);
  });

  // Break caught: a parcel whose order is priced taken back by an untap, a correction to missing or a void, which would leave a priced order for a parcel that is not there; and an order that still waits
  // blocking the officer's own untap.
  it('does not let a parcel whose order is priced be taken back, and lets one whose order still waits', async () => {
    const intake = await photoIntake(3);
    const [priced, waiting] = intake.parcels as [Parcel, Parcel, Parcel];
    await orderFor(intake, priced);
    await orderFor(intake, waiting);
    // While the vendor is open both can be tapped and untapped: nothing is priced yet.
    rowsOf(await attempt(staff(COUNT), tap(waiting.id, true)));
    rowsOf(await attempt(staff(COUNT), tap(waiting.id, false)));
    for (const parcel of intake.parcels) rowsOf(await attempt(staff(COUNT), tap(parcel.id, true)));
    rowsOf(await attempt(staff(COUNT), finish(intake.id, true, 3)));
    expect(rowsOf(await attempt(staff(COUNT), freeze(intake.id)))).toHaveLength(2);
    // Now both are priced, and the first confirmation began the itemizing (OB-S1-142): neither goes back, by the senior's correction either.
    expect((await intakeOf(intake.id)).state).toBe('ITEMIZING');
    const result = await attempt(
      staff(OSD),
      correct(intake.id, 'counted again', [{ parcel_id: priced.id, state: 'MISSING' }]),
    );
    expect(refusal(result)).toEqual(['23514', 'STATE_CONFLICT', 'itemization_started']);
    expect((await parcelsOf(intake.id)).every((parcel) => parcel.state === 'ARRIVED')).toBe(true);
  });

  // Break caught: a parcel that leaves ARRIVED under an order that is priced while the intake is still in reconciliation, where no state of the intake forbids it: the parcel's own guard holds it for every writer.
  it('does not let a parcel whose order is priced be taken back while the intake is still in reconciliation', async () => {
    const intake = await photoIntake(3);
    const [priced, waiting] = intake.parcels as [Parcel, Parcel, Parcel];
    await orderFor(intake, priced);
    await orderFor(intake, waiting);
    rowsOf(await attempt(staff(COUNT), tap(priced.id, true)));
    rowsOf(await attempt(staff(COUNT), tap(waiting.id, true)));
    // The third parcel never arrived: the vendor is finished as tapped, and the intake is in reconciliation with a missing parcel.
    rowsOf(await attempt(staff(COUNT), finish(intake.id, false)));
    expect((await intakeOf(intake.id)).state).toBe('RECONCILIATION_REQUIRED');
    expect(rowsOf(await attempt(staff(COUNT), freeze(intake.id)))).toHaveLength(2);
    // The confirmation does not begin the itemizing of an intake that is not cleared.
    expect((await intakeOf(intake.id)).state).toBe('RECONCILIATION_REQUIRED');
    const result = await attempt(
      staff(OSD),
      correct(intake.id, 'counted again', [{ parcel_id: priced.id, state: 'MISSING' }]),
    );
    expect(refusal(result)).toEqual(['23514', 'STATE_CONFLICT', 'parcel_has_order']);
    expect(
      (await parcelsOf(intake.id)).filter((parcel) => parcel.state === 'ARRIVED'),
    ).toHaveLength(2);
  });
});

describe('what the database holds of an order for every writer', () => {
  const direct = (
    intake: Arranged,
    parcel: Parcel | null,
    by: string,
    over: Record<string, string> = {},
  ): string => {
    const columns: Record<string, string> = {
      id: `'${randomUUID()}'`,
      code: `'ORD-D${randomUUID().slice(0, 6).toUpperCase()}'`,
      pickup_intake_id: `'${intake.id}'`,
      responsible_hub_id: `'${HUB_A}'`,
      intake_parcel_id: parcel === null ? 'null' : `'${parcel.id}'`,
      recipient: `'{"name":"A"}'::jsonb`,
      origin_zone_snapshot: `'{"scope":"SERVICE_AREA","zone_code":"ORIGIN"}'::jsonb`,
      destination_zone_snapshot: `'{"scope":"SERVICE_AREA"}'::jsonb`,
      destination_zone_resolution: `'SERVER_RESOLVED'`,
      derived_delivery_date: `'2026-11-03'`,
      size_class: `'SMALL'`,
      size_class_selected_by: `'${by}'`,
      is_high_value: 'false',
      lane: `'DOORSTEP'`,
      price_components_snapshot: `'${JSON.stringify(PRICE())}'::jsonb`,
      initial_commitment_id: `'${randomUUID()}'`,
      created_by: `'${by}'`,
      ...over,
    };
    return `insert into "order" (${Object.keys(columns).join(', ')}) values (${Object.values(columns).join(', ')})`;
  };
  const as = staff(ITEMIZE, [HUB_A], randomUUID());
  const insertAs = (intake: Arranged, parcel: Parcel | null, over: Record<string, string> = {}) =>
    asOwner(as, [direct(intake, parcel, as.principalId, over)]);

  // Break caught (the review of 21 November 2026, finding 1): the places of a blind count held by the operation and not by the table, so that a direct insert makes the order that has no place.
  it('refuses, for the owner too, an order of a blind count for which no place is left, and takes the last one', async () => {
    const blind = await blindIntake(2);
    const first = await insertAs(blind, null);
    expect(first).toBe('ran:1');
    // The first insert was rolled back with its transaction: put two orders there as the operation does, then try a third as the owner.
    await orderFor(blind, null);
    expect(await insertAs(blind, null)).toBe('ran:1');
    await orderFor(blind, null);
    expect(await insertAs(blind, null)).toMatch(
      /^23514:an intake that is counted blind has an order for no more parcels than it received/,
    );
  });

  // Break caught: a constraint of the table that the owner's own insert slips past: the carrier's cost on a doorstep order, a lane with the wrong mode, serialized goods without a serial, a high-value
  // flag without evidence, no sender, a size class outside the three, a price that is not an object.
  it('refuses, for the owner too, what an order cannot be', async () => {
    const intake = await clearedPhotoIntake(1);
    const parcel = present(intake.parcels, 0);
    // A waybill that is stored and the intake's own, so that the guard's judgement of the evidence passes and the table's own rule is the one that refuses.
    const waybill = await intakeEvidence(intake.id);
    const cases: [string, Record<string, string>, string][] = [
      [
        'a carrier cost on a doorstep order',
        { carrier_cost_minor: '5000', carrier_waybill_evidence_id: `'${waybill}'` },
        'order_carrier_cost_facts',
      ],
      [
        'a third-party order without its mode',
        { lane: `'THIRD_PARTY_HANDOFF'` },
        'order_lane_mode',
      ],
      ['a mode on a doorstep order', { commercial_mode: `'STATION_DROP'` }, 'order_lane_mode'],
      [
        'a covered third-party order without its carrier cost',
        { lane: `'THIRD_PARTY_HANDOFF'`, commercial_mode: `'MELARC_COVERED_THIRD_PARTY_DELIVERY'` },
        'order_carrier_cost_facts',
      ],
      ['serialized goods with no serial', { is_serialized_goods: 'true' }, 'order_serial_required'],
      [
        'serialized goods with a blank serial',
        { is_serialized_goods: 'true', serial_imei: `'  '` },
        'order_serial_required',
      ],
      [
        'a high-value parcel with no evidence',
        { is_high_value: 'true' },
        'order_high_value_evidence',
      ],
      ['a size class of a fourth kind', { size_class: `'HUGE'` }, 'order_size_class_closed'],
      [
        'a negative declared value',
        { declared_value_minor: '-1' },
        'order_declared_value_nonnegative',
      ],
      [
        'a price that is not an object',
        { price_components_snapshot: `'[]'::jsonb` },
        'a price is a total and the components',
      ],
    ];
    for (const [name, over, constraint] of cases) {
      const result = await insertAs(intake, parcel, over);
      expect(result.startsWith('23514'), `${name}: ${result}`).toBe(true);
      expect(result, name).toContain(constraint);
    }
  });

  // Break caught: an order whose hub, sender or moment is the writer's; an order made frozen; an order whose first life is not the beginning of its life.
  it('takes its hub, its sender and its moment from the intake, the request and the clock, and is made unfrozen at the beginning of its life', async () => {
    const intake = await clearedPhotoIntake(1);
    const parcel = present(intake.parcels, 0);
    // The writer gives another hub and a moment in the past: the guard gives the intake's hub and the clock's.
    // The same transaction reads the row back: the hub is the intake's and the moment is the clock's, whatever the writer gave (a row of another hub, or of 2020, would be found by neither question).
    const stray = await asOwner(as, [
      direct(intake, parcel, as.principalId, {
        responsible_hub_id: `'${HUB_B}'`,
        created_at: `'2020-01-01T00:00:00Z'`,
      }),
      `select 1 from "order" where pickup_intake_id = '${intake.id}' and responsible_hub_id = '${HUB_A}' and created_at > now() - interval '1 minute'`,
    ]);
    expect(stray).toBe('ran:1');
    const beginnings: Record<string, string>[] = [
      {
        commercial_state: `'PRICED'`,
        locked_price_minor: '3500',
        locked_at: 'now()',
        payer_allocation: `'{"sender_minor":3500,"recipient_minor":0}'::jsonb`,
      },
      { fulfilment_state: `'DELIVERED'` },
      { delivery_attempt_count: '2' },
      { delivery_date_override: `'{"by":"x"}'::jsonb` },
    ];
    for (const over of beginnings) {
      expect((await insertAs(intake, parcel, over)).startsWith('23514'), JSON.stringify(over)).toBe(
        true,
      );
    }
  });

  // Break caught: a price whose components do not add up, one that does not name the hub of the order (a frozen price that cannot be explained, §3.7), or one that is not a total and components.
  it('holds the components of a price to the hub of the order and to its total', async () => {
    const intake = await clearedPhotoIntake(1);
    const parcel = present(intake.parcels, 0);
    const price = (over: Record<string, unknown>) =>
      `'${JSON.stringify({ ...PRICE(), ...over })}'::jsonb`;
    const withComponent = (component: Record<string, unknown>) =>
      price({ components: [{ ...PRICE().components[0], ...component }] });
    for (const [name, value] of [
      ['a total that is not the sum', price({ total_minor: 4000 })],
      ['a component of another hub', withComponent({ hub_id: HUB_B })],
      ['a component with no hub', withComponent({ hub_id: undefined })],
      ['a component with a fraction of a pesewa', withComponent({ amount_minor: 35.5 })],
      ['no components', price({ components: [] })],
      ['no total', price({ total_minor: undefined })],
    ] as const) {
      const result = await insertAs(intake, parcel, { price_components_snapshot: value });
      expect(result.startsWith('23514') || result.startsWith('22P02'), `${name}: ${result}`).toBe(
        true,
      );
    }
  });

  // Break caught: the evidence of an order that is not the intake's own, is not stored, is of another purpose, or is cited twice: the "attached evidence" every rule asks for satisfied by nothing.
  it('cites evidence that is stored, the intake’s own and of the purpose of an itemization, each piece once', async () => {
    const intake = await clearedPhotoIntake(4);
    const other = await clearedPhotoIntake(1);
    const [a, b, c, d] = intake.parcels as [Parcel, Parcel, Parcel, Parcel];
    const good = await intakeEvidence(intake.id);
    const cases: [string, Facts, [string, string | undefined, string | undefined]][] = [
      [
        'pending evidence',
        {
          is_high_value: true,
          high_value_evidence_ids: [
            await intakeEvidence(intake.id, 'ITEMIZATION', 'PENDING_UPLOAD'),
          ],
        },
        ['23514', 'EVIDENCE_NOT_STORED', undefined],
      ],
      [
        'evidence of another intake',
        { is_high_value: true, high_value_evidence_ids: [await intakeEvidence(other.id)] },
        ['23514', 'EVIDENCE_NOT_STORED', undefined],
      ],
      [
        'evidence of a condition',
        {
          is_high_value: true,
          high_value_evidence_ids: [await intakeEvidence(intake.id, 'CONDITION')],
        },
        ['23514', 'EVIDENCE_NOT_STORED', undefined],
      ],
      [
        'evidence that does not exist',
        { is_high_value: true, high_value_evidence_ids: [randomUUID()] },
        ['23514', 'EVIDENCE_NOT_STORED', undefined],
      ],
      [
        'one piece twice',
        { is_high_value: true, high_value_evidence_ids: [good, good] },
        ['23514', 'VALIDATION_FAILED', 'evidence_once'],
      ],
    ];
    const targets = [a, b, c, d, a];
    for (const [at, [name, over, expected]] of cases.entries()) {
      const result = await attempt(
        itemizer,
        itemize(intake.id, facts(present(targets, at).id, over)),
      );
      expect(refusal(result), name).toEqual(expected);
    }
    // The same piece, once, is accepted, and a waybill photograph is held to the same rules.
    const made = await orderFor(intake, d, {
      is_high_value: true,
      high_value_evidence_ids: [good],
    });
    expect((await orderOf(made.id)).high_value_evidence_ids).toEqual([good]);
  });

  // Break caught: every order of an intake carrying the origin zone of its own resolution (AC-SLICE-001-57): the origin is the request's, resolved once.
  it('gives every order of an intake the one origin zone', async () => {
    const intake = await clearedPhotoIntake(3);
    const [a, b] = intake.parcels as [Parcel, Parcel, Parcel];
    await orderFor(intake, a, {
      origin_zone_snapshot: { scope: 'SERVICE_AREA', zone_code: 'FIRST' },
    });
    expect(
      refusal(
        await attempt(
          itemizer,
          itemize(
            intake.id,
            facts(b.id, { origin_zone_snapshot: { scope: 'SERVICE_AREA', zone_code: 'SECOND' } }),
          ),
        ),
      ),
    ).toEqual(['23514', undefined, undefined]);
    const same = await orderFor(intake, b, {
      origin_zone_snapshot: { scope: 'SERVICE_AREA', zone_code: 'FIRST' },
    });
    expect((await orderOf(same.id)).origin_zone_snapshot).toEqual({
      scope: 'SERVICE_AREA',
      zone_code: 'FIRST',
    });
  });

  // Break caught: an order that can be changed, removed or unfrozen, a locked price that can be rewritten (§35.6.7: a correction is a linked adjustment), or a freeze that is not the price calculated.
  it('is kept as it was once frozen, and takes no change but the freeze', async () => {
    const intake = await clearedPhotoIntake(1);
    const made = await orderFor(intake, present(intake.parcels, 0));
    for (const change of [
      `locked_price_minor = 1`,
      `commercial_state = 'PAYMENT_REQUIRED'`,
      `locked_at = null`,
      `size_class = 'LARGE'`,
      `recipient = '{"name":"B"}'::jsonb`,
      `price_components_snapshot = '{"total_minor":1,"components":[]}'::jsonb`,
      `payer_allocation = '{"sender_minor":0,"recipient_minor":3500}'::jsonb`,
      `fulfilment_state = 'DELIVERED'`,
    ]) {
      const result = await asOwner(staff(ITEMIZE), [
        `update "order" set ${change} where id = '${made.id}'`,
      ]);
      expect(result.startsWith('23514'), `${change}: ${result}`).toBe(true);
    }
    // Nobody is shown an order to remove (no policy admits a delete), and the guard refuses it to a writer that is not bound by the policies.
    expect(await asOwner(staff(ITEMIZE), [`delete from "order" where id = '${made.id}'`])).toBe(
      'ran:0',
    );
    expect(await adminCommit([`delete from "order" where id = '${made.id}'`])).toMatchObject({
      code: '23514',
    });
  });

  // Break caught: a freeze to a price that is not the one calculated, to portions that do not add up, to a state that is not the first of the commercial machine, for a parcel that has not arrived or
  // while the vendor's check-in is open (a tap can still be taken back).
  it('takes the freeze only to the price that was calculated, with portions that add up, once the parcel has arrived and the vendor is finished', async () => {
    const early = await photoIntake(2);
    const [waits] = early.parcels as [Parcel, Parcel];
    const pending = await orderFor(early, waits);
    const freezeTo = (price: number, sender: number, recipient: number, state = 'PRICED') =>
      `update "order" set commercial_state = '${state}', locked_price_minor = ${String(price)}, locked_at = now(),
         payer_allocation = '{"sender_minor":${String(sender)},"recipient_minor":${String(recipient)}}'::jsonb where id = '${pending.id}'`;
    // Even the right freeze is refused for a parcel that has not arrived, and for one that is tapped while the vendor is open (the tap can be taken back).
    const notArrived = await asOwner(staff(COUNT), [freezeTo(3500, 3500, 0)]);
    expect(
      notArrived.startsWith('23514') && notArrived.includes('once its parcel has arrived'),
    ).toBe(true);
    rowsOf(await attempt(staff(COUNT), tap(waits.id, true)));
    const open = await asOwner(staff(COUNT), [freezeTo(3500, 3500, 0)]);
    expect(open.startsWith('23514') && open.includes('check-in is finished')).toBe(true);
    // The vendor is finished ("All N here"): the parcel has arrived and the intake is no longer waiting for its count.
    rowsOf(await attempt(staff(COUNT), finish(early.id, true, 2)));
    for (const [name, statement] of [
      ['a price that is not the one calculated', freezeTo(9999, 9999, 0)],
      ['portions that do not add up', freezeTo(3500, 1, 1)],
      ['a state that is not the first of the machine', freezeTo(3500, 3500, 0, 'PAYMENT_REQUIRED')],
    ] as const) {
      const result = await asOwner(staff(COUNT), [statement]);
      expect(result.startsWith('23514'), `${name}: ${result}`).toBe(true);
    }
    expect(await asOwner(staff(COUNT), [freezeTo(3500, 3500, 0)])).toBe('ran:1');
    // The right freeze, made, gives the database's moment and is kept.
    expect(await adminCommit([freezeTo(3500, 3500, 0)])).toBe('committed');
    const frozen = await orderOf(pending.id);
    expect(frozen.locked_at).toBeInstanceOf(Date);
    expect(Date.now() - (frozen.locked_at?.getTime() ?? 0)).toBeLessThan(60_000);
  });
});

describe('the commercial gate is held by the database for every writer (S1.37)', () => {
  const stateOf = async (id: string): Promise<string | null> =>
    (await orderOf(id)).commercial_state;
  const move = (id: string, state: string): string =>
    `update "order" set commercial_state = '${state}' where id = '${id}'`;

  // Break caught: a gate that lets a writer choose the outcome whatever the resolved portion says, run twice, or move a gated order anywhere else.
  it('takes an order from PRICED to the one outcome its resolved vendor portion allows, once, and nowhere else', async () => {
    const intake = await clearedPhotoIntake(2);
    await arrangePayer(intake.requestId, 'SENDER_PAYS_FULL');
    const paying = await orderFor(intake, present(intake.parcels, 0));
    const clearing = await orderFor(intake, present(intake.parcels, 1), {
      payer_override: { payer_intent: 'RECIPIENT_PAYS' },
    });
    expect(await stateOf(paying.id)).toBe('PAYMENT_REQUIRED');
    expect(await stateOf(clearing.id)).toBe('NO_VENDOR_CHARGE');
    for (const [name, id, state] of [
      ['a vendor portion above zero cleared with no charge', paying.id, 'NO_VENDOR_CHARGE'],
      ['a gated order put back to PRICED', paying.id, 'PRICED'],
      [
        'a gated order sent to a state of the reservation, which is not built',
        paying.id,
        'CREDIT_RESERVED',
      ],
      ['a gated order closed', paying.id, 'CLOSED'],
      ['a vendor portion of zero asked to pay', clearing.id, 'PAYMENT_REQUIRED'],
      ['a cleared order put back to PRICED', clearing.id, 'PRICED'],
      ['a cleared order closed', clearing.id, 'CLOSED'],
    ] as const) {
      const result = await asOwner(staff(COUNT), [move(id, state)]);
      expect(result.startsWith('23514'), `${name}: ${result}`).toBe(true);
    }
  });

  // Break caught: the gate judged by something other than the portions the freeze wrote: the statement that follows the freeze is held to them.
  it('judges the gate by the portions the freeze wrote, in the statement that follows it', async () => {
    const early = await photoIntake(2);
    const [first, second] = early.parcels as [Parcel, Parcel];
    const pending = await orderFor(early, first);
    const other = await orderFor(early, second);
    rowsOf(await attempt(staff(COUNT), tap(first.id, true)));
    rowsOf(await attempt(staff(COUNT), tap(second.id, true)));
    rowsOf(await attempt(staff(COUNT), finish(early.id, true, 2)));
    const freezeTo = (id: string, sender: number): string =>
      `update "order" set commercial_state = 'PRICED', locked_price_minor = 3500, locked_at = now(),
         payer_allocation = '{"sender_minor":${String(sender)},"recipient_minor":${String(3500 - sender)}}'::jsonb where id = '${id}'`;
    expect(
      await asOwner(staff(COUNT), [
        freezeTo(pending.id, 3500),
        move(pending.id, 'NO_VENDOR_CHARGE'),
      ]),
    ).toMatch(/^23514/);
    expect(
      await asOwner(staff(COUNT), [freezeTo(pending.id, 0), move(pending.id, 'PAYMENT_REQUIRED')]),
    ).toMatch(/^23514/);
    expect(
      await asOwner(staff(COUNT), [
        freezeTo(pending.id, 3500),
        move(pending.id, 'PAYMENT_REQUIRED'),
      ]),
    ).toBe('ran:1');
    expect(
      await asOwner(staff(COUNT), [freezeTo(other.id, 0), move(other.id, 'NO_VENDOR_CHARGE')]),
    ).toBe('ran:1');
  });
});

describe('the close of an intake is held by the database for every writer (S1.38)', () => {
  const closing = (id: string, principal: string, extra = ''): string =>
    `update pickup_intake set state = 'CLOSED', closed_at = now(), closed_by = '${principal}'${extra} where id = '${id}'`;
  const exceptionOf = (note: string | null): string =>
    `, parity_exception_id = '${randomUUID()}', parity_exception_note = ${note === null ? 'null' : `'${note}'`}`;

  // Break caught: a writer that closes with fewer orders than parcels, takes the exception without its key or its reason, writes the facts apart from the close or in another officer's name, or closes by another key.
  it('closes only with the parity of the orders to the parcels the hub received, by the exception under its own key and a reason, once, in the officer’s name', async () => {
    const intake = await clearedPhotoIntake(2);
    const first = await orderFor(intake, present(intake.parcels, 0));
    const principal = randomUUID();
    const closer = staff('hub.intake.close', [HUB_A], principal);
    const senior = staff('hub.intake.close_exception', [HUB_A], principal);
    const run = (context: SecurityContext, text: string): Promise<string> =>
      asOwner(context, [text]);

    // One order for two parcels that arrived: no parity, and only the exception passes it.
    expect(await run(closer, closing(intake.id, principal))).toMatch(
      /^23514:.*as many as the parcels/,
    );
    expect(
      await run(closer, closing(intake.id, principal, exceptionOf('Lost on the table'))),
    ).toMatch(/^23514:.*approved exception/);
    expect(await run(senior, closing(intake.id, principal, exceptionOf('   ')))).toMatch(
      /^23514:.*reason in words/,
    );
    expect(await run(senior, closing(intake.id, principal, exceptionOf('Lost on the table')))).toBe(
      'ran:1',
    );
    // The facts are one change with the move: apart from it, or in another officer's name, or by another key, they are refused.
    expect(
      await run(
        closer,
        `update pickup_intake set closed_at = now(), closed_by = '${principal}' where id = '${intake.id}'`,
      ),
    ).toMatch(/^23514:.*made once, with the move/);
    expect(await run(closer, closing(intake.id, randomUUID()))).toMatch(
      /^23514:.*in the name of the officer/,
    );
    expect(
      await run(staff('hub.intake.count', [HUB_A], principal), closing(intake.id, principal)),
    ).toMatch(/^23514:/);

    // The second order gives parity: the close is made, and an exception is not what parity needs.
    await orderFor(intake, present(intake.parcels, 1));
    // An order of a parcel that arrived and has no locked price refuses the close whatever the count says (made unfrozen with the triggers off, as no writer can).
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `update "order" set locked_price_minor = null, locked_at = null, payer_allocation = null, commercial_state = null where id = $1`,
        [first.id],
      );
      await routes.admin.query('set local session_replication_role = origin');
      await routes.admin.query('set local role melarc_owner');
      for (const [name, value] of toContextSettings(closer)) {
        await routes.admin.query('select set_config($1, $2, true)', [name, value]);
      }
      let message = 'closed';
      try {
        await routes.admin.query(closing(intake.id, principal));
      } catch (error) {
        message = serverErrorIn(error)?.message ?? String(error);
      }
      expect(message).toMatch(/has its locked price/);
    } finally {
      await routes.admin.query('rollback');
    }
    expect(await run(closer, closing(intake.id, principal))).toBe('ran:1');
    expect(await run(senior, closing(intake.id, principal, exceptionOf('Not needed')))).toMatch(
      /^23514:.*not got parity/,
    );
  });
});

describe('the payer correction is held by the database for every writer (S1.39)', () => {
  // Break caught: portions of a locked price that move by any writer's statement, a correction asked or decided under the other's key, and a checker that is the maker without being a Platform Admin.
  it('moves the portions only by an approved correction, asks and decides under the right keys, and keeps the checker apart from the maker', async () => {
    const intake = await clearedPhotoIntake(1);
    const made = await orderFor(intake, present(intake.parcels, 0));
    const maker = randomUUID();
    const asking = staff('pricing.correction.create', [HUB_A], maker);
    const deciding = staff('pricing.correction.approve', [HUB_A], maker);
    const proposed = '{"payer_intent":"SENDER_PAYS_FULL"}';
    const insert = (id: string, requester: string): string =>
      `insert into payer_correction (id, order_id, responsible_hub_id, requested_by, previous_allocation, proposed, note)
       values ('${id}', '${made.id}', '${HUB_A}', '${requester}', '{}'::jsonb, '${proposed}'::jsonb, 'The vendor agreed')`;
    const moveAllocation = `update "order" set payer_allocation = '{"payer_intent":"SENDER_PAYS_FULL","sender_minor":3500,"recipient_minor":0}'::jsonb, commercial_state = 'PAYMENT_REQUIRED' where id = '${made.id}'`;

    // The portions of a locked price move by no statement of its own.
    expect(await asOwner(deciding, [moveAllocation])).toMatch(
      /^23514:.*only by a payer correction/,
    );
    // A correction is asked under the key of the maker, in the maker's name, and the guard fills what the order says.
    expect(await asOwner(deciding, [insert(randomUUID(), maker)])).toMatch(/^(23514|42501):/);
    expect(await asOwner(asking, [insert(randomUUID(), randomUUID())])).toMatch(
      /^23514:.*in the name of the officer/,
    );
    expect(await asOwner(asking, [insert(randomUUID(), maker)])).toBe('ran:1');
    // Asked under one key and decided under the other, in one transaction: by its own maker it is refused, unless the transaction says the decider is a Platform Admin.
    const id = randomUUID();
    const decide = `update payer_correction set state = 'REJECTED', decided_by = '${maker}', decided_at = now() where id = '${id}'`;
    /**
     * `admin` says, as the service used to before the review of 20 November 2026, that the decider is a Platform Admin: **the database no longer believes it** and asks the decider's own bundle
     * (`melarc.staff_holds_at_tier_p`), so the setting changes nothing.
     */
    const sequence = async (
      steps: readonly [SecurityContext, string][],
      admin: boolean,
    ): Promise<string> => {
      await routes.admin.query('begin');
      try {
        await routes.admin.query('set local role melarc_owner');
        let last = 0;
        for (const [context, text] of steps) {
          for (const [name, value] of toContextSettings(context))
            await routes.admin.query('select set_config($1, $2, true)', [name, value]);
          if (admin)
            await routes.admin.query(
              "select set_config('melarc.platform_admin_decision', 'on', true)",
            );
          last = (await routes.admin.query(text)).rowCount ?? 0;
        }
        return `ran:${String(last)}`;
      } catch (error) {
        const server = serverErrorIn(error);
        return `${server?.code ?? 'other'}:${server?.message ?? String(error)}`;
      } finally {
        await routes.admin.query('rollback');
      }
    };
    expect(
      await sequence(
        [
          [asking, insert(id, maker)],
          [deciding, decide],
        ],
        false,
      ),
    ).toMatch(/^23514:.*not its requester/);
    // The setting is no longer believed: a decider who is no Platform Admin is refused whatever the transaction says (the review of 20 November 2026).
    expect(
      await sequence(
        [
          [asking, insert(id, maker)],
          [deciding, decide],
        ],
        true,
      ),
    ).toMatch(/^23514:.*not its requester/);
    // A Platform Admin, by the grant of the bundle the database holds for them, decides the correction they asked for, with no setting at all.
    const boss = await routes.platformAdmin();
    const bossAsks = staff('pricing.correction.create', 'ALL', boss.identity.id);
    const bossDecides = staff('pricing.correction.approve', 'ALL', boss.identity.id);
    const bossId = randomUUID();
    expect(
      await sequence(
        [
          [bossAsks, insert(bossId, boss.identity.id)],
          [
            bossDecides,
            `update payer_correction set state = 'REJECTED', decided_by = '${boss.identity.id}', decided_at = now() where id = '${bossId}'`,
          ],
        ],
        false,
      ),
    ).toBe('ran:1');
    // An Ops Staff member, whose bundle holds the key of the maker alone, is refused whatever the transaction says; so is a Senior Ops member, who holds the checker's key below tier P.
    for (const bundle of [BUNDLE_IDS.opsStaff, BUNDLE_IDS.seniorOps]) {
      const member = await routes.actor(bundle, HUB_A);
      const memberId = randomUUID();
      expect(
        await sequence(
          [
            [
              staff('pricing.correction.create', [HUB_A], member.identity.id),
              insert(memberId, member.identity.id),
            ],
            [
              staff('pricing.correction.approve', [HUB_A], member.identity.id),
              `update payer_correction set state = 'REJECTED', decided_by = '${member.identity.id}', decided_at = now() where id = '${memberId}'`,
            ],
          ],
          true,
        ),
        bundle,
      ).toMatch(/^(23514|42501):/);
    }
    // A fabricated approval moves nothing: the portions of the locked price add up to it, and the state is the gate's, run again from them (decided by a checker who is not the maker, to reach the order's guard).
    const fabricated = randomUUID();
    const checker = randomUUID();
    const checking = staff('pricing.correction.approve', [HUB_A], checker);
    const approval = (allocation: string, state: string): [SecurityContext, string][] => [
      [asking, insert(fabricated, maker)],
      [
        checking,
        `update payer_correction set state = 'APPROVED', decided_by = '${checker}', decided_at = now(), resulting_allocation = '${allocation}'::jsonb, resulting_commercial_state = '${state}' where id = '${fabricated}'`,
      ],
      [
        checking,
        `update "order" set payer_allocation = '${allocation}'::jsonb, commercial_state = '${state}' where id = '${made.id}'`,
      ],
    ];
    expect(
      await sequence(
        approval('{"sender_minor":100,"recipient_minor":100}', 'PAYMENT_REQUIRED'),
        false,
      ),
    ).toMatch(/^23514:.*add up to it/);
    expect(
      await sequence(
        approval('{"sender_minor":3500,"recipient_minor":0}', 'NO_VENDOR_CHARGE'),
        false,
      ),
    ).toMatch(/^23514:.*gate is re-run/);
    expect(
      await sequence(
        approval('{"sender_minor":3500,"recipient_minor":0}', 'PAYMENT_REQUIRED'),
        false,
      ),
    ).toBe('ran:1');
    // A correction is never removed.
    expect(
      await asOwner(asking, [insert(id, maker), `delete from payer_correction where id = '${id}'`]),
    ).toMatch(/^(23514|42501):|^ran:0$/);
  });
});

describe('the portions of a frozen price (AC-SLICE-001-65, -66: the gate reads the resolved amount)', () => {
  // Break caught: the portions resolved from the intent and not from the amounts, a percentage rounded down, a fixed amount larger than the price, or the sum of the portions not the price.
  it.each([
    ['RECIPIENT_PAYS', null, 0, 3500],
    ['SENDER_PAYS_FULL', null, 3500, 0],
    ['SPLIT', { basis: 'FIXED_AMOUNT' as const, amount: 1000 }, 1000, 2500],
    ['SPLIT', { basis: 'FIXED_AMOUNT' as const, amount: 5000 }, 3500, 0],
    ['SPLIT', { basis: 'PERCENTAGE' as const, percentage: 50 }, 1750, 1750],
    ['SPLIT', { basis: 'PERCENTAGE' as const, percentage: 33.33 }, 1167, 2333],
    ['SPLIT', { basis: 'PERCENTAGE' as const, percentage: 0 }, 0, 3500],
    ['SPLIT', { basis: 'PERCENTAGE' as const, percentage: 100 }, 3500, 0],
  ] as const)(
    'resolves %s %j into %i for the sender and %i for the recipient',
    async (intent, split, sender, recipient) => {
      const intake = await clearedPhotoIntake(1);
      await arrangePayer(intake.requestId, intent, split);
      const made = await orderFor(intake, present(intake.parcels, 0));
      const order = await orderOf(made.id);
      expect(order.payer_allocation).toMatchObject({
        sender_minor: sender,
        recipient_minor: recipient,
        payer_intent: intent,
      });
      expect(order.payer_allocation?.sender_minor).toBeDefined();
      expect(
        (order.payer_allocation?.sender_minor ?? 0) +
          (order.payer_allocation?.recipient_minor ?? 0),
      ).toBe(order.locked_price_minor);
    },
  );

  // Break caught: a freeze that reads the request's arrangement without the lock an edit holds (the review of 20 November 2026, finding 2). Asked of the function itself, with an edit in flight on another connection and
  // nothing of the application between them: the freeze waits for the edit and freezes with the arrangement it leaves.
  it('makes the freeze wait for an edit of the request that is in flight, and freeze with what the edit leaves', async () => {
    const intake = await photoIntake(2);
    const parcels = await parcelsOf(intake.id);
    const early = await orderFor(intake, present(parcels, 0));
    expect(early.frozen).toBe(false);
    rowsOf(await attempt(staff(COUNT), finish(intake.id, true, 2)));
    const holder = await holdingPickupRequest(routes.database, intake.requestId);
    const caller = clientFor(routes.database.urlFor('postgres'));
    await caller.connect();
    let freezing: Promise<unknown> | undefined;
    try {
      await holder.client.query(
        `update pickup_request set default_payer_intent = 'SENDER_PAYS_FULL' where id = $1`,
        [intake.requestId],
      );
      await caller.query('begin');
      await caller.query('set local role melarc_owner');
      for (const [name, value] of toContextSettings(staff(COUNT, [HUB_A], randomUUID()))) {
        await caller.query('select set_config($1, $2, true)', [name, value]);
      }
      freezing = caller.query(freeze(intake.id));
      await waitUntilBlockedBy(routes.admin, holder.pid, 'the freeze', freezing);
      await holder.client.query('commit');
      await freezing;
      await caller.query('commit');
    } catch (error) {
      await holder.client.query('rollback').catch(() => undefined);
      await caller.query('rollback').catch(() => undefined);
      await Promise.allSettled([freezing]);
      throw error;
    } finally {
      await holder.client.end();
      await caller.end();
    }
    expect((await orderOf(early.id)).payer_allocation).toMatchObject({
      sender_minor: 3500,
      recipient_minor: 0,
    });
  });

  // Break caught: the request's arrangement used when the order carries its own (a parcel-level override), or the arrangement read when the order was made and not when it was frozen (the vendor edits it until the freeze).
  it('applies the order’s own arrangement over the request’s, and the request’s as it stands at the freeze', async () => {
    const intake = await clearedPhotoIntake(2);
    await arrangePayer(intake.requestId, 'SENDER_PAYS_FULL');
    const override = await orderFor(intake, present(intake.parcels, 0), {
      payer_override: { payer_intent: 'RECIPIENT_PAYS' },
    });
    const own = await orderOf(override.id);
    expect(own.payer_override_applied).toBe(true);
    expect(own.payer_allocation).toMatchObject({
      sender_minor: 0,
      recipient_minor: 3500,
      payer_intent: 'RECIPIENT_PAYS',
    });

    // An order that waits is resolved when it is frozen: the vendor changed the arrangement in between.
    const early = await photoIntake(1);
    await arrangePayer(early.requestId, 'SENDER_PAYS_FULL');
    const waits = await orderFor(early, present(early.parcels, 0));
    await arrangePayer(early.requestId, 'RECIPIENT_PAYS');
    rowsOf(await attempt(staff(COUNT), tap(present(early.parcels, 0).id, true)));
    rowsOf(await attempt(staff(COUNT), finish(early.id, true, 1)));
    rowsOf(await attempt(staff(COUNT), freeze(early.id)));
    expect((await orderOf(waits.id)).payer_allocation).toMatchObject({
      sender_minor: 0,
      recipient_minor: 3500,
    });
  });
});

describe('the first commitment (AC-SLICE-001-56; contract: itemizeOrder)', () => {
  // Break caught: a commitment that is not written with the order, whose SLA clock is the writer's or the moment of itemization, or whose dates are not the order's.
  it('is written with the order at sequence 1, its clock the moment custody passed and its dates the order’s own', async () => {
    const intake = await clearedPhotoIntake(1);
    const made = await orderFor(intake, present(intake.parcels, 0), {
      requested_delivery_date: '2026-11-05',
      commitment: {
        default_date: '2026-11-03',
        requested_date: '2026-11-05',
        committed_date: '2026-11-05',
        window_start: '10:00',
        window_end: '16:00',
      },
    });
    const order = await orderOf(made.id);
    const [commitment, ...rest] = await commitmentsOf(made.id);
    expect(rest).toEqual([]);
    expect(commitment).toMatchObject({
      id: order.initial_commitment_id,
      sequence: 1,
      responsible_hub_id: HUB_A,
      default_date: '2026-11-03',
      requested_date: '2026-11-05',
      committed_date: '2026-11-05',
      committed_window_start: '10:00:00',
      committed_window_end: '16:00:00',
      superseded_at: null,
    });
    // The clock is custody (the handshake of the stop's collection, three hours ago), never the moment the order was made.
    expect(commitment?.sla_start_at.getTime()).toBe(intake.custody.getTime());
    expect(order.created_at.getTime() - (commitment?.sla_start_at.getTime() ?? 0)).toBeGreaterThan(
      60 * 60 * 1000,
    );
  });

  // Break caught: an order made for a stop whose custody cannot be read, which would promise a date from nothing (COMMITMENT_SOURCE_UNRESOLVED), leaving the order behind.
  it('is refused, with no order, when the moment custody passed cannot be read', async () => {
    const intake = await photoIntake(1, false);
    rowsOf(await attempt(staff(COUNT), finish(intake.id, true, 1)));
    const parcel = present(await parcelsOf(intake.id), 0);
    expect(refusal(await attempt(itemizer, itemize(intake.id, facts(parcel.id))))).toEqual([
      '23514',
      'COMMITMENT_SOURCE_UNRESOLVED',
      undefined,
    ]);
    expect(
      await routes.rows(`select 1 from "order" where pickup_intake_id = $1`, [intake.id]),
    ).toEqual([]);
    expect((await intakeOf(intake.id)).state).toBe('READY_FOR_ITEMIZATION');
  });

  // Break caught: a commitment whose dates disagree with the order's, one that can be edited or removed, a second one made with the first, or an order that can be committed without its commitment.
  it('is appended and never edited, and an order cannot be committed without it', async () => {
    const intake = await clearedPhotoIntake(1);
    const made = await orderFor(intake, present(intake.parcels, 0));
    const [first] = await commitmentsOf(made.id);
    expect(first).toBeDefined();
    const at = `where id = '${first?.id ?? ''}'`;
    // The policy that admits the amendment of an order that is not confirmed reaches the guard, which keeps the promise of a confirmed order as it was.
    expect(
      await asOwner(staff(ITEMIZE), [
        `update delivery_commitment set committed_date = '2026-12-01' ${at}`,
      ]),
    ).toMatch(
      /^23514:the promise of an order is rewritten only by the amendment of an order that is not confirmed/,
    );
    for (const change of [
      `committed_date = '2026-12-01'`,
      `default_date = '2026-12-01'`,
      `sla_start_at = now()`,
      `sequence = 2`,
    ]) {
      expect(
        await adminCommit([`update delivery_commitment set ${change} ${at}`]),
        change,
      ).toMatchObject({ code: '23514' });
    }
    expect(await adminCommit([`delete from delivery_commitment ${at}`])).toMatchObject({
      code: '23514',
    });
    // The supersession is the one change, once.
    expect(
      await adminCommit([
        `update delivery_commitment set superseded_at = now() where id = '${first?.id ?? ''}'`,
      ]),
    ).toBe('committed');
    expect(
      await adminCommit([
        `update delivery_commitment set superseded_at = now() + interval '1 hour' where id = '${first?.id ?? ''}'`,
      ]),
    ).toMatchObject({ code: '23514' });
    // A later sequence is not made so far, and a commitment whose dates are not the order's is refused.
    const second = await clearedPhotoIntake(1);
    const parcel = present(second.parcels, 0);
    const orderId = randomUUID();
    const commitmentId = randomUUID();
    const insertOrder = `insert into "order" (id, code, pickup_intake_id, responsible_hub_id, intake_parcel_id, recipient, origin_zone_snapshot, destination_zone_snapshot, destination_zone_resolution, derived_delivery_date, size_class, size_class_selected_by, is_high_value, lane, price_components_snapshot, initial_commitment_id, created_by)
       values ('${orderId}', 'ORD-X${randomUUID().slice(0, 5).toUpperCase()}', '${second.id}', '${HUB_A}', '${parcel.id}', '{"name":"A"}', '{"scope":"X"}', '{"scope":"X"}', 'SERVER_RESOLVED', '2026-11-03', 'SMALL', '${randomUUID()}', false, 'DOORSTEP', '${JSON.stringify(PRICE())}', '${commitmentId}', '${randomUUID()}')`;
    const insertCommitment = (over: string) =>
      `insert into delivery_commitment (id, order_id, responsible_hub_id, sequence, default_date, committed_date, sla_start_at) values ('${commitmentId}', '${orderId}', '${HUB_A}', ${over})`;
    // A later sequence is not made so far, and a commitment whose dates are not the order's is refused. (The guard's own refusal of a sequence other than 1 is shadowed by the table's rule that a later one
    // carries a reason, and by the guard's refusal of a reason: both say 23514, so this holds the pair and not the clause alone.)
    expect(
      await adminCommit([insertOrder, insertCommitment(`2, '2026-11-03', '2026-11-03', now()`)]),
    ).toMatchObject({ code: '23514' });
    expect(
      await adminCommit([insertOrder, insertCommitment(`1, '2026-11-03', '2026-12-01', now()`)]),
    ).toMatchObject({ code: '23514' });
    // No commitment: the end of the transaction refuses the order (the deferred key).
    expect(await adminCommit([insertOrder])).toMatchObject({
      code: '23503',
      constraint: 'order_initial_commitment_fkey',
    });
    // A commitment of the order's dates: committed.
    expect(
      await adminCommit([insertOrder, insertCommitment(`1, '2026-11-03', '2026-11-03', now()`)]),
    ).toBe('committed');
  });
});

describe('who reads an order, and who writes none', () => {
  // Break caught: a read of an order by a key that has no act on it, a write of an order or a commitment by the application's own login, or an order read across hubs.
  it('is read by the officer who made it in the hubs of its grant, and written by the application’s login by nobody', async () => {
    const intake = await clearedPhotoIntake(1);
    const made = await orderFor(intake, present(intake.parcels, 0));
    const read = (context: SecurityContext) =>
      attempt(context, `select id from "order" where id = '${made.id}'`);
    expect(rowsOf(await read(itemizer))).toHaveLength(1);
    // The senior who reverses an arrival reads the order in its own hubs (to hold the version of what it read), and nowhere else; no other key reads it.
    expect(rowsOf(await read(staff(OSD)))).toHaveLength(1);
    for (const denied of [
      staff(COUNT),
      staff(READ),
      staff(ITEMIZE, [HUB_B]),
      staff(OSD, [HUB_B]),
    ]) {
      expect(rowsOf(await read(denied)), denied.authorizationKey).toHaveLength(0);
    }
    expect(
      rowsOf(
        await attempt(itemizer, `select id from delivery_commitment where order_id = '${made.id}'`),
      ),
    ).toHaveLength(1);
    expect(
      rowsOf(
        await attempt(
          staff(READ),
          `select id from delivery_commitment where order_id = '${made.id}'`,
        ),
      ),
    ).toHaveLength(0);
    for (const write of [
      `insert into "order" (id) values ('${randomUUID()}')`,
      `update "order" set size_class = 'LARGE' where id = '${made.id}'`,
      `delete from "order" where id = '${made.id}'`,
      `update delivery_commitment set committed_date = '2030-01-01' where order_id = '${made.id}'`,
      `delete from delivery_commitment where order_id = '${made.id}'`,
    ]) {
      expect(refusal(await attempt(itemizer, write))[0], write).toBe('42501');
    }
  });

  // Break caught: what an order is made from read by a key that does not itemize, or across hubs: the place of collection, the booking's acknowledgement and the moment of custody.
  it('says what it is made from to the officer who itemizes alone', async () => {
    const intake = await clearedPhotoIntake(1);
    const source = `select responsible_hub_id, origin_location, acknowledged_at_booking, custody_at from melarc.itemization_source('${intake.id}')`;
    const [row] = rowsOf(await attempt(itemizer, source));
    expect(row).toMatchObject({ responsible_hub_id: HUB_A, acknowledged_at_booking: false });
    expect(new Date(String(row?.custody_at)).getTime()).toBe(intake.custody.getTime());
    expect(row?.origin_location).toBeDefined();
    for (const denied of [staff(COUNT), staff(OSD), staff(READ)]) {
      expect(refusal(await attempt(denied, source))[0], denied.authorizationKey).toBe('42501');
    }
    expect(rowsOf(await attempt(staff(ITEMIZE, [HUB_B]), source))).toEqual([]);
  });
});

describe('the records of an amendment and of a reversal, for every writer (the review of 19 November 2026)', () => {
  const amendment = (orderId: string, version: number): string =>
    `insert into order_amendment (id, order_id, responsible_hub_id, amended_by, order_version, note, before, after)
     values ('${randomUUID()}', '${orderId}', '${HUB_A}', '${randomUUID()}', ${String(version)}, 'a note', '{}'::jsonb, '{"size_class":"LARGE"}'::jsonb)`;

  // Break caught: a record of an amendment that can be written for an order that is confirmed, so that its edit would have a record to stand beside.
  it('refuses a record of an amendment for an order that is confirmed, and for a version that was not read', async () => {
    const intake = await clearedPhotoIntake(1);
    const made = await orderFor(intake, present(intake.parcels, 0));
    const confirmed = await asOwner(staff(ITEMIZE), [amendment(made.id, 1)]);
    expect(confirmed).toMatch(
      /^23514:an order whose price is frozen is confirmed: it is not amended/,
    );
    // An order that waits: a version the officer did not read is refused too.
    const waiting = await photoIntake(1);
    const early = await orderFor(waiting, present(waiting.parcels, 0));
    expect(await asOwner(staff(ITEMIZE), [amendment(early.id, 99)])).toMatch(
      /^23514:the order has changed since it was read/,
    );
    // And no other key writes one.
    expect(await asOwner(staff(COUNT), [amendment(early.id, 1)])).toMatch(/^(42501|23514):/);
  });

  // Break caught: a reversal recorded for an order that was never confirmed, or by a key that does not adjudicate.
  it('refuses a record of a reversal for an order that is not confirmed, and by a key that does not adjudicate', async () => {
    const waiting = await photoIntake(1);
    const early = await orderFor(waiting, present(waiting.parcels, 0));
    const reversal = (orderId: string, parcelId: string, intakeId: string): string =>
      `insert into order_reversal (id, order_id, intake_parcel_id, pickup_intake_id, responsible_hub_id, reversed_by, order_version, previous_commercial_state, previous_parcel_state, resulting_parcel_state, note)
       values ('${randomUUID()}', '${orderId}', '${parcelId}', '${intakeId}', '${HUB_A}', '${randomUUID()}', 1, 'PRICED', 'ARRIVED', 'MISSING', 'a note')`;
    const parcel = present(waiting.parcels, 0);
    expect(await asOwner(staff(OSD), [reversal(early.id, parcel.id, waiting.id)])).toMatch(
      /^23514:only a confirmed order that has not been paid for, reserved or dispatched is reversed/,
    );
    expect(await asOwner(staff(ITEMIZE), [reversal(early.id, parcel.id, waiting.id)])).toMatch(
      /^(42501|23514):/,
    );
  });
});
