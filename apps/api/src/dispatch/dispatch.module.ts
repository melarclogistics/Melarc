import { Module } from '@nestjs/common';

import { ridersProviders } from './riders-providers.js';
import { RidersController } from './riders.controller.js';

/**
 * The `dispatch` permission domain, one of the seventeen that exist (permissions.md section 4; plan section 3: the first use of an existing
 * domain folder is not a new domain). S0.53 builds the two reads of the rider roster here, `listRiders` and `getRider`, because their key is
 * `dispatch.read` and the roster is the same rider list that dispatch will need to assign a manifest (Gate PD-3R1, `PDA-47`). The rider
 * tables themselves are the staff domain's (the identity and its devices), so this module owns no table and reads them through the staff
 * domain's helpers (`rider-view.ts`): no second identity store, no duplicated logic. It depends on the platform and nothing depends on it.
 */
@Module({
  controllers: [RidersController],
  providers: [...ridersProviders],
})
export class DispatchModule {}
