import { Module } from '@nestjs/common';

import { fleetProviders } from './fleet-providers.js';
import { RunCustodyHandoverActsController } from './run-custody-handover-acts.controller.js';
import { RunCustodyHandoverReadsController } from './run-custody-handover-reads.controller.js';

/**
 * The `fleet` permission domain (S1.24, `SLICE-001`): the custody of a started run's parcels moving from the rider who holds them to another rider
 * or to the hub (`MSC-DEC-246`). It holds the keys of the operations (`fleet.custody.initiate`, `.accept`, `.read`), so by the placement rule the
 * acts are its own, though they change a run of the `pickup` domain. **It imports nothing of `pickup`, and `pickup` imports nothing of it**
 * (readiness check F-32): the two meet through two ports that `platform/domain-ports/` defines, each implemented by the domain that owns it and wired
 * by the composition root (`src/domain-ports.module.ts`), and `src/architecture.test.ts` holds it. The only thing of `pickup` it names is the schema
 * of the run's table, for the foreign key of its own table (the data layer's convention).
 */
@Module({
  controllers: [RunCustodyHandoverActsController, RunCustodyHandoverReadsController],
  providers: [...fleetProviders],
})
export class FleetModule {}
