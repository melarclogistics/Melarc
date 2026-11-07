import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { isUuid } from '../platform/database/transaction-context.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import {
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATES,
} from '../platform/notifications/notification-vocabulary.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './notification-log-schemas.js';
import {
  LOG_COLUMNS,
  entryOf,
  type NotificationLogEntry,
  type NotificationLogRow,
} from './notification-log-view.js';
import { decodePageToken, encodePageToken } from './notification-page-token.js';

export type { NotificationLogEntry };

export interface NotificationLogFilter {
  readonly state?: string;
  readonly audience?: string;
  readonly channel?: string;
  readonly subjectId?: string;
  /** Only the messages of this hub (task C3, `AC-HUBF-03`): a filter that narrows what the caller may read and never widens it. */
  readonly hubId?: string;
  readonly pageSize?: number;
  readonly pageToken?: string;
}

export interface NotificationLogServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  readonly audit: AuditWriter;
}

/** The rows of a page and the audit of a crossing are one picture of the data: one `REPEATABLE READ` transaction. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

function invalid(name: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'query', pointer: `/${name}`, rule }],
  });
}

const oneOf = (value: string, allowed: readonly string[]): boolean => allowed.includes(value);

/**
 * `listNotifications` (S1.12e; `notification.read`; sections 31.3 and 31.6): the Ops message log and, filtered to its audience and channel,
 * the Ops feed. Ops can tell the queued, sent, delivered, failed, waiting-for-a-retry, held-back and expired messages apart.
 *
 * - **The scope is row-level security, nothing the use case writes.** The read runs in the caller's own context with the authorizing key
 *   `notification.read`: the policy of the table shows a staff member the messages of the hubs of that grant and no other staff key's
 *   reach, a vendor or a rider none (they are refused by the guard before this runs, and the policy would answer them nothing).
 * - **No entry holds a destination, a text or a code** (`notification-log-view.ts`): the row keeps a masked hint only, and the columns
 *   the API role may read exclude the count digest, the provider's reference and the lease.
 * - **An authorised staff read outside the actor's own hub is audited, without contents** (audit.md sections 5.4 and 6), as the staff
 *   reads are: one `auth.hub_boundary.crossed` for each foreign hub the page represents.
 * - **The list is newest first, then by id**, so that a page does not move under a reader who is paging, and is paged by an opaque token
 *   that is only a position.
 * - **`hub_id` is a filter that narrows and never widens** (task C3, `AC-HUBF-03`, `-06`): the hub of a message is the hub its record answered
 *   to when the act was done (`responsible_hub_id`, which a message keeps). It is one more condition of the statement, in the transaction the
 *   row-level security scopes and never in the security context, so a hub outside the session's grant, or that names no hub, is an empty page
 *   and never `HUB_SCOPE_VIOLATION`.
 */
export class NotificationLogService {
  readonly #options: NotificationLogServiceOptions;

  constructor(options: NotificationLogServiceOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: NotificationLogFilter,
  ): Promise<{
    readonly items: readonly NotificationLogEntry[];
    readonly next_page_token: string | null;
  }> {
    const size = filter.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      throw invalid('page_size', 'range');
    }
    if (filter.state !== undefined && !oneOf(filter.state, NOTIFICATION_STATES)) {
      throw invalid('state', 'enum');
    }
    if (filter.audience !== undefined && !oneOf(filter.audience, NOTIFICATION_AUDIENCES)) {
      throw invalid('audience', 'enum');
    }
    if (filter.channel !== undefined && !oneOf(filter.channel, NOTIFICATION_CHANNELS)) {
      throw invalid('channel', 'enum');
    }
    if (filter.subjectId !== undefined && !isUuid(filter.subjectId)) {
      throw invalid('subject_id', 'format');
    }
    if (filter.hubId !== undefined && !isUuid(filter.hubId)) throw invalid('hub_id', 'format');
    const after = filter.pageToken === undefined ? undefined : decodePageToken(filter.pageToken);
    if (filter.pageToken !== undefined && after === undefined) {
      throw invalid('page_token', 'format');
    }

    const state = filter.state ?? null;
    const audience = filter.audience ?? null;
    const channel = filter.channel ?? null;
    const subjectId = filter.subjectId ?? null;
    const hubFilter = filter.hubId ?? null;
    const afterMoment = after?.createdAt ?? null;
    const afterId = after?.id ?? null;
    return this.#options.runner.read(
      authorized,
      correlationId,
      async (handle) => {
        const result = await transactionOf(handle).execute(sql`
        select ${LOG_COLUMNS} from notification
         where (${state}::text is null or state = ${state}::text)
           and (${audience}::text is null or audience = ${audience}::text)
           and (${channel}::text is null or channel = ${channel}::text)
           and (${subjectId}::uuid is null or subject_id = ${subjectId}::uuid)
           and (${hubFilter}::uuid is null or responsible_hub_id = ${hubFilter}::uuid)
           and (${afterMoment}::timestamptz is null or (created_at, id) < (${afterMoment}::timestamptz, ${afterId}::uuid))
         order by created_at desc, id desc
         limit ${size + 1}`);
        const read = result.rows as unknown as NotificationLogRow[];
        const page = read.slice(0, size);

        // The hubs the rows of the page represent (never the row that only says whether another page follows) and that are not the
        // actor's own: one bounded event for each, in the order of the hubs' ids, naming the hub and the operation.
        const baseline = await this.#primaryHubOf(handle, authorized);
        if (baseline !== undefined) {
          const foreign = [
            ...new Set(page.map((row) => row.responsible_hub_id).filter((hub) => hub !== baseline)),
          ].toSorted();
          for (const hubId of foreign) {
            await this.#options.audit.write(handle, {
              code: 'auth.hub_boundary.crossed',
              enhanced: true,
              outcome: 'SUCCEEDED',
              object: { type: 'HUB', id: hubId },
              responsibleHubId: hubId,
              relatedIds: { operation_id: 'listNotifications' },
            });
          }
        }
        const last = page.at(-1);
        return {
          items: page.map(entryOf),
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
   * The actor's primary hub, which is the baseline of a crossing: `null` for a staff actor with none (every hub it reads is foreign),
   * `undefined` for an actor that is not staff, whose reads are not hub-scoped and cross no hub.
   */
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
