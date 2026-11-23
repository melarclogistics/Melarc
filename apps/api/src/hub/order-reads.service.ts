import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import {
  authorizationForKey,
  type AuthorizedRequest,
} from '../platform/authorization/authorized-request.js';
import { scopeIncludesHub } from '../platform/authorization/effective-scope.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { timestampOf } from '../platform/database/timestamps.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { primaryHubOfStaff } from '../platform/lookup/primary-hub.js';
import { loadOrder, orderViewOf, type OrderView } from './order-view.js';

export interface OrderReadsOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/**
 * What a vendor is shown of an order, **by allowlist** (37.6; the contract's `getOrder`: the locked price and never its inputs): a member added to the staff's view is not a vendor's until it is named here. The
 * recipient, the serial or IMEI, the officer who judged the size, the carrier's cost, **the components of the price** (they name the margin and the carrier's cost), the zones, the hub and the date override stay
 * with the staff.
 */
const SHOWN_TO_A_VENDOR = [
  'id',
  'code',
  'pickup_intake_id',
  'intake_parcel_id',
  'intake_parcel_state',
  'commercial_state',
  'fulfilment_state',
  'size_class',
  'lane',
  'commercial_mode',
  'is_high_value',
  'locked_price',
  'payer_allocation',
  'derived_delivery_date',
  'requested_delivery_date',
  'service_level',
  'delivery_attempt_count',
] as const;

/** The order a vendor reads: the members named above and no other. */
export type VendorOrderView = Partial<Pick<OrderView, (typeof SHOWN_TO_A_VENDOR)[number]>>;

/** An order as one session reads it, and the `ETag` of what that session was shown. */
/** What the staff of the order's hub read besides the order: how it was corrected before it froze, and whether its arrival was reversed. */
export interface OrderHistory {
  readonly amendments: readonly {
    readonly id: string;
    readonly amended_by: string;
    readonly amended_at: string;
    readonly note: string;
    readonly changed: readonly string[];
  }[];
  readonly reversal: {
    readonly id: string;
    readonly reversed_by: string;
    readonly reversed_at: string;
    readonly note: string;
  } | null;
}

export interface ReadOrder {
  readonly order: (OrderView & OrderHistory) | VendorOrderView;
  readonly etag: string;
}

/** The vendor-facing summary of a closed intake (`IntakeSummary`): the orders of the parcels that arrived, each with what a vendor may know of it, and nothing else. */
export interface IntakeSummaryView {
  readonly intake_id: string;
  readonly pickup_request_id: string;
  readonly closed_at: string;
  readonly orders: readonly {
    readonly id: string;
    readonly code: string;
    readonly recipient_name: string;
    readonly service_area: string;
    readonly size_class?: string;
    readonly locked_price?: { readonly amount_minor: number; readonly currency: 'GHS' };
    /** Who pays what of the locked price (D-S7-10): shown where the price is, and left out where it is not. */
    readonly payer_allocation?: { readonly sender_minor: number; readonly recipient_minor: number };
    readonly commercial_state: string;
  }[];
}

const DOMAIN = 'melarc.order-etag.v1';
const ORDER_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

/**
 * The `ETag` of an order as a session reads it (S1.38; `getOrder` is the read that returns the order's `ETag`, which a payer correction takes back): an opaque strong validator, the digest of what the read
 * returned and of the order's durable `version`, which the database moves for any change to the row. A vendor's `ETag` is the digest of the vendor's own shape, so it never says anything the vendor is not shown.
 */
export function orderEtagOf(shown: object, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, version, shown]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag of the order. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function orderEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && ORDER_ETAG.test(header) && header === current;
}

/** The order a vendor reads. */
export function vendorOrderViewOf(view: OrderView): VendorOrderView {
  const shown = new Set<string>(SHOWN_TO_A_VENDOR);
  const picked: VendorOrderView = Object.fromEntries(
    Object.entries(view).filter(([member]) => shown.has(member)),
  );
  return picked;
}

