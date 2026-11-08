import { sql } from 'drizzle-orm';

import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';

export interface VendorPickupLocationView {
  readonly id: string;
  readonly vendor_organization_id: string;
  readonly label: string;
  readonly location: {
    readonly address: string;
    readonly landmark?: string;
    readonly map_link?: string;
    readonly latitude?: number;
    readonly longitude?: number;
  };
  readonly is_default: boolean;
  readonly active: boolean;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_by: string | null;
  readonly updated_at: string | null;
}

interface LocationRow {
  readonly id: string;
  readonly vendor_organization_id: string;
  readonly label: string;
  readonly location: VendorPickupLocationView['location'];
  readonly is_default: boolean;
  readonly active: boolean;
  readonly created_by: string;
  readonly created_at: string | Date;
  readonly updated_by: string | null;
  readonly updated_at: string | Date | null;
}

const iso = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * `listVendorPickupLocations` (S1.14; `vendor.pickup_location.manage`; `AC-SLICE-001-69`; domain-model.md section 6.18): the saved
 * pickup locations of one vendor organisation, active and retired, the default first. A booking offers the active ones.
 *
 * - **The organisation is named by the path, and whether the caller can see it is decided before this runs**: a vendor sees its own and
 *   another's is `NOT_FOUND` by the same path as an id that matches nothing; an Ops member sees the organisations of the hubs of its grant
 *   and is told `HUB_SCOPE_VIOLATION` for one outside them (the existence rule, `AC-SLICE-001-79`).
 * - **Read-only.** The management operations (add, edit, set the default, retire) are `SLICE-008`'s; the table is written by the
 *   non-production fixture and the test kit until then.
 */
export class VendorPickupLocationsService {
  readonly #runner: Pick<OperationRunner, 'read'>;

  constructor(options: { readonly runner: Pick<OperationRunner, 'read'> }) {
    this.#runner = options.runner;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    organisationId: string,
  ): Promise<{ readonly items: readonly VendorPickupLocationView[] }> {
    return this.#runner.read(authorized, correlationId, async (handle) => {
      const found = await transactionOf(handle).execute(sql`
        select id, vendor_organization_id, label, location, is_default, active, created_by, created_at, updated_by, updated_at
          from vendor_pickup_location
         where vendor_organization_id = ${organisationId}::uuid
         order by is_default desc, active desc, created_at, id`);
      return {
        items: (found.rows as unknown as LocationRow[]).map((row) => ({
          id: row.id,
          vendor_organization_id: row.vendor_organization_id,
          label: row.label,
          location: row.location,
          is_default: row.is_default,
          active: row.active,
          created_by: row.created_by,
          created_at: iso(row.created_at),
          updated_by: row.updated_by,
          updated_at: row.updated_at === null ? null : iso(row.updated_at),
        })),
      };
    });
  }
}
