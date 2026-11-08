import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
} from '../staff/staff-identity-schemas.js';
import { decodePageToken, encodePageToken } from '../staff/staff-identity-page-token.js';
import { vendorAccountEtagOf } from './vendor-account-etag.js';
import {
  ACCOUNT_COLUMNS,
  ACCOUNT_SOURCE,
  credentialFactsOf,
  devicesOf,
  viewOf,
  type AccountRow,
  type RegisteredDeviceView,
  type VendorAccountView,
} from './vendor-account-view.js';

export type { RegisteredDeviceView, VendorAccountView };

export interface VendorListFilter {
  readonly status?: string;
  readonly hubId?: string;
  readonly q?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface VendorAccountsServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** Both reads are one picture of the data: the rows, the credential facts and the audit in one snapshot. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

function invalid(name: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });
}

/** A string for a `LIKE` pattern in which `%`, `_` and the escape character mean themselves: the search matches text, not a pattern. */
const literal = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * `listVendorAccounts` and `getVendorAccount` (S0.47a; `vendor.read`; the staff clauses of `AC-SLICE-000-102`), in the form of the staff
 * reads (`staff-identities.service.ts`), whose two helpers of paging this domain uses.
 *
 * - **The scope is row-level security and the scope probe** (migration 0034): the reads run in the caller's own context under the key, so
 *   an account is shown when its organisation's responsible hub is in the scope of the grant, or under the explicit all-hub scope. `hub_id`
 *   narrows within that and never widens it. The record a route names is found or refused (`HUB_SCOPE_VIOLATION` by the probe through the
 *   organisation, `NOT_FOUND`) by the guard before this runs; one that has gone since is `NOT_FOUND` here.
 * - **Authentication status only.** The credential is the `authentication` capability's; the read is given its facts by
 *   `melarc.vendor_credential_facts` for exactly the accounts it read, in the same snapshot, and **an account read without its facts is a
 *   fault of the read**, never a row left out or a guess. No response holds a hash, a secret or a recovery address.
 * - **An authorised read outside the actor's own hub is audited, without contents** (audit.md sections 5.4 and 6), as for the staff reads:
 *   one `auth.hub_boundary.crossed` for the read of an account of another hub, and one for each foreign hub a list represents. The baseline
 *   is the actor's primary hub; an actor with none has none of its own.
 * - **The ETag is the digest of what the read returned and of the credential's generation** (`vendor-account-etag.ts`). A list carries none.
 * - **The list is ordered by the account's moment of creation, then its id**, and paged by an opaque position.
 */
export class VendorAccountsService {
  readonly #options: VendorAccountsServiceOptions;

  constructor(options: VendorAccountsServiceOptions) {
    this.#options = options;
  }

  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<{
    readonly detail: {
      readonly account: VendorAccountView;
      readonly devices: readonly RegisteredDeviceView[];
    };
    readonly etag: string;
  }> {
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const found = await transactionOf(handle).execute(
          sql`select ${ACCOUNT_COLUMNS} from ${ACCOUNT_SOURCE} where a.id = ${id}::uuid`,
        );
        const read = found.rows[0] as unknown as AccountRow | undefined;
        if (read === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        if (read.responsible_hub_id !== (await this.#primaryHubOf(handle, authorized))) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'VendorAccount', id: read.id },
            responsibleHubId: read.responsible_hub_id,
          });
        }
        const facts = (await credentialFactsOf(handle, [read.id])).get(read.id);
        if (facts === undefined) {
          throw new Error('A vendor account was read and the facts of its credential were not');
        }
        const account = viewOf(read, facts);
        const devices = await devicesOf(handle, read.id);
        return {
          detail: { account, devices },
          etag: vendorAccountEtagOf(account, devices, facts.credential_generation),
        };
      },
      ONE_SNAPSHOT,
    );
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: VendorListFilter,
  ): Promise<{
    readonly items: readonly VendorAccountView[];
    readonly next_page_token: string | null;
  }> {
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    const search = filter.q?.trim() ?? '';
    if (search.length > MAX_SEARCH_LENGTH) throw invalid('q', 'maxLength');
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined)
      throw invalid('page_token', 'format');

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
        select ${ACCOUNT_COLUMNS} from ${ACCOUNT_SOURCE}
         where (${status}::text is null or a.status = ${status}::text)
           and (${hub}::uuid is null or o.responsible_hub_id = ${hub}::uuid)
           and (${pattern}::text is null or o.legal_name ilike ${pattern}::text escape '\\'
                or o.trading_name ilike ${pattern}::text escape '\\' or a.account_identifier ilike ${pattern}::text escape '\\')
           and (${afterMoment}::timestamptz is null or (a.created_at, a.id) > (${afterMoment}::timestamptz, ${afterId}::uuid))
         order by a.created_at, a.id
         limit ${size + 1}`);
        const read = result.rows as unknown as AccountRow[];
        const page = read.slice(0, size);
        // The hubs the rows of the page represent and that are not the actor's own: one bounded event for each, naming the hub and the
        // operation, in the order of the hubs' ids.
        const baseline = await this.#primaryHubOf(handle, authorized);
        const foreign = [
          ...new Set(page.map((row) => row.responsible_hub_id).filter((each) => each !== baseline)),
        ].toSorted();
        for (const hubId of foreign) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'HUB', id: hubId },
            responsibleHubId: hubId,
            relatedIds: { operation_id: 'listVendorAccounts' },
          });
        }
        const facts = await credentialFactsOf(
          handle,
          page.map((row) => row.id),
        );
        const items = page.map((row) => {
          const each = facts.get(row.id);
          if (each === undefined) {
            throw new Error('A vendor account was read and the facts of its credential were not');
          }
          return viewOf(row, each);
        });
        const last = page.at(-1);
        return {
          items,
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