const isoOf = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * The reads of the orders and of the closed intake (S1.38; features/hub/itemization.md sections 5.1 and 5.2; `AC-SLICE-001-46` and `-56`):
 *
 * - **`getOrder`** (`pricing.read`): the order with the state of its parcel and the `ETag` of what the session was shown. Staff see the whole order in the hubs of their grant (a hub that is not the caller's own is
 *   audited as every staff read is); a vendor reads only its own orders and never the recipient, the serial or IMEI, the officer who judged the size or the carrier's cost; **another vendor's order, and an order of
 *   another hub, is one that does not exist**. The authoritative price is the `locked_price` and the booking's estimate is a different thing, kept apart (`AC-SLICE-001-56`).
 * - **`getIntakeSummary`** (`pickup.read`): the vendor-facing intake-completed and order summary, from one function of the database that reads the closed intake and its orders and returns what a vendor may know;
 *   no blind count, declaration, discrepancy, evidence or adjudication is in what it reads or returns, so no code path can leak one. An intake that is not closed, that another vendor owns or that is in another
 *   hub is one that does not exist. **A price is shown to the owning vendor, and to staff only where their own `pricing.read` grant also reaches the intake's hub** (the Product Owner's decision of 22 November 2026,
 *   OB-S1-155): the staff's operational summary needs `pickup.read` and the money needs the grant of the money, so an officer who holds the first and not the second (or holds it for another hub) is given no
 *   `locked_price` at all. The amount is left out on the server, never shown as zero: a zero is a price that is zero.
 */
export class HubOrderReads {
  readonly #options: OrderReadsOptions;

  constructor(options: OrderReadsOptions) {
    this.#options = options;
  }

