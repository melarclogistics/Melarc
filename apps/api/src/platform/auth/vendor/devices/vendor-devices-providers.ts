import type { FactoryProvider } from '@nestjs/common';

import { OPERATION_RUNNER } from '../../../authorization/authorization-providers.js';
import type { OperationRunner } from '../../../authorization/operation-runner.js';
import type { AppConfig } from '../../../config/load-config.js';
import { renderLink } from '../../../config/origins.js';
import { APP_CONFIG } from '../../../platform.tokens.js';
import { AUDIT_WRITER, type AuditWriter } from '../../ports/audit-writer.port.js';
import { IDEMPOTENCY_STORE, type IdempotencyStore } from '../../ports/idempotency-store.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../../ports/identity-directory.port.js';
import { RATE_LIMITER, type RateLimiter } from '../../ports/rate-limiter.port.js';
import { SESSION_STORE, type SessionStore } from '../../ports/session-store.port.js';
import { SETUP_GRANT_STORE } from '../../setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../../setup-grants/setup-grant-store.js';
import type { RegisteredDeviceStore } from '../registered-device-store.js';
import { REGISTERED_DEVICE_STORE } from '../vendor-setup-providers.js';
import { VendorDevicesService } from './vendor-devices.service.js';

/** The injection token of the service of the vendor's own browsers (S0.49), which its controller asks for. */
export const VENDOR_DEVICES_SERVICE = Symbol('VENDOR_DEVICES_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built from the runner, the ports and the stores the platform provides, and `undefined` where one is missing, so its
 * operations fail closed (`503`). The limiter may be absent from a composition that serves no limited route; the grant then fails closed
 * itself. The link is the Vendor origin's additional-browser route.
 */
export const vendorDevicesProviders: readonly FactoryProvider[] = [
  {
    provide: VENDOR_DEVICES_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      directory: IdentityDirectory | undefined,
      grants: SetupGrantStore | undefined,
      devices: RegisteredDeviceStore | undefined,
      sessions: SessionStore | undefined,
      idempotency: IdempotencyStore | undefined,
      limiter: RateLimiter | undefined,
      audit: AuditWriter | undefined,
      config: AppConfig,
    ): VendorDevicesService | undefined =>
      runner === undefined ||
      directory === undefined ||
      grants === undefined ||
      devices === undefined ||
      sessions === undefined ||
      idempotency === undefined ||
      audit === undefined
        ? undefined
        : new VendorDevicesService({
            runner,
            directory,
            grants,
            devices,
            sessions,
            idempotency,
            limiter,
            audit,
            deviceLink: (token) => renderLink(config.links.vendor.setupDevice, token),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(IDENTITY_DIRECTORY),
      optional(SETUP_GRANT_STORE),
      optional(REGISTERED_DEVICE_STORE),
      optional(SESSION_STORE),
      optional(IDEMPOTENCY_STORE),
      optional(RATE_LIMITER),
      optional(AUDIT_WRITER),
      APP_CONFIG,
    ],
  },
];
