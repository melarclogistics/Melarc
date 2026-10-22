import type { FactoryProvider } from '@nestjs/common';

import { SettingsReader } from '../../settings/settings-reader.js';
import type { MfaChallengeStore } from '../mfa/mfa-challenge-store.js';
import type { MfaFactorStore } from '../mfa/mfa-factor-store.js';
import { MFA_CHALLENGE_STORE, MFA_FACTOR_STORE } from '../mfa/mfa-providers.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { TOTP_VERIFIER, type TotpVerifier } from '../ports/totp-verifier.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import type { SessionIssuer } from '../sessions/session-issuer.js';
import { SESSION_ISSUER } from '../sessions/session-providers.js';
import { StaffMfaSignInService } from './staff-mfa-sign-in.service.js';

/** The injection token of the service of `completeStaffMfaSignIn` (S0.33), which its controller asks for. */
export const STAFF_MFA_SIGN_IN_SERVICE = Symbol('STAFF_MFA_SIGN_IN_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built from the ports the composition root bound and the stores and the issuer built from them, and `undefined` where
 * any one is missing: an application composed without a database, or without local key material (the key that seals a seed), has no
 * factor store, no challenge store or no session issuer, so it has no service, and the second step fails closed (`503`).
 */
export const staffMfaSignInProviders: readonly FactoryProvider[] = [
  {
    provide: STAFF_MFA_SIGN_IN_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      challenges: MfaChallengeStore | undefined,
      factors: MfaFactorStore | undefined,
      totp: TotpVerifier | undefined,
      issuer: SessionIssuer | undefined,
      audit: AuditWriter | undefined,
    ): StaffMfaSignInService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      challenges === undefined ||
      factors === undefined ||
      totp === undefined ||
      issuer === undefined ||
      audit === undefined
        ? undefined
        : new StaffMfaSignInService({
            unitOfWork,
            directory,
            challenges,
            factors,
            totp,
            issuer,
            audit,
            settings: new SettingsReader(),
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(MFA_CHALLENGE_STORE),
      optional(MFA_FACTOR_STORE),
      optional(TOTP_VERIFIER),
      optional(SESSION_ISSUER),
      optional(AUDIT_WRITER),
    ],
  },
];
