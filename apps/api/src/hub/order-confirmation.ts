import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';

/**
 * The confirmation of the orders that waited for their parcel (S1.36 and D-D6; itemization.md §5.4: *checking a parcel in confirms its order*; `AC-SLICE-001-104`). It is made **in the transaction of the act that
 * commits an arrival**, once that act has been made: the vendor is finished (`finishCheckIn`), a missing parcel is found (`recordParcelArrival`), a senior's correction brings a parcel back
 * (`correctIntakeCount`). A tap made while the vendor's check-in is open is **not** such an act, because the officer may take it back: nothing is frozen until the arrival is committed.
 *
 * `melarc.freeze_orders` freezes every order of the intake whose parcel has arrived and that is not frozen yet, to the price that was calculated when it was made (so this can never be refused for a price: every
 * refusal of the price was raised when the order was made), with the portions resolved from the sender's payer arrangement as it then stands. It returns what it froze, and the ledger's `pricing.price.locked` is
 * written for each. An intake whose vendor is still being checked in freezes nothing. The commercial gate follows the freeze in the same change (S1.37, `0111`) and has its own event.
 */
export async function confirmWaitingOrders(
  handle: TransactionHandle,
  audit: AuditWriter,
  intake: {
    readonly id: string;
    readonly responsible_hub_id: string;
    readonly pickup_manifest_id: string;
    readonly pickup_request_id: string;
  },
): Promise<number> {
  const frozen = await transactionOf(handle).execute(
    sql`select order_id, locked_price_minor, commercial_state, sender_minor, recipient_minor from melarc.freeze_orders(${intake.id}::uuid)`,
  );
  const relatedIds = {
    pickup_intake_id: intake.id,
    pickup_manifest_id: intake.pickup_manifest_id,
    pickup_request_id: intake.pickup_request_id,
  };
  for (const row of frozen.rows as unknown as {
    order_id: string;
    locked_price_minor: number;
    commercial_state: string;
    sender_minor: number;
    recipient_minor: number;
  }[]) {
    await audit.write(handle, {
      code: 'pricing.price.locked',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'Order', id: row.order_id },
      responsibleHubId: intake.responsible_hub_id,
      relatedIds,
      detail: { locked_price_minor: row.locked_price_minor, confirmed_by_check_in: true },
    });
    await recordCommercialGate(handle, audit, {
      orderId: row.order_id,
      hubId: intake.responsible_hub_id,
      relatedIds,
      commercialState: row.commercial_state,
      lockedPriceMinor: row.locked_price_minor,
      senderMinor: row.sender_minor,
      recipientMinor: row.recipient_minor,
    });
  }
  return frozen.rows.length;
}

/**
 * The event of the commercial gate (S1.37, `AC-SLICE-001-65`): the freeze has just taken the order to `NO_VENDOR_CHARGE` or `PAYMENT_REQUIRED` (the database made the move, by the resolved vendor portion alone,
 * `0111`), and the ledger names the one it took: `order.commercial.cleared_no_charge` when the resolved portion was zero, `order.payment.required` otherwise. The state and the portions are what the database
 * handed back (the gate is never worked out again here), and the event carries the amounts the gate read: the resolved portions and never the request's intent.
 */
export async function recordCommercialGate(
  handle: TransactionHandle,
  audit: AuditWriter,
  gated: {
    readonly orderId: string;
    readonly hubId: string;
    readonly relatedIds: Readonly<Record<string, string>>;
    readonly commercialState: string | null;
    readonly lockedPriceMinor: number;
    readonly senderMinor: number;
    readonly recipientMinor: number;
  },
): Promise<void> {
  const code =
    gated.commercialState === 'NO_VENDOR_CHARGE'
      ? 'order.commercial.cleared_no_charge'
      : gated.commercialState === 'PAYMENT_REQUIRED'
        ? 'order.payment.required'
        : undefined;
  if (code === undefined) throw new Error('A frozen order was not gated');
  await audit.write(handle, {
    code,
    enhanced: false,
    outcome: 'SUCCEEDED',
    object: { type: 'Order', id: gated.orderId },
    responsibleHubId: gated.hubId,
    relatedIds: gated.relatedIds,
    detail: {
      commercial_state: gated.commercialState,
      locked_price_minor: gated.lockedPriceMinor,
      sender_minor: gated.senderMinor,
      recipient_minor: gated.recipientMinor,
    },
  });
}
