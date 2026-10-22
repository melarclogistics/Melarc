import { sql } from 'drizzle-orm';

import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { riderHoldsAssignedWork } from './rider-assigned-work.js';

/** The filters of `listReasonDefinitions`, each already a string that the contract validated against its enumeration where it has one. */
export interface ReasonFilter {
  readonly domain?: string;
  readonly checkpoint?: string;
  readonly operation?: string;
  readonly branch?: string;
}

/** One reason as the catalogue answers it (`ReasonDefinition`): the metadata a workflow validates with, and the registry's operations. */
export interface ReasonDefinitionView {
  readonly code: string;
  readonly domain: string;
  readonly validCheckpoints: readonly string[] | null;
  readonly label: string;
  readonly attribution: string;
  readonly consumesDeliveryAttempt: boolean;
  readonly requiresNote: boolean;
  readonly requiresPhoto: boolean;
  readonly requiresContactAttempt: boolean;
  readonly requiresApproval: boolean;
  readonly requiresOpsReview: boolean;
  readonly requiresEscalation: boolean;
  readonly active: boolean;
  readonly permittedOperations:
    readonly { readonly operationId: string; readonly branch: string | null }[] | null;
}

interface ReasonRow {
  readonly code: string;
  readonly domain: string;
  readonly valid_checkpoints: string[] | null;
  readonly label: string;
  readonly attribution: string;
  readonly consumes_delivery_attempt: boolean;
  readonly requires_note: boolean;
  readonly requires_photo: boolean;
  readonly requires_contact_attempt: boolean;
  readonly requires_approval: boolean;
  readonly requires_ops_review: boolean;
  readonly requires_escalation: boolean;
  readonly active: boolean;
  readonly permitted_operations: string[] | null;
}

/** An entry of `permitted_operations` is an `operationId`, or `operationId#BRANCH` for a branch of it (domain-model.md section 3.9). */
function operationOf(entry: string): { operationId: string; branch: string | null } {
  const at = entry.indexOf('#');
  return at < 0
    ? { operationId: entry, branch: null }
    : { operationId: entry.slice(0, at), branch: entry.slice(at + 1) };
}

function viewOf(row: ReasonRow): ReasonDefinitionView {
  return {
    code: row.code,
    domain: row.domain,
    validCheckpoints: row.valid_checkpoints,
    label: row.label,
    attribution: row.attribution,
    consumesDeliveryAttempt: row.consumes_delivery_attempt,
    requiresNote: row.requires_note,
    requiresPhoto: row.requires_photo,
    requiresContactAttempt: row.requires_contact_attempt,
    requiresApproval: row.requires_approval,
    requiresOpsReview: row.requires_ops_review,
    requiresEscalation: row.requires_escalation,
    active: row.active,
    permittedOperations:
      row.permitted_operations === null ? null : row.permitted_operations.map(operationOf),
  };
}

export interface ReasonDefinitionsServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
}

/**
 * `listReasonDefinitions` (S0.35; `AC-SLICE-000-132`): the operational reason catalogue, read-only, in the transaction of the
 * caller's own context on the lock-free read path of the operation runner. **The key is held by the session's snapshot** (the guard
 * decided that), and holding it lets nobody act on another principal: the act's own permission, tier and scope still decide, and a
 * reason used outside its operation or branch is still `REASON_NOT_ACTIVE` where it is used.
 *
 * - **A Rider's scope is assignment-based** and is false while no stop or run exists: a Rider is `PERMISSION_DENIED` (`403`), by the
 *   use case, before anything is read. (No dispatch table exists in this slice, so no Rider holds assigned work; the check is one
 *   function, `riderHoldsAssignedWork`, which the slice that builds the assignment replaces.) A Vendor does not hold the key and is
 *   refused by the guard.
 * - **The filters narrow a read the caller already holds** and change no scope. `operation` returns the **active** reasons whose
 *   `permittedOperations` names that operation; `branch`, valid only with `operation`, keeps those whose entry for it names that branch
 *   **or none** (a reason that is not narrower than its operation is valid on every branch). `domain` and `checkpoint` narrow by the
 *   reason's own fields. A `branch` without an `operation` is `VALIDATION_FAILED` (the contract's enumerations cannot say that, so the
 *   use case does). Without an `operation`, an inactive reason is returned with `active: false` for the screen to read: only the
 *   operation filter is stated as returning the active ones.
 * - **Ordered by `code`**, bytewise (the codes are upper-case words with digits and underscores), so the order is the same on every
 *   database. Nothing is written, and nothing hub-scoped or secret is read: the table holds neither.
 */
export class ReasonDefinitionsService {
  readonly #options: ReasonDefinitionsServiceOptions;

  constructor(options: ReasonDefinitionsServiceOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: ReasonFilter,
  ): Promise<readonly ReasonDefinitionView[]> {
    if (authorized.session.principalType === 'RIDER' && !riderHoldsAssignedWork()) {
      throw ApiException.of(ErrorCode.PermissionDenied, 'Permission denied');
    }
    if (filter.branch !== undefined && filter.operation === undefined) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'query', pointer: '/branch', rule: 'dependentRequired' }],
      });
    }
    const domain = filter.domain ?? null;
    const checkpoint = filter.checkpoint ?? null;
    const operation = filter.operation ?? null;
    const branch = filter.branch ?? null;
    return this.#options.runner.read(authorized, correlationId, async (handle) => {
      const result = await transactionOf(handle).execute(sql`
        select code, domain, valid_checkpoints, label, attribution, consumes_delivery_attempt, requires_note, requires_photo,
               requires_contact_attempt, requires_approval, requires_ops_review, requires_escalation, active, permitted_operations
          from reason_code
         where (${domain}::text is null or domain = ${domain}::text)
           and (${checkpoint}::text is null or valid_checkpoints @> array[${checkpoint}::text])
           and (${operation}::text is null
                or (active
                    and exists (select 1 from unnest(permitted_operations) as entry
                                 where entry = ${operation}::text
                                    or (${branch}::text is null and starts_with(entry, ${operation}::text || '#'))
                                    or entry = ${operation}::text || '#' || ${branch}::text)))
         order by code collate "C"`);
      return (result.rows as unknown as ReasonRow[]).map(viewOf);
    });
  }
}
