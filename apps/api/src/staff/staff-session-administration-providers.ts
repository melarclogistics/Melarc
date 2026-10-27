import type { FactoryProvider } from '@nestjs/common';

import { MFA_FACTOR_STORE } from '../platform/auth/mfa/mfa-providers.js';
import type { MfaFactorStore } from '../platform/auth/mfa/mfa-factor-store.js';
import { MfaResetService } from '../platform/auth/mfa/mfa-reset.service.js';
import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStore,
} from '../platform/auth/ports/idempotency-store.port.js';
import { SESSION_STORE, type SessionStore } from '../platform/auth/ports/session-store.port.js';
import { TRUSTED_BROWSER_STORE } from '../platform/auth/trusted-browsers/trusted-browser-providers.js';
import type { TrustedBrowserStore } from '../platform/auth/trusted-browsers/trusted-browser-store.js';
import { SETUP_GRANT_STORE } from '../platform/auth/setup-grants/setup-grant-providers.js';
import type { SetupGrantStore } from '../platform/auth/setup-grants/setup-grant-store.js';
import {
  OPERATION_CONTEXTS,
  OPERATION_RUNNER,
  RECORD_SCOPE_RESOLVER,
} from '../platform/authorization/authorization-providers.js';
import type { OperationContexts } from '../platform/authorization/operation-contexts.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import type { RecordScopeResolver } from '../platform/authorization/record-scope.js';
import { renderLink } from '../platform/config/origins.js';
import type { AppConfig } from '../platform/config/load-config.js';
import { APP_CONFIG } from '../platform/platform.tokens.js';
import { ReasonValidator } from '../platform/settings/reason-validator.js';
import { SettingsReader } from '../platform/settings/settings-reader.js';
import { StaffMfaReset } from './staff-mfa-reset.service.js';
import { StaffSessionAdministration } from './staff-session-administration.service.js';
import { StaffTrustedBrowserAdministration } from './staff-trusted-browser-administration.service.js';

/** The injection tokens of the services of S0.37, which their controllers ask for. */
export const STAFF_SESSION_ADMINISTRATION = Symbol('STAFF_SESSION_ADMINISTRATION');
export const STAFF_MFA_RESET = Symbol('STAFF_MFA_RESET');
export const STAFF_TRUSTED_BROWSER_ADMINISTRATION = Symbol('STAFF_TRUSTED_BROWSER_ADMINISTRATION');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The services, built on the runner, the resolver of a record's scope, the stores and the audit writer the platform provides, and
 * `undefined` where any is missing: an application composed without a database or without local key material has no store of grants and
 * no delivery queue, so a reset is `503`; the list and the revocation need the runner and the resolver only. Nothing falls back to a
 * stand-in that pretends to have ended a session or reset a factor.
 */
export const staffSessionAdministrationProviders: readonly FactoryProvider[] = [
  {
    provide: STAFF_SESSION_ADMINISTRATION,
    useFactory: (
      runner: OperationRunner | undefined,
      contexts: OperationContexts,
      scope: RecordScopeResolver | undefined,
      sessions: SessionStore | undefined,
      audit: AuditWriter | undefined,
    ): StaffSessionAdministration | undefined =>
      runner === undefined || scope === undefined || sessions === undefined || audit === undefined
        ? undefined
        : new StaffSessionAdministration({
            runner,
            contexts,
            scope,
            sessions,
            audit,
            reasons: new ReasonValidator(),
            settings: new SettingsReader(),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      OPERATION_CONTEXTS,
      optional(RECORD_SCOPE_RESOLVER),
      optional(SESSION_STORE),
      optional(AUDIT_WRITER),
    ],
  },
  {
    provide: STAFF_TRUSTED_BROWSER_ADMINISTRATION,
    useFactory: (
      runner: OperationRunner | undefined,
      store: TrustedBrowserStore | undefined,
      audit: AuditWriter | undefined,
      idempotency: IdempotencyStore | undefined,
    ): StaffTrustedBrowserAdministration | undefined =>
      runner === undefined ||
      store === undefined ||
      audit === undefined ||
      idempotency === undefined
        ? undefined
        : new StaffTrustedBrowserAdministration({
            runner,
            store,
            audit,
            idempotency,
            reasons: new ReasonValidator(),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(TRUSTED_BROWSER_STORE),
      optional(AUDIT_WRITER),
      optional(IDEMPOTENCY_STORE),
    ],
  },
  {
    provide: STAFF_MFA_RESET,
    useFactory: (
      runner: OperationRunner | undefined,
      grants: SetupGrantStore | undefined,
      factors: MfaFactorStore | undefined,
      sessions: SessionStore | undefined,
      audit: AuditWriter | undefined,
      trustedBrowsers: TrustedBrowserStore | undefined,
      config: AppConfig,
    ): StaffMfaReset | undefined =>
      runner === undefined ||
      grants === undefined ||
      factors === undefined ||
      sessions === undefined ||
      audit === undefined ||
      trustedBrowsers === undefined
        ? undefined
        : new StaffMfaReset({
            runner,
            reset: new MfaResetService({
              grants,
              factors,
              sessions,
              trustedBrowsers,
              audit,
              reasons: new ReasonValidator(),
              reenrolmentLink: (token) => renderLink(config.links.ops.setupMfa, token),
            }),
          }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(SETUP_GRANT_STORE),
      optional(MFA_FACTOR_STORE),
      optional(SESSION_STORE),
      optional(AUDIT_WRITER),
      optional(TRUSTED_BROWSER_STORE),
      APP_CONFIG,
    ],
  },
];
