import { randomUUID } from 'node:crypto';

import { Controller, Headers, HttpCode, Inject, Optional, Param, Post, Res } from '@nestjs/common';
import { ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import type { PickupRequestConfirmation } from './pickup-request-confirmation.service.js';
import { PICKUP_REQUEST_SCHEMA } from './pickup-request-schemas.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { PICKUP_REQUEST_CONFIRMATION } from './pickup-requests-providers.js';
import type { PickupRequestView } from './pickup-request-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-requests/{id}/confirm` (S1.15): Ops confirms a `PENDING` request. It requires `pickup.request.confirm` (Ops Staff, Senior
 * Ops and Platform Admin at their hubs; a vendor does not hold it), serves the Ops Portal alone, takes a browser session with its
 * synchronizer token and the `If-Match` of the request's read, and answers `200` with the confirmed request, its indicative estimate and
 * its new version. The request the path names is found or refused (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`) before the request is validated.
 */
@Controller('pickup-requests')
export class PickupRequestConfirmationController {
  constructor(
    @Optional()
    @Inject(PICKUP_REQUEST_CONFIRMATION)
    private readonly service: PickupRequestConfirmation | undefined,
  ) {}

  @Post(':id/confirm')
  @HttpCode(200)
  @ContractOperation('confirmPickupRequest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiResponse({ status: 200, schema: PICKUP_REQUEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.PickupAttemptLimitReached,
    ErrorCode.PickupMinimumNotMet,
    ErrorCode.RateLimited,
    ErrorCode.SenderSuspended,
    ErrorCode.ServiceDateNotPermitted,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
    ErrorCode.ZoneNotServicedOnDate,
  )
  @RequiresPermission('pickup.request.confirm', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
    providerInitiating: true,
  })
  async confirm(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('confirmPickupRequest');
    const confirmed = await this.service.confirm(authorized, correlation(), id, ifMatch);
    response.setHeader('ETag', confirmed.etag);
    return confirmed.request;
  }
}
