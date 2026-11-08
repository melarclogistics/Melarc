import { Module } from '@nestjs/common';

import { staffAdministrationProviders } from './staff-administration-providers.js';
import { staffSessionAdministrationProviders } from './staff-session-administration-providers.js';
import {
  StaffMfaResetController,
  StaffSessionController,
} from './staff-session-administration.controller.js';
import { StaffTrustedBrowserController } from './staff-trusted-browser-administration.controller.js';
import { RiderDeviceAdministrationController } from './rider-device-administration.controller.js';
import { riderDeviceAdministrationProviders } from './rider-device-administration-providers.js';
import { staffIdentitiesProviders } from './staff-identities-providers.js';
import {
  StaffCredentialSetupController,
  StaffIdentityAdministrationController,
} from './staff-identity-administration.controller.js';
import { StaffIdentitiesController } from './staff-identities.controller.js';

/**
 * The `staff` permission domain (S0.35: the reads of staff identities; the first adapter this domain provided was the staff identity
 * directory of the authentication ports, which the composition root binds and which is not a Nest module). It depends on the platform
 * and nothing depends on it. The operations that make and settle a record (create, approve, re-issue; S0.36) run in the caller's own staff context under the key of the operation (migration 0029 states the mechanism).
 * The rider device operations (S0.53: `registerRiderDevice`, `reregisterRiderDevice`, and S0.58's `revokeRiderDevice`) are `staff.device.*`
 * and so are the staff domain's; the rider roster reads are `dispatch.read` and are `dispatch`'s (migration 0040 states the mechanism).
 */
@Module({
  controllers: [
    StaffIdentitiesController,
    StaffIdentityAdministrationController,
    StaffCredentialSetupController,
    StaffSessionController,
    StaffMfaResetController,
    StaffTrustedBrowserController,
    RiderDeviceAdministrationController,
  ],
  providers: [
    ...staffIdentitiesProviders,
    ...staffAdministrationProviders,
    ...staffSessionAdministrationProviders,
    ...riderDeviceAdministrationProviders,
  ],
})
export class StaffModule {}
