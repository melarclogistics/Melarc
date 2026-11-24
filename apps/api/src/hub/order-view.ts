import { sql } from 'drizzle-orm';

import type { transactionOf } from '../platform/database/transaction-handle.js';

/**
 * The order as the staff of the hub's Ops Portal read it (S1.36; the contract's `Order`): what `itemizeOrder` answers, from the row the database made and the state of the parcel it is made for. **Staff see the
 * whole order** (`getOrder`, which a vendor also reads without the recipient, the serial and the officer, is a later task's): a vendor's session never reaches this view.
 *
 * An order that waits for its parcel has **no commercial state, no locked price and no portions**: it is not in the commercial machine yet, and `intake_parcel_state` (`EXPECTED`) says what it waits for;
 * a parcel that is `MISSING` or `VOID` is told the same way and its order is never priced or dispatched. The calculated price is in `price_components_snapshot` from the moment the order is made, beside the
 * booking's estimate and distinct from it (`AC-SLICE-001-56`).
 */
export interface OrderRow {
  readonly id: string;
  readonly code: string;
  readonly pickup_intake_id: string;
  readonly responsible_hub_id: string;
  readonly intake_parcel_id: string | null;
  readonly intake_parcel_state: string | null;
  /** The picture of the parcel the order is made for (Run G1, D-S7-14): the door photo of a door parcel, the officer's photo of an extra; null for an order of a vendor counted without photos. Staff only. */
  readonly intake_parcel_photo_evidence_id: string | null;
  readonly commercial_state: string | null;
  readonly fulfilment_state: string;
  readonly origin_zone_snapshot: Record<string, unknown>;
  readonly destination_zone_snapshot: Record<string, unknown>;
  readonly destination_zone_resolution: string;
  readonly declared_value_minor: number | null;
  readonly is_serialized_goods: boolean;
  readonly serial_imei: string | null;
  readonly service_level: string;
  readonly requested_delivery_date: string | null;
  readonly derived_delivery_date: string | null;
  readonly delivery_date_override: Record<string, unknown> | null;
  readonly size_class: string;
  readonly size_class_selected_by: string | null;
  readonly carrier_cost_minor: number | null;
  readonly is_high_value: boolean;
  /** The officer's own flag, apart from what the declared value says (the review of 20 November 2026, finding 4). */
  readonly is_high_value_manual: boolean | null;
  readonly lane: string;
  readonly commercial_mode: string | null;
  readonly payer_allocation: { sender_minor: number; recipient_minor: number } | null;
  readonly price_components_snapshot: Record<string, unknown>;
  readonly locked_price_minor: number | null;
  readonly delivery_attempt_count: number;
  readonly recipient: { name: string; phone: string; location: Record<string, unknown> };
  /** What an amendment restates and a reader cannot rebuild: the order's own payer arrangement (null when the request's stands) and the evidence it cites. */
  readonly payer_override: Record<string, unknown> | null;
  readonly high_value_evidence_ids: readonly string[];
  readonly carrier_waybill_evidence_id: string | null;
  /** The durable version of the row, read **in the same statement** as the rest of it, so that the `ETag` built from the two always names one coherent record (review finding D). */
  readonly version: number | string;
}

/** The columns of an order and the state of its parcel, for a read in the caller's transaction. */
export const ORDER_SELECT = sql.raw(`
  o.id, o.code, o.pickup_intake_id, o.responsible_hub_id, o.intake_parcel_id, p.state AS intake_parcel_state, coalesce(p.door_photo_evidence_id, p.hub_photo_evidence_id) AS intake_parcel_photo_evidence_id, o.commercial_state, o.fulfilment_state,
  o.origin_zone_snapshot, o.destination_zone_snapshot, o.destination_zone_resolution, o.declared_value_minor, o.is_serialized_goods, o.serial_imei, o.service_level,
  o.requested_delivery_date::text AS requested_delivery_date, o.derived_delivery_date::text AS derived_delivery_date, o.delivery_date_override,
  o.size_class, o.size_class_selected_by, o.carrier_cost_minor, o.is_high_value, o.is_high_value_manual, o.lane, o.commercial_mode, o.payer_allocation, o.price_components_snapshot,
  o.locked_price_minor, o.delivery_attempt_count, o.recipient, o.payer_override, o.high_value_evidence_ids, o.carrier_waybill_evidence_id, o.version
  FROM "order" AS o LEFT JOIN intake_parcel AS p ON p.id = o.intake_parcel_id`);

const money = (amountMinor: number): { amount_minor: number; currency: 'GHS' } => ({
  amount_minor: amountMinor,
  currency: 'GHS',
});

