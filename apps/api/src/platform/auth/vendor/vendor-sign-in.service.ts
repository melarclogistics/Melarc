import { createHash } from 'node:crypto';

import { commitThenRefuse } from '../../audit/commit-then-refuse.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { runAdmitted } from '../../limiter/run-admitted.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import { normalisePresentedCredential } from '../credentials/credential-rule.js';
import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type { HashAdmission } from '../ports/hash-admission.port.js';
import type { Hasher } from '../ports/hasher.port.js';
import type {
  IdentityDirectory,
  LockoutPolicy,
  PrincipalRef,
  PrincipalSummary,
} from '../ports/identity-directory.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { currentSessionOf, type CurrentSessionView } from '../sessions/current-session.js';
import { SessionIssueRefusedError } from '../sessions/session-errors.js';
import type { IssuedSession, SessionIssuer } from '../sessions/session-issuer.js';
import { authenticationContext } from '../staff/authentication-context.js';
import type { RegisteredDeviceStore } from './registered-device-store.js';
import { MAX_IDENTIFIER_BYTES } from './vendor-sign-in-limit.js';
import { canonicalAccountIdentifier } from './vendor-vocabulary.js';

const MAX_ATTEMPTS_SETTING = 'signin_max_attempts';
const LOCKOUT_MINUTES_SETTING = 'signin_lockout_minutes';

/** The one answer to every refusal of a factor but the lock: nothing in it says which factor failed. */
const invalidCredentials = (): ApiException =>
  ApiException.of(
    ErrorCode.InvalidCredentials,
    'The account identifier, the secret or this browser is not correct',
  );
/** The one refusal a registered browser is told: the shared credential is locked (vendor-authentication.md section 5.6). */
const credentialLocked = (): ApiException =>
  ApiException.of(ErrorCode.CredentialLocked, 'The credential is locked');

function violation(pointer: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });
}

/** The closed sets of audit.md section 5.4 the vendor sign-in uses. */
type FailureCause =
  | 'UNKNOWN_PRINCIPAL'
  | 'UNREGISTERED_BROWSER'
  | 'INELIGIBLE_PRINCIPAL'
  | 'LOCKED_OUT'
  | 'WRONG_SECRET';
type FactorReached = 'SECRET' | 'NONE';

/** A hash of a typed identifier and its kind, for the refusal that names no account (audit.md section 5.4), never the text as typed. */
function identifierDigest(text: string): string {
  return createHash('sha256')
    .update(`melarc.audit.identifier.v1\u0000ACCOUNT_IDENTIFIER\u0000${text}`, 'utf8')
    .digest('hex');
}

function failedEvent(input: {
  readonly cause: FailureCause;
  readonly factor: FactorReached;
  readonly account: PrincipalRef | null;
  readonly typed: string;
}): AuditEventInput {
  return {
    code: 'auth.session.failed',
    enhanced: false,
    outcome: 'REJECTED',
    object: { type: 'VendorAccount', id: input.account?.id ?? null },
    detail: {
      cause: input.cause,
      factor: input.factor,
      ...(input.account === null
        ? {
            identifier_kind: 'ACCOUNT_IDENTIFIER',
            identifier_digest: identifierDigest(input.typed),
          }
        : {}),
    },
  };
}

export interface VendorSignInOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: IdentityDirectory;
  readonly devices: Pick<RegisteredDeviceStore, 'findByCredential' | 'isActiveFor'>;
  readonly hasher: Hasher;
  readonly hashAdmission: HashAdmission;
  readonly issuer: Pick<SessionIssuer, 'issue'>;
  readonly audit: AuditWriter;
  readonly settings: Pick<SettingsReader, 'integer'>;
}

export interface VendorSignInOutcome {
  readonly session: IssuedSession<CurrentSessionView>;
  readonly view: CurrentSessionView;
}

/** What the lookup and the one derivation found: the branch of the contract's order the request ended in. */
type Branch =
  'UNKNOWN' | 'UNREGISTERED' | 'INELIGIBLE' | 'LOCKED' | 'OVERLONG' | 'WRONG' | 'CORRECT';

