import { createHash } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
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
export interface ReadOrder {
  readonly order: OrderView | VendorOrderView;
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
 *   hub is one that does not exist.
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
    return this.#options.runner.read(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const row = await loadOrder(tx, id);
      if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
      const versioned = await tx.execute(sql`select version from "order" where id = ${id}::uuid`);
      const version = Number((versioned.rows[0] as { version: number | string }).version);
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
        return { order: view, etag: orderEtagOf(view, version) };
      }
      const shown = vendorOrderViewOf(view);
      return { order: shown, etag: orderEtagOf(shown, version) };
    });
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
      const orders = (typeof row.orders === 'string' ? JSON.parse(row.orders) : row.orders) as {
        id: string;
        code: string;
        recipient_name: string;
        service_area: string;
        size_class: string | null;
        locked_price_minor: number | null;
        commercial_state: string | null;
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
          ...(order.locked_price_minor === null
            ? {}
            : {
                locked_price: { amount_minor: order.locked_price_minor, currency: 'GHS' as const },
              }),
          commercial_state: order.commercial_state ?? 'PRICED',
        })),
      };
    });
  }
}
