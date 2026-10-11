import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { transactionOf } from '../database/transaction-handle.js';

/**
 * The branches of an identity operation that narrow a reason (domain-model.md §3.9, Product decision of 9 October 2026):
 * `APPROVAL_REJECTED` is the `approved: false` branch of `approveStaffIdentity`; `FACTOR_ACTIVE` and `ENROLMENT_UNFINISHED` are the
 * branches of `resetStaffMfa` (state-machines.md §18). The use case derives the branch from the **recorded state, under the
 * identity lock**, and passes it here; a branch the client names is never passed on.
 */
export const REASON_BRANCHES = [
  'APPROVAL_REJECTED',
  'FACTOR_ACTIVE',
  'ENROLMENT_UNFINISHED',
] as const;
export type ReasonBranch = (typeof REASON_BRANCHES)[number];

/**
 * The reason domain each identity operation takes its reason from (domain-model.md §3.9, "Six domains, one per operation family").
 * A reason of another domain is `REASON_NOT_ACTIVE` for the operation, whatever else is true of it. An operation that is not on
 * this list (a workflow reason of a later slice) has its domain named by its caller.
 */
export const IDENTITY_OPERATION_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  revokeSession: 'SESSION_REVOCATION',
  approveStaffIdentity: 'STAFF_PROFILE_REJECTION',
  resetStaffMfa: 'STAFF_MFA_RESET',
  reissueStaffCredentialSetup: 'CREDENTIAL_ADMINISTRATION',
  reissueVendorCredentialSetup: 'CREDENTIAL_ADMINISTRATION',
  recoverStaffCredential: 'CREDENTIAL_ADMINISTRATION',
  recoverVendorCredential: 'CREDENTIAL_ADMINISTRATION',
  reregisterRiderDevice: 'RIDER_DEVICE_REPLACEMENT',
  revokeRiderDevice: 'RIDER_DEVICE_REVOCATION',
});

export type ReasonRefusal = 'REASON_REQUIRED' | 'REASON_NOT_ACTIVE';

/**
 * A reason the operation cannot take: `REASON_REQUIRED` when none was supplied (or a field its metadata makes mandatory is
 * absent), `REASON_NOT_ACTIVE` when it is unknown, retired, of another domain, or not permitted for this operation or branch
 * (errors-and-enums.md §5). The message never repeats what the client sent: a reason code is client text.
 */
export class ReasonRefusedError extends Error {
  constructor(readonly code: ReasonRefusal) {
    super(
      code === 'REASON_REQUIRED'
        ? 'A reason is required'
        : 'The reason is not active for this operation',
    );
    this.name = 'ReasonRefusedError';
  }
}

/** A row of `reason_code` as the validator asks for it. */
export interface ReasonRow {
  readonly code: string;
  readonly domain: string;
  readonly label: string;
  readonly requires_note: boolean;
  readonly requires_photo: boolean;
  readonly requires_contact_attempt: boolean;
  readonly requires_approval: boolean;
  readonly requires_ops_review: boolean;
  readonly requires_escalation: boolean;
  readonly attribution: string;
  readonly consumes_delivery_attempt: boolean;
  readonly active: boolean;
  readonly permitted_operations: readonly string[] | null;
}

export interface ReasonRequest {
  /** What the client sent: anything. */
  readonly reasonCode: unknown;
  /** The `operationId` the reason is given to. */
  readonly operationId: string;
  /** The branch of the operation, derived from recorded state under the identity lock; never from the client. */
  readonly branch?: ReasonBranch;
  /** The note the client sent, for a reason whose metadata makes a note mandatory. */
  readonly note?: string | null;
  /** The reason domain this operation takes its reason from, for an operation that is not an identity operation. */
  readonly domain?: string;
}

/** What a caller needs of an accepted reason: the code and label to snapshot into the audit event, and the flags it must enforce. */
export interface ValidatedReason {
  readonly code: string;
  readonly domain: string;
  readonly label: string;
  readonly attribution: string;
  readonly requiresNote: boolean;
  readonly requiresPhoto: boolean;
  readonly requiresContactAttempt: boolean;
  readonly requiresApproval: boolean;
  readonly requiresOpsReview: boolean;
  readonly requiresEscalation: boolean;
  readonly consumesDeliveryAttempt: boolean;
}

/** The grammar of `reason_code.code` (the table's `reason_code_code_grammar`), and the longest a code is. */
const CODE = /^[A-Z][A-Z0-9_]*$/;
const MAX_CODE_LENGTH = 64;

