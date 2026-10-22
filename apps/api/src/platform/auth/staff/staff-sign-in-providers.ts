import type { FactoryProvider } from '@nestjs/common';

import { SettingsReader } from '../../settings/settings-reader.js';
import type { MfaChallengeStore } from '../mfa/mfa-challenge-store.js';
import { MFA_CHALLENGE_STORE } from '../mfa/mfa-providers.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { HASH_ADMISSION, type HashAdmission } from '../ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../ports/hasher.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { SESSION_ISSUER } from '../sessions/session-providers.js';
import type { SessionIssuer } from '../sessions/session-issuer.js';
import { StaffSignInService } from './staff-sign-in.service.js';

/** The injection token of the service of `staffSignIn` (S0.32), which its controller asks for. */
export const STAFF_SIGN_IN_SERVICE = Symbol('STAFF_SIGN_IN_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built from the ports the composition root bound and the stores and the issuer built from them, and `undefined` where
 * any one is missing: an application composed without a database, or without local key material (the pepper that hashes a password),
 * has no hasher, no challenge store or no session issuer, so it has no service, and the sign-in fails closed (`503`). Nothing here
 * falls back to a stand-in that signs somebody in.
 */
export const staffSignInProviders: readonly FactoryProvider[] = [
  {
    provide: STAFF_SIGN_IN_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      hasher: Hasher | undefined,
      hashAdmission: HashAdmission | undefined,
      challenges: MfaChallengeStore | undefined,
      issuer: SessionIssuer | undefined,
      audit: AuditWriter | undefined,
    ): StaffSignInService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      hasher === undefined ||
      hashAdmission === undefined ||
      challenges === undefined ||
      issuer === undefined ||
      audit === undefined
        ? undefined
        : new StaffSignInService({
            unitOfWork,
            directory,
            hasher,
            hashAdmission,
            challenges,
            issuer,
            audit,
            settings: new SettingsReader(),
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(HASHER),
      optional(HASH_ADMISSION),
      optional(MFA_CHALLENGE_STORE),
      optional(SESSION_ISSUER),
      optional(AUDIT_WRITER),
    ],
  },
];
