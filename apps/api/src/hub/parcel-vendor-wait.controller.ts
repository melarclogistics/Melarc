import { randomUUID } from 'node:crypto';

import { Body, Controller, Headers, HttpCode, Inject, Optional, Param, Put } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { HUB_PARCEL_VENDOR_WAITS } from './hub-providers.js';
import { PARCEL_WAIT_BODY, PARCEL_WAIT_SCHEMA } from './parcel-vendor-wait-schemas.js';
import type {
  ParcelVendorWaits,
  ParcelWaitBody,
  ParcelWaitView,
} from './parcel-vendor-wait.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `setParcelWaitingForVendor` (Run G1, D-S7-12): `PUT /intake-parcels/{parcel_id}/waiting-for-vendor` marks a parcel as waiting for the vendor's details, or takes the mark off, under `hub.intake.itemize`, for the
 * Ops Portal's staff alone and in the hubs of the session's grant. It states the parcel's desired state (so it is idempotent by nature and takes no `Idempotency-Key`) and takes the `ETag` of the vendor's read as
 * `If-Match`, as the order of a parcel does, without moving it.
 */
@Controller()
export class ParcelVendorWaitController {
  constructor(
    @Optional()
    @Inject(HUB_PARCEL_VENDOR_WAITS)
    private readonly waits: ParcelVendorWaits | undefined,
  ) {}

  @Put('intake-parcels/:parcel_id/waiting-for-vendor')
  @HttpCode(200)
  @ContractOperation('setParcelWaitingForVendor')
  @ApiParam({ name: 'parcel_id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: PARCEL_WAIT_BODY })
  @ApiResponse({ status: 200, schema: PARCEL_WAIT_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('hub.intake.itemize', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'intake_parcel', param: 'parcel_id' },
  })
  set(
    @Authorized() authorized: AuthorizedRequest,
    @Param('parcel_id') parcelId: string,
    @Body() body: ParcelWaitBody,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<ParcelWaitView> {
    if (this.waits === undefined) {
      return Promise.reject(new OperationUnavailableError('setParcelWaitingForVendor'));
    }
    return this.waits.set(authorized, correlation(), parcelId, { body, ifMatch });
  }
}