interface Examined {
  readonly branch: Branch;
  readonly account: PrincipalSummary | null;
  readonly deviceId: string | null;
  readonly policy: LockoutPolicy;
  readonly rehashed: string | null;
  readonly verifiedHash: string | null;
}

/** The lock was set by another request while this one was being verified: answered as a request inside a lock, and it clears nothing. */
class LockedMeanwhileError extends Error {
  constructor() {
    super('The credential was locked while the sign-in was in flight');
    this.name = 'LockedMeanwhileError';
  }
}

/** The browser was revoked while the request was being verified: answered as an unregistered browser. */
class BrowserEndedMeanwhileError extends Error {
  constructor() {
    super('The registered browser was ended while the sign-in was in flight');
    this.name = 'BrowserEndedMeanwhileError';
  }
}

/**
 * `vendorSignIn` (S0.48; vendor-authentication.md sections 4.1, 5.1, 5.3 and 5.6; SECURITY_DESIGN.md sections 13.4b, 13.8a): **three
 * factors, all required**: the account identifier, the shared secret and the registered browser's credential in its cookie.
 *
 * **The order is the contract's**, after the rate limit (keyed in the guard on the account and the recognised browser) and the schema:
 * (1) **the registered browser**: the cookie must name an `ACTIVE` browser of the account named; absent, unknown, revoked or another
 * account's is `INVALID_CREDENTIALS`, **the secret is not examined and nothing is counted**; (2) an account that is not `ACTIVE`, or holds no
 * secret, is `INVALID_CREDENTIALS`; (3) with the browser proved, a locked credential is `CREDENTIAL_LOCKED`; (4) a wrong secret is
 * `INVALID_CREDENTIALS` and counts, by the one atomic conditional update of the staff sign-in, against the credential everyone shares; a
 * correct one resets the count. An unknown or malformed identifier is answered as a wrong secret: the identifier is not a control.
 *
 * - **One hash slot first, then one derivation for every request admitted to it** (against the real hash only when the secret was reached,
 *   against the dummy otherwise), so timing does not say which stage ended it; a request with no slot is `RATE_LIMITED`, derives nothing and
 *   counts nowhere. A secret that expands past 128 after NFKC is never derived and never counted.
 * - **The count, the lock event and every refusal's event commit before the refusal is answered** (`commitThenRefuse`).
 * - **A correct secret issues the session through the S0.24 protocol**, which ends the account's earlier session (`SUPERSEDED_BY_NEW_LOGIN`)
 *   and records the browser it was issued to; under the account's lock the browser is judged again, a lock set meanwhile is honoured, a
 *   stronger hash replaces the stored one and the count is cleared, in the transaction of the session.
 * - **The events name the account, never a person** (section 5.2), and hold no secret, credential or token.
 */
export class VendorSignInService {
  readonly #options: VendorSignInOptions;

  constructor(options: VendorSignInOptions) {
    this.#options = options;
  }

  async signIn(request: {
    readonly accountIdentifier: string;
    readonly secret: string;
    /** The value of the `melarc_vendor_device` cookie as presented, when the request carried exactly one. */
    readonly device: string | undefined;
  }): Promise<VendorSignInOutcome> {
    const context = authenticationContext();
    // A text longer than the limiter takes a key from is refused before anything else: it met no limit.
    if (Buffer.byteLength(request.accountIdentifier, 'utf8') > MAX_IDENTIFIER_BYTES) {
      throw violation('/account_identifier', 'maxLength');
    }
    const presented = normalisePresentedCredential(request.secret);
    if (!presented.ok && presented.refusal === 'MALFORMED_UNICODE')
      throw violation('/secret', 'format');
    // What is not a possible secret (it expands past the bound) is examined by nothing: no slot, no derivation, no count.
    const secret = presented.ok ? presented.credential : null;
    const canonical = canonicalAccountIdentifier(request.accountIdentifier);

    const examined =
      secret === null
        ? await this.#examine(context, canonical, request.device, null)
        : await this.#examinedInASlot(context, canonical, request.device, secret);
    return this.#conclude(context, request.accountIdentifier, examined);
  }

