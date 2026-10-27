import { DeliveryNotQueueableError } from '../../delivery/delivery-errors.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import type { RecoveryRequestStore, StoredRecovery } from './recovery-request-store.js';
import { absorbingLink } from './recovery-request.service.js';
import {
  RECOVERY_GUARD_SETTING,
  type RecoveryChannel,
  type RecoveryPrincipalType,
} from './recovery-vocabulary.js';

/** The answer of an administrator's recovery (`RecoveryRequest` of the contract): where the request stands, **never its token**. */
export interface RecoveryRequestView {
  readonly id: string;
  readonly principal_type: RecoveryPrincipalType;
  readonly channel: RecoveryChannel;
  readonly state: StoredRecovery['state'];
  readonly issued_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
  readonly initiated_by: string | null;
  /** True when the request was absorbed by a live link inside the guard or at the cap: nothing was issued or claimed to be sent. */
  readonly coalesced: boolean;
}

export function recoveryRequestViewOf(
  request: StoredRecovery,
  coalesced: boolean,
): RecoveryRequestView {
  return {
    id: request.id,
    principal_type: request.principalType,
    channel: request.channel,
    state: request.state,
    issued_at: request.issuedAt.toISOString(),
    expires_at: request.expiresAt.toISOString(),
    consumed_at: request.consumedAt === null ? null : request.consumedAt.toISOString(),
    initiated_by: request.initiatedBy,
    coalesced,
  };
}

/** What the domain's operation has judged under the principal's lock, for the request it now makes on the principal's behalf. */
export interface AdministratorRecoveryRequest {
  readonly principal: { readonly type: RecoveryPrincipalType; readonly id: string };
  /** The registered channel and its address, read from the principal's record under the lock; never from the request. */
  readonly channel: RecoveryChannel;
  readonly destination: string;
  readonly accountIdentifier?: string;
  /** The acting Platform Admin, who initiates the request and is the actor of its event. */
  readonly administrator: string;
  readonly reason: { readonly code: string; readonly label: string };
  readonly note?: string;
  /** The hub the principal's record belongs to, for the event (a vendor's organisation's responsible hub; a staff member's primary hub). */
  readonly responsibleHubId?: string;
}

export interface AdministratorRecoveriesOptions {
  readonly store: Pick<RecoveryRequestStore, 'liveOf' | 'issue'>;
  readonly settings: Pick<SettingsReader, 'integer'>;
  readonly audit: AuditWriter;
  /** Each surface's recovery route, with the token in the fragment: the principal follows the link on its own surface. */
  readonly links: Readonly<Record<RecoveryPrincipalType, (token: string) => string>>;
}

/**
 * The part of `recoverStaffCredential` and `recoverVendorCredential` (S0.51b; credential-recovery.md section 5.5) that does not depend on
 * the domain: **the same coexistence rule as self-service**. Inside `recovery_request_supersede_guard_seconds` of the newest live link, or
 * with two live, nothing is issued: the existing request's non-secret metadata is returned with `coalesced` true and the event records that
 * the administrator's request was coalesced, claiming no message. Otherwise a request is made with the administrator as `initiated_by`, its
 * link queued to the principal's registered channel in the same transaction, and any earlier usable link left usable. **The token goes to
 * the principal and to nobody else**: never into the answer, the event or a log.
 *
 * The domain's operation has locked the principal, compared the version and judged the eligibility and the reason before it calls this; the
 * transaction is the caller's, in its staff context under the operation's key (migration 0038 binds the arms to the locked principal).
 */
export class AdministratorRecoveries {
  readonly #options: AdministratorRecoveriesOptions;

  constructor(options: AdministratorRecoveriesOptions) {
    this.#options = options;
  }

  async recover(
    handle: TransactionHandle,
    request: AdministratorRecoveryRequest,
  ): Promise<RecoveryRequestView> {
    const { store, settings, audit, links } = this.#options;
    const { principal, administrator } = request;
    const guardSeconds = await settings.integer(handle, RECOVERY_GUARD_SETTING);
    const live = await store.liveOf(handle, principal, guardSeconds);
    const event = {
      code: 'auth.recovery.requested',
      enhanced: true,
      enhancedBasis: 'ADMINISTRATOR_INITIATED',
      outcome: 'SUCCEEDED',
      reason: request.reason,
      ...(request.note === undefined ? {} : { note: request.note }),
      ...(request.responsibleHubId === undefined
        ? {}
        : { responsibleHubId: request.responsibleHubId }),
      relatedIds: {
        principal_type: principal.type,
        principal_id: principal.id,
        initiated_by: administrator,
      },
    } as const;

    const absorbing = absorbingLink(live);
    if (absorbing !== undefined) {
      await audit.write(handle, {
        ...event,
        object: { type: 'RecoveryRequest', id: absorbing.id },
        resultingState: 'COALESCED',
      });
      return recoveryRequestViewOf(absorbing, true);
    }

    let issued;
    try {
      issued = await store.issue(handle, {
        principal,
        channel: request.channel,
        destination: request.destination,
        link: links[principal.type],
        initiatedBy: administrator,
        ...(request.accountIdentifier === undefined
          ? {}
          : { accountIdentifier: request.accountIdentifier }),
      });
    } catch (error) {
      if (error instanceof DeliveryNotQueueableError) {
        throw ApiException.of(
          ErrorCode.CredentialDeliveryFailed,
          'The recovery link could not be queued for delivery',
        );
      }
      throw error;
    }
    await audit.write(handle, {
      ...event,
      object: { type: 'RecoveryRequest', id: issued.request.id },
      resultingState: 'ISSUED',
      beforeAfter: { recovery_request: { before: 'NONE', after: 'ISSUED' } },
      detail: { channel: request.channel },
    });
    return recoveryRequestViewOf(issued.request, false);
  }
}
