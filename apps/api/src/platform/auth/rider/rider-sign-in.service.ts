import { createHash } from 'node:crypto';

import { commitThenRefuse } from '../../audit/commit-then-refuse.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { runAdmitted } from '../../limiter/run-admitted.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import {
  parseDevicePublicKey,
  parseDeviceSignature,
  verifyDeviceSignature,
} from '../device-key/device-key-protocol.js';
import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type { HashAdmission } from '../ports/hash-admission.port.js';
import type { Hasher } from '../ports/hasher.port.js';
import type {
  IdentityDirectory,
  LockoutPolicy,
  PrincipalRef,
  PrincipalSummary,
} from '../ports/identity-directory.port.js';
import { CLIENT_ROOT_SIGNALS, type ClientRootSignal } from '../ports/session-store.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { currentSessionOf, type CurrentSessionView } from '../sessions/current-session.js';
import { SessionIssueRefusedError } from '../sessions/session-errors.js';
import type { IssuedSession, SessionIssuer } from '../sessions/session-issuer.js';
import { authenticationContext } from '../staff/authentication-context.js';
import { isCanonicalBase64Url32 } from './enrolment-uri.js';
import {
  deviceContextBinding,
  phoneBinding,
  RIDER_CHALLENGE_NO_RIDER,
  sameBinding,
} from './rider-challenge-binding.js';
import { RiderChallengeExpiredError } from './rider-challenge-errors.js';
import { judgeChallenge, type ChallengeJudgement } from './rider-challenge-judgement.js';
import type { RiderChallengeForDecision, RiderChallengeStore } from './rider-challenge-store.js';
import type { RiderDeviceStore } from './rider-device-store.js';
import { canonicalRiderPhone, isRiderPin } from './rider-vocabulary.js';

const MAX_ATTEMPTS_SETTING = 'signin_max_attempts';
const LOCKOUT_MINUTES_SETTING = 'signin_lockout_minutes';

/**
 * The answers of the sign-in, and nothing in them says which factor failed except where the contract gives a caller a code to act on
 * (SECURITY_DESIGN.md section 13.4b): the app is sent to its Device-blocked screen by `DEVICE_NOT_ENROLLED` and by nothing else.
 */
const unusable = (): ApiException =>
  ApiException.of(ErrorCode.ChallengeUnusable, 'This sign-in cannot be completed: start again');
const expired = (): ApiException =>
  ApiException.of(ErrorCode.ChallengeExpired, 'This sign-in has expired: start again');
const proofInvalid = (): ApiException =>
  ApiException.of(ErrorCode.DeviceProofInvalid, 'The device could not prove itself');
const notEnrolled = (): ApiException =>
  ApiException.of(ErrorCode.DeviceNotEnrolled, 'No device is enrolled for this rider');
const invalidCredentials = (): ApiException =>
  ApiException.of(
    ErrorCode.InvalidCredentials,
    'The phone number, the PIN or this device is not correct',
  );
const locked = (): ApiException =>
  ApiException.of(ErrorCode.CredentialLocked, 'The credential is locked: try again later');

function violation(pointer: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });
}

/** The closed sets of audit.md section 5.4 that the rider's sign-in uses. */
type FailureCause =
  | 'UNKNOWN_PRINCIPAL'
  | 'INELIGIBLE_PRINCIPAL'
  | 'WRONG_PIN'
  | 'DEVICE_PROOF_INVALID'
  | 'NO_ACTIVE_DEVICE'
  | 'LOCKED_OUT'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_UNUSABLE';
type FactorReached = 'PIN' | 'NONE';

/** A hash of a typed number and its kind, for the refusal that names no rider (audit.md section 5.4), never the text as typed. */
function identifierDigest(canonicalPhone: string): string {
  return createHash('sha256')
    .update(`melarc.audit.identifier.v1\u0000PHONE_NUMBER\u0000${canonicalPhone}`, 'utf8')
    .digest('hex');
}

/**
 * What a request can end in before it is a session, in the order the factors are decided (SECURITY_DESIGN.md section 13.4b, "the rider order"):
 * the branches are named for what happened, and each has one answer, one cause and one factor in `OUTCOMES`.
 */
