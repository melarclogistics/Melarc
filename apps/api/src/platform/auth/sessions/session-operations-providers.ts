import type { FactoryProvider } from '@nestjs/common';

import { OPERATION_RUNNER } from '../../authorization/authorization-providers.js';
import type { OperationRunner } from '../../authorization/operation-runner.js';
import { AUDIT_WRITER, type AuditWriter } from '../ports/audit-writer.port.js';
import { IDENTITY_DIRECTORY, type IdentityDirectory } from '../ports/identity-directory.port.js';
import { SESSION_STORE, type SessionStore } from '../ports/session-store.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../ports/unit-of-work.port.js';
import { SessionOperations } from './session-operations.js';

/** The injection token of the operations on the caller's own session (S0.34), which the controller asks for. */
export const SESSION_OPERATIONS = Symbol('SESSION_OPERATIONS');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service of `getCurrentSession` and `signOut`, built from the ports the composition root bound and the runner built from
 * them, and `undefined` where any one is missing: an application composed without a database has no runner, no store and no
 * directory, so it has no service, and the two operations fail closed (`503`) and never answer as though a session had been read or
 * ended.
 */
export const sessionOperationsProviders: readonly FactoryProvider[] = [
  {
    provide: SESSION_OPERATIONS,
    useFactory: (
      runner: OperationRunner | undefined,
      unitOfWork: UnitOfWork | undefined,
      sessions: SessionStore | undefined,
      audit: AuditWriter | undefined,
      directory: IdentityDirectory | undefined,
    ): SessionOperations | undefined =>
      runner === undefined ||
      unitOfWork === undefined ||
      sessions === undefined ||
      audit === undefined ||
      directory === undefined
        ? undefined
        : new SessionOperations({ runner, unitOfWork, sessions, audit, names: directory }),
    inject: [
      optional(OPERATION_RUNNER),
      optional(UNIT_OF_WORK),
      optional(SESSION_STORE),
      optional(AUDIT_WRITER),
      optional(IDENTITY_DIRECTORY),
    ],
  },
];
