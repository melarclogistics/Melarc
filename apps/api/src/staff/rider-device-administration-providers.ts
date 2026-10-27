import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
} from '../platform/auth/ports/idempotency-store.port.js';
import { SESSION_STORE, type SessionStore } from '../platform/auth/ports/session-store.port.js';
import { TOKEN_SERVICE, type TokenService } from '../platform/auth/ports/token-service.port.js';
import { SETUP_GRANT_STORE } from '../platform/auth/setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../platform/auth/setup-grants/setup-grant-store.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { ReasonValidator } from '../platform/settings/reason-validator.js';
import { RiderDeviceAdministration } from './rider-device-administration.service.js';

/** The injection token of the service of the operations that start, and (S0.58) end, a rider's device binding, which their controller asks for. */
export const RIDER_DEVICE_ADMINISTRATION = Symbol('RIDER_DEVICE_ADMINISTRATION');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the runner, the store of grants, the idempotency store, the token service and the audit writer the platform
 * provides, and `undefined` where any is missing: an application composed without a database or without local key material has no store
 * of grants and no sealed replay, so it has no service, and the operations fail closed (`503`). Nothing falls back to a stand-in that
 * pretends to have started a device binding.
 */
export const riderDeviceAdministrationProviders: readonly FactoryProvider[] = [
  {
    provide: RIDER_DEVICE_ADMINISTRATION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      grants: SetupGrantStore | undefined,
      idempotency: IdempotencyStore | undefined,
      tokens: TokenService | undefined,
      sessions: SessionStore | undefined,
    ): RiderDeviceAdministration | undefined =>
      runner === undefined ||
      audit === undefined ||
      grants === undefined ||
      idempotency === undefined ||
      tokens === undefined ||
      sessions === undefined
        ? undefined
        : new RiderDeviceAdministration({
            runner,
            audit,
            grants,
            idempotency,
            tokens,
            reasons: new ReasonValidator(),
            sessions,
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(SETUP_GRANT_STORE),
      optional(IDEMPOTENCY_STORE),
      optional(TOKEN_SERVICE),
      optional(SESSION_STORE),
    ],
  },
];