/** The jsonb columns as the driver gave them: parsed, or the text of them. */
const jsonOf = (value: unknown): unknown => (typeof value === 'string' ? JSON.parse(value) : value);

/** The order's own payer arrangement as the API states it (a portion in money, never the column's internal name), or null when the request's stands. */
export function payerOverrideViewOf(stored: unknown): {
  payer_intent: string;
  split_basis?: string;
  split_sender_amount?: { amount_minor: number; currency: 'GHS' };
  split_sender_percentage?: number;
} | null {
  if (stored === null || stored === undefined) return null;
  const given = jsonOf(stored) as {
    payer_intent: string;
    split_basis?: string | null;
    split_sender_amount_minor?: number | null;
    split_sender_percentage?: number | string | null;
  };
  return {
    payer_intent: given.payer_intent,
    ...(given.split_basis == null ? {} : { split_basis: given.split_basis }),
    ...(given.split_sender_amount_minor == null
      ? {}
      : {
          split_sender_amount: {
            amount_minor: given.split_sender_amount_minor,
            currency: 'GHS' as const,
          },
        }),
    ...(given.split_sender_percentage == null
      ? {}
      : { split_sender_percentage: Number(given.split_sender_percentage) }),
  };
}

export type OrderView = ReturnType<typeof orderViewOf>;

/** The answer for one order. A member that does not apply to it (a carrier's cost outside the covered third-party mode, the portions of an order that is not frozen) is left out, not null. */
export function orderViewOf(row: OrderRow) {
  const allocation =
    row.payer_allocation === null
      ? null
      : (jsonOf(row.payer_allocation) as { sender_minor: number; recipient_minor: number });
  return {
    id: row.id,
    code: row.code,
    pickup_intake_id: row.pickup_intake_id,
    responsible_hub_id: row.responsible_hub_id,
    intake_parcel_id: row.intake_parcel_id,
    intake_parcel_state: row.intake_parcel_state,
    intake_parcel_photo_evidence_id: row.intake_parcel_photo_evidence_id,
    commercial_state: row.commercial_state,
    fulfilment_state: row.fulfilment_state,
    origin_zone_snapshot: jsonOf(row.origin_zone_snapshot) as Record<string, unknown>,
    destination_zone_snapshot: jsonOf(row.destination_zone_snapshot) as Record<string, unknown>,
    size_class: row.size_class,
    size_class_selected_by: row.size_class_selected_by,
    ...(row.carrier_cost_minor === null ? {} : { carrier_cost: money(row.carrier_cost_minor) }),
    derived_delivery_date: row.derived_delivery_date,
    is_high_value: row.is_high_value,
    is_high_value_manual: row.is_high_value_manual,
    lane: row.lane,
    commercial_mode: row.commercial_mode,
    // What the price is, in a word: an early quote (calculated, kept as calculated until the order is amended or confirmed) or the frozen price. A preview is neither, and says so itself.
    price_status: row.locked_price_minor === null ? ('EARLY_QUOTE' as const) : ('FROZEN' as const),
    locked_price: row.locked_price_minor === null ? null : money(row.locked_price_minor),
    price_components_snapshot: jsonOf(row.price_components_snapshot) as Record<string, unknown>,
    delivery_attempt_count: row.delivery_attempt_count,
    recipient: jsonOf(row.recipient) as {
      name: string;
      phone: string;
      location: Record<string, unknown>;
    },
    declared_value_minor: row.declared_value_minor,
    is_serialized_goods: row.is_serialized_goods,
    serial_imei: row.serial_imei,
    requested_delivery_date: row.requested_delivery_date,
    service_level: row.service_level,
    destination_zone_resolution: row.destination_zone_resolution,
    delivery_date_override: row.delivery_date_override,
    payer_override: payerOverrideViewOf(row.payer_override),
    high_value_evidence_ids: row.high_value_evidence_ids,
    carrier_waybill_evidence_id: row.carrier_waybill_evidence_id ?? null,
    ...(allocation === null
      ? {}
      : {
          payer_allocation: {
            sender_minor: allocation.sender_minor,
            recipient_minor: allocation.recipient_minor,
          },
        }),
  };
}

/** One order as the caller's transaction reads it, with the state of its parcel. */
export async function loadOrder(
  tx: ReturnType<typeof transactionOf>,
  id: string,
): Promise<OrderRow | undefined> {
  const found = await tx.execute(sql`select ${ORDER_SELECT} where o.id = ${id}::uuid`);
  return found.rows[0] as unknown as OrderRow | undefined;
}
