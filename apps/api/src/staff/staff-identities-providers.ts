import type { FactoryProvider } from '@nestjs/common';

import { AUDIT_WRITER, type AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { StaffIdentitiesService } from './staff-identities.service.js';

/** The injection token of the service of the staff reads (S0.35), which its controller asks for. */
export const STAFF_IDENTITIES_SERVICE = Symbol('STAFF_IDENTITIES_SERVICE');

const optional = (token: symbol) => ({ token, optional: true });

/**
 * The service, built on the operation runner and the audit writer the platform provides, and `undefined` where either is missing: an
 * application composed without a database has none, so it has no service, and the reads fail closed (`503`). The second-factor facts
 * are read inside the operation's own transaction (`melarc.staff_reset_facts`), so no reader of them is injected.
 */
export const staffIdentitiesProviders: readonly FactoryProvider[] = [
  {
    provide: STAFF_IDENTITIES_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
      audit: AuditWriter | undefined,
    ): StaffIdentitiesService | undefined =>
      runner === undefined || audit === undefined
        ? undefined
        : new StaffIdentitiesService({ runner, audit }),
    inject: [optional(OPERATION_RUNNER), optional(AUDIT_WRITER)],
  },
];
