import type { FactoryProvider } from '@nestjs/common';

import { SettingsReader } from '../../settings/settings-reader.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { HASH_ADMISSION, type HashAdmission } from '../ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../ports/hasher.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { SESSION_ISSUER } from '../sessions/session-providers.js';
import type { SessionIssuer } from '../sessions/session-issuer.js';
import type { RegisteredDeviceStore } from './registered-device-store.js';
import { REGISTERED_DEVICE_STORE } from './vendor-setup-providers.js';
import { VendorSignInService } from './vendor-sign-in.service.js';

/** The injection token of the service of the vendor sign-in (S0.48), which its controller asks for. */
export const VENDOR_SIGN_IN_SERVICE = Symbol('VENDOR_SIGN_IN_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built from the ports the composition root bound, the session-issue protocol and the store of registered browsers, and
 * `undefined` where one is missing, so the operation fails closed (`503`). The partition of its rate limit (the account and the recognised
 * browser) is composed with the others in `limit-partitions-providers.ts`. Nothing falls back to a stand-in.
 */
export const vendorSignInProviders: readonly FactoryProvider[] = [
  {
    provide: VENDOR_SIGN_IN_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      devices: RegisteredDeviceStore | undefined,
      hasher: Hasher | undefined,
      hashAdmission: HashAdmission | undefined,
      issuer: SessionIssuer | undefined,
      audit: AuditWriter | undefined,
    ): VendorSignInService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      devices === undefined ||
      hasher === undefined ||
      hashAdmission === undefined ||
      issuer === undefined ||
      audit === undefined
        ? undefined
        : new VendorSignInService({
            unitOfWork,
            directory,
            devices,
            hasher,
            hashAdmission,
            issuer,
            audit,
            settings: new SettingsReader(),
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(REGISTERED_DEVICE_STORE),
      optional(HASHER),
      optional(HASH_ADMISSION),
      optional(SESSION_ISSUER),
      optional(AUDIT_WRITER),
    ],
  },
];
