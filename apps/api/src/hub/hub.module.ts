import { Module } from '@nestjs/common';

import { BlindCountController } from './blind-count.controller.js';
import { CheckInController } from './check-in.controller.js';
import { HubHandoverController } from './hub-handover.controller.js';
import { HubIntakesController } from './hub-intakes.controller.js';
import { IntakeFindingsController } from './intake-findings.controller.js';
import { IntakeWorklistController } from './intake-worklist.controller.js';
import { ItemizationController } from './itemization.controller.js';
import { hubProviders } from './hub-providers.js';
import { OrderChangesController } from './order-changes.controller.js';
import { OrderReadsController } from './order-reads.controller.js';
import { PayerCorrectionsController } from './payer-corrections.controller.js';
import { ReceivingController } from './receiving.controller.js';

/**
 * The `hub` permission domain (S1.31, `SLICE-001`): the custody boundary between the rider on the road and the hub's controlled inventory (hub-intake.md). It holds the keys of the
 * intake (`hub.handover.submit`, `hub.read` and `hub.intake.count` since S1.32, and later `hub.osd.adjudicate`), so by the placement rule the hub handover is its own, though it completes a run of the
 * `pickup` domain and moves nothing of the `fleet` domain's custody. **It imports nothing of `pickup` or `fleet`**: it reaches the run and the custody of its parcels through the two ports
 * that `platform/domain-ports/` defines, each implemented by the domain that owns it and wired by the composition root (`src/domain-ports.module.ts`), and `src/architecture.test.ts` holds
 * it. The only thing of `pickup` it names is the schema of the run's and the request's tables, for the foreign keys of its own table (the data layer's convention).
 */
@Module({
  controllers: [
    HubHandoverController,
    HubIntakesController,
    BlindCountController,
    IntakeFindingsController,
    ReceivingController,
    CheckInController,
    ItemizationController,
    OrderReadsController,
    PayerCorrectionsController,
    IntakeWorklistController,
    OrderChangesController,
  ],
  providers: [...hubProviders],
})
export class HubModule {}
