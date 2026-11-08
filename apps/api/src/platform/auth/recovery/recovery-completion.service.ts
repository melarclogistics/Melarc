import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { runAdmitted } from '../../limiter/run-admitted.js';
import { normaliseNewCredential } from '../credentials/credential-rule.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { HashAdmission } from '../ports/hash-admission.port.js';
import type { Hasher } from '../ports/hasher.port.js';
import type { IdentityDirectory, PrincipalRef } from '../ports/identity-directory.port.js';
import type { SessionStore } from '../ports/session-store.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { authenticationContext } from '../staff/authentication-context.js';
import type { TrustedBrowserStore } from '../trusted-browsers/trusted-browser-store.js';
import type { RegisteredDeviceStore } from '../vendor/registered-device-store.js';
import { secretRefusal } from '../vendor/vendor-setup.service.js';
import {
  RecoveryRequestExpiredError,
  type RecoveryRequestStore,
  type StoredRecovery,
} from './recovery-request-store.js';
import type { RecoveryPrincipalType } from './recovery-vocabulary.js';

/**
 * The one answer for every recovery link that cannot be used (credential-recovery.md section 5.3): malformed, unknown, expired, consumed,
 * superseded, of an identity that is no longer eligible, or presented from the other surface. Which it was is not for the holder to learn,
 * and a reused link is not signalled.
 */
export const invalidRecoveryLink = (): ApiException =>
  ApiException.of(ErrorCode.RecoveryTokenInvalid, 'The recovery link is not valid');
const limited = (): ApiException => ApiException.of(ErrorCode.RateLimited, 'Too many requests');

export interface RecoveryCompletionOptions {
  readonly unitOfWork: Pick<UnitOfWork, 'run'>;
  readonly directory: Pick<
    IdentityDirectory,
    'lockIdentity' | 'recoveryEligible' | 'replaceCredential'
  >;
  readonly store: Pick<
    RecoveryRequestStore,
    'findLiveByToken' | 'lockLive' | 'consume' | 'endOthers'
  >;
  readonly devices: Pick<RegisteredDeviceStore, 'listFor' | 'revoke' | 'register'>;
  readonly sessions: Pick<SessionStore, 'terminate'>;
  /** A staff member's trusted browsers, which the new password ends (`CREDENTIAL_CHANGED`; domain-model.md 6.8 `TrustedBrowser`). */
  readonly trustedBrowsers: Pick<TrustedBrowserStore, 'revokeAll'>;
  readonly hasher: Hasher;
  readonly hashAdmission: HashAdmission;
  readonly audit: AuditWriter;
}

/** What a completion did, for the response: whose answer it is and, for a vendor, the new browser's credential (shown once, as a cookie). */
export type RecoveryCompleted =
  | { readonly principalType: 'STAFF' }
  | { readonly principalType: 'VENDOR'; readonly deviceCredential: string };

