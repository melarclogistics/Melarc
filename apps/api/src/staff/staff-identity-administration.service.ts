import { sql } from 'drizzle-orm';

import { canonicalWorkEmail, isEmailShape } from '../platform/auth/credentials/work-email.js';
import { isWellFormedUnicode } from '../platform/auth/credentials/unicode.js';
import { destinationProblem } from '../platform/delivery/delivery-payload.js';
import { isIdempotencyKey } from '../platform/idempotency/idempotency-scope.js';
import { randomUUIDv7 } from '../platform/auth/crypto/uuid-v7.js';
import { decideMfaResetState, type ResetFacts } from '../platform/auth/mfa/mfa-reset-state.js';
import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { Clock } from '../platform/auth/ports/clock.port.js';
import type { IdempotencyStore } from '../platform/auth/ports/idempotency-store.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type {
  SetupGrantStore,
  IssuedGrant,
} from '../platform/auth/setup-grants/setup-grant-store.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { scopeIncludesHub } from '../platform/authorization/effective-scope.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { meetsTier } from '../platform/authorization/tier-policy.js';
import { serverErrorIn } from '../platform/database/database-failures.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { DeliveryNotQueueableError } from '../platform/delivery/delivery-errors.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import {
  ReasonRefusedError,
  type ReasonRequest,
  type ReasonValidator,
  type ValidatedReason,
} from '../platform/settings/reason-validator.js';
import { staffIdentityEtagOf } from './staff-identity-etag.js';
import { lockStaffIdentity, requireVersion } from './staff-locked-identity.js';
import { checkedNote } from './staff-note.js';
import {
  IDENTITY_COLUMNS,
  viewOf,
  type IdentityRow,
  type StaffIdentityView,
} from './staff-identity-view.js';

/** What `createStaffIdentity` takes (`StaffIdentityCreate`): no status, no maker, no credential and no factor, by the schema. */
export interface CreateStaffRequest {
  readonly work_email: string;
  readonly full_name: string;
  readonly phone?: string;
  readonly role_bundle_id: string;
  readonly primary_hub_id?: string;
}

/** What `approveStaffIdentity` takes (`StaffIdentityApproval`). */
export interface ApprovalRequest {
  readonly approved: boolean;
  readonly reason_code?: string;
  readonly note?: string;
}

/** What `reissueStaffCredentialSetup` takes (`SetupGrantReissue`). */
export interface ReissueRequest {
  readonly reason_code: string;
  readonly note?: string;
}

/** The answer of a re-issue (`SetupGrant`): where the grant stands, never its token. */
export interface SetupGrantView {
  readonly id: string;
  readonly principal_type: 'STAFF';
  readonly principal_id: string;
  readonly purpose: 'STAFF_CREDENTIAL_SETUP';
  readonly state: 'PENDING';
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: null;
}

export interface StaffIdentityAnswer {
  readonly identity: StaffIdentityView;
  readonly etag: string;
}

export interface StaffIdentityAdministrationOptions {
  readonly runner: Pick<OperationRunner, 'mutate' | 'requireTargetTier'>;
  readonly audit: AuditWriter;
  readonly grants: Pick<SetupGrantStore, 'issue'>;
  readonly idempotency: IdempotencyStore;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  readonly clock: Pick<Clock, 'now'>;
  /** The Ops origin's link for a staff credential setup, with `{token}` for the fragment (`linkTemplates`). */
  readonly setupLink: (token: string) => string;
}

const OPERATION_CREATE = 'createStaffIdentity';

/** The shape a phone number is held in (domain-model.md section 3.4): E.164. Nothing is normalised here; the number is as sent. */
const E164 = /^\+[1-9][0-9]{7,14}$/;
const MAX_ENTERED_EMAIL = 320;
/**
 * A character a name has no use for and an attacker has: a control character (Unicode category Cc: the C0 and C1 controls, NUL among
 * them), the line and paragraph separators, and the bidirectional embeddings, overrides and isolates, which make a screen or a log show
 * a name other than the one stored. and the zero-width space, word joiner and byte order mark, which make two names that look alike differ. (The zero-width joiner and non-joiner that some scripts need are not among them.)
 */
