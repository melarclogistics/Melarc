import { commitThenRefuse } from '../../audit/commit-then-refuse.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import { runAdmitted } from '../../limiter/run-admitted.js';
import { parseDevicePublicKey } from '../device-key/device-key-protocol.js';
import { AttestationInterfaceError } from '../attestation/attestation-errors.js';
import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type {
  AttestationSummary,
  AttestationUnavailableCause,
  AttestationVerifier,
} from '../ports/attestation-verifier.port.js';
import type { HashAdmission } from '../ports/hash-admission.port.js';
import type { Hasher } from '../ports/hasher.port.js';
import type { IdentityDirectory, PrincipalRef } from '../ports/identity-directory.port.js';
import type { SessionStore } from '../ports/session-store.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import { SetupGrantExpiredError } from '../setup-grants/setup-grant-errors.js';
import type { SetupGrantStore, StoredGrant } from '../setup-grants/setup-grant-store.js';
import {
  RIDER_DEVICE_PURPOSES,
  type RiderDeviceGrantPurpose,
} from '../setup-grants/setup-grant-vocabulary.js';
import { authenticationContext } from '../staff/authentication-context.js';
import {
  RIDER_DEVICE_KIND,
  DEVICE_BINDABLE_RIDER_STATUSES,
  isRiderPin,
} from './rider-vocabulary.js';
import type {
  RiderDeviceFacts,
  RiderDeviceRecord,
  RiderDeviceStore,
} from './rider-device-store.js';

/**
 * How long a handset is told to wait before it completes the same enrolment again after `TRUST_DATA_UNAVAILABLE`, in whole seconds
 * (`Retry-After`, the contract's `TrustDataUnavailable`). **No document states a figure**: the contract and the design say "shortly" and that
 * the grant is still good, so this is an engineering parameter and a finding for the Product Owner (plan section 7.47). One minute is
 * short enough for a ceremony in the officer's presence and long enough not to stand a queue of handsets on a verifier that is overloaded;
 * the grant lasts 30 minutes, and the verifier retries a failed load every 15 (`VERIFIER_RETRY_MINUTES`).
 */
export const TRUST_DATA_RETRY_AFTER_SECONDS = 60;

const invalidGrant = (): ApiException =>
  ApiException.of(ErrorCode.SetupGrantInvalid, 'The setup link is not valid');
const limited = (): ApiException => ApiException.of(ErrorCode.RateLimited, 'Too many requests');
const unavailable = (): ApiException =>
  ApiException.of(
    ErrorCode.TrustDataUnavailable,
    'The device could not be checked just now; try the same enrolment again shortly',
    undefined,
    { 'Retry-After': String(TRUST_DATA_RETRY_AFTER_SECONDS) },
  );

/** The two bounds of the contract that its schema cannot say, named as the schema names its own (`format`, `pattern`). */
function invalidBody(pointer: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });
}

export interface RiderEnrolmentOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: IdentityDirectory;
  readonly grants: SetupGrantStore;
  readonly devices: RiderDeviceStore;
  readonly sessions: SessionStore;
  readonly verifier: AttestationVerifier;
  readonly tokens: Pick<TokenService, 'hash'>;
  readonly hasher: Hasher;
  readonly hashAdmission: HashAdmission;
  readonly audit: AuditWriter;
  /**
   * Where the closed cause of an unavailable verifier goes (the structured log): it is never in the response and it is no audit event,
   * because nothing was decided about the device (SECURITY_DESIGN.md §15.2.3). The counter is the adapter's.
   */
  readonly onUnavailable?: (cause: AttestationUnavailableCause) => void;
}

export interface RiderEnrolmentRequest {
  readonly setupToken: string;
  /** The canonical standard base64 of the 91-byte DER SubjectPublicKeyInfo of the handset's key. */
  readonly publicKey: string;
  readonly pin: string;
  /** The Android key attestation chain, leaf first, 1 to 10 certificates as base64 DER. */
  readonly certificateChain: readonly string[];
}

