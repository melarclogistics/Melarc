import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { CANCEL_BODY, CANCELLATION_CHARGE_WAIVER_BODY } from './cancellation-schemas.js';
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import type {
  CancelBody,
  PickupRequestCancellation,
  WaiverBody,
} from './pickup-request-cancellation.service.js';
import { PICKUP_REQUEST_SCHEMA } from './pickup-request-schemas.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { PICKUP_REQUEST_CANCELLATION } from './pickup-requests-providers.js';
import type { PickupRequestView } from './pickup-request-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The cancellation of a pickup request and the waiver of its charge (S1.17).
 *
 * `POST /pickup-requests/{id}/cancel` requires `pickup.request.cancel`, which a vendor holds for its own organisation's requests and Ops
 * for the requests of its hubs; it serves the Ops Portal and the Vendor app, takes a browser session with its synchronizer token, an
 * `Idempotency-Key` and the `If-Match` of the request's read, and answers `200` with the cancelled request and its new version.
 *
 * `POST /pickup-requests/{id}/cancellation-charge/waiver` requires `pickup.cancellation_charge.waive` (Senior Ops and above), serves the Ops
 * Portal alone, and takes the `If-Match` of the request's read and a note.
 *
 * The request the path names is found or refused (`HUB_SCOPE_VIOLATION` for Ops, `NOT_FOUND` for anyone else and for an id that matches
 * nothing) before the request is validated.
 */
@Controller('pickup-requests')
export class PickupRequestCancellationController {
  constructor(
    @Optional()
    @Inject(PICKUP_REQUEST_CANCELLATION)
    private readonly service: PickupRequestCancellation | undefined,
  ) {}

  @Post(':id/cancel')
  @HttpCode(200)
  @ContractOperation('cancelPickupRequest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: CANCEL_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_REQUEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.PickupAttemptLimitReached,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.ReplacementRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.SourceStillActive,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.request.cancel', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  async cancel(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: CancelBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('cancelPickupRequest');
    const cancelled = await this.service.cancel(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'cancelPickupRequest'),
    });
    response.setHeader('ETag', cancelled.etag);
    return cancelled.request;
  }

  @Post(':id/cancellation-charge/waiver')
  @HttpCode(200)
  @ContractOperation('waiveCancellationCharge')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: CANCELLATION_CHARGE_WAIVER_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_REQUEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NoChargeApplied,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.cancellation_charge.waive', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  async waive(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: WaiverBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) {
      throw new OperationUnavailableError('waiveCancellationCharge');
    }
    const waived = await this.service.waive(authorized, correlation(), id, { body, ifMatch });
    response.setHeader('ETag', waived.etag);
    return waived.request;
  }
}