const CONTROL_CHARACTER = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF]/u;

const violation = (
  pointer: string,
  rule: string,
  location: 'body' | 'header' = 'body',
): ApiException =>
  new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: location, pointer, rule }],
  });

const stateConflict = (message: string): ApiException =>
  ApiException.of(ErrorCode.StateConflict, message);

/** A reason the catalogue refuses is the contract's `REASON_REQUIRED` or `REASON_NOT_ACTIVE`; anything else is not this function's. */
export async function validated(
  reasons: Pick<ReasonValidator, 'validate'>,
  handle: TransactionHandle,
  request: ReasonRequest,
): Promise<ValidatedReason> {
  try {
    return await reasons.validate(handle, request);
  } catch (error) {
    if (error instanceof ReasonRefusedError) {
      throw ApiException.of(
        error.code === 'REASON_REQUIRED' ? ErrorCode.ReasonRequired : ErrorCode.ReasonNotActive,
        error.message,
      );
    }
    throw error;
  }
}

/**
 * The three staff operations that make and settle a staff identity (S0.36; `createStaffIdentity`, `approveStaffIdentity`,
 * `reissueStaffCredentialSetup`; staff-authentication.md; state-machines.md §13.3; migration 0029 states the mechanism). Each runs through
 * `OperationRunner.mutate` in the caller's own staff context under the key of the operation: the shared policy locks first, the session
 * judged again under them, and every row it touches admitted by a policy of that key and of the caller's scope.
 *
 * - **The order of refusal is the contract's** (permission-enforcement.md §5.1): the guard has answered the key, the tier the target's bundle
 *   needs and the record's scope (steps 5 to 7) and the schema (8) before this runs. Here, in the transaction that acts: the idempotency of
 *   a command that has a key (9), then **the identity's lock**, and under it the tier again, the version (10), the state (11), the reason
 *   (the branch is derived from the recorded state), and **the maker-checker rule last** (12).
 * - **`If-Match` is compared under the lock**, against the ETag recomputed in this transaction from the identity row and the facts
 *   `melarc.staff_locked_facts` returns, so that what the caller's token names is what the mutation acts on. A mismatch is
 *   `STATE_CONFLICT`.
 * - **A message that cannot be queued rolls the act back** with `CREDENTIAL_DELIVERY_FAILED`: the grant, its message, the decision and
 *   the events are one transaction. A provider's later failure is a job outcome and never this.
 * - **No credential, no token and no destination is ever returned, logged or audited**: the link is made from the token that exists
 *   nowhere else and sealed with the destination in the delivery job.
 */
export class StaffIdentityAdministration {
  readonly #options: StaffIdentityAdministrationOptions;

  constructor(options: StaffIdentityAdministrationOptions) {
    this.#options = options;
  }