type Branch =
  | 'CHALLENGE_UNUSABLE'
  | 'CHALLENGE_EXPIRED'
  | 'UNKNOWN_PHONE'
  | 'NO_DEVICE_WRONG_PIN'
  | 'NO_DEVICE_RIGHT_PIN'
  | 'BAD_PROOF'
  | 'INELIGIBLE'
  | 'LOCKED'
  | 'WRONG_PIN'
  | 'CORRECT';

type Refusal = Exclude<Branch, 'CORRECT'>;

interface Outcome {
  readonly cause: FailureCause;
  readonly factor: FactorReached;
  readonly answer: () => ApiException;
}

const OUTCOMES: Readonly<Record<Refusal, Outcome>> = {
  CHALLENGE_UNUSABLE: { cause: 'CHALLENGE_UNUSABLE', factor: 'NONE', answer: unusable },
  CHALLENGE_EXPIRED: { cause: 'CHALLENGE_EXPIRED', factor: 'NONE', answer: expired },
  // No proof can be checked for a number nobody holds, so the PIN is decided; for such a number it can only be wrong.
  UNKNOWN_PHONE: { cause: 'UNKNOWN_PRINCIPAL', factor: 'NONE', answer: proofInvalid },
  NO_DEVICE_WRONG_PIN: { cause: 'NO_ACTIVE_DEVICE', factor: 'NONE', answer: proofInvalid },
  // The one answer that tells a caller about the device, and only a caller who has proved the PIN.
  NO_DEVICE_RIGHT_PIN: { cause: 'NO_ACTIVE_DEVICE', factor: 'PIN', answer: notEnrolled },
  BAD_PROOF: { cause: 'DEVICE_PROOF_INVALID', factor: 'NONE', answer: proofInvalid },
  INELIGIBLE: { cause: 'INELIGIBLE_PRINCIPAL', factor: 'NONE', answer: invalidCredentials },
  LOCKED: { cause: 'LOCKED_OUT', factor: 'PIN', answer: locked },
  WRONG_PIN: { cause: 'WRONG_PIN', factor: 'PIN', answer: invalidCredentials },
};

export interface RiderSignInOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: IdentityDirectory;
  readonly devices: Pick<RiderDeviceStore, 'activeKeyFor' | 'isActiveFor'>;
  readonly challenges: RiderChallengeStore;
  readonly tokens: Pick<TokenService, 'hash'>;
  readonly hasher: Hasher;
  readonly hashAdmission: HashAdmission;
  readonly issuer: Pick<SessionIssuer, 'issue'>;
  readonly audit: AuditWriter;
  readonly settings: Pick<SettingsReader, 'integer'>;
  /** The environment and service a challenge is issued for (`riderChallengeAudience`): a challenge carried to another one is unusable. */
  readonly audience: string;
}

/** What the handset sent, validated in form. The challenge and the signature are in their one canonical spelling. */
export interface RiderSignInRequest {
  readonly phone: string;
  readonly pin: string;
  readonly challenge: string;
  readonly deviceSignature: string;
  readonly clientRootSignal: ClientRootSignal;
}

export interface RiderSignInOutcome {
  readonly session: IssuedSession<CurrentSessionView>;
  readonly view: CurrentSessionView;
}

/** What the lookup and the one derivation found: the branch of the contract's order the request ended in. */
interface Examined {
  readonly branch: Branch;
  readonly challenge: RiderChallengeForDecision | null;
  readonly rider: PrincipalSummary | null;
  readonly deviceId: string | null;
  readonly policy: LockoutPolicy;
  readonly rehashed: string | null;
  readonly verifiedHash: string | null;
}

/** The challenge was spent, or lapsed, between the examination and the issue. */
class ChallengeSpentError extends Error {
  constructor() {
    super('The challenge was consumed or ended while the sign-in was in flight');
    this.name = 'ChallengeSpentError';
  }
}

/** The registered device was revoked or replaced while the sign-in was in flight: its key no longer stands. */
class DeviceEndedMeanwhileError extends Error {
  constructor() {
    super('The registered device was ended while the sign-in was in flight');
    this.name = 'DeviceEndedMeanwhileError';
  }
}

/** The lock was set by another request while this one was being verified: answered as a request inside a lock, and it clears nothing. */
class LockedMeanwhileError extends Error {
  constructor() {
    super('The credential was locked while the sign-in was in flight');
    this.name = 'LockedMeanwhileError';
  }
}

