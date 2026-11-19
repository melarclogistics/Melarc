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
import {
  ETAG_HEADERS,
  IDEMPOTENCY_KEY_SCHEMA,
  IF_MATCH_SCHEMA,
} from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import type { AmendBody, PickupRequestAmendment } from './pickup-request-amendment.service.js';
import { PICKUP_REQUEST_AMEND_BODY, PICKUP_REQUEST_SCHEMA } from './pickup-request-schemas.js';
import type { PickupRequestView } from './pickup-request-view.js';
import { PICKUP_REQUEST_AMENDMENT } from './pickup-requests-providers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `amendPickupRequest` (S1.39): `POST /pickup-requests/{id}/amend` under `pickup.request.create`, for the Ops Portal and the Vendor app. A vendor edits the default payer arrangement of its own `PENDING` request
 * and Ops that of a `PENDING` or `CONFIRMED` request of its hubs whose run has not started, until the price freezes; it takes the request's `ETag` as `If-Match` and an `Idempotency-Key`.
 */
@Controller('pickup-requests')
export class PickupRequestAmendmentController {
  constructor(
    @Optional()
    @Inject(PICKUP_REQUEST_AMENDMENT)
    private readonly service: PickupRequestAmendment | undefined,
  ) {}

  @Post(':id/amend')
  @HttpCode(200)
  @ContractOperation('amendPickupRequest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: PICKUP_REQUEST_AMEND_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_REQUEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.request.create', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  async amend(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: AmendBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('amendPickupRequest');
    const amended = await this.service.amend(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'amendPickupRequest'),
    });
    response.setHeader('ETag', amended.etag);
    return amended.request;
  }
}
