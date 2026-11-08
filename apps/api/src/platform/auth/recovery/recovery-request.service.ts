import { DeliveryNotQueueableError } from '../../delivery/delivery-errors.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import { canonicalWorkEmail, isEmailShape } from '../credentials/work-email.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { IdentityDirectory, PrincipalRef } from '../ports/identity-directory.port.js';
import type { Metrics } from '../ports/metrics.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { authenticationContext } from '../staff/authentication-context.js';
import { MAX_ADDRESS_BYTES } from '../staff/staff-sign-in-limit.js';
import { canonicalAccountIdentifier } from '../vendor/vendor-vocabulary.js';
import type { LiveRecovery, RecoveryRequestStore } from './recovery-request-store.js';
import {
  RECOVERY_GUARD_SETTING,
  RECOVERY_LIVE_LINK_CAP,
  type RecoveryPrincipalType,
} from './recovery-vocabulary.js';

function violation(pointer: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });
}

/** What a request was, for the caller's tests and nobody's answer: every one is answered the same `202`. */
export type RecoveryRequestOutcome = 'ISSUED' | 'COALESCED' | 'EXCLUDED';

/** The live link that absorbs a request issued inside the guard or at the cap, or none when a new link may be issued (section 5.5). */
export function absorbingLink(live: readonly LiveRecovery[]): LiveRecovery | undefined {
  const newest = live[0];
  if (newest === undefined) return undefined;
  return newest.withinGuard || live.length >= RECOVERY_LIVE_LINK_CAP ? newest : undefined;
}

/** Thrown inside the transaction to take back a request whose message could not be queued; never leaves the service. */
class NotDeliverable extends Error {}

export interface RecoveryRequestOptions {
  readonly unitOfWork: Pick<UnitOfWork, 'run'>;
  readonly directory: Pick<
    IdentityDirectory,
    | 'findStaffByCanonicalEmail'
    | 'findVendorAccountByIdentifier'
    | 'lockIdentity'
    | 'recoveryEligible'
    | 'registeredChannel'
  >;
  readonly store: Pick<RecoveryRequestStore, 'liveOf' | 'issue'>;
  readonly settings: Pick<SettingsReader, 'integer'>;
  readonly audit: AuditWriter;
  /** The bounded registry; none composed counts nothing (the count is an observation, never a condition of the answer). */
  readonly metrics: Pick<Metrics, 'increment'> | undefined;
  /** The surface's recovery route, with the token in the fragment (`linkTemplates`): the Ops Portal's for staff, the Vendor PWA's for vendors. */
  readonly links: Readonly<Record<RecoveryPrincipalType, (token: string) => string>>;
}

/**
 * `requestCredentialRecovery` (S0.50; credential-recovery.md sections 5.1, 5.3, 5.5 and 5.7; `AC-SLICE-000-20`, `-21`, `-104`, `-107` and the
 * request half of `-121`). Self-service, for a staff member or a vendor account, with no session: **every request it accepts is answered the
 * same `202`**, whether the identifier matched an eligible principal, an ineligible one or nobody, and whatever was decided.
 *
 * - **The request carries no destination.** The link goes to the principal's registered channel, read from its record: a staff member's
 *   verified work email; the address of a vendor's delivery channel, with its account identifier. A body with any other field is refused by
 *   the schema (`VALIDATION_FAILED`) before this runs.
 * - **Eligibility is judged under the identity's lock** (section 5.7): the principal is found by its canonical identifier, locked (for a
 *   vendor, the account row), and only then read for its status, its credential and its channel (and its organisation's status). An
 *   ineligible or unknown one is excluded: nothing is written, no event, and the bounded counter `credential_recovery_requests_excluded_total`
 *   counts it (`UNKNOWN_OR_INELIGIBLE`), with no label that holds what was typed.
 * - **Links coexist, in a bounded number** (section 5.5). Inside `recovery_request_supersede_guard_seconds` of the newest live link, or with
 *   two live, nothing is issued and the request is `COALESCED` onto the newest live link; otherwise a new link is issued and the earlier one
 *   stays usable. The cap is judged under the same lock, so two requests that arrive together make at most two live links.
 * - **The message is queued in the same transaction** and sent by the worker: no provider is called on the response path, so a provider
 *   that times out or rejects is a job outcome the caller never sees.
 * - **Audit** (audit.md section 5.4): exactly one `auth.recovery.requested` for an eligible principal, `ISSUED` (the new request) or
 *   `COALESCED` (the live request that absorbed it), by `SYSTEM`, with the principal and, for `ISSUED`, the kind of channel.
 */
