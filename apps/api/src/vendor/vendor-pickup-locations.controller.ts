import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Param } from '@nestjs/common';
import { ApiParam, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { VENDOR_PICKUP_LOCATIONS_SERVICE } from './vendor-pickup-locations-providers.js';
import { VENDOR_PICKUP_LOCATION_LIST } from './vendor-pickup-location-schemas.js';
import type {
  VendorPickupLocationsService,
  VendorPickupLocationView,
} from './vendor-pickup-locations.service.js';

/**
 * `GET /vendor-organizations/{id}/pickup-locations` (S1.14): the saved pickup locations of one vendor organisation. It requires
 * `vendor.pickup_location.manage` (a vendor on its own record, Ops at the organisation's hub), serves the Ops Portal and the Vendor app,
 * and takes a browser session with no synchronizer token (a safe read). The organisation is named by the path: whether the caller can
 * see it is decided before the request is validated, `HUB_SCOPE_VIOLATION` by the scope probe for Ops and `NOT_FOUND` for everyone else.
 */
@Controller('vendor-organizations')
export class VendorPickupLocationsController {
  constructor(
    @Optional()
    @Inject(VENDOR_PICKUP_LOCATIONS_SERVICE)
    private readonly service: VendorPickupLocationsService | undefined,
  ) {}

  @Get(':id/pickup-locations')
  @ContractOperation('listVendorPickupLocations')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: VENDOR_PICKUP_LOCATION_LIST })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('vendor.pickup_location.manage', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
    record: { entity: 'vendor_organization', param: 'id' },
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
  ): Promise<{ readonly items: readonly VendorPickupLocationView[] }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listVendorPickupLocations'));
    }
    return this.service.list(authorized, currentRequestContext()?.requestId ?? randomUUID(), id);
  }
}