/**
 * `completeCredentialRecovery` (S0.51a; credential-recovery.md sections 5.2, 5.5 and 5.7; `AC-SLICE-000-17`, `-22`, `-24`, `-36`, `-87`,
 * `-97`, `-103`, `-106`; the completion half of `-121` and `GBT-B15`): **the sole consumer of a recovery request**, whoever created it. With
 * no session, a holder of a live link sets a new credential for the principal the link names.
 *
 * - **The new credential is held to both bounds first** (12 to 128 code points as sent, by the schema, and after NFKC, here):
 *   `VALIDATION_FAILED` at `/new_credential`, never with the value, and the link is not consumed.
 * - **A cheap look before the hash**: a link that is not live, or whose principal is not eligible now, is refused for the price of a lookup,
 *   so an invented token buys no hash. Nothing decided on it is final.
 * - **The credential is hashed outside any transaction, after hash admission**; then **one transaction judged under the identity's lock**
 *   (the order of SECURITY_DESIGN.md section 13.10a: the identity, then the request): it locks the identity, then the request, and requires
 *   a `PENDING`, unexpired request (on a fresh database time, after the waits) **and** an eligible identity; otherwise
 *   `RECOVERY_TOKEN_INVALID`, and no credential changes, no lock is cleared and no session is touched.
 * - **Completing ends everything the old credential held**: the credential is replaced (its generation raised, the failed-attempt count and
 *   the lock cleared), **every session of the principal ends `CREDENTIAL_CHANGED`**, the one performing the change included, and every
 *   other outstanding link of the credential is ended (`SUPERSEDED`, or `EXPIRED` past its time) with its message cancelled. A staff
 *   member's trusted browsers end with `CREDENTIAL_CHANGED` (domain-model.md section 6.8: the cause the recovery writes; the generation that
 *   moved already refuses them, and this records it). **For
 *   a vendor** every browser of the account is revoked and the browser completing the recovery is registered and given its credential: the
 *   only other route a browser becomes registered.
 * - **It reactivates nothing and issues no session**: a suspension stands, the MFA factor is untouched, and the principal signs in afterwards.
 * - **The surface is the principal's**: a link of a staff member presented from the Vendor PWA, or a vendor's from the Ops Portal, is the
 *   same invalid link, so a vendor's browser credential is only ever given to a page of the Vendor PWA.
 */
export class RecoveryCompletionService {
  readonly #options: RecoveryCompletionOptions;

  constructor(options: RecoveryCompletionOptions) {
    this.#options = options;
  }

  async complete(request: {
    readonly token: string;
    readonly newCredential: string;
    /** The type whose surface the request came from: the Ops origin's is `STAFF`, the Vendor origin's `VENDOR`. */
    readonly surfaceOf: RecoveryPrincipalType;
  }): Promise<RecoveryCompleted> {
    const checked = normaliseNewCredential(request.newCredential);
    if (!checked.ok) throw secretRefusal(checked, '/new_credential');
    const { unitOfWork, store, directory, hasher, hashAdmission } = this.#options;
    const context = authenticationContext();

    const found = await unitOfWork.run(context, async (transaction) => {
      const live = await store.findLiveByToken(transaction, request.token);
      if (live?.principalType !== request.surfaceOf) return null;
      return (await directory.recoveryEligible(transaction, refOf(live))) ? live : null;
    });
    if (found === null) throw invalidRecoveryLink();

    const hashed = await runAdmitted(hashAdmission, () =>
      hasher.hash(
        found.principalType === 'STAFF' ? 'STAFF_PASSWORD' : 'VENDOR_SECRET',
        checked.credential,
      ),
    );
    if (!hashed.admitted) throw limited();
    const encodedHash = hashed.value;

    try {
      return await unitOfWork.run(context, (transaction) =>
        this.#complete(transaction, refOf(found), request.token, encodedHash),
      );
    } catch (error) {
      if (error instanceof RecoveryRequestExpiredError) throw invalidRecoveryLink();
      throw error;
    }
  }

