import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../platform/auth/ports/clock.port.js';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
} from '../platform/auth/ports/idempotency-store.port.js';
import { SETUP_GRANT_STORE } from '../platform/auth/setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../platform/auth/setup-grants/setup-grant-store.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { renderLink } from '../platform/config/origins.js';
import type { AppConfig } from '../platform/config/load-config.js';
import { APP_CONFIG } from '../platform/platform.tokens.js';
import { ReasonValidator } from '../platform/settings/reason-validator.js';
import { ADMINISTRATOR_RECOVERIES } from '../platform/auth/recovery/recovery-providers.js';
import type { AdministratorRecoveries } from '../platform/auth/recovery/administrator-recovery.js';
import { StaffCredentialRecovery } from './staff-credential-recovery.service.js';
import { StaffIdentityAdministration } from './staff-identity-administration.service.js';

/** The injection token of the service of the operations that make and settle a staff identity (S0.36), which their controllers ask for. */
export const STAFF_IDENTITY_ADMINISTRATION = Symbol('STAFF_IDENTITY_ADMINISTRATION');
/** The injection token of the service of `recoverStaffCredential` (S0.51b). */
export const STAFF_CREDENTIAL_RECOVERY = Symbol('STAFF_CREDENTIAL_RECOVERY');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the runner, the store of grants (which queues the message), the idempotency store and the audit writer the
 * platform provides, and `undefined` where any is missing: an application composed without a database or without local key material has
 * no store of grants and no delivery queue, so it has no service, and the three operations fail closed (`503`). Nothing falls back to a
 * stand-in that pretends to have approved a person.
 */
export const staffAdministrationProviders: readonly FactoryProvider[] = [
  {
    provide: STAFF_IDENTITY_ADMINISTRATION,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
      grants: SetupGrantStore | undefined,
      idempotency: IdempotencyStore | undefined,
      clock: Clock | undefined,
      config: AppConfig,
    ): StaffIdentityAdministration | undefined =>
      runner === undefined ||
      audit === undefined ||
      grants === undefined ||
      idempotency === undefined ||
      clock === undefined
        ? undefined
        : new StaffIdentityAdministration({
            runner,
            audit,
            grants,
            idempotency,
            clock,
            reasons: new ReasonValidator(),
            setupLink: (token) => renderLink(config.links.ops.setupCredential, token),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(AUDIT_WRITER),
      optional(SETUP_GRANT_STORE),
      optional(IDEMPOTENCY_STORE),
      optional(CLOCK),
      APP_CONFIG,
    ],
  },
  {
    // The administrator's recovery of a staff member's password: the runner and the platform's shared part of a recovery, and nothing
    // where either is missing (the operation then fails closed, `503`).
    provide: STAFF_CREDENTIAL_RECOVERY,
    useFactory: (
      runner: OperationRunner | undefined,
      recoveries: AdministratorRecoveries | undefined,
    ): StaffCredentialRecovery | undefined =>
      runner === undefined || recoveries === undefined
        ? undefined
        : new StaffCredentialRecovery({ runner, recoveries, reasons: new ReasonValidator() }),
    inject: [optional(OPERATION_RUNNER), optional(ADMINISTRATOR_RECOVERIES)],
  },
];