/**
 * Whether a reason's list permits an operation on a branch: a bare entry (`operationId`) is valid on every branch of that
 * operation and with no branch; a qualified entry (`operationId#BRANCH`) only on the branch it names. The entry has to be the
 * operation's own: an entry that merely begins like it, or names the branch of another operation, permits nothing.
 */
function permits(
  entries: readonly string[],
  operationId: string,
  branch: ReasonBranch | undefined,
): boolean {
  return entries.some(
    (entry) =>
      entry === operationId || (branch !== undefined && entry === `${operationId}#${branch}`),
  );
}

/**
 * Whether a reason is usable, or the refusal. Pure: no database. The order is the contract's: a missing reason is
 * `REASON_REQUIRED`; a reason that is unknown, retired, of the wrong domain or not permitted for the operation and branch is
 * `REASON_NOT_ACTIVE`; a reason whose metadata makes the note mandatory, with none given, is `REASON_REQUIRED`.
 */
export function decideReason(request: ReasonRequest, row: ReasonRow | undefined): ValidatedReason {
  const { reasonCode, operationId, branch } = request;
  if (branch !== undefined && !(REASON_BRANCHES as readonly string[]).includes(branch)) {
    throw new TypeError('A reason branch is one of the closed set, derived from recorded state');
  }
  const domain = request.domain ?? IDENTITY_OPERATION_DOMAINS[operationId];
  if (domain === undefined) {
    throw new TypeError(
      'The reason domain of an operation that is not an identity operation is named by its caller',
    );
  }

  if (reasonCode === undefined || reasonCode === null)
    throw new ReasonRefusedError('REASON_REQUIRED');
  if (typeof reasonCode === 'string' && reasonCode.trim() === '') {
    throw new ReasonRefusedError('REASON_REQUIRED');
  }
  if (
    typeof reasonCode !== 'string' ||
    reasonCode.length > MAX_CODE_LENGTH ||
    !CODE.test(reasonCode)
  ) {
    throw new ReasonRefusedError('REASON_NOT_ACTIVE');
  }

  if (row?.code !== reasonCode || !row.active || row.domain !== domain) {
    throw new ReasonRefusedError('REASON_NOT_ACTIVE');
  }
  // An identity reason carries the list of operations it is for; a reason of another family has none, and its domain decides.
  const identityDomain = Object.values(IDENTITY_OPERATION_DOMAINS).includes(domain);
  if (
    row.permitted_operations === null
      ? identityDomain
      : !permits(row.permitted_operations, operationId, branch)
  ) {
    throw new ReasonRefusedError('REASON_NOT_ACTIVE');
  }

  if (
    row.requires_note &&
    (request.note === undefined || request.note === null || request.note.trim() === '')
  ) {
    throw new ReasonRefusedError('REASON_REQUIRED');
  }

  return {
    code: row.code,
    domain: row.domain,
    label: row.label,
    attribution: row.attribution,
    requiresNote: row.requires_note,
    requiresPhoto: row.requires_photo,
    requiresContactAttempt: row.requires_contact_attempt,
    requiresApproval: row.requires_approval,
    requiresOpsReview: row.requires_ops_review,
    requiresEscalation: row.requires_escalation,
    consumesDeliveryAttempt: row.consumes_delivery_attempt,
  };
}

/**
 * The reason validator (S0.13), run in the caller's transaction and under the caller's context, like the settings reader. It
 * reads the reason by its code and decides with `decideReason`. The use case calls it after it holds the identity lock and has
 * derived the branch from recorded state, so that a stale or forged branch is `REASON_NOT_ACTIVE` here and a target that is no
 * longer eligible is `STATE_CONFLICT` there. It builds no reason-management operation: the six identity domains are system-managed
 * and a later slice may change a label or `active`, never `permitted_operations`.
 */
export class ReasonValidator {
  async validate(transaction: TransactionHandle, request: ReasonRequest): Promise<ValidatedReason> {
    // The decision is made on the request first where it needs no row, so a missing reason or a malformed code reads nothing.
    const code = request.reasonCode;
    let row: ReasonRow | undefined;
    if (typeof code === 'string' && code.length <= MAX_CODE_LENGTH && CODE.test(code)) {
      const result = await transactionOf(transaction).execute(sql`
        select code, domain, label, requires_note, requires_photo, requires_contact_attempt, requires_approval,
               requires_ops_review, requires_escalation, attribution, consumes_delivery_attempt, active, permitted_operations
          from reason_code where code = ${code}`);
      row = result.rows[0] as unknown as ReasonRow | undefined;
    }
    return decideReason(request, row);
  }
}