  async create(
    authorized: AuthorizedRequest,
    correlationId: string,
    request: {
      readonly body: CreateStaffRequest;
      readonly idempotencyKey: string;
      readonly fingerprint: string;
    },
  ): Promise<StaffIdentityAnswer> {
    const { runner, audit, idempotency, clock } = this.#options;
    const { body } = request;
    const actor = authorized.session.principalId;
    // The scope before the validation, as the order has it: a profile may be placed only in a hub the caller acts in. An all-hub caller
    // may name any hub or none; a caller scoped to hubs names one of them, and a profile with no hub is no profile it could place.
    this.#requireHubInScope(authorized, body.primary_hub_id);
    const canonical = canonicalWorkEmail(body.work_email);
    if (
      !canonical.ok ||
      body.work_email.length > MAX_ENTERED_EMAIL ||
      !isEmailShape(canonical.email)
    ) {
      throw violation('/work_email', 'format');
    }
    // A name is text a person reads: well-formed, not blank, and with no control character (a NUL byte is one PostgreSQL cannot store, and
    // a line break or an escape in a name would reach the log, the message and the screen as something other than a name).
    if (
      !isWellFormedUnicode(body.full_name) ||
      CONTROL_CHARACTER.test(body.full_name) ||
      body.full_name.trim() === ''
    ) {
      throw violation('/full_name', 'format');
    }
    if (body.phone !== undefined && !E164.test(body.phone)) throw violation('/phone', 'format');
    // The address the approval will send the setup link to is the one entered, trimmed: a profile whose address no message can be queued
    // to could never be approved, and would hold its work email until someone rejected it (the adversarial review of 23 October 2026).
    if (destinationProblem('EMAIL', body.work_email.trim()) !== undefined) {
      throw violation('/work_email', 'format');
    }
    // The key is the store's to keep: one it would refuse is a request that is not valid, not a defect of the server.
    if (!isIdempotencyKey(request.idempotencyKey)) {
      throw violation('Idempotency-Key', 'format', 'header');
    }

    return runner.mutate(authorized, correlationId, async (handle) => {
      const tx = transactionOf(handle);
      const bundle = await tx.execute(
        sql`select 1 from role_bundle where id = ${body.role_bundle_id}::uuid and audience = 'STAFF'`,
      );
      if (bundle.rows.length !== 1) throw violation('/role_bundle_id', 'enum');

      const scope = {
        principalType: 'STAFF',
        principalId: actor,
        operationId: OPERATION_CREATE,
        key: request.idempotencyKey,
      } as const;
      const begun = await idempotency.begin(handle, scope, request.fingerprint);
      if (begun.outcome === 'REPLAY') {
        const identity = JSON.parse(
          Buffer.from(begun.response.body).toString('utf8'),
        ) as StaffIdentityView;
        // The version a new profile has is one, and the representation is the stored answer: the ETag of the original answer.
        return { identity, etag: staffIdentityEtagOf(identity, 1) };
      }
      if (begun.outcome === 'CONFLICT') {
        throw ApiException.of(
          ErrorCode.IdempotencyKeyConflict,
          'That Idempotency-Key was used with a different request',
        );
      }
      if (begun.outcome !== 'NEW') {
        // A record that began and did not complete is a stranded one (OB-100): the command is not run again, and nothing is invented.
        throw new Error('An idempotency record of this command is stranded');
      }

      const id = randomUUIDv7(clock);
      let row: IdentityRow | undefined;
      try {
        const inserted = await tx.execute(sql`
          insert into staff_identity (id, work_email, work_email_canonical, full_name, phone, status, role_bundle_id, primary_hub_id,
                                      created_by, origin)
          values (${id}::uuid, ${body.work_email}, ${canonical.email}, ${body.full_name}, ${body.phone ?? null}, 'PENDING_APPROVAL',
                  ${body.role_bundle_id}::uuid, ${body.primary_hub_id ?? null}::uuid, ${actor}::uuid, 'MAKER_CHECKER')
          returning ${IDENTITY_COLUMNS}`);
        row = inserted.rows[0] as unknown as IdentityRow | undefined;
      } catch (error) {
        const server = serverErrorIn(error);
        if (
          server?.code === '23505' &&
          server.constraint === 'staff_identity_work_email_live_key'
        ) {
          throw ApiException.of(ErrorCode.WorkEmailInUse, 'That work email is already in use');
        }
        if (server?.code === '23503' && server.constraint === 'staff_identity_primary_hub_fkey') {
          throw violation('/primary_hub_id', 'enum');
        }
        throw error;
      }
      if (row === undefined) throw new Error('A staff identity was inserted and not returned');

      // A profile that has just been made holds no factor and no credential, and is pending: the rule's answer for it is `NOT_ELIGIBLE`.
      const view = viewOf(row, {
        mfaEnrolled: false,
        resetState: decideMfaResetState(FRESH_PROFILE),
      });
      await audit.write(handle, {
        code: 'staff.identity.created',
        enhanced: false,
        enhancedBasis: 'OPERATION',
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id },
        ...(row.primary_hub_id === null ? {} : { responsibleHubId: row.primary_hub_id }),
        resultingState: 'PENDING_APPROVAL',
        relatedIds: { created_by: actor, role_bundle_id: row.role_bundle_id },
      });
      await idempotency.complete(handle, scope, {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify(view)),
      });
      return { identity: view, etag: staffIdentityEtagOf(view, row.version) };
    });
  }

  async decide(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    ifMatch: string | undefined,
    body: ApprovalRequest,
  ): Promise<StaffIdentityAnswer> {
    const { runner, audit, reasons } = this.#options;
    const actor = authorized.session.principalId;
    // The note is judged with the rest of the body, before the version and the state.
    const note = checkedNote(body.note);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const before = await lockStaffIdentity(handle, id);
      // The requirement of the target's bundle is judged again on the record as it now is, under its lock.
      await runner.requireTargetTier(authorized, handle);
      requireVersion(ifMatch, before.etag);
      if (before.row.status !== 'PENDING_APPROVAL') {
        throw stateConflict('Only a profile awaiting approval can be approved or rejected');
      }
      const reason = body.approved
        ? undefined
        : await validated(reasons, handle, {
            reasonCode: body.reason_code,
            operationId: 'approveStaffIdentity',
            branch: 'APPROVAL_REJECTED',
            ...(note === undefined ? {} : { note }),
          });
      // The maker-checker rule is the last refusal (permission-enforcement.md §5.1, step 12). A Platform Admin needs no second person
      // (the Product Owner's decision of 25 October 2026): the exemption is the tier of the grant that authorizes this act, read from
      // the session's snapshot, and never a role's name. Migration 0032 holds the same rule in the table for every other writer.
      if (before.row.created_by === actor && !meetsTier(authorized.grant?.tier ?? null, 'P')) {
        throw ApiException.of(
          ErrorCode.SelfApprovalForbidden,
          'Only a Platform Admin approves or rejects a profile they made; any other maker needs someone else to decide it',
        );
      }

      const next = body.approved ? 'ACTIVE' : 'REJECTED';
      const decided = await transactionOf(handle).execute(sql`
        update staff_identity set status = ${next}, approved_by = ${actor}::uuid
         where id = ${id}::uuid and status = 'PENDING_APPROVAL'`);
      if (decided.rowCount !== 1) throw stateConflict('The profile is no longer awaiting approval');

      await audit.write(handle, {
        code: body.approved ? 'staff.identity.approved' : 'staff.identity.rejected',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'StaffIdentity', id },
        ...(before.row.primary_hub_id === null
          ? {}
          : { responsibleHubId: before.row.primary_hub_id }),
        previousState: 'PENDING_APPROVAL',
        resultingState: next,
        ...(reason === undefined ? {} : { reason: { code: reason.code, label: reason.label } }),
        // The note is kept once, on the event of the decision itself (the rejection's required explanation, an approval's optional one).
        ...(note === undefined ? {} : { note }),
        beforeAfter: {
          status: { before: 'PENDING_APPROVAL', after: next },
          approved_by: { before: null, after: actor },
        },
        relatedIds: { created_by: before.row.created_by, approved_by: actor },
      });
      if (body.approved) {
        await this.#issueSetup(handle, actor, before.row);
      }
      const after = await lockStaffIdentity(handle, id);
      return { identity: after.view, etag: after.etag };
    });
  }

  async reissue(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    ifMatch: string | undefined,
    body: ReissueRequest,
  ): Promise<SetupGrantView> {
    const { runner, reasons } = this.#options;
    const actor = authorized.session.principalId;
    const note = checkedNote(body.note);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const before = await lockStaffIdentity(handle, id);
      await runner.requireTargetTier(authorized, handle);
      requireVersion(ifMatch, before.etag);
      // An approved identity that holds no credential and was made by the maker-checker process: the grant that was issued to it lapsed or
      // was lost. A seeded administrator is refused however its credential stands (its work email was never accepted by an approval), and
      // an identity that already holds a credential is recovered, not onboarded again.
      if (
        before.row.status !== 'ACTIVE' ||
        before.facts.origin !== 'MAKER_CHECKER' ||
        before.facts.hasCredential
      ) {
        throw stateConflict(
          'A setup link is re-issued to an approved identity that has no credential yet',
        );
      }
      const reason = await validated(reasons, handle, {
        reasonCode: body.reason_code,
        operationId: 'reissueStaffCredentialSetup',
        ...(note === undefined ? {} : { note }),
      });
      const issued = await this.#issueSetup(handle, actor, before.row, reason, note);
      const { grant } = issued;
      if (grant.expiresAt === null) throw new Error('A staff credential setup grant has an expiry');
      return {
        id: grant.id,
        principal_type: 'STAFF',
        principal_id: grant.principalId,
        purpose: 'STAFF_CREDENTIAL_SETUP',
        state: 'PENDING',
        issued_at: grant.issuedAt.toISOString(),
        expires_at: grant.expiresAt.toISOString(),
        consumed_at: null,
      };
    });
  }

  #requireHubInScope(authorized: AuthorizedRequest, hub: string | undefined): void {
    if (authorized.scope.hubScopeMode === 'ALL') return;
    if (hub === undefined) throw violation('/primary_hub_id', 'required');
    if (!scopeIncludesHub(authorized.scope, hub)) {
      throw ApiException.of(ErrorCode.HubScopeViolation, 'The hub is outside your hubs');
    }
  }

  /**
   * Issues the `STAFF_CREDENTIAL_SETUP` grant and queues its message to the identity's work email, in the transaction, and records both
   * events. A message that cannot be queued fails the act whole (`CREDENTIAL_DELIVERY_FAILED`).
   */
  async #issueSetup(
    handle: TransactionHandle,
    actor: string,
    row: IdentityRow,
    reason?: ValidatedReason,
    note?: string,
  ): Promise<IssuedGrant> {
    const { grants, audit, setupLink } = this.#options;
    let issued: IssuedGrant;
    try {
      issued = await grants.issue(handle, {
        principal: { type: 'STAFF', id: row.id },
        purpose: 'STAFF_CREDENTIAL_SETUP',
        issuedBy: actor,
        delivery: {
          kind: 'SETUP_GRANT',
          channel: 'EMAIL',
          // As entered, without the padding the canonical form removes: the address is the one the approval accepted.
          destination: row.work_email.trim(),
          link: setupLink,
        },
      });
    } catch (error) {
      if (error instanceof DeliveryNotQueueableError) {
        throw ApiException.of(
          ErrorCode.CredentialDeliveryFailed,
          'The setup link could not be queued for delivery',
        );
      }
      throw error;
    }
    if (issued.supersededGrantId !== null) {
      await audit.write(handle, {
        code: 'auth.setup_grant.superseded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'SetupGrant', id: issued.supersededGrantId },
        previousState: 'PENDING',
        resultingState: 'SUPERSEDED',
        relatedIds: { principal_id: row.id, superseded_by: issued.grant.id },
        detail: { purpose: 'STAFF_CREDENTIAL_SETUP', principal_type: 'STAFF' },
      });
    }
    await audit.write(handle, {
      code: 'auth.setup_grant.issued',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'SetupGrant', id: issued.grant.id },
      ...(reason === undefined ? {} : { reason: { code: reason.code, label: reason.label } }),
      // A re-issue's primary event is the issue of the new grant (the supersession of the old one is its side effect): it keeps the note.
      ...(note === undefined ? {} : { note }),
      relatedIds: { principal_id: row.id, issued_by: actor },
      detail: { purpose: 'STAFF_CREDENTIAL_SETUP', channel: 'EMAIL', principal_type: 'STAFF' },
    });
    return issued;
  }
}

/** The facts of a profile that has just been made: pending, no credential, no factor. */
const FRESH_PROFILE: ResetFacts = Object.freeze({
  status: 'PENDING_APPROVAL',
  origin: 'MAKER_CHECKER',
  privileged: false,
  hasCredential: false,
  hasActiveFactor: false,
  hasPendingFactor: false,
  hasUsableGrant: false,
  hasPendingDelivery: false,
  latestFactor: null,
});
