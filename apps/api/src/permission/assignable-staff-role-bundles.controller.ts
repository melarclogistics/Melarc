import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { ASSIGNABLE_STAFF_ROLE_BUNDLES_SCHEMA } from './assignable-staff-role-bundles-schemas.js';
import { ASSIGNABLE_STAFF_ROLE_BUNDLES_SERVICE } from './assignable-staff-role-bundles-providers.js';
import type {
  AssignableStaffRoleBundleView,
  AssignableStaffRoleBundlesService,
} from './assignable-staff-role-bundles.service.js';

/**
 * `GET /staff-role-bundles/assignable` (S0.35): the bundles a maker may name when creating a staff profile. It requires
 * `permission.assignable_bundle.read` (Ops Staff, Senior Ops and Platform Admin hold it, with no hub scope) and serves the Ops Portal
 * alone; a browser session, with no synchronizer token for a read. A read the person makes by opening the creation form is the person
 * acting.
 */
@Controller('staff-role-bundles')
export class AssignableStaffRoleBundlesController {
  constructor(
    @Optional()
    @Inject(ASSIGNABLE_STAFF_ROLE_BUNDLES_SERVICE)
    private readonly service: AssignableStaffRoleBundlesService | undefined,
  ) {}

  @Get('assignable')
  @ContractOperation('listAssignableStaffRoleBundles')
  @ApiResponse({ status: 200, schema: ASSIGNABLE_STAFF_ROLE_BUNDLES_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid)
  @RequiresPermission('permission.assignable_bundle.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
  ): Promise<{ readonly items: readonly AssignableStaffRoleBundleView[] }> {
    return this.service === undefined
      ? Promise.reject(new OperationUnavailableError('listAssignableStaffRoleBundles'))
      : this.service.list(authorized, currentRequestContext()?.requestId ?? randomUUID());
  }
}
