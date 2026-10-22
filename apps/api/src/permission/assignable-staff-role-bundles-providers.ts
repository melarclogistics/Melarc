import type { FactoryProvider } from '@nestjs/common';

import { OPERATION_RUNNER } from '../platform/authorization/authorization-providers.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { AssignableStaffRoleBundlesService } from './assignable-staff-role-bundles.service.js';

/** The injection token of the service of `listAssignableStaffRoleBundles` (S0.35), which its controller asks for. */
export const ASSIGNABLE_STAFF_ROLE_BUNDLES_SERVICE = Symbol(
  'ASSIGNABLE_STAFF_ROLE_BUNDLES_SERVICE',
);

/**
 * The service, built on the operation runner the platform provides, and `undefined` where there is none: an application composed
 * without a database has no runner, so it has no service, and the read fails closed (`503`).
 */
export const assignableStaffRoleBundlesProviders: readonly FactoryProvider[] = [
  {
    provide: ASSIGNABLE_STAFF_ROLE_BUNDLES_SERVICE,
    useFactory: (
      runner: OperationRunner | undefined,
    ): AssignableStaffRoleBundlesService | undefined =>
      runner === undefined ? undefined : new AssignableStaffRoleBundlesService({ runner }),
    inject: [{ token: OPERATION_RUNNER, optional: true }],
  },
];
