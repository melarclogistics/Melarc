import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import type { SettingsReader } from '../../settings/settings-reader.js';
import type { IdentityDirectory } from '../ports/identity-directory.port.js';
import type { TokenService } from '../ports/token-service.port.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import { authenticationContext } from '../staff/authentication-context.js';
import {
  deviceContextBinding,
  phoneBinding,
  RIDER_CHALLENGE_NO_RIDER,
} from './rider-challenge-binding.js';
import type { RiderChallengeStore } from './rider-challenge-store.js';
import type { RiderDeviceStore } from './rider-device-store.js';
import { canonicalRiderPhone } from './rider-vocabulary.js';

const CHALLENGE_TTL_SETTING = 'authentication_challenge_ttl_minutes';

export interface RiderChallengeServiceOptions {
  readonly unitOfWork: UnitOfWork;
  readonly directory: Pick<IdentityDirectory, 'findRiderByCanonicalPhone'>;
  readonly devices: Pick<RiderDeviceStore, 'activeKeyFor'>;
  readonly challenges: Pick<RiderChallengeStore, 'issue'>;
  readonly tokens: Pick<TokenService, 'issue'>;
  readonly settings: Pick<SettingsReader, 'integer'>;
  /** The environment and service a challenge is issued for (`riderChallengeAudience`). */
  readonly audience: string;
}

/** What `requestRiderSignInChallenge` answers: the nonce to sign, once, and when it ends. Nothing about the number. */
export interface IssuedRiderChallenge {
  readonly challenge: string;
  readonly expiresAt: Date;
}

function violation(pointer: string, rule: string): ApiException {
  return new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
    violations: [{ in: 'body', pointer, rule }],
  });
}

/**
 * `requestRiderSignInChallenge` (S0.59a; rider-authentication.md sections 4.1 and 5.1; SECURITY_DESIGN.md sections 13.4b and 13.6): step one of a
 * rider's sign-in. The server issues a short-lived, **single-use** challenge, 32 random bytes in 43 base64url characters, that the handset
 * signs with its registered key. The challenge alone authenticates nothing.
 *
 * - **It is not an enumeration oracle.** The answer is the same for a number that belongs to an `ACTIVE` rider with a device, for a rider
 *   with none, for a rider who is suspended and for a number that belongs to nobody: a nonce and its expiry, with no name, hub, status or
 *   device state in it. **The work is the same too**: one transaction that reads the lifetime, looks the number up, looks up the key of the
 *   rider's `ACTIVE` device (for the nil identifier when there is no rider, the same one statement), and writes one row. The row records which,
 *   to the server alone (`rider_identity_id` is null for a number that matched no rider), and the number is bound by a digest.
 * - **A text that is not an E.164 number is `VALIDATION_FAILED`**, before any work: about the text, never about the rider.
 * - **Nothing is hashed**, so the request takes no hash slot; it is limited by the number it names (`rate_limit_rider_challenge`, in the guard).
 * - **It ends no other challenge of the rider** (the store), and it writes no audit event: the audit catalogue has none for a challenge
 *   that grants nothing, and an event for each request would be the log an attacker fills.
 */
export class RiderChallengeService {
  readonly #options: RiderChallengeServiceOptions;

  constructor(options: RiderChallengeServiceOptions) {
    this.#options = options;
  }

  async request(phone: string): Promise<IssuedRiderChallenge> {
    const canonical = canonicalRiderPhone(phone);
    if (canonical === undefined) throw violation('/phone', 'format');
    const { unitOfWork, directory, devices, challenges, tokens, settings, audience } =
      this.#options;

    return unitOfWork.run(authenticationContext(), async (transaction) => {
      const ttlMinutes = await settings.integer(transaction, CHALLENGE_TTL_SETTING);
      const rider = await directory.findRiderByCanonicalPhone(transaction, canonical);
      const riderId = rider?.ref.id ?? null;
      // The same one statement whether or not there is a rider: the nil identifier names none and finds no device.
      const device = await devices.activeKeyFor(transaction, riderId ?? RIDER_CHALLENGE_NO_RIDER);
      const nonce = tokens.issue();
      const issued = await challenges.issue(transaction, {
        riderId,
        nonceHash: nonce.hash,
        phoneHash: phoneBinding(canonical),
        deviceContextHash: device === null ? null : deviceContextBinding(device.deviceId),
        audience,
        ttlMinutes,
      });
      return { challenge: nonce.token, expiresAt: issued.expiresAt };
    });
  }
}
