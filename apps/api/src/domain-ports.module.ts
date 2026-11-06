import { Global, Module } from '@nestjs/common';

import { riderRecordLookupSources } from './dispatch/rider-record-lookup.adapter.js';
import { FleetRunCustody } from './fleet/fleet-run-custody.adapter.js';
import { pickupRecordLookupSources } from './pickup/pickup-record-lookup.adapter.js';
import { pickupQueueCounters } from './pickup/pickup-queue-counters.adapter.js';
import { PickupRunAccess } from './pickup/pickup-run-access.adapter.js';
import { AUDIT_WRITER, type AuditWriter } from './platform/auth/ports/audit-writer.port.js';
import { QUEUE_COUNTERS, type QueueCounter } from './platform/domain-ports/queue-counter.port.js';
import {
  RECORD_LOOKUP_SOURCES,
  type RecordLookupSource,
} from './platform/domain-ports/record-lookup.port.js';
import { RUN_ACCESS } from './platform/domain-ports/run-access.port.js';
import { RUN_CUSTODY, type RunCustody } from './platform/domain-ports/run-custody.port.js';
import { staffQueueCounters } from './staff/staff-queue-counter.adapter.js';
import { staffRecordLookupSources } from './staff/staff-record-lookup.adapter.js';
import { vendorRecordLookupSources } from './vendor/vendor-record-lookup.adapter.js';

/**
 * Where the two domains that meet over a run are joined (S1.24; F-32; SOLUTION_ARCHITECTURE.md section 5: "the application composition root wires
 * adapters to ports"). `pickup` owns the run and `fleet` owns the custody of its parcels; neither imports the other, and each is given the other's
 * answer by a token whose shape `platform/domain-ports/` defines. This is the one place that names both adapters, which is why it is part of the
 * composition root (`src/architecture.test.ts` lets only it and `app.module.ts` import across).
 *
 * Global, so that a domain module asks for the token and does not import the module that provides it (a module import would be the dependency again).
 * The run port is `undefined` where it cannot be built (an application composed without the ledger), and a service that needs it then fails closed.
 *
 * It also joins the counters of the queues to the one read that counts them (task C1): `pickup` and `staff` each own the queues they
 * count, and `platform/queue-summary/` calls them through the port `platform/domain-ports/queue-counter.port.ts` defines, without importing
 * either.
 *
 * And the sources of the records a lookup finds (task C2): `pickup`, `vendor`, `dispatch` and `staff` each own the kinds of record they search,
 * and `platform/lookup/` calls them through the port `platform/domain-ports/record-lookup.port.ts` defines, without importing any of the four.
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
    {
      provide: QUEUE_COUNTERS,
      useFactory: (): readonly QueueCounter[] => [
        ...pickupQueueCounters(),
        ...staffQueueCounters(),
      ],
    },
    {
      provide: RECORD_LOOKUP_SOURCES,
      useFactory: (): readonly RecordLookupSource[] => [
        ...pickupRecordLookupSources(),
        ...vendorRecordLookupSources(),
        ...riderRecordLookupSources(),
        ...staffRecordLookupSources(),
      ],
    },
  ],
  exports: [RUN_ACCESS, RUN_CUSTODY, QUEUE_COUNTERS, RECORD_LOOKUP_SOURCES],
})
export class DomainPortsModule {}