  async #complete(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    token: string,
    encodedHash: string,
  ): Promise<RecoveryCompleted> {
    const { directory, store, sessions, audit } = this.#options;
    // The identity's lock first, then the request's; both judged after the waits, on what the locks protect.
    if ((await directory.lockIdentity(transaction, ref)) === null) throw invalidRecoveryLink();
    const live = await store.lockLive(transaction, token);
    if (live?.principalType !== ref.type || live.principalId !== ref.id)
      throw invalidRecoveryLink();
    if (!(await directory.recoveryEligible(transaction, ref))) throw invalidRecoveryLink();
    const consumed = await store.consume(transaction, live.id);
    if (consumed === null) throw invalidRecoveryLink();
    const replaced = await directory.replaceCredential(transaction, ref, encodedHash);
    if (replaced === null) throw invalidRecoveryLink();
    await store.endOthers(transaction, ref, consumed.id);

    const actor =
      ref.type === 'STAFF'
        ? ({ type: 'STAFF', id: ref.id } as const)
        : ({ type: 'VENDOR_ACCOUNT', id: ref.id } as const);
    await audit.write(transaction, {
      code: 'auth.credential.changed',
      enhanced: false,
      outcome: 'SUCCEEDED',
      actor,
      object: { type: ref.type === 'STAFF' ? 'StaffIdentity' : 'VendorAccount', id: ref.id },
      beforeAfter: {
        credential_generation: { before: replaced.generation - 1, after: replaced.generation },
      },
      relatedIds: { principal_id: ref.id, recovery_request_id: consumed.id },
      detail: {
        cause: 'RECOVERY',
        credential_kind: ref.type === 'STAFF' ? 'STAFF_PASSWORD' : 'VENDOR_SECRET',
      },
    });
    const ended = await sessions.terminate(
      transaction,
      { by: 'principal', principalType: ref.type, principalId: ref.id },
      'CREDENTIAL_CHANGED',
    );
    for (const sessionId of ended) {
      await audit.write(transaction, {
        code: 'auth.session.terminated',
        enhanced: false,
        enhancedBasis: 'ROUTINE_TERMINATION',
        outcome: 'SUCCEEDED',
        actor,
        object: { type: 'Session', id: sessionId },
        reason: { code: 'CREDENTIAL_CHANGED', label: 'The credential was changed by a recovery' },
        relatedIds: { principal_id: ref.id, recovery_request_id: consumed.id },
      });
    }
    if (ref.type === 'STAFF') {
      for (const id of await this.#options.trustedBrowsers.revokeAll(transaction, {
        staffIdentityId: ref.id,
        cause: 'CREDENTIAL_CHANGED',
        revokedBy: null,
      })) {
        await audit.write(transaction, {
          code: 'auth.trusted_browser.revoked',
          enhanced: false,
          outcome: 'SUCCEEDED',
          actor,
          object: { type: 'StaffIdentity', id: ref.id },
          relatedIds: { trusted_browser_id: id },
          detail: { cause: 'CREDENTIAL_CHANGED' },
        });
      }
      return { principalType: 'STAFF' };
    }
    return {
      principalType: 'VENDOR',
      deviceCredential: await this.#rotateBrowsers(transaction, ref, consumed),
    };
  }

  /** Every browser of the account revoked, and the one completing the recovery registered: its credential, for the cookie, and nowhere else. */
  async #rotateBrowsers(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    consumed: StoredRecovery,
  ): Promise<string> {
    const { devices, audit } = this.#options;
    const actor = { type: 'VENDOR_ACCOUNT', id: ref.id } as const;
    for (const device of await devices.listFor(transaction, ref.id)) {
      if (device.status !== 'ACTIVE') continue;
      const revoked = await devices.revoke(transaction, device.id, ref.id);
      if (revoked === null) continue;
      await audit.write(transaction, {
        code: 'auth.device.revoked',
        enhanced: true,
        outcome: 'SUCCEEDED',
        actor,
        object: { type: 'RegisteredDevice', id: revoked.id },
        previousState: 'ACTIVE',
        resultingState: 'REVOKED',
        beforeAfter: { status: { before: 'ACTIVE', after: 'REVOKED' } },
        relatedIds: { principal_id: ref.id, recovery_request_id: consumed.id },
        detail: { device_kind: 'VENDOR_BROWSER_CREDENTIAL', cause: 'RECOVERY' },
      });
    }
    const registered = await devices.register(transaction, ref.id);
    await audit.write(transaction, {
      code: 'auth.device.registered',
      enhanced: true,
      outcome: 'SUCCEEDED',
      actor,
      object: { type: 'RegisteredDevice', id: registered.device.id },
      resultingState: 'ACTIVE',
      beforeAfter: { status: { before: null, after: 'ACTIVE' } },
      relatedIds: { principal_id: ref.id, recovery_request_id: consumed.id },
      detail: { device_kind: 'VENDOR_BROWSER_CREDENTIAL', cause: 'RECOVERY' },
    });
    return registered.credential;
  }
}

const refOf = (request: StoredRecovery): PrincipalRef => ({
  type: request.principalType,
  id: request.principalId,
});