/**
 * `riderSignIn` (S0.59b and S0.59c; rider-authentication.md sections 4.1, 5.1, 5.3 and 5.5; SECURITY_DESIGN.md sections 13.4b, 13.6 and 13.8a):
 * the registered phone, the private PIN and the registered device's signature over a fresh challenge, all required. **No device is nominated**:
 * the server resolves the rider's sole `ACTIVE` device and verifies the signature against its key.
 *
 * **The order is the contract's**, after the rate limit (keyed in the guard on the canonical number) and the schema:
 * (1) **the challenge**: unknown, consumed or bound to another number, service or purpose is `CHALLENGE_UNUSABLE`, a lapsed one is
 * `CHALLENGE_EXPIRED`, and **any other request consumes it, pass or fail**; (2) a rider with an `ACTIVE` device is held to a valid signature
 * (and to the device the challenge was issued for): failing it is `DEVICE_PROOF_INVALID`, **the PIN is never looked at and nothing is
 * counted**; (3) a number that is unknown, or a rider with no `ACTIVE` device, offers no proof, so the PIN is decided instead: wrong is
 * `DEVICE_PROOF_INVALID` and right is `DEVICE_NOT_ENROLLED`, nothing counted; (4) with a valid signature, a status other than `ACTIVE` is
 * `INVALID_CREDENTIALS`, nothing counted and no lock announced; (5) a locked PIN is `CREDENTIAL_LOCKED`, neither verified nor counted; (6) a
 * wrong PIN is `INVALID_CREDENTIALS` and counts, by the one atomic conditional update of the staff sign-in; a correct one resets the count and
 * issues the session.
 *
 * - **One hash slot first, then one derivation for every request admitted to it** (against the real hash only when the PIN was reached or is
 *   the deciding factor, against the dummy otherwise), so timing does not say which stage ended it; a request with no slot is `RATE_LIMITED`,
 *   derives nothing and counts nowhere. The reads before the derivation are the same statements on every branch.
 * - **The challenge is ended in the transaction of the outcome** (identity lock first where a count follows, the challenge second, the order of
 *   the session issue): a refusal commits it with its bookkeeping before it is answered (`commitThenRefuse`), and a session commits it with the
 *   session. Two requests that present one challenge take turns, and the second finds it spent.
 * - **A correct PIN issues the session through the S0.24 protocol**, which ends the rider's earlier session (`REPLACED_BY_NEW_SESSION`) and
 *   records the device and the root signal; under the rider's lock the device is judged again, a lock set meanwhile is honoured, a stronger hash
 *   replaces the stored one and the count is cleared, in the transaction of the session. The root signal is recorded and **never decides**.
 * - **The events name the rider, never a person's number**, and hold no PIN, signature, nonce or token.
 */
export class RiderSignInService {
  readonly #options: RiderSignInOptions;

  constructor(options: RiderSignInOptions) {
    this.#options = options;
  }

  async signIn(request: RiderSignInRequest): Promise<RiderSignInOutcome> {
    const context = authenticationContext();
    // What is not a possible request is refused before anything else: it met no limit and does no work.
    const canonical = canonicalRiderPhone(request.phone);
    if (canonical === undefined) throw violation('/phone', 'format');
    if (!isRiderPin(request.pin)) throw violation('/pin', 'format');
    if (!isCanonicalBase64Url32(request.challenge)) throw violation('/challenge', 'format');
    const signature = parseDeviceSignature(request.deviceSignature);
    if (signature === null) throw violation('/device_signature', 'format');
    if (!(CLIENT_ROOT_SIGNALS as readonly string[]).includes(request.clientRootSignal)) {
      throw violation('/client_root_signal', 'enum');
    }
    const input: Input = { ...request, canonical, signature };

    const slot = await runAdmitted(this.#options.hashAdmission, () =>
      this.#examine(context, input),
    );
    if (!slot.admitted) throw ApiException.of(ErrorCode.RateLimited, 'Too many requests');
    const examined = slot.value;
    if (examined.branch === 'CORRECT') return this.#session(context, input, examined);
    return this.#settle(context, input, examined, examined.branch);
  }

