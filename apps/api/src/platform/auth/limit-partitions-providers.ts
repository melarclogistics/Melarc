import type { FactoryProvider } from '@nestjs/common';

import { LIMIT_PARTITIONS, type LimitPartitions } from '../routes/limit-partitions.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from './ports/identity-directory.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from './ports/unit-of-work.port.js';
import { recoveryPrincipalPartition } from './recovery/recovery-request-limit.js';
import type { RegisteredDeviceStore } from './vendor/registered-device-store.js';
import { REGISTERED_DEVICE_STORE } from './vendor/vendor-setup-providers.js';
import { vendorDevicePartition } from './vendor/vendor-sign-in-limit.js';

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The partitions the rate-limit guard asks for (`limit-partitions.ts`), composed in one place: the recovery request's (S0.50: the principal
 * type and the identifier, from the body alone, so always composed) and the vendor sign-in's (S0.48: the account and the recognised browser,
 * which reads the database and is composed only where the stores are). A route that names a partition the application was not composed with
 * fails closed, as a missing limiter does.
 */
export const limitPartitionsProviders: readonly FactoryProvider[] = [
  {
    provide: LIMIT_PARTITIONS,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      devices: RegisteredDeviceStore | undefined,
    ): LimitPartitions => ({
      RECOVERY_PRINCIPAL: recoveryPrincipalPartition,
      ...(unitOfWork === undefined || directory === undefined || devices === undefined
        ? {}
        : { VENDOR_DEVICE: vendorDevicePartition(unitOfWork, directory, devices) }),
    }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(REGISTERED_DEVICE_STORE),
    ],
  },
];
