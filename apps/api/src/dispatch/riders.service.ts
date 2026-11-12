import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import {
  hubOutsideStaffGrant,
  type AuthorizedRequest,
} from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { isUuid } from '../platform/database/transaction-context.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { riderEtagOf } from '../staff/rider-etag.js';
import {
  RIDER_COLUMNS,
  RIDER_SOURCE,
  devicesOfRider,
  generationOf,
  viewOf,
  type RiderDeviceView,
  type RiderRow,
  type RiderView,
} from '../staff/rider-view.js';
import { decodePageToken, encodePageToken } from '../staff/staff-identity-page-token.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
} from '../staff/staff-identity-schemas.js';

export type { RiderDeviceView, RiderView };

export interface RiderListFilter {
  readonly status?: string;
  readonly hubId?: string;
  readonly q?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface RidersServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** Both reads are one picture of the data: the rows, the devices and the audit in one snapshot. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

function invalid(name: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });
}

/** A string for a `LIKE` pattern in which `%`, `_` and the escape character mean themselves: the search matches text, not a pattern. */
const literal = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * `listRiders` and `getRider` (S0.53a; `dispatch.read`; `AC-SLICE-000-113`; rider-authentication.md section 12), in the form of the vendor
 * reads (`vendor-accounts.service.ts`) over the staff domain's rider tables.
 *
 * - **The scope is row-level security and the scope probe** (migration 0040): the reads run in the caller's own context under the key, so a
 *   rider is shown when its primary hub is in the scope of the grant, or under the explicit all-hub scope. `hub_id` narrows within that and
 *   never widens it. The record a route names is found or refused (`HUB_SCOPE_VIOLATION` by the probe, `NOT_FOUND`) by the guard before this
 *   runs; one that has gone since is `NOT_FOUND` here. **The browser surface only**: a rider's bearer credential, though the Rider bundle
 *   holds `dispatch.read`, is not one the operation takes (`401 SESSION_INVALID`), and a Vendor's session is refused `PERMISSION_DENIED`.
 * - **Identity and readiness only.** No response holds a PIN, a hash, a key, a failed-attempt count, a lock or an attestation; `pin_established`
 *   and `has_active_device` are the whole of the rider's authentication state, derived by the query and never stored.
 * - **An authorised read outside the actor's own hub is audited, without contents** (audit.md sections 5.4 and 6), as for the staff and
 *   vendor reads: one `auth.hub_boundary.crossed` for the read of a rider of another hub, and one for each foreign hub a list represents.
 *   The baseline is the actor's primary hub; an actor with none has none of its own.
 * - **The ETag is the digest of what the read returned and of the PIN's generation** (`rider-etag.ts`), so it changes when the status or the
 *   device set changes and never because of a failed sign-in. A list carries none.
 * - **The list is ordered by the rider's moment of creation, then its id**, and paged by an opaque position.
 * - **A `hub_id` outside a staff session's set of hubs is answered with no transaction and no statement** (task F, `AC-HUBF-13`; hub-filters.md section 5): the
 *   database would walk that hub's index before row-level security discarded every row, and the time that takes tells a caller whether the hub exists. The
 *   value is judged first (a value that is not a UUID is `VALIDATION_FAILED` naming `hub_id`); a hub inside the grant, a grant of every hub and no `hub_id`
 *   read as before.
 */
export class RidersService {
  readonly #options: RidersServiceOptions;

  constructor(options: RidersServiceOptions) {
    this.#options = options;
  }

  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<{
    readonly detail: { readonly rider: RiderView; readonly devices: readonly RiderDeviceView[] };
    readonly etag: string;
  }> {
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const found = await transactionOf(handle).execute(
          sql`select ${RIDER_COLUMNS} from ${RIDER_SOURCE} where r.id = ${id}::uuid`,
        );
        const read = found.rows[0] as unknown as RiderRow | undefined;
        if (read === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        if (read.primary_hub_id !== (await this.#primaryHubOf(handle, authorized))) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'RiderIdentity', id: read.id },
            responsibleHubId: read.primary_hub_id,
          });
        }
        const rider = viewOf(read);
        const devices = await devicesOfRider(handle, read.id);
        return {
          detail: { rider, devices },
          etag: riderEtagOf(rider, devices, generationOf(read)),
        };
      },
      ONE_SNAPSHOT,
    );
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: RiderListFilter,
  ): Promise<{ readonly items: readonly RiderView[]; readonly next_page_token: string | null }> {
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    const search = filter.q?.trim() ?? '';
    if (search.length > MAX_SEARCH_LENGTH) throw invalid('q', 'maxLength');
    if (filter.hubId !== undefined && !isUuid(filter.hubId)) throw invalid('hub_id', 'format');
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined) {
      throw invalid('page_token', 'format');
    }
    // A hub the staff session's grant of this key does not reach is an empty page and **no transaction, no statement** (task F, `AC-HUBF-13`, as the four reads of
    // task C3 answer it, `AC-HUBF-05`): the database would walk that hub's index and discard every row, and the time that takes tells a caller whether the hub
    // exists and how much it holds. The answer is the one row-level security gives, since `authorized.scope` is the very set the transaction would run under; a hub
    // that does not exist takes the same path and so the same time. Judged after every validation, so a value that is not a hub is still refused first.
    if (filter.hubId !== undefined && hubOutsideStaffGrant(authorized, filter.hubId)) {
      return { items: [], next_page_token: null };
    }

    const status = filter.status ?? null;
    const hub = filter.hubId ?? null;
    const pattern = search === '' ? null : `%${literal(search)}%`;
    const afterMoment = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const result = await transactionOf(handle).execute(sql`
        select ${RIDER_COLUMNS} from ${RIDER_SOURCE}
         where (${status}::text is null or r.status = ${status}::text)
           and (${hub}::uuid is null or r.primary_hub_id = ${hub}::uuid)
           and (${pattern}::text is null or r.full_name ilike ${pattern}::text escape '\\'
                or r.phone ilike ${pattern}::text escape '\\')
           and (${afterMoment}::timestamptz is null or (r.created_at, r.id) > (${afterMoment}::timestamptz, ${afterId}::uuid))
         order by r.created_at, r.id
         limit ${size + 1}`);
        const read = result.rows as unknown as RiderRow[];
        const page = read.slice(0, size);
        // The hubs the rows of the page represent and that are not the actor's own: one bounded event for each, naming the hub and the
        // operation, in the order of the hubs' ids.
        const baseline = await this.#primaryHubOf(handle, authorized);
        const foreign = [
          ...new Set(page.map((row) => row.primary_hub_id).filter((each) => each !== baseline)),
        ].toSorted();
        for (const hubId of foreign) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'HUB', id: hubId },
            responsibleHubId: hubId,
            relatedIds: { operation_id: 'listRiders' },
          });
        }
        const last = page.at(-1);
        return {
          items: page.map((row) => viewOf(row)),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.created_at_text, id: last.id })
              : null,
        };
      },
      ONE_SNAPSHOT,
    );
  }

  /** The actor's primary hub, read from the actor's own row (which its own context may always read): the baseline of a crossing. */
  async #primaryHubOf(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
  ): Promise<string | null> {
    const own = await transactionOf(handle).execute(
      sql`select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid`,
    );
    return (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id ?? null;
  }
}