export class RecoveryRequestService {
  readonly #options: RecoveryRequestOptions;

  constructor(options: RecoveryRequestOptions) {
    this.#options = options;
  }

  async request(input: {
    readonly principalType: RecoveryPrincipalType;
    readonly identifier: string;
  }): Promise<RecoveryRequestOutcome> {
    const canonical = this.#canonical(input.principalType, input.identifier);
    let outcome: RecoveryRequestOutcome;
    try {
      outcome = await this.#options.unitOfWork.run(authenticationContext(), (handle) =>
        this.#decide(handle, input.principalType, canonical),
      );
    } catch (error) {
      // An eligible principal whose registered address the queue cannot take has, for this request, no deliverable channel: nothing was
      // kept (the transaction rolled back), and the answer is the one an unknown identifier gets.
      if (!(error instanceof NotDeliverable)) throw error;
      outcome = 'EXCLUDED';
    }
    if (outcome === 'EXCLUDED') {
      this.#options.metrics?.increment('credential_recovery_requests_excluded_total', {
        outcome: 'UNKNOWN_OR_INELIGIBLE',
      });
    }
    return outcome;
  }

  /** The identifier in its type's canonical form; a text that cannot be one is refused by its shape alone, which names nobody. */
  #canonical(type: RecoveryPrincipalType, identifier: string): string {
    // Over the limiter's bound the text takes no key, so it must be refused before any work: trimming could otherwise make it valid.
    if (Buffer.byteLength(identifier, 'utf8') > MAX_ADDRESS_BYTES)
      throw violation('/identifier', 'format');
    if (type === 'STAFF') {
      const email = canonicalWorkEmail(identifier);
      if (!email.ok || !isEmailShape(email.email)) throw violation('/identifier', 'format');
      return email.email;
    }
    const account = canonicalAccountIdentifier(identifier);
    if (account === undefined) throw violation('/identifier', 'format');
    return account;
  }

  async #decide(
    handle: TransactionHandle,
    type: RecoveryPrincipalType,
    canonical: string,
  ): Promise<RecoveryRequestOutcome> {
    const { directory, store, settings, audit, links } = this.#options;
    const found =
      type === 'STAFF'
        ? await directory.findStaffByCanonicalEmail(handle, canonical)
        : await directory.findVendorAccountByIdentifier(handle, canonical);
    if (found === null) return 'EXCLUDED';
    const ref: PrincipalRef = found.ref;
    // The decision is made on the state the lock protects, never on the read that found the principal.
    if ((await directory.lockIdentity(handle, ref)) === null) return 'EXCLUDED';
    if (!(await directory.recoveryEligible(handle, ref))) return 'EXCLUDED';
    const channel = await directory.registeredChannel(handle, ref);
    if (channel === null) return 'EXCLUDED';

    const guardSeconds = await settings.integer(handle, RECOVERY_GUARD_SETTING);
    const live = await store.liveOf(handle, ref, guardSeconds);
    const relatedIds = { principal_type: type, principal_id: ref.id };
    const absorbing = absorbingLink(live);
    if (absorbing !== undefined) {
      await audit.write(handle, {
        code: 'auth.recovery.requested',
        enhanced: false,
        enhancedBasis: 'SELF_SERVICE',
        outcome: 'SUCCEEDED',
        object: { type: 'RecoveryRequest', id: absorbing.id },
        resultingState: 'COALESCED',
        relatedIds,
      });
      return 'COALESCED';
    }

    let issued;
    try {
      issued = await store.issue(handle, {
        principal: ref,
        channel: channel.channel,
        destination: channel.destination,
        link: links[type],
        ...(channel.accountIdentifier === undefined
          ? {}
          : { accountIdentifier: channel.accountIdentifier }),
      });
    } catch (error) {
      if (error instanceof DeliveryNotQueueableError) throw new NotDeliverable();
      throw error;
    }
    await audit.write(handle, {
      code: 'auth.recovery.requested',
      enhanced: false,
      enhancedBasis: 'SELF_SERVICE',
      outcome: 'SUCCEEDED',
      object: { type: 'RecoveryRequest', id: issued.request.id },
      resultingState: 'ISSUED',
      relatedIds,
      detail: { channel: channel.channel },
    });
    return 'ISSUED';
  }
}