  async getOrder(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<ReadOrder> {
    const principal = authorized.session.principalType;
    if (principal !== 'STAFF' && principal !== 'VENDOR') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    // **One snapshot** (the review of 20 November 2026, finding 6): the order, its history and the hub's baseline are read in statements of one transaction, and at the default isolation each statement sees what
    // had committed when it began, so an amendment or a reversal that committed between them was shown as the history of an order that does not yet have it. At `REPEATABLE READ` they are one picture.
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const tx = transactionOf(handle);
        const row = await loadOrder(tx, id);
        if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        // The version comes with the row, in one statement: a second read could see a correction that committed in between (old data with the new version).
        const version = Number(row.version);
        const view = orderViewOf(row);
        if (principal === 'STAFF') {
          const baseline = await primaryHubOfStaff(handle, authorized.session.principalId);
          if (row.responsible_hub_id !== baseline) {
            await this.#options.audit.write(handle, {
              code: 'auth.hub_boundary.crossed',
              enhanced: true,
              outcome: 'SUCCEEDED',
              object: { type: 'Order', id },
              responsibleHubId: row.responsible_hub_id,
            });
          }
          // The ETag is the digest of the order as the other acts recompute it, never of the history beside it.
          return {
            order: { ...view, ...(await this.#historyOf(tx, id)) },
            etag: orderEtagOf(view, version),
          };
        }
        // A vendor has no policy on the parcels (the hub's inside): the one thing of its parcel it is told is read through a function of the database that answers for the vendor's own order alone (D-S7-4: a
        // parcel that did not come is told as one that was not received, with no price and nothing to pay).
        const parcelState =
          row.intake_parcel_id === null ? null : await this.#parcelStateForVendor(tx, id);
        const shown = vendorOrderViewOf({ ...view, intake_parcel_state: parcelState });
        return { order: shown, etag: orderEtagOf(shown, version) };
      },
      { isolation: 'REPEATABLE READ' },
    );
  }

  /** The state of the parcel of the vendor's own order (`melarc.vendor_order_parcel_state`, migration 0122): null for an order that is not the vendor's, whatever it says. */
  async #parcelStateForVendor(
    tx: ReturnType<typeof transactionOf>,
    id: string,
  ): Promise<string | null> {
    const found = await tx.execute(
      sql`select melarc.vendor_order_parcel_state(${id}::uuid) as state`,
    );
    const state = (found.rows[0] as { state: string | null } | undefined)?.state;
    return state ?? null;
  }

  /** How the order was corrected before it froze (the members that changed, never their values) and whether its arrival was reversed. */
  async #historyOf(tx: ReturnType<typeof transactionOf>, id: string): Promise<OrderHistory> {
    const amended = (
      await tx.execute(
        sql`select id, amended_by, amended_at, note, after from order_amendment where order_id = ${id}::uuid order by amended_at, id`,
      )
    ).rows as unknown as {
      id: string;
      amended_by: string;
      amended_at: string | Date;
      note: string;
      after: unknown;
    }[];
    const reversed = (
      await tx.execute(
        sql`select id, reversed_by, reversed_at, note from order_reversal where order_id = ${id}::uuid`,
      )
    ).rows[0] as
      { id: string; reversed_by: string; reversed_at: string | Date; note: string } | undefined;
    return {
      amendments: amended.map((row) => ({
        id: row.id,
        amended_by: row.amended_by,
        amended_at: timestampOf(row.amended_at).toISOString(),
        note: row.note,
        changed: Object.keys(
          (typeof row.after === 'string' ? JSON.parse(row.after) : row.after) as Record<
            string,
            unknown
          >,
        ).toSorted(),
      })),
      reversal:
        reversed === undefined
          ? null
          : {
              id: reversed.id,
              reversed_by: reversed.reversed_by,
              reversed_at: timestampOf(reversed.reversed_at).toISOString(),
              note: reversed.note,
            },
    };
  }

  async getSummary(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<IntakeSummaryView> {
    const principal = authorized.session.principalType;
    if (principal !== 'STAFF' && principal !== 'VENDOR') {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Not permitted');
    }
    return this.#options.runner.read(authorized, correlationId, async (handle) => {
      const found = await transactionOf(handle).execute(
        sql`select intake_id, pickup_request_id, closed_at, orders from melarc.intake_summary(${id}::uuid)`,
      );
      const row = found.rows[0] as
        | {
            intake_id: string;
            pickup_request_id: string;
            closed_at: string | Date;
            orders: unknown;
          }
        | undefined;
      if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      // The money: the owning vendor sees its own orders' prices; staff see them where the grant of the money reaches the intake's hub, which is the grant's own scope and not the operation's.
      const showPrices =
        principal === 'VENDOR' || (await this.#staffMaySeePrices(handle, authorized, id));
      const orders = (typeof row.orders === 'string' ? JSON.parse(row.orders) : row.orders) as {
        id: string;
        code: string;
        recipient_name: string;
        service_area: string;
        size_class: string | null;
        locked_price_minor: number | null;
        commercial_state: string | null;
        payer_allocation: { sender_minor: number; recipient_minor: number } | null;
      }[];
      return {
        intake_id: row.intake_id,
        pickup_request_id: row.pickup_request_id,
        closed_at: isoOf(row.closed_at),
        orders: orders.map((order) => ({
          id: order.id,
          code: order.code,
          recipient_name: order.recipient_name,
          service_area: order.service_area,
          ...(order.size_class === null ? {} : { size_class: order.size_class }),
          ...(order.locked_price_minor === null || !showPrices
            ? {}
            : {
                locked_price: { amount_minor: order.locked_price_minor, currency: 'GHS' as const },
              }),
          ...(order.payer_allocation === null || !showPrices
            ? {}
            : {
                payer_allocation: {
                  sender_minor: order.payer_allocation.sender_minor,
                  recipient_minor: order.payer_allocation.recipient_minor,
                },
              }),
          commercial_state: order.commercial_state ?? 'PRICED',
        })),
      };
    });
  }

  /**
   * Whether this staff reader holds `pricing.read` for the hub of the intake (OB-S1-155): the grant of that key from the session's snapshot, and its scope (never the scope of `pickup.read`, which a wider grant of
   * another key does not widen). The intake is the one the summary was just read for, in the same transaction; its hub does not change.
   */
  async #staffMaySeePrices(
    handle: Parameters<typeof transactionOf>[0],
    authorized: AuthorizedRequest,
    intakeId: string,
  ): Promise<boolean> {
    const pricing = authorizationForKey(authorized, 'pricing.read');
    if (pricing === undefined) return false;
    const hub = (
      (
        await transactionOf(handle).execute(
          sql`select responsible_hub_id from pickup_intake where id = ${intakeId}::uuid`,
        )
      ).rows[0] as { responsible_hub_id?: string } | undefined
    )?.responsible_hub_id;
    return typeof hub === 'string' && scopeIncludesHub(pricing.scope, hub);
  }
}
