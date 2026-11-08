import { Module } from '@nestjs/common';

import { assignableStaffRoleBundlesProviders } from './assignable-staff-role-bundles-providers.js';
import { AssignableStaffRoleBundlesController } from './assignable-staff-role-bundles.controller.js';

/**
 * The `permission` permission domain (S0.35: the first key segment of `permission.assignable_bundle.read`; no new domain). It holds
 * the read of the bundles a maker may assign; what a bundle holds and who holds it (`permission.read`) is no operation of this slice.
 * It depends on the platform and nothing depends on it.
 */
@Module({
  controllers: [AssignableStaffRoleBundlesController],
  providers: [...assignableStaffRoleBundlesProviders],
})
export class PermissionModule {}
