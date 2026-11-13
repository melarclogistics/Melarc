import { sql, type SQL } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { isUuid } from '../platform/database/transaction-context.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { decodePageToken, encodePageToken } from '../platform/http/page-token.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import {
  parcelPhotoExceptionViewOf,
  parcelPhotoProgressViewOf,
  STOP_EVIDENCE_PURPOSES,
  stopEvidenceItemViewOf,
  type ParcelPhotoExceptionRow,
  type ParcelPhotoProgressRow,
  type StopEvidenceListView,
  type StopEvidenceRow,
} from './pickup-stop-evidence-views.js';

/** What the read takes from the query, as strings and numbers exactly as they were sent (the service judges them). */
export interface StopEvidenceFilter {
  /** Only the evidence of this purpose; left out, all of the stop's. It narrows the items and never the counts. */
  readonly purpose?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface PickupStopEvidenceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** One `REPEATABLE READ` transaction: the page, the counts and the exception are one picture of the stop. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

const OPERATION = 'listPickupStopEvidence';

function invalid(place: 'path' | 'query', name: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: place, pointer: `/${name}`, rule }],
  });
}

/**
 * `listPickupStopEvidence` (S1.30; `pickup.read`; the Product Owner's decision D-A10, `AC-SLICE-001-86` to `-88`, `OB-S1-80`): the evidence of one pickup stop as Ops reads it, with the
 * progress of its parcel photos and the exception that let its count through without them.
 *
 * - **For Ops staff alone, by the hubs of the grant.** The statements run in the caller's own context under the authorizing key: the policy of `evidence` shows a staff member the
 *   records of a stop of a hub of the grant, under `pickup.read`, and the policy of the exception shows its hub's staff the exception. A vendor and a rider are refused by the guard and
 *   again here. **Whether the caller may see the stop is decided before this runs** (the route's scope probe: `HUB_SCOPE_VIOLATION` for a stop of another hub, `NOT_FOUND` for an id that
 *   matches nothing), and a stop that is no longer there when the statement runs is `NOT_FOUND` as well. An authorised staff read of a stop outside the actor's own hub is audited,
 *   without contents, as every staff read is.
 * - **A closed projection**: no object key, no address, no signed operation (`pickup-stop-evidence-views.ts`). The image of a record is read with
 *   `createEvidenceRetrievalAuthorization`, one at a time, only when it is shown.
 * - **The progress is the server's, for the whole stop**: the counts of the parcel photos by state are the database's and do not depend on the page or on the `purpose` filter.
 * - **The order is the moment the platform made the record, then its identifier**, so that a page does not move under a reader who is paging and a photo that arrives while the officer
 *   reads comes last; the position of the next page is that moment and that identifier and nothing else.
 */
export class PickupStopEvidence {
  readonly #options: PickupStopEvidenceOptions;

  constructor(options: PickupStopEvidenceOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    stopId: string,
    filter: StopEvidenceFilter,
  ): Promise<StopEvidenceListView> {
    if (authorized.session.principalType !== 'STAFF') {
      throw new ApiException(ErrorCode.PermissionDenied, 403, 'Permission denied');
    }
    if (!isUuid(stopId)) throw invalid('path', 'id', 'format');
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('query', 'page_size', 'range');
    }
    if (
      filter.purpose !== undefined &&
      !(STOP_EVIDENCE_PURPOSES as readonly string[]).includes(filter.purpose)
    ) {
      throw invalid('query', 'purpose', 'enum');
    }
    const position = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && position === undefined) {
      throw invalid('query', 'page_token', 'format');
    }
    const purposeIs: SQL =
      filter.purpose === undefined ? sql`` : sql`and e.purpose = ${filter.purpose}`;
    const after: SQL =
      position === undefined
        ? sql``
        : sql`and (e.created_at, e.id) > (${position.createdAt}::timestamptz, ${position.id}::uuid)`;

    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle): Promise<StopEvidenceListView> => {
        const tx = transactionOf(handle);
        const stops = await tx.execute(
          sql`select id, responsible_hub_id from pickup_stop where id = ${stopId}::uuid`,
        );
        const stop = stops.rows[0] as { id: string; responsible_hub_id: string } | undefined;
        if (stop === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');

        const listed = await tx.execute(sql`
          select e.id, e.purpose, e.state, e.captured_at, e.uploaded_at, e.content_type, (e.scanned_at is not null) as scanned_clean,
                 e.created_at::text as position_text, e.id as position_id
            from evidence e
           where e.owner_type = 'PICKUP_STOP' and e.owner_id = ${stopId}::uuid ${purposeIs} ${after}
           order by e.created_at, e.id
           limit ${size + 1}`);
        const read = listed.rows as unknown as StopEvidenceRow[];
        const page = read.slice(0, size);

        const counts = await tx.execute(sql`
          select count(*) filter (where state = 'STORED')::integer as stored,
                 count(*) filter (where state = 'PENDING_UPLOAD')::integer as pending,
                 count(*) filter (where state = 'EXPIRED')::integer as expired
            from evidence
           where owner_type = 'PICKUP_STOP' and owner_id = ${stopId}::uuid and purpose = 'PARCEL_PHOTO'`);
        const progress = counts.rows[0] as unknown as ParcelPhotoProgressRow;

        const exceptions = await tx.execute(sql`
          select id, pickup_stop_id, authorised_by, authorised_at, note
            from parcel_photo_exception where pickup_stop_id = ${stopId}::uuid`);
        const exception = exceptions.rows[0] as unknown as ParcelPhotoExceptionRow | undefined;

        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined && stop.responsible_hub_id !== baseline) {
          await this.#options.audit.write(handle, {
            code: 'auth.hub_boundary.crossed',
            enhanced: true,
            outcome: 'SUCCEEDED',
            object: { type: 'PickupStop', id: stop.id },
            responsibleHubId: stop.responsible_hub_id,
            relatedIds: { operation_id: OPERATION },
          });
        }

        const last = page.at(-1);
        return {
          items: page.map(stopEvidenceItemViewOf),
          next_page_token:
            read.length > size && last !== undefined
              ? encodePageToken({ createdAt: last.position_text, id: last.position_id })
              : null,
          parcel_photos: parcelPhotoProgressViewOf(progress),
          parcel_photo_exception:
            exception === undefined ? null : parcelPhotoExceptionViewOf(exception),
        };
      },
      ONE_SNAPSHOT,
    );
  }

  /** The actor's primary hub, which is the baseline of a crossing: `null` for a staff actor with none (every hub it reads is foreign). */
  async #primaryHubOf(
    handle: TransactionHandle,
    authorized: AuthorizedRequest,
  ): Promise<string | null | undefined> {
    if (authorized.session.principalType !== 'STAFF') return undefined;
    const own = await transactionOf(handle).execute(
      sql`select primary_hub_id from staff_identity where id = ${authorized.session.principalId}::uuid`,
    );
    return (own.rows[0] as { primary_hub_id: string | null } | undefined)?.primary_hub_id ?? null;
  }
}