/** A grant that can be acted on at all: there, `PENDING`, a rider's, and of one of the two rider purposes. */
function usable(grant: StoredGrant | null): grant is StoredGrant & {
  readonly purpose: RiderDeviceGrantPurpose;
} {
  return (
    grant !== null &&
    grant.state === 'PENDING' &&
    grant.principalType === 'RIDER' &&
    (RIDER_DEVICE_PURPOSES as readonly string[]).includes(grant.purpose)
  );
}

/**
 * Whether the rider's devices are what the purpose of the grant assumes: the first binding is for a rider who has held none that is `ACTIVE` or
 * `REVOKED` (a revoked rider is bound again by a replacement alone), and a replacement is for a rider who has one of the two. The table's guard
 * holds the same when a grant is issued; this holds it when one is used, because the rider's devices can change in between.
 */
export function deviceStateAllows(
  purpose: RiderDeviceGrantPurpose,
  facts: Pick<RiderDeviceFacts, 'activeDeviceId' | 'revokedDevices'>,
): boolean {
  const held = facts.activeDeviceId !== null || facts.revokedDevices > 0;
  return purpose === 'RIDER_DEVICE_ENROLMENT' ? !held : held;
}

const bindable = (status: string): boolean =>
  (DEVICE_BINDABLE_RIDER_STATUSES as readonly string[]).includes(status);

/** The first sixteen hexadecimal characters of a signing-certificate digest: enough to tell one certificate from another, not the digest. */
const fingerprintOf = (digest: string): string => digest.slice(0, 16);

/** What `auth.device.registered` records of the verified attestation (audit.md §5.4): never the chain, the challenge or the grant. */
function attestationFacts(summary: AttestationSummary): Record<string, string | number | boolean> {
  return {
    attested: true,
    security_level: summary.securityLevel,
    attestation_version: summary.attestationVersion,
    key_mint_version: summary.keyMintVersion,
    // A verdict of `VERIFIED` is one that passed step 8 of the policy, so these two are what it means and not a reading of the evidence.
    verified_boot_state: 'VERIFIED',
    device_locked: true,
    package_name: summary.packageName,
    // In one order whatever the verifier's: the record of a binding does not depend on how a set was walked.
    signer_fingerprints: summary.signerDigests.map(fingerprintOf).toSorted().join(','),
  };
}

/**
 * `completeRiderDeviceEnrolment` (S0.57; rider-authentication.md sections 4.2 and 4.3; SECURITY_DESIGN.md sections 13.6 and 15.2): the handset
 * submits the public half of the key it made, the PIN its rider chose and the attestation of the key, and the grant from the QR the officer's
 * screen showed. One operation for the first binding and the replacement, because the act is the same. **No session is issued.**
 *
 * - **The order is the contract's.** The two bounds the schema cannot say (a key that is not a canonical P-256 key, a PIN that is not six digits)
 *   come first, as the schema's own do; then a short look at the grant, which costs a lookup and reads no evidence: a grant that is unknown,
 *   spent, superseded, lapsed, another purpose's or for a rider that cannot be given a device is `SETUP_GRANT_INVALID` and **the verifier is not
 *   called** (`AC-SLICE-000-67`). Only then is the evidence evaluated, **outside any transaction**, and only a `VERIFIED` verdict is followed by a
 *   hash of the PIN (a refused handset costs the API no Argon2id) and by the one transaction that changes anything.
 * - **A verdict the verifier gave is never relabelled.** `DEVICE_INTEGRITY_FAILED` and `DEVICE_SECURITY_UNSUPPORTED` are answered as they were
 *   given, after an `auth.device.attestation_failed` event is committed (its own transaction, written only for a grant that is still good); a
 *   verifier that could not decide is `TRUST_DATA_UNAVAILABLE` with a `Retry-After` and **writes nothing at all**, the grant untouched
 *   (`AC-SLICE-000-69`). A verifier that breaks its interface, or says `VERIFIED` for another key than the one it was asked about, is a defect
 *   (`AttestationInterfaceError`, a `500` that is alerted) and never a verdict about the device.
 * - **The change is one transaction under the rider's lock** (lock order: identity, then grant): the rider and the grant are read again and
 *   judged on the database's clock, the rider's devices are counted again against the purpose, the grant is consumed, an `ACTIVE` device is
 *   ended as `REPLACED` with its live session `DEVICE_REPLACED` (a `REVOKED` device stays revoked), the new device is registered `ACTIVE`, the PIN
 *   is set (or replaced, with its failed-attempt count cleared) and the events are written. A refusal at any point rolls all of it back, so a
 *   refused replacement leaves the old device exactly as it was (`AC-SLICE-000-72`), and two handsets presenting one grant take turns on the
 *   rider's lock, of which the second finds the grant consumed (`AC-SLICE-000-73`).
 * - **Nothing secret is kept or written.** The chain is not stored by value and nothing of it, the challenge, the PIN or the key's private half is
 *   logged, audited or returned; the events record the verified summary (security level, package, fingerprints of the signing certificates) and
 *   the officer who authorised the binding.
 */
