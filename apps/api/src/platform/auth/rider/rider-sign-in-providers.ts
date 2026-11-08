import type { FactoryProvider } from '@nestjs/common';

import { SettingsReader } from '../../settings/settings-reader.js';
import type { AppConfig } from '../../config/load-config.js';
import { APP_CONFIG } from '../../platform.tokens.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { HASH_ADMISSION, type HashAdmission } from '../ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../ports/hasher.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import type { SessionIssuer } from '../sessions/session-issuer.js';
import { SESSION_ISSUER } from '../sessions/session-providers.js';
import { riderChallengeAudience } from './rider-challenge-binding.js';
import { RiderChallengeService } from './rider-challenge.service.js';
import { RiderChallengeStore } from './rider-challenge-store.js';
import { RIDER_DEVICE_STORE } from './rider-enrolment-providers.js';
import type { RiderDeviceStore } from './rider-device-store.js';
import { RiderSignInService } from './rider-sign-in.service.js';

/** The injection tokens of the rider's challenge store and of the services of the challenge request and the sign-in (S0.59). */
export const RIDER_CHALLENGE_STORE = Symbol('RIDER_CHALLENGE_STORE');
export const RIDER_CHALLENGE_SERVICE = Symbol('RIDER_CHALLENGE_SERVICE');
export const RIDER_SIGN_IN_SERVICE = Symbol('RIDER_SIGN_IN_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The store of the rider's sign-in challenges, built on the clock, and the two services, built from the ports the composition root bound, the
 * session-issue protocol and the store of the rider's devices; each is `undefined` where one is missing (an application without a database,
 * without local key material for the pepper that hashes a PIN, or without the issuer), and the operation fails closed (`503`). Nothing falls
 * back to a stand-in that pretends to have issued a challenge or a session. The rate limit of both (the number, in the guard) is composed with
 * the others.
 */
export const riderSignInProviders: readonly FactoryProvider[] = [
  {
    provide: RIDER_CHALLENGE_STORE,
    useFactory: (clock: Clock | undefined): RiderChallengeStore | undefined =>
      clock === undefined ? undefined : new RiderChallengeStore({ clock }),
    inject: [optional(CLOCK)],
  },
  {
    provide: RIDER_CHALLENGE_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      devices: RiderDeviceStore | undefined,
      challenges: RiderChallengeStore | undefined,
      tokens: TokenService | undefined,
      config: AppConfig,
    ): RiderChallengeService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      devices === undefined ||
      challenges === undefined ||
      tokens === undefined
        ? undefined
        : new RiderChallengeService({
            unitOfWork,
            directory,
            devices,
            challenges,
            tokens,
            settings: new SettingsReader(),
            audience: riderChallengeAudience(config.appEnv),
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(RIDER_DEVICE_STORE),
      optional(RIDER_CHALLENGE_STORE),
      optional(TOKEN_SERVICE),
      APP_CONFIG,
    ],
  },
  {
    provide: RIDER_SIGN_IN_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      devices: RiderDeviceStore | undefined,
      challenges: RiderChallengeStore | undefined,
      tokens: TokenService | undefined,
      hasher: Hasher | undefined,
      hashAdmission: HashAdmission | undefined,
      issuer: SessionIssuer | undefined,
      audit: AuditWriter | undefined,
      config: AppConfig,
    ): RiderSignInService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      devices === undefined ||
      challenges === undefined ||
      tokens === undefined ||
      hasher === undefined ||
      hashAdmission === undefined ||
      issuer === undefined ||
      audit === undefined
        ? undefined
        : new RiderSignInService({
            unitOfWork,
            directory,
            devices,
            challenges,
            tokens,
            hasher,
            hashAdmission,
            issuer,
            audit,
            settings: new SettingsReader(),
            audience: riderChallengeAudience(config.appEnv),
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(RIDER_DEVICE_STORE),
      optional(RIDER_CHALLENGE_STORE),
      optional(TOKEN_SERVICE),
      optional(HASHER),
      optional(HASH_ADMISSION),
      optional(SESSION_ISSUER),
      optional(AUDIT_WRITER),
      APP_CONFIG,
    ],
  },
];
