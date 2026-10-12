import type { FactoryProvider } from '@nestjs/common';

import type { AppConfig } from '../../config/load-config.js';
import { DatabaseService } from '../../database/database.service.js';
import { PolicyCoordinator } from '../../database/policy-lock/coordinate.js';
import { APP_CONFIG } from '../../platform.tokens.js';
import { SettingsReader } from '../../settings/settings-reader.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { CLOCK, type Clock } from '../ports/clock.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { SESSION_STORE, type SessionStore } from '../ports/session-store.port.js';
import { TOKEN_SERVICE, type TokenService } from '../ports/token-service.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { SESSION_AUTHENTICATOR, SessionAuthenticator } from './session-authenticator.js';
import { SessionIssuer } from './session-issuer.js';

/** The injection tokens of the coordinator of policy-locked operations and of the session-issue protocol. */
export const POLICY_COORDINATOR = Symbol('POLICY_COORDINATOR');
export const SESSION_ISSUER = Symbol('SESSION_ISSUER');

const optional = (token: symbol | typeof DatabaseService) => ({ token, optional: true });

/**
 * The session machinery as the platform provides it (S0.24): the coordinator of policy-locked operations (OB-63: a plain class,
 * made here from the configuration, with the request budget as its total deadline), the authenticator the authentication guard
 * asks for, and the session-issue protocol the sign-in operations (S0.32, S0.33, S0.48, S0.5x) will ask for.
 *
 * **Each is built from the ports the composition root bound, and is `undefined` where one is missing.** In the runtime composition
 * with a database every port they need is bound (`runtimePortBindings`); where one is not (an application composed without a
 * database, a test that supplies some ports and not others) the service is not there, and its consumer fails closed: a credential
 * with no authenticator is `503`, and an operation with no issuer cannot sign anyone in. Nothing here falls back to a stand-in.
 * The describe composition binds inert adapters to every port, so the services exist there and are never invoked.
 *
 * The compiled fixed-policy revision of this build is declared by the tasks that build the Vendor and Rider sign-ins (S0.48,
 * S0.63); until then no revision is declared and no session of either audience can be issued.
 */
export const sessionProviders: readonly FactoryProvider[] = [
  {
    provide: POLICY_COORDINATOR,
    useFactory: (
      database: DatabaseService | undefined,
      clock: Clock | undefined,
      config: AppConfig,
    ): PolicyCoordinator | undefined =>
      database === undefined || clock === undefined
        ? undefined
        : new PolicyCoordinator(database, {
            clock,
            totalDeadlineMs: config.execution.requestBudgetMs,
          }),
    inject: [optional(DatabaseService), optional(CLOCK), APP_CONFIG],
  },
  {
    provide: SESSION_AUTHENTICATOR,
    useFactory: (
      unitOfWork: UnitOfWork | undefined,
      sessions: SessionStore | undefined,
      tokens: TokenService | undefined,
    ): SessionAuthenticator | undefined =>
      unitOfWork === undefined || sessions === undefined || tokens === undefined
        ? undefined
        : new SessionAuthenticator({
            unitOfWork,
            sessions,
            tokens,
            settings: new SettingsReader(),
          }),
    inject: [optional(UNIT_OF_WORK), optional(SESSION_STORE), optional(TOKEN_SERVICE)],
  },
  {
    provide: SESSION_ISSUER,
    useFactory: (
      coordinator: PolicyCoordinator | undefined,
      unitOfWork: UnitOfWork | undefined,
      identities: IdentityDirectory | undefined,
      sessions: SessionStore | undefined,
      tokens: TokenService | undefined,
      audit: AuditWriter | undefined,
    ): SessionIssuer | undefined =>
      coordinator === undefined ||
      unitOfWork === undefined ||
      identities === undefined ||
      sessions === undefined ||
      tokens === undefined ||
      audit === undefined
        ? undefined
        : new SessionIssuer({
            coordinator,
            unitOfWork,
            identities,
            sessions,
            tokens,
            audit,
            settings: new SettingsReader(),
          }),
    inject: [
      POLICY_COORDINATOR,
      optional(UNIT_OF_WORK),
      optional(IDENTITY_DIRECTORY),
      optional(SESSION_STORE),
      optional(TOKEN_SERVICE),
      optional(AUDIT_WRITER),
    ],
  },
];
