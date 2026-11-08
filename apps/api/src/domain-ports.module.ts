import { Global, Module } from '@nestjs/common';

import { FleetRunCustody } from './fleet/fleet-run-custody.adapter.js';
import { PickupRunAccess } from './pickup/pickup-run-access.adapter.js';
import { AUDIT_WRITER, type AuditWriter } from './platform/auth/ports/audit-writer.port.js';
import { RUN_ACCESS } from './platform/domain-ports/run-access.port.js';
import { RUN_CUSTODY, type RunCustody } from './platform/domain-ports/run-custody.port.js';

/**
 * Where the two domains that meet over a run are joined (S1.24; F-32; SOLUTION_ARCHITECTURE.md section 5: "the application composition root wires
 * adapters to ports"). `pickup` owns the run and `fleet` owns the custody of its parcels; neither imports the other, and each is given the other's
 * answer by a token whose shape `platform/domain-ports/` defines. This is the one place that names both adapters, which is why it is part of the
 * composition root (`src/architecture.test.ts` lets only it and `app.module.ts` import across).
 *
 * Global, so that a domain module asks for the token and does not import the module that provides it (a module import would be the dependency again).
 * The run port is `undefined` where it cannot be built (an application composed without the ledger), and a service that needs it then fails closed.
 */
@Global()
@Module({
  providers: [
    { provide: RUN_CUSTODY, useFactory: (): RunCustody => new FleetRunCustody() },
    {
      provide: RUN_ACCESS,
      useFactory: (audit: AuditWriter | undefined, custody: RunCustody) =>
        audit === undefined ? undefined : new PickupRunAccess({ audit, custody }),
      inject: [{ token: AUDIT_WRITER, optional: true }, RUN_CUSTODY],
    },
  ],
  exports: [RUN_ACCESS, RUN_CUSTODY],
})
export class DomainPortsModule {}
