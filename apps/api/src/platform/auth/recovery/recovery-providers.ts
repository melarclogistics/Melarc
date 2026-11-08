import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../config/load-config.js';
import { renderLink } from '../../config/origins.js';
import { APP_CONFIG } from '../../platform.tokens.js';
import { SettingsReader } from '../../settings/settings-reader.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { DELIVERY_QUEUE, type DeliveryQueue } from '../ports/delivery-queue.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { METRICS, type Metrics } from '../ports/metrics.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { HASH_ADMISSION, type HashAdmission } from '../ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../ports/hasher.port.js';
import { SESSION_STORE, type SessionStore } from '../ports/session-store.port.js';
import type { RegisteredDeviceStore } from '../vendor/registered-device-store.js';
import { REGISTERED_DEVICE_STORE } from '../vendor/vendor-setup-providers.js';
import { AdministratorRecoveries } from './administrator-recovery.js';
import { TRUSTED_BROWSER_STORE } from '../trusted-browsers/trusted-browser-providers.js';
import type { TrustedBrowserStore } from '../trusted-browsers/trusted-browser-store.js';
import { RecoveryCompletionService } from './recovery-completion.service.js';
import { RecoveryRequestStore } from './recovery-request-store.js';
import { RecoveryRequestService } from './recovery-request.service.js';

/** The injection token of the store of recovery requests, which the recovery operations of S0.50 and S0.51 ask for. */
export const RECOVERY_REQUEST_STORE = Symbol('RECOVERY_REQUEST_STORE');
/** The injection token of the service of `requestCredentialRecovery` (S0.50). */
export const RECOVERY_REQUEST_SERVICE = Symbol('RECOVERY_REQUEST_SERVICE');
/** The injection token of the service of `completeCredentialRecovery` (S0.51a). */
export const RECOVERY_COMPLETION_SERVICE = Symbol('RECOVERY_COMPLETION_SERVICE');
/** The injection token of the part of an administrator's recovery the two domains share (S0.51b), which their services ask for. */
export const ADMINISTRATOR_RECOVERIES = Symbol('ADMINISTRATOR_RECOVERIES');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The store and the service, built from the ports the composition root bound and `undefined` where one is missing, so the operations
 * fail closed (`503`), as every credential operation does: an application composed without a database or without local key material has
 * no queue to put a link on. The metrics registry may be absent (nothing is then counted; the answer never depends on a count). The links
 * are each surface's recovery route.
 */
export const recoveryProviders: readonly FactoryProvider[] = [
  {
    provide: RECOVERY_REQUEST_STORE,
    useFactory: (
      tokens: TokenService | undefined,
      queue: DeliveryQueue | undefined,
      clock: Clock | undefined,
    ): RecoveryRequestStore | undefined =>
      tokens === undefined || queue === undefined || clock === undefined
        ? undefined
        : new RecoveryRequestStore({ tokens, queue, settings: new SettingsReader(), clock }),
    inject: [optional(TOKEN_SERVICE), optional(DELIVERY_QUEUE), optional(CLOCK)],
  },
  {
    provide: RECOVERY_REQUEST_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      store: RecoveryRequestStore | undefined,
      audit: AuditWriter | undefined,
      metrics: Metrics | undefined,
      config: AppConfig,
    ): RecoveryRequestService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      store === undefined ||
      audit === undefined
        ? undefined
        : new RecoveryRequestService({
            unitOfWork,
            directory,
            store,
            settings: new SettingsReader(),
            audit,
            metrics,
            links: {
              STAFF: (token) => renderLink(config.links.ops.recovery, token),
              VENDOR: (token) => renderLink(config.links.vendor.recovery, token),
            },
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(RECOVERY_REQUEST_STORE),
      optional(AUDIT_WRITER),
      optional(METRICS),
      APP_CONFIG,
    ],
  },
  {
    provide: ADMINISTRATOR_RECOVERIES,
    useFactory: (
      store: RecoveryRequestStore | undefined,
      audit: AuditWriter | undefined,
      config: AppConfig,
    ): AdministratorRecoveries | undefined =>
      store === undefined || audit === undefined
        ? undefined
        : new AdministratorRecoveries({
            store,
            settings: new SettingsReader(),
            audit,
            links: {
              STAFF: (token) => renderLink(config.links.ops.recovery, token),
              VENDOR: (token) => renderLink(config.links.vendor.recovery, token),
            },
          }),
    inject: [optional(RECOVERY_REQUEST_STORE), optional(AUDIT_WRITER), APP_CONFIG],
  },
  {
    provide: RECOVERY_COMPLETION_SERVICE,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      directory: IdentityDirectory | undefined,
      store: RecoveryRequestStore | undefined,
      devices: RegisteredDeviceStore | undefined,
      sessions: SessionStore | undefined,
      trustedBrowsers: TrustedBrowserStore | undefined,
      hasher: Hasher | undefined,
      hashAdmission: HashAdmission | undefined,
      audit: AuditWriter | undefined,
    ): RecoveryCompletionService | undefined =>
      unitOfWork === undefined ||
      directory === undefined ||
      store === undefined ||
      devices === undefined ||
      sessions === undefined ||
      trustedBrowsers === undefined ||
      hasher === undefined ||
      hashAdmission === undefined ||
      audit === undefined
        ? undefined
        : new RecoveryCompletionService({
            unitOfWork,
            directory,
            store,
            devices,
            sessions,
            trustedBrowsers,
            hasher,
            hashAdmission,
            audit,
          }),
    inject: [
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(RECOVERY_REQUEST_STORE),
      optional(REGISTERED_DEVICE_STORE),
      optional(SESSION_STORE),
      optional(TRUSTED_BROWSER_STORE),
      optional(HASHER),
      optional(HASH_ADMISSION),
      optional(AUDIT_WRITER),
    ],
  },
];