  async #examinedInASlot(
    context: SecurityContext,
    canonical: string | undefined,
    device: string | undefined,
    secret: string,
  ): Promise<Examined> {
    const slot = await runAdmitted(this.#options.hashAdmission, () =>
      this.#examine(context, canonical, device, secret),
    );
    if (!slot.admitted) throw ApiException.of(ErrorCode.RateLimited, 'Too many requests');
    return slot.value;
  }

  /** One lookup (the browser, the account, its lock, the two settings), then one derivation: real only when the secret was reached. */
  async #examine(
    context: SecurityContext,
    canonical: string | undefined,
    presentedDevice: string | undefined,
    secret: string | null,
  ): Promise<Examined> {
    const { unitOfWork, directory, devices, hasher, settings } = this.#options;
    const found = await unitOfWork.run(context, async (transaction) => {
      const account =
        canonical === undefined
          ? null
          : await directory.findVendorAccountByIdentifier(transaction, canonical);
      const device = await devices.findByCredential(transaction, presentedDevice);
      const registered =
        account !== null &&
        device !== null &&
        device.status === 'ACTIVE' &&
        device.accountId === account.ref.id;
      const policy: LockoutPolicy = {
        maxAttempts: await settings.integer(transaction, MAX_ATTEMPTS_SETTING),
        lockoutMinutes: await settings.integer(transaction, LOCKOUT_MINUTES_SETTING),
      };
      const eligible =
        registered && account.status === 'ACTIVE' && account.credentialGeneration > 0;
      const locked = eligible
        ? await directory.isCredentialLocked(transaction, account.ref)
        : false;
      const hash =
        eligible && !locked && secret !== null
          ? await directory.readCredentialHash(transaction, account.ref)
          : null;
      return {
        account,
        deviceId: registered ? device.deviceId : null,
        policy,
        eligible,
        locked,
        hash,
      };
    });
    const { account, deviceId, policy, eligible, locked, hash } = found;
    const none = (branch: Branch): Examined => ({
      branch,
      account,
      deviceId,
      policy,
      rehashed: null,
      verifiedHash: null,
    });
    const dummy = async (): Promise<void> => {
      if (secret !== null) await hasher.verifyAgainstDummy('VENDOR_SECRET', secret);
    };

    if (account === null) {
      await dummy();
      return none('UNKNOWN');
    }
    if (deviceId === null) {
      await dummy();
      return none('UNREGISTERED');
    }
    if (!eligible) {
      await dummy();
      return none('INELIGIBLE');
    }
    if (locked) {
      await dummy();
      return none('LOCKED');
    }
    if (secret === null) return none('OVERLONG');
    if (hash === null) {
      // The credential went between the two reads: no account that can sign in.
      await dummy();
      return none('INELIGIBLE');
    }
    const verdict = await hasher.verify('VENDOR_SECRET', secret, hash);
    if (!verdict.matches) return none('WRONG');
    const rehashed = verdict.needsRehash ? await hasher.hash('VENDOR_SECRET', secret) : null;
    return { branch: 'CORRECT', account, deviceId, policy, rehashed, verifiedHash: hash };
  }

  async #conclude(
    context: SecurityContext,
    typed: string,
    examined: Examined,
  ): Promise<VendorSignInOutcome> {
    const ref = examined.account?.ref ?? null;
    const refuse = (
      cause: FailureCause,
      factor: FactorReached,
      answer = invalidCredentials(),
    ): Promise<never> =>
      commitThenRefuse(this.#options.unitOfWork, context, async (transaction) => {
        await this.#options.audit.write(
          transaction,
          failedEvent({ cause, factor, account: ref, typed }),
        );
        return answer;
      });

    switch (examined.branch) {
      case 'UNKNOWN':
        return refuse('UNKNOWN_PRINCIPAL', 'NONE');
      case 'UNREGISTERED':
        return refuse('UNREGISTERED_BROWSER', 'NONE');
      case 'INELIGIBLE':
        return refuse('INELIGIBLE_PRINCIPAL', 'NONE');
      case 'LOCKED':
        return refuse('LOCKED_OUT', 'SECRET', credentialLocked());
      case 'OVERLONG':
        // Never examined: no factor reached, nothing counted; a secret that cannot be right.
        return refuse('WRONG_SECRET', 'NONE');
      case 'WRONG':
        return commitThenRefuse(this.#options.unitOfWork, context, (transaction) =>
          this.#countFailure(transaction, examined, typed),
        );
      case 'CORRECT':
        return this.#session(context, typed, examined);
    }
  }

  /** The bookkeeping of a wrong secret: the count, the lock it may set and the events, in one transaction that commits first. */
  async #countFailure(
    transaction: TransactionHandle,
    examined: Examined,
    typed: string,
  ): Promise<Error> {
    const { directory, audit } = this.#options;
    const account = examined.account;
    if (account === null) throw new Error('A wrong secret was judged for an account');
    const result = await directory.recordFailedAttempt(
      transaction,
      account.ref,
      account.credentialGeneration,
      examined.policy,
    );
    if (!result.counted && result.reason === 'STALE') {
      // The credential the secret was checked against is not the account's now: nothing is counted on the one that replaced it.
      await audit.write(
        transaction,
        failedEvent({
          cause: 'INELIGIBLE_PRINCIPAL',
          factor: 'SECRET',
          account: account.ref,
          typed,
        }),
      );
      return invalidCredentials();
    }
    if (!result.counted) {
      // Another request set the lock while this one was verified: a request inside a lock, from a registered browser.
      await audit.write(
        transaction,
        failedEvent({ cause: 'LOCKED_OUT', factor: 'SECRET', account: account.ref, typed }),
      );
      return credentialLocked();
    }
    await audit.write(
      transaction,
      failedEvent({ cause: 'WRONG_SECRET', factor: 'SECRET', account: account.ref, typed }),
    );
    if (result.tipped) {
      // One event per lock, written by the update that set it, and never what was typed.
      await audit.write(transaction, {
        code: 'auth.lockout.applied',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'VendorAccount', id: account.ref.id },
        detail: { factor: 'SECRET', locked_until: result.lockedUntil.toISOString() },
      });
    }
    return invalidCredentials();
  }

  async #session(
    context: SecurityContext,
    typed: string,
    examined: Examined,
  ): Promise<VendorSignInOutcome> {
    const { directory, devices, issuer } = this.#options;
    const account = examined.account;
    const deviceId = examined.deviceId;
    if (account === null || deviceId === null)
      throw new Error('A correct secret was judged for an account and its browser');
    const ref = account.ref;
    const generation = account.credentialGeneration;
    let issued: IssuedSession<CurrentSessionView>;
    try {
      issued = await issuer.issue({
        principal: ref,
        correlationId: context.correlationId,
        verifiedCredentialGeneration: generation,
        registeredDeviceId: deviceId,
        project: (handle, session) => currentSessionOf(handle, session, directory),
        steps: [
          {
            name: 'the registered browser stands, a lock set meanwhile is honoured, and a complete sign-in clears the count',
            run: async (handle) => {
              if (!(await devices.isActiveFor(handle, deviceId, ref.id)))
                throw new BrowserEndedMeanwhileError();
              if (await directory.isCredentialLocked(handle, ref)) throw new LockedMeanwhileError();
              if (examined.rehashed !== null && examined.verifiedHash !== null) {
                await directory.rehashCredential(
                  handle,
                  ref,
                  generation,
                  examined.verifiedHash,
                  examined.rehashed,
                );
              }
              await directory.clearFailedAttempts(handle, ref);
            },
          },
        ],
      });
    } catch (error) {
      const refuse = (
        cause: FailureCause,
        factor: FactorReached,
        answer: ApiException,
      ): Promise<never> =>
        commitThenRefuse(this.#options.unitOfWork, context, async (transaction) => {
          await this.#options.audit.write(
            transaction,
            failedEvent({ cause, factor, account: ref, typed }),
          );
          return answer;
        });
      if (error instanceof SessionIssueRefusedError)
        return refuse('INELIGIBLE_PRINCIPAL', 'NONE', invalidCredentials());
      if (error instanceof BrowserEndedMeanwhileError)
        return refuse('UNREGISTERED_BROWSER', 'NONE', invalidCredentials());
      if (error instanceof LockedMeanwhileError)
        return refuse('LOCKED_OUT', 'SECRET', credentialLocked());
      throw error;
    }
    return { session: issued, view: issued.view };
  }
}
