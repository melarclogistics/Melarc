import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type {
  AdministratorRecoveries,
  RecoveryRequestView,
} from '../platform/auth/recovery/administrator-recovery.js';
import type { DeliveryChannel } from '../platform/auth/ports/delivery-queue.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type {
  IssuedGrant,
  SetupGrantStore,
} from '../platform/auth/setup-grants/setup-grant-store.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { DeliveryNotQueueableError } from '../platform/delivery/delivery-errors.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import {
  ReasonRefusedError,
  type ReasonRequest,
  type ReasonValidator,
  type ValidatedReason,
} from '../platform/settings/reason-validator.js';
import { checkedNote } from '../staff/staff-note.js';
import {
  lockVendorAccount,
  requireVendorVersion,
  type LockedVendorAccount,
} from './vendor-locked-account.js';

/** What `reissueVendorCredentialSetup` takes (`SetupGrantReissue`): the path names the account; no purpose and no principal. */
export interface VendorReissueRequest {
  readonly reason_code: string;
  readonly note?: string;
}

/** The answer of a re-issue (`SetupGrant`): where the grant stands, never its token. */
export interface VendorSetupGrantView {
  readonly id: string;
  readonly principal_type: 'VENDOR';
  readonly principal_id: string;
  readonly purpose: 'VENDOR_CREDENTIAL_SETUP';
  readonly state: 'PENDING';
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: null;
}

export interface VendorCredentialAdministrationOptions {
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly audit: AuditWriter;
  readonly grants: Pick<SetupGrantStore, 'issue'>;
  readonly reasons: Pick<ReasonValidator, 'validate'>;
  /** The platform's shared part of an administrator's recovery (S0.51b). */
  readonly recoveries: Pick<AdministratorRecoveries, 'recover'>;
  /** The Vendor origin's link for a credential setup, with the token in the fragment (`linkTemplates`). */
  readonly setupLink: (token: string) => string;
}

const OPERATION_REISSUE = 'reissueVendorCredentialSetup';
const OPERATION_RECOVER = 'recoverVendorCredential';

/** What `recoverVendorCredential` takes (`CredentialRecoveryInitiation`): a reason and a note; the path names the account. */
export interface VendorRecoveryRequest {
  readonly reason_code: string;
  readonly note?: string;
}

/** The statuses in which an account, and its organisation, may recover (credential-recovery.md section 5.7). */
const RECOVERABLE = new Set(['ACTIVE', 'SUSPENDED']);

