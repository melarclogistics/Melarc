import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { HASH_ADMISSION, type HashAdmission } from '../ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../ports/hasher.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { SETUP_GRANT_STORE } from '../setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../setup-grants/setup-grant-store.js';
import { RegisteredDeviceStore } from './registered-device-store.js';
import { VendorSetupService } from './vendor-setup.service.js';

/** The injection tokens of the vendor's registered browsers and of the service of its credential setup (S0.47b). */
export const REGISTERED_DEVICE_STORE = Symbol('REGISTERED_DEVICE_STORE');
export const VENDOR_SETUP_SERVICE = Symbol('VENDOR_SETUP_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The store of registered browsers, built on the token service and the clock, and the setup service, built from the ports the composition
 * root bound; each is `undefined` where one is missing (an application without a database, or without the pepper that hashes a secret),
 * and the operation fails closed (`503`). Nothing falls back to a stand-in that pretends to have set a secret.
 */
export const vendorSetupProviders: readonly FactoryProvider[] = [
  {
    provide: REGISTERED_DEVICE_STORE,
    useFactory: (
      tokens: TokenService | undefined,
      clock: Clock | undefined,
    ): RegisteredDeviceStore | undefined =>
      tokens === undefined || clock === undefined
        ? undefined
        : new RegisteredDeviceStore({ tokens, clock }),
    inject: [optional(TOKEN_SERVICE), optional(CLOCK)],
  },
  {
    provide: VENDOR_SETUP_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      grants: SetupGrantStore | undefined,
      devices: RegisteredDeviceStore | undefined,
      tokens: TokenService | undefined,
      hasher: Hasher | undefined,
      hashAdmission: HashAdmission | undefined,
      audit: AuditWriter | undefined,
    ): VendorSetupService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      grants === undefined ||
      devices === undefined ||
      tokens === undefined ||
      hasher === undefined ||
      hashAdmission === undefined ||
      audit === undefined
        ? undefined
        : new VendorSetupService({
            unitOfWork,
            directory,
            grants,
            devices,
            tokens,
            hasher,
            hashAdmission,
            audit,
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(SETUP_GRANT_STORE),
      optional(REGISTERED_DEVICE_STORE),
      optional(TOKEN_SERVICE),
      optional(HASHER),
      optional(HASH_ADMISSION),
      optional(AUDIT_WRITER),
    ],
  },
];
