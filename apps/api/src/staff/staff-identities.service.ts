import { sql } from 'drizzle-orm';

import { mfaPostureOf, type MfaPosture } from '../platform/auth/mfa/mfa-reset-state.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH } from './staff-identity-schemas.js';
import { staffIdentityEtagOf } from './staff-identity-etag.js';
import {
  IDENTITY_COLUMNS as COLUMNS,
  viewOf,
  type IdentityRow,
  type StaffIdentityView,
} from './staff-identity-view.js';
import { decodePageToken, encodePageToken } from './staff-identity-page-token.js';

export type { StaffIdentityView };

export interface StaffListFilter {
  readonly status?: string;
  readonly hubId?: string;
  readonly q?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface StaffIdentitiesServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** The isolation of both reads: the rows, the second-factor facts and the audit are one picture of the data (F02 of 22 October 2026). */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

function invalid(name: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });
}

/** A string for a `LIKE` pattern in which `%`, `_` and the escape character mean themselves: the search matches text, not a pattern. */
const literal = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * `getStaffIdentity` and `listStaffIdentities` (S0.35; `staff.read`; `AC-SLICE-000-07`, `-30`, `-128`; domain-model.md section 6.8).
 *
 * - **The scope is row-level security and the scope probe, nothing the use case writes.** The reads run in the caller's own context with
 *   the authorizing key, so the table shows a Senior Ops user the identities of its hubs and a holder of the all-hub scope every one,
 *   and a query that names no hub still returns only the session's. The record a route names is found or refused (`HUB_SCOPE_VIOLATION`
 *   by the scope probe alone, `NOT_FOUND`) by the guard before this runs; a record that has gone since is `NOT_FOUND` here.
 * - **An authorised read outside the actor's own hub is audited, without contents** (audit.md section 5.4 and 6): one
 *   `auth.hub_boundary.crossed` for each read of a record of another hub (the actor, the hub, a reference to the record), and one for
 *   each foreign hub a list represents, naming the hub and the operation and carrying neither a row nor an id. **The baseline is the
 *   actor's primary hub**: an actor with none has none of its own, so every hub it reads is foreign. A record with no hub crosses no
 *   hub. The event is written in the read's own transaction; a read that is refused writes none.
 * - **One transaction, one snapshot, one instant.** A read opens one `REPEATABLE READ` transaction in the caller's context and reads in it
 *   the identity rows (under the policy of the scope), the second-factor facts of exactly those rows (`melarc.staff_reset_facts`,
 *   migration 0027: the facts and nothing else of the rows only the `authentication` capability reads, for the identities the caller's
 *   scope shows, from the same snapshot, a grant's expiry judged at one instant) and the audit events. So what the representation says
 *   was true together, and a row that was read always has its facts: **a row for which the function answered nothing is a fault of the
 *   read, answered as one, never a row left out of a list or a representation built on a guess.**
 * - **The ETag is the digest of what the read returned** (`staff-identity-etag.ts`): the complete representation, the second-factor
 *   posture included, and the identity's durable revision (`version`, which also moves with the replacement of the credential). So it
 *   changes with anything the caller was shown and with the credential's replacement, and with nothing else. A list carries none: it is
 *   for discovery, and the ETag comes from the read of the chosen record. A mutation that takes the ETag compares it under the identity's
 *   lock, recomputed from the same facts in that transaction (S0.36, S0.37).
 * - **The list is ordered by the moment of creation, then the id**, so that a page does not move under a reader who is paging, and is
 *   paged by an opaque token that is only a position (`staff-identity-page-token.ts`).
 */
export class StaffIdentitiesService {
  readonly #options: StaffIdentitiesServiceOptions;

  constructor(options: StaffIdentitiesServiceOptions) {
    this.#options = options;
  }

  async get(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
  ): Promise<{ readonly identity: StaffIdentityView; readonly etag: string }> {
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const found = await transactionOf(handle).execute(
          sql`select ${COLUMNS} from staff_identity where id = ${id}::uuid`,
        );
        const read = found.rows[0] as unknown as IdentityRow | undefined;
        if (read === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (read.primary_hub_id !== null && read.primary_hub_id !== baseline) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'StaffIdentity', id: read.id },
            responsibleHubId: read.primary_hub_id,
          });
        }
        const [view] = await this.#viewsOf(handle, [read]);
        if (view === undefined)
          throw new Error('A staff identity was read and no view was made of it');
        return { identity: view, etag: staffIdentityEtagOf(view, read.version) };
      },
      ONE_SNAPSHOT,
    );
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: StaffListFilter,
  ): Promise<{
    readonly items: readonly StaffIdentityView[];
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
        select ${COLUMNS} from staff_identity
         where (${status}::text is null or status = ${status}::text)
           and (${hub}::uuid is null or primary_hub_id = ${hub}::uuid)
           and (${pattern}::text is null or full_name ilike ${pattern}::text escape '\\' or work_email ilike ${pattern}::text escape '\\')
           and (${afterMoment}::timestamptz is null or (created_at, id) > (${afterMoment}::timestamptz, ${afterId}::uuid))
         order by created_at, id
         limit ${size + 1}`);
        const read = result.rows as unknown as IdentityRow[];
        const page = read.slice(0, size);
        // The hubs the rows of the page represent (never the row that only says whether another page follows) and that are not the
        // actor's own: one bounded event for each, in the order of the hubs' ids, naming the hub and the operation.
        const baseline = await this.#primaryHubOf(handle, authorized);
        const foreign = [
          ...new Set(
            page
              .map((row) => row.primary_hub_id)
              .filter((each): each is string => each !== null && each !== baseline),
          ),
        ].toSorted();
        for (const hubId of foreign) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'HUB', id: hubId },
            responsibleHubId: hubId,
            relatedIds: { operation_id: 'listStaffIdentities' },
          });
        }
        const items = await this.#viewsOf(handle, page);
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

  /**
   * The representation of each row read, from the second-factor facts of those rows in the same transaction: one view for each row, in
   * the order of the rows. The function answers for the identities the caller's scope shows, and the rows were read under that scope in
   * the same snapshot, so each row has its facts; one that does not is a fault of the read (a scope that differs between the two, a
   * facts function that answered for fewer), which fails the request rather than dropping the row or inventing its posture.
   */
  async #viewsOf(
    handle: TransactionHandle,
    rows: readonly IdentityRow[],
  ): Promise<StaffIdentityView[]> {
    const postures = await mfaPostureOf(
      handle,
      rows.map((row) => row.id),
    );
    return rows.map((row) => {
      const posture: MfaPosture | undefined = postures.get(row.id);
      if (posture === undefined) {
        throw new Error('A staff identity was read and the facts of its second factor were not');
      }
      return viewOf(row, posture);
    });
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