/** A reason the catalogue refuses is the contract's `REASON_REQUIRED` or `REASON_NOT_ACTIVE`; anything else is not this function's. */
async function validated(
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

const deliveryFailed = (): ApiException =>
  ApiException.of(
    ErrorCode.CredentialDeliveryFailed,
    'The setup link could not be queued for delivery',
  );

/**
 * Where a vendor's message goes (domain-model.md section 6.8, `delivery_channel`): the registered address of the channel the approver chose,
 * read under the account's lock and never from the request. An account with no channel chosen, or none registered for it, has nowhere to
 * be sent anything: the act writes nothing (`CREDENTIAL_DELIVERY_FAILED`).
 */
const recoveryDeliveryFailed = (): ApiException =>
  ApiException.of(
    ErrorCode.CredentialDeliveryFailed,
    'The recovery link could not be queued for delivery',
  );

function deliveryOf(
  locked: LockedVendorAccount,
  refusal: () => ApiException = deliveryFailed,
): { readonly channel: DeliveryChannel; readonly destination: string } {
  const { delivery_channel: chosen, delivery_destination: destination } = locked.facts;
  if (chosen === null || destination === null) throw refusal();
  return { channel: chosen === 'PHONE' ? 'SMS' : 'EMAIL', destination };
}

/**
 * `reissueVendorCredentialSetup` (S0.47b; `vendor.organization.approve`, Senior Ops at the vendor's own hub or a Platform Admin at every hub;
 * `AC-SLICE-000-101`; vendor-authentication.md section 12): **establishment repeated, not recovery**. An approved account whose one setup
 * grant lapsed before anyone at the vendor acted on it holds no secret, and recovery repairs a secret that exists; the approval authority
 * is exercised again, and a fresh `VENDOR_CREDENTIAL_SETUP` grant goes to the credential's delivery channel.
 *
 * - **It runs in the caller's own staff context under the key** (`OperationRunner.mutate`; migration 0035 states the mechanism): the guard
 *   has answered the key and the account's scope (`HUB_SCOPE_VIOLATION` through the organisation's hub, `NOT_FOUND`) and the schema before
 *   this runs; the note is judged first, as a malformed body is.
 * - **Under the credential's lock** (`melarc.vendor_locked_facts`): the version (`If-Match` against the ETag the read gives, recomputed
 *   here), then the state, then the reason. **The guard is the secret being null** (an account that holds one is `STATE_CONFLICT`: it is
 *   recovered, not onboarded again); the account and its organisation are `ACTIVE`. Suspension is preserved: the act changes no state.
 * - **The grant and its message are one transaction with the events**: the earlier pending grant is superseded and its message cancelled,
 *   and the new message, which carries the account identifier beside the link, is queued for the delivery worker. A message that cannot be
 *   queued writes nothing (`CREDENTIAL_DELIVERY_FAILED`). **No token, no destination and no secret is returned, logged or audited.**
 */
export class VendorCredentialAdministration {
  readonly #options: VendorCredentialAdministrationOptions;

  constructor(options: VendorCredentialAdministrationOptions) {
    this.#options = options;
  }

  async reissue(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    ifMatch: string | undefined,
    body: VendorReissueRequest,
  ): Promise<VendorSetupGrantView> {
    const { runner, reasons } = this.#options;
    const actor = authorized.session.principalId;
    const note = checkedNote(body.note);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const locked = await lockVendorAccount(handle, id);
      requireVendorVersion(ifMatch, locked.etag);
      if (locked.facts.credential_established) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'The account already holds a secret: it is recovered, not set up again',
        );
      }
      if (
        locked.facts.account_status !== 'ACTIVE' ||
        locked.facts.organization_status !== 'ACTIVE'
      ) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'A setup link is re-issued to an active account of an approved organisation',
        );
      }
      const reason = await validated(reasons, handle, {
        reasonCode: body.reason_code,
        operationId: OPERATION_REISSUE,
        ...(note === undefined ? {} : { note }),
      });
      const issued = await this.#issueSetup(handle, actor, locked, reason, note);
      const { grant } = issued;
      if (grant.expiresAt === null)
        throw new Error('A vendor credential setup grant has an expiry');
      return {
        id: grant.id,
        principal_type: 'VENDOR',
        principal_id: grant.principalId,
        purpose: 'VENDOR_CREDENTIAL_SETUP',
        state: 'PENDING',
        issued_at: grant.issuedAt.toISOString(),
        expires_at: grant.expiresAt.toISOString(),
        consumed_at: null,
      };
    });
  }

  /**
   * `recoverVendorCredential` (S0.51b; `vendor.credential.recover`, Platform Admin at every hub; credential-recovery.md sections 5.5 and 5.7;
   * the vendor clauses of `AC-SLICE-000-23` and `-121`): a Platform Admin starts the recovery of an account's existing shared secret. The
   * link goes to the credential's delivery channel with the account identifier; completing it rotates both the secret and the browsers, and
   * **the administrator never learns the new secret**. Under the credential's lock: the version, then the eligibility (the account and its
   * organisation `ACTIVE` or `SUSPENDED`, a secret established: anything else is `STATE_CONFLICT` and nothing is written; an account with no
   * secret is reached by `reissueVendorCredentialSetup`), then the delivery channel (`CREDENTIAL_DELIVERY_FAILED` when none is registered),
   * then the reason; the coexistence rule is self-service's. Suspension is preserved: the act changes no state.
   */
  async recover(
    authorized: AuthorizedRequest,
    correlationId: string,
    id: string,
    ifMatch: string | undefined,
    body: VendorRecoveryRequest,
  ): Promise<RecoveryRequestView> {
    const { runner, reasons, recoveries } = this.#options;
    const administrator = authorized.session.principalId;
    const note = checkedNote(body.note);
    return runner.mutate(authorized, correlationId, async (handle) => {
      const locked = await lockVendorAccount(handle, id);
      requireVendorVersion(ifMatch, locked.etag);
      const { facts } = locked;
      if (
        !facts.credential_established ||
        !RECOVERABLE.has(facts.account_status) ||
        !RECOVERABLE.has(facts.organization_status)
      ) {
        throw ApiException.of(
          ErrorCode.StateConflict,
          'Recovery repairs the secret of an account, and of an organisation, that may still hold one',
        );
      }
      const { channel, destination } = deliveryOf(locked, recoveryDeliveryFailed);
      const reason = await validated(reasons, handle, {
        reasonCode: body.reason_code,
        operationId: OPERATION_RECOVER,
        ...(note === undefined ? {} : { note }),
      });
      return recoveries.recover(handle, {
        principal: { type: 'VENDOR', id: locked.row.id },
        channel,
        destination,
        accountIdentifier: locked.row.account_identifier,
        administrator,
        reason: { code: reason.code, label: reason.label },
        ...(note === undefined ? {} : { note }),
        responsibleHubId: locked.row.responsible_hub_id,
      });
    });
  }

  /** Issues the grant, queues its message to the delivery channel with the account identifier, and records both events. */
  async #issueSetup(
    handle: TransactionHandle,
    actor: string,
    locked: LockedVendorAccount,
    reason: ValidatedReason,
    note: string | undefined,
  ): Promise<IssuedGrant> {
    const { grants, audit, setupLink } = this.#options;
    const { channel, destination } = deliveryOf(locked);
    const account = locked.row;
    let issued: IssuedGrant;
    try {
      issued = await grants.issue(handle, {
        principal: { type: 'VENDOR', id: account.id },
        purpose: 'VENDOR_CREDENTIAL_SETUP',
        issuedBy: actor,
        delivery: {
          kind: 'SETUP_GRANT',
          channel,
          destination,
          link: setupLink,
          accountIdentifier: account.account_identifier,
        },
      });
    } catch (error) {
      if (error instanceof DeliveryNotQueueableError) throw deliveryFailed();
      throw error;
    }
    if (issued.supersededGrantId !== null) {
      await audit.write(handle, {
        code: 'auth.setup_grant.superseded',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'SetupGrant', id: issued.supersededGrantId },
        responsibleHubId: account.responsible_hub_id,
        previousState: 'PENDING',
        resultingState: 'SUPERSEDED',
        relatedIds: { principal_id: account.id, superseded_by: issued.grant.id },
        detail: { purpose: 'VENDOR_CREDENTIAL_SETUP', principal_type: 'VENDOR' },
      });
    }
    await audit.write(handle, {
      code: 'auth.setup_grant.issued',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'SetupGrant', id: issued.grant.id },
      responsibleHubId: account.responsible_hub_id,
      reason: { code: reason.code, label: reason.label },
      ...(note === undefined ? {} : { note }),
      relatedIds: { principal_id: account.id, issued_by: actor },
      detail: { purpose: 'VENDOR_CREDENTIAL_SETUP', channel, principal_type: 'VENDOR' },
    });
    return issued;
  }
}
