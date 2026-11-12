import { Module } from '@nestjs/common';

import { AdHocSendersController } from './ad-hoc-senders.controller.js';
import { CutoffExceptionController } from './cutoff-exception.controller.js';
import { OnePackageExceptionController } from './one-package-exception.controller.js';
import { PickupRequestCancellationController } from './pickup-request-cancellation.controller.js';
import { PickupRequestChainController } from './pickup-request-chain.controller.js';
import { PickupRequestConfirmationController } from './pickup-request-confirmation.controller.js';
import { PickupRequestCreationController } from './pickup-request-creation.controller.js';
import { PickupManifestDispatchController } from './pickup-manifest-dispatch.controller.js';
import { PickupManifestPlanningController } from './pickup-manifest-planning.controller.js';
import { PickupManifestsController } from './pickup-manifests.controller.js';
import { pickupManifestsProviders } from './pickup-manifests-providers.js';
import { PickupRequestsController } from './pickup-requests.controller.js';
import { pickupRequestsProviders } from './pickup-requests-providers.js';
import { PickupRunStartController } from './pickup-run-start.controller.js';
import { PickupFailureController } from './pickup-failure.controller.js';
import { PickupStopArrivalController } from './pickup-stop-arrival.controller.js';
import { PickupStopSkipController } from './pickup-stop-skip.controller.js';
import { CollectionDisputeController } from './collection-dispute.controller.js';
import { CollectionHandshakeController } from './collection-handshake.controller.js';
import { CollectionController } from './collection.controller.js';
import { PickupStopsController } from './pickup-stops.controller.js';
import { OpsWorkListsController } from './ops-work-lists.controller.js';
import { pickupOpsWorkListsProviders } from './ops-work-lists-providers.js';

/**
 * The `pickup` permission domain (S1.13, `SLICE-001`): the pickup request, from its booking to its cancellation and its chain, and (S1.20)
 * the manifest that groups confirmed requests into a run. It depends on the platform and nothing depends on it. The operations arrive with
 * the tasks that build them (S1.14 to S1.18); the first two are the reads of a request (`listPickupRequests`, `getPickupRequest`), whose
 * ETag every later mutation takes back as `If-Match`, and the manifest's creation and reads (S1.20) are the first of its run.
 */
@Module({
  controllers: [
    PickupRequestsController,
    PickupManifestsController,
    PickupManifestPlanningController,
    PickupManifestDispatchController,
    PickupRunStartController,
    PickupStopsController,
    PickupStopArrivalController,
    PickupStopSkipController,
    PickupFailureController,
    CollectionController,
    CollectionHandshakeController,
    CollectionDisputeController,
    OpsWorkListsController,
    PickupRequestCreationController,
    PickupRequestConfirmationController,
    CutoffExceptionController,
    OnePackageExceptionController,
    PickupRequestCancellationController,
    PickupRequestChainController,
    AdHocSendersController,
  ],
  providers: [
    ...pickupRequestsProviders,
    ...pickupManifestsProviders,
    ...pickupOpsWorkListsProviders,
  ],
})
export class PickupModule {}