  /**
   * The reads, then the signature, then the one derivation. The reads are the same statements whatever they find (the nil identifier names no
   * rider and finds no device, no lock and no hash), so what the database was asked does not tell an unknown number from a rider; the
   * signature is cheap and is checked on every branch that has a key; and the derivation is real only where the PIN decides the answer.
   */
  async #examine(context: SecurityContext, input: Input): Promise<Examined> {
    const { unitOfWork, directory, devices, challenges, tokens, hasher, settings, audience } =
      this.#options;
    const nonceHash = tokens.hash(input.challenge);
    if (nonceHash === null) throw new Error('A canonical challenge has no hash');
    const found = await unitOfWork.run(context, async (transaction) => {
      const challenge = await challenges.findByNonceHash(transaction, nonceHash);
      const rider = await directory.findRiderByCanonicalPhone(transaction, input.canonical);
      const ref: PrincipalRef = { type: 'RIDER', id: rider?.ref.id ?? RIDER_CHALLENGE_NO_RIDER };
      const device = await devices.activeKeyFor(transaction, ref.id);
      const isLocked = await directory.isCredentialLocked(transaction, ref);
      const policy: LockoutPolicy = {
        maxAttempts: await settings.integer(transaction, MAX_ATTEMPTS_SETTING),
        lockoutMinutes: await settings.integer(transaction, LOCKOUT_MINUTES_SETTING),
      };
      const hash = await directory.readCredentialHash(transaction, ref);
      return { challenge, rider, device, isLocked, policy, hash };
    });
    const { challenge, rider, device, isLocked, policy, hash } = found;
    const none = (branch: Refusal): Examined => ({
      branch,
      challenge,
      rider,
      deviceId: device?.deviceId ?? null,
      policy,
      rehashed: null,
      verifiedHash: null,
    });
    const dummy = (): Promise<void> => hasher.verifyAgainstDummy('RIDER_PIN', input.pin);

    // (1) The challenge, judged on the database's clock; whatever follows, a live one is ended by this presentation.
    const judgement = judgeChallenge(challenge, {
      phoneHash: phoneBinding(input.canonical),
      audience,
    });
    if (judgement.outcome !== 'LIVE') {
      await dummy();
      return none(judgement.outcome === 'EXPIRED' ? 'CHALLENGE_EXPIRED' : 'CHALLENGE_UNUSABLE');
    }

    // (3) No proof can be checked for a number nobody holds, nor for a rider with no ACTIVE device: the PIN decides.
    if (rider === null) {
      await dummy();
      return none('UNKNOWN_PHONE');
    }
    if (device === null) {
      if (hash === null) {
        await dummy();
        return none('NO_DEVICE_WRONG_PIN');
      }
      const verdict = await hasher.verify('RIDER_PIN', input.pin, hash);
      return none(verdict.matches ? 'NO_DEVICE_RIGHT_PIN' : 'NO_DEVICE_WRONG_PIN');
    }

    // (2) The rider has an ACTIVE device: the signature must verify against its key, over this challenge, and the challenge must be the one
    // issued for this device. Both are computed so that the work does not depend on the first.
    const key = parseDevicePublicKey(device.publicKey);
    if (!key.ok) throw new Error('The registered key of a device is not a canonical P-256 key');
    const signatureHolds = verifyDeviceSignature(key.key, input.challenge, input.signature);
    const contextHolds =
      challenge !== null &&
      sameBinding(challenge.challenge.deviceContextHash, deviceContextBinding(device.deviceId));
    if (!signatureHolds || !contextHolds) {
      await dummy();
      return none('BAD_PROOF');
    }