export class RiderEnrolmentService {
  readonly #options: RiderEnrolmentOptions;

  constructor(options: RiderEnrolmentOptions) {
    this.#options = options;
  }

  async complete(request: RiderEnrolmentRequest): Promise<RiderDeviceRecord> {
    const { tokens, verifier, hasher, hashAdmission } = this.#options;
    const context = authenticationContext();

    // The contract's own bounds, judged before the grant as the schema's are: a refusal of the key or the PIN is `VALIDATION_FAILED` whatever the
    // grant is, and consumes nothing. The key is held to its one canonical spelling by the crypto stack, and compared with the attested one by it.
    const key = parseDevicePublicKey(request.publicKey);
    if (!key.ok) throw invalidBody('/public_key', 'format');
    if (!isRiderPin(request.pin)) throw invalidBody('/pin', 'pattern');
    const hash = tokens.hash(request.setupToken);
    if (hash === null) throw invalidGrant();

    const look = await this.#look(context, hash);

    const verdict = await verifier.verify({
      expectedChallengeSha256: look.challengeHash,
      certificateChain: request.certificateChain,
      devicePublicKey: key.canonical,
    });
    switch (verdict.verdict) {
      case 'TRUST_DATA_UNAVAILABLE':
        this.#options.onUnavailable?.(verdict.cause);
        throw unavailable();
      case 'DEVICE_SECURITY_UNSUPPORTED':
        return this.#refused(context, hash, look.riderId, 'DEVICE_SECURITY_UNSUPPORTED', null);
      case 'DEVICE_INTEGRITY_FAILED':
        return this.#refused(context, hash, look.riderId, 'DEVICE_INTEGRITY_FAILED', verdict.cause);
      case 'VERIFIED':
        break;
    }
    // The verifier was told which key to expect and answers `VERIFIED` only for it: another key, or one that is not a canonical key at all, is an
    // answer that breaks the interface, whatever the adapter is, and is never enrolled.
    const attested = parseDevicePublicKey(verdict.attestedPublicKey);
    if (!attested.ok || !attested.key.equals(key.key)) {
      throw new AttestationInterfaceError('attested_public_key');
    }

    const hashed = await runAdmitted(hashAdmission, () => hasher.hash('RIDER_PIN', request.pin));
    if (!hashed.admitted) throw limited();
    const encodedHash = hashed.value;

    return this.#act(context, async (transaction) => {
      const { directory, grants, devices, sessions } = this.#options;
      const found = await grants.findLiveByTokenHash(transaction, hash);
      if (!usable(found)) throw invalidGrant();
      const ref: PrincipalRef = { type: 'RIDER', id: found.principalId };

      // The rider's authority, judged under the identity lock: a rider whose access has ended is given no device.
      const identity = await directory.lockIdentity(transaction, ref);
      if (identity === null || !bindable(identity.status)) throw invalidGrant();
      // The grant is locked and judged again on the time after any wait for the identity's lock; the rider's devices are counted again, under
      // the same lock, against the purpose the grant was issued for.
      const live = await grants.lockLive(transaction, hash);
      if (!usable(live)) throw invalidGrant();
      const facts = await devices.factsFor(transaction, ref.id);
      if (!deviceStateAllows(live.purpose, facts)) throw invalidGrant();

      const consumed = await grants.consume(transaction, {
        principal: ref,
        purpose: live.purpose,
        token: request.setupToken,
      });
      if (consumed === null) throw invalidGrant();

      // The old device first, so that the rider never holds two `ACTIVE` ones (the table would refuse the second in any case): an `ACTIVE` device
      // becomes `REPLACED` and the session it carried ends `DEVICE_REPLACED` in this transaction. A `REVOKED` device is left as it is.
      let replacedDevice: RiderDeviceRecord | null = null;
      let endedSessions: readonly string[] = [];
      if (facts.activeDeviceId !== null) {
        replacedDevice = await devices.replace(transaction, facts.activeDeviceId, ref.id);
        if (replacedDevice === null) {
          throw new Error('A rider’s active device could not be ended under the rider’s lock');
        }
        endedSessions = await sessions.terminate(
          transaction,
          { by: 'device', registeredDeviceId: replacedDevice.id },
          'DEVICE_REPLACED',
        );
      }
      const device = await devices.register(transaction, {
        riderId: ref.id,
        publicKey: key.canonical,
        registeredBy: consumed.issuedBy,
      });

      // The PIN the rider chose, on the handset: established the first time, replaced after (its generation raised, its count cleared).
      const first = identity.credentialGeneration === 0;
      const pin = first
        ? await directory.establishCredential(transaction, ref, encodedHash)
        : await directory.replaceCredential(transaction, ref, encodedHash);
      if (pin === null) throw new Error('A rider’s PIN could not be set under the rider’s lock');

      const hub = identity.authorizedHubIds[0];
      const event = (input: AuditEventInput): Promise<void> =>
        this.#options.audit.write(transaction, {
          actor: { type: 'RIDER', id: ref.id },
          ...(hub === undefined ? {} : { responsibleHubId: hub }),
          ...input,
        });
      const authorisedBy = consumed.issuedBy;
      await event({
        code: 'auth.setup_grant.consumed',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'SetupGrant', id: consumed.id },
        previousState: 'PENDING',
        resultingState: 'CONSUMED',
        relatedIds: { principal_id: ref.id },
        detail: { purpose: consumed.purpose, principal_type: 'RIDER' },
      });
      await event({
        code: 'auth.credential.changed',
        enhanced: false,
        outcome: 'SUCCEEDED',
        object: { type: 'RiderIdentity', id: ref.id },
        beforeAfter: {
          credential_generation: { before: identity.credentialGeneration, after: pin.generation },
        },
        relatedIds: { principal_id: ref.id, setup_grant_id: consumed.id },
        detail: { cause: first ? 'ENROLMENT' : 'REPLACEMENT', credential_kind: 'RIDER_PIN' },
      });
      await event({
        code: 'auth.device.registered',
        enhanced: true,
        outcome: 'SUCCEEDED',
        object: { type: 'RegisteredDevice', id: device.id },
        resultingState: 'ACTIVE',
        beforeAfter: { status: { before: null, after: 'ACTIVE' } },
        relatedIds: {
          principal_id: ref.id,
          setup_grant_id: consumed.id,
          authorised_by: authorisedBy,
          ...(replacedDevice === null ? {} : { replaces_device_id: replacedDevice.id }),
        },
        detail: {
          device_kind: RIDER_DEVICE_KIND,
          purpose: consumed.purpose,
          ...attestationFacts(verdict.summary),
        },
      });
      if (replacedDevice !== null) {
        await event({
          code: 'auth.device.replaced',
          enhanced: true,
          outcome: 'SUCCEEDED',
          object: { type: 'RegisteredDevice', id: replacedDevice.id },
          previousState: 'ACTIVE',
          resultingState: 'REPLACED',
          beforeAfter: { status: { before: 'ACTIVE', after: 'REPLACED' } },
          relatedIds: {
            principal_id: ref.id,
            new_device_id: device.id,
            setup_grant_id: consumed.id,
            authorised_by: authorisedBy,
            ended_session_ids: [...endedSessions],
          },
          detail: { device_kind: RIDER_DEVICE_KIND, sessions_ended: endedSessions.length },
        });
        for (const sessionId of endedSessions) {
          await event({
            code: 'auth.session.terminated',
            enhanced: false,
            enhancedBasis: 'ROUTINE_TERMINATION',
            outcome: 'SUCCEEDED',
            object: { type: 'Session', id: sessionId },
            reason: { code: 'DEVICE_REPLACED', label: 'The handset was replaced' },
            relatedIds: { registered_device_id: replacedDevice.id },
          });
        }
      }
      return device;
    });
  }

  /**
   * The cheap look before any evidence is read: the grant is live (judged on the database's clock), is one of the two rider purposes, names a
   * rider who can be given a device and whose devices are what the purpose assumes, and carries the hash of the challenge the evidence must
   * answer. It locks nothing and decides nothing for good (the transaction of the act reads everything again under the lock); what it spares is
   * the verifier, so that a made-up or spent token costs a lookup and nothing is evaluated for it.
   */
  async #look(
    context: SecurityContext,
    hash: Uint8Array,
  ): Promise<{ readonly riderId: string; readonly challengeHash: Uint8Array }> {
    const { unitOfWork, grants, directory, devices } = this.#options;
    const found = await unitOfWork.run(context, async (transaction) => {
      const grant = await grants.findLiveByTokenHash(transaction, hash);
      if (!usable(grant)) return null;
      const challengeHash = await grants.attestationChallengeHashOf(transaction, hash);
      if (challengeHash === null) return null;
      const ref: PrincipalRef = { type: 'RIDER', id: grant.principalId };
      const identity = await directory.readIdentity(transaction, ref);
      if (identity === null || !bindable(identity.status)) return null;
      if (!deviceStateAllows(grant.purpose, await devices.factsFor(transaction, ref.id))) {
        return null;
      }
      return { riderId: ref.id, challengeHash };
    });
    if (found === null) throw invalidGrant();
    return found;
  }

  /**
   * The refusal of evidence the verifier evaluated and rejected: `auth.device.attestation_failed` is committed in a transaction of its own
   * (`commitThenRefuse`: the event must survive the refusal, so that a rate of them shows) and the verdict is answered after the commit, as the
   * verifier gave it. It is written against a grant that is still good; a grant that ended while the verifier worked is answered as every grant
   * that cannot be used, with nothing recorded. Nothing else changes: no device, no grant consumed, no PIN set, the old device untouched.
   */
  #refused(
    context: SecurityContext,
    hash: Uint8Array,
    riderId: string,
    outcome: 'DEVICE_SECURITY_UNSUPPORTED' | 'DEVICE_INTEGRITY_FAILED',
    cause: string | null,
  ): Promise<never> {
    const { unitOfWork, grants, directory, audit } = this.#options;
    return commitThenRefuse(unitOfWork, context, async (transaction) => {
      const grant = await grants.findLiveByTokenHash(transaction, hash);
      if (!usable(grant)) return invalidGrant();
      const identity = await directory.readIdentity(transaction, { type: 'RIDER', id: riderId });
      const hub = identity?.authorizedHubIds[0];
      await audit.write(transaction, {
        code: 'auth.device.attestation_failed',
        enhanced: false,
        outcome: 'REJECTED',
        actor: { type: 'RIDER', id: riderId },
        object: { type: 'RiderIdentity', id: riderId },
        ...(hub === undefined ? {} : { responsibleHubId: hub }),
        relatedIds: {
          principal_id: riderId,
          setup_grant_id: grant.id,
          authorised_by: grant.issuedBy,
        },
        detail: {
          verdict: outcome,
          purpose: grant.purpose,
          ...(cause === null ? {} : { cause }),
        },
      });
      return outcome === 'DEVICE_INTEGRITY_FAILED'
        ? ApiException.of(ErrorCode.DeviceIntegrityFailed, 'The device could not be verified')
        : ApiException.of(
            ErrorCode.DeviceSecurityUnsupported,
            'The device cannot hold a hardware-backed key',
          );
    });
  }

  /**
   * The transaction of the act. A grant that lapsed while the act waited for a lock is refused by the table's guard when it is consumed,
   * which fails the statement and so the transaction (`SetupGrantExpiredError`): the act has rolled back whole, and it is answered as every
   * other grant that cannot be used. Nothing else is caught here, a lost commit and any other refusal of the database included.
   */
  async #act<T>(
    context: SecurityContext,
    work: (transaction: TransactionHandle) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.#options.unitOfWork.run(context, work);
    } catch (error) {
      if (error instanceof SetupGrantExpiredError) throw invalidGrant();
      throw error;
    }
  }
}
