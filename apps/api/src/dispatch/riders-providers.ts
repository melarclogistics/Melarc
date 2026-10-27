import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { RidersService } from './riders.service.js';

/** The injection token of the service of the rider reads (S0.53a), which its controller asks for. */
export const RIDERS_SERVICE = Symbol('RIDERS_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the operation runner and the audit writer the platform provides, and `undefined` where either is missing: an
 * application composed without a database has none, and the reads fail closed (`503`). Nothing about a rider's authentication state is read
 * through a reader injected here: it is the PIN's generation and two booleans of the query, in the operation's own transaction.
 */
export const ridersProviders: readonly FactoryProvider[] = [
  {
    provide: RIDERS_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): RidersService | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new RidersService({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
];