    // (4) A valid signature and a status other than ACTIVE (or a rider who holds no PIN to lock or to prove): the factor is not reached.
    if (rider.status !== 'ACTIVE' || rider.credentialGeneration < 1 || hash === null) {
      await dummy();
      return none('INELIGIBLE');
    }
    // (5) A locked PIN is announced to the one who holds the registered handset; it is neither verified nor counted.
    if (isLocked) {
      await dummy();
      return none('LOCKED');
    }
    // (6) The PIN.
    const verdict = await hasher.verify('RIDER_PIN', input.pin, hash);
    if (!verdict.matches) return none('WRONG_PIN');
    const rehashed = verdict.needsRehash ? await hasher.hash('RIDER_PIN', input.pin) : null;
    return {
      branch: 'CORRECT',
      challenge,
      rider,
      deviceId: device.deviceId,
      policy,
      rehashed,
      verifiedHash: hash,
    };
  }

  /**
   * A refusal and its bookkeeping, in one transaction that commits before the answer: the challenge is judged again under its lock and ended
   * (this presentation ends it, pass or fail), then the branch's events and, for a wrong PIN, the count. A challenge that is no longer live
   * under the lock (another request presented it first, or its time has passed) is answered as that, and **nothing is counted**: a replay is
   * no attempt. The identity is locked before the challenge wherever a count follows, the order of the session issue.
   */
  async #settle(
    context: SecurityContext,
    input: Input,
    examined: Examined,
    branch: Refusal,
  ): Promise<never> {
    const { unitOfWork } = this.#options;
    try {
      return await commitThenRefuse(unitOfWork, context, (transaction) =>
        this.#settleIn(transaction, input, examined, branch),
      );
    } catch (error) {
      // The challenge lapsed between the judgement under the lock and the consumption, and the table's guard refused it: the transaction
      // has rolled back whole and the request is answered, in a transaction of its own, as what it is (expired).
      if (!(error instanceof RiderChallengeExpiredError)) throw error;
      return commitThenRefuse(unitOfWork, context, (transaction) =>
        this.#settleIn(transaction, input, examined, branch),
      );
    }
  }

  async #settleIn(
    transaction: TransactionHandle,
    input: Input,
    examined: Examined,
    branch: Refusal,
  ): Promise<Error> {
    const { directory, challenges, audience } = this.#options;
    const rider = examined.rider === null ? null : examined.rider.ref;
    // A count follows only a wrong PIN: its identity is locked first, so that it takes turns with a session issue and never waits in a cycle.
    const counting = branch === 'WRONG_PIN' && examined.rider !== null;
    const identity =
      counting && rider !== null ? await directory.lockIdentity(transaction, rider) : null;

    let outcome: Outcome = OUTCOMES[branch];
    const found = examined.challenge;
    if (found !== null) {
      const decided = await challenges.lockForDecision(transaction, found.challenge.id);
      const judgement: ChallengeJudgement = judgeChallenge(decided, {
        phoneHash: phoneBinding(input.canonical),
        audience,
      });
      if (judgement.outcome !== 'LIVE') {
        // Presented first by another request, lapsed, or not the one this request was bound to: answered as that, and counted nowhere.
        if (judgement.end !== null) {
          await challenges.end(transaction, found.challenge.id, judgement.end);
        }
        const gone: Refusal =
          judgement.outcome === 'EXPIRED' ? 'CHALLENGE_EXPIRED' : 'CHALLENGE_UNUSABLE';
        return this.#record(transaction, input, rider, found, OUTCOMES[gone], null);
      }
      // A live challenge ends with this presentation, whatever the presentation was. The row is locked, so the only thing that can stop the
      // consumption is the clock: the time passed between the judgement and the statement, and the request is answered as expired.
      if (!(await challenges.consume(transaction, found.challenge.id))) {
        await challenges.end(transaction, found.challenge.id, 'EXPIRED');
        return this.#record(transaction, input, rider, found, OUTCOMES.CHALLENGE_EXPIRED, null);
      }
    } else if (branch !== 'CHALLENGE_UNUSABLE') {
      // The examination found a challenge it judged live and none is there now: nothing removes a challenge, so this is a defect.
      throw new Error('A challenge that was judged live is not there');
    }

    if (!counting || rider === null) {
      return this.#record(transaction, input, rider, found, outcome, examined.deviceId);
    }

    // The wrong PIN: judged again under the identity's lock, then counted against the PIN of the generation that was verified.
    if (
      identity?.status !== 'ACTIVE' ||
      identity.credentialGeneration !== examined.rider.credentialGeneration
    ) {
      outcome = OUTCOMES.INELIGIBLE;
      return this.#record(transaction, input, rider, found, outcome, examined.deviceId);
    }
    const counted = await directory.recordFailedAttempt(
      transaction,
      rider,
      examined.rider.credentialGeneration,
      examined.policy,
    );
    if (!counted.counted) {
      outcome = counted.reason === 'STALE' ? OUTCOMES.INELIGIBLE : OUTCOMES.LOCKED;
      return this.#record(transaction, input, rider, found, outcome, examined.deviceId);
    }
    const answer = await this.#record(transaction, input, rider, found, outcome, examined.deviceId);
    if (counted.tipped) {
      // One event per lock, written by the update that set it, and never what was typed.
      await this.#options.audit.write(transaction, {
        code: 'auth.lockout.applied',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'RiderIdentity', id: rider.id },
        detail: { factor: 'PIN', locked_until: counted.lockedUntil.toISOString() },
      });
    }
    return answer;
  }

  /** The events of one refusal, and the answer for it. */
  async #record(
    transaction: TransactionHandle,
    input: Input,
    rider: PrincipalRef | null,
    found: RiderChallengeForDecision | null,
    outcome: Outcome,
    deviceId: string | null,
  ): Promise<ApiException> {
    const { audit } = this.#options;
    await audit.write(
      transaction,
      failedEvent({ outcome, rider, found, canonical: input.canonical }),
    );
    if (outcome.cause === 'DEVICE_PROOF_INVALID' && deviceId !== null && rider !== null) {
      // A failed signature is also the specific record of it (audit.md section 5.4), in addition to the uniform one.
      await audit.write(transaction, {
        code: 'auth.device.proof_failed',
        enhanced: false,
        outcome: 'REJECTED',
        object: { type: 'RegisteredDevice', id: deviceId },
        relatedIds: {
          principal_id: rider.id,
          ...(found === null ? {} : { challenge_id: found.challenge.id }),
        },
      });
    }
    return outcome.answer();
  }

  /** The correct PIN, turned into the session; the proofs it spends commit with it, and what a race lost is answered as what it is. */
  async #session(
    context: SecurityContext,
    input: Input,
    examined: Examined,
  ): Promise<RiderSignInOutcome> {
    const { directory, devices, challenges, issuer } = this.#options;
    const rider = examined.rider;
    const deviceId = examined.deviceId;
    const challenge = examined.challenge;
    if (rider === null || deviceId === null || challenge === null) {
      throw new Error('A correct PIN was judged for a rider, a device and a challenge');
    }
    const ref = rider.ref;
    const generation = rider.credentialGeneration;
    let issued: IssuedSession<CurrentSessionView>;
    try {
      issued = await issuer.issue({
        principal: ref,
        correlationId: context.correlationId,
        verifiedCredentialGeneration: generation,
        registeredDeviceId: deviceId,
        clientRootSignal: input.clientRootSignal,
        // The view is built in the issuing transaction: one that cannot be built takes the session, the challenge and the count it cleared back
        // with it.
        project: (handle, session) => currentSessionOf(handle, session, directory),
        steps: [
          {
            name: 'the challenge is consumed, the device stands, a lock set meanwhile is honoured, and a complete sign-in clears the count',
            run: async (handle) => {
              // The challenge first among the proofs: spent by another request, or lapsed, it ends this sign-in (the guard raises the lapse).
              if (!(await challenges.consume(handle, challenge.challenge.id))) {
                throw new ChallengeSpentError();
              }
              if (!(await devices.isActiveFor(handle, deviceId, ref.id))) {
                throw new DeviceEndedMeanwhileError();
              }
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
      // Each of these rolled the issue back whole: the challenge is unspent, the session is not there, the count is as it was. The request is
      // then answered as what it lost, with the challenge ended and the events written in a transaction of its own.
      if (error instanceof ChallengeSpentError || error instanceof RiderChallengeExpiredError) {
        return this.#settle(context, input, examined, 'CHALLENGE_UNUSABLE');
      }
      if (error instanceof DeviceEndedMeanwhileError) {
        return this.#settle(context, input, examined, 'BAD_PROOF');
      }
      if (error instanceof LockedMeanwhileError) {
        return this.#settle(context, input, examined, 'LOCKED');
      }
      if (error instanceof SessionIssueRefusedError) {
        return this.#settle(context, input, examined, 'INELIGIBLE');
      }
      throw error;
    }
    return { session: issued, view: issued.view };
  }
}

/** The request after its form was checked: the canonical number and the decoded signature beside what was sent. */
interface Input extends RiderSignInRequest {
  readonly canonical: string;
  readonly signature: Buffer;
}

function failedEvent(input: {
  readonly outcome: Outcome;
  readonly rider: PrincipalRef | null;
  readonly found: RiderChallengeForDecision | null;
  readonly canonical: string;
}): AuditEventInput {
  const { outcome, rider, found, canonical } = input;
  return {
    code: 'auth.session.failed',
    enhanced: false,
    outcome: 'REJECTED',
    object: { type: 'RiderIdentity', id: rider?.id ?? null },
    ...(found === null ? {} : { relatedIds: { challenge_id: found.challenge.id } }),
    detail: {
      cause: outcome.cause,
      factor: outcome.factor,
      ...(rider === null
        ? { identifier_kind: 'PHONE_NUMBER', identifier_digest: identifierDigest(canonical) }
        : {}),
    },
  };
}
