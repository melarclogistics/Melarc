import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { HASH_ADMISSION, type HashAdmission } from '../ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../ports/hasher.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { TOTP_VERIFIER, type TotpVerifier } from '../ports/totp-verifier.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { MFA_FACTOR_STORE } from '../mfa/mfa-providers.js';
import type { MfaFactorStore } from '../mfa/mfa-factor-store.js';
import { SETUP_GRANT_STORE } from '../setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../setup-grants/setup-grant-store.js';
import { StaffSetupService } from './staff-setup.service.js';

/** The injection token of the service of the three credential setup operations (S0.31), which their controller asks for. */
export const STAFF_SETUP_SERVICE = Symbol('STAFF_SETUP_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built from the ports the composition root bound and the two stores built from them, and `undefined` where any one is
 * missing: an application composed without a database, or without local key material (the pepper that hashes a password, the key
 * that seals a seed), has no hasher, no store of factors or no unit of work, so it has no service, and the three operations fail closed
 * (`503`). Nothing here falls back to a stand-in that pretends to have set a password.
 */
export const staffSetupProviders: readonly FactoryProvider[] = [
  {
    provide: STAFF_SETUP_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      grants: SetupGrantStore | undefined,
      factors: MfaFactorStore | undefined,
      tokens: TokenService | undefined,
      hasher: Hasher | undefined,
      hashAdmission: HashAdmission | undefined,
      totp: TotpVerifier | undefined,
      audit: AuditWriter | undefined,
    ): StaffSetupService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      grants === undefined ||
      factors === undefined ||
      tokens === undefined ||
      hasher === undefined ||
      hashAdmission === undefined ||
      totp === undefined ||
      audit === undefined
        ? undefined
        : new StaffSetupService({
            unitOfWork,
            directory,
            grants,
            factors,
            tokens,
            hasher,
            hashAdmission,
            totp,
            audit,
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(SETUP_GRANT_STORE),
      optional(MFA_FACTOR_STORE),
      optional(TOKEN_SERVICE),
      optional(HASHER),
      optional(HASH_ADMISSION),
      optional(TOTP_VERIFIER),
      optional(AUDIT_WRITER),
    ],
  },
];
