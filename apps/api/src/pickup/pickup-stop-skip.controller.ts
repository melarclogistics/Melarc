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
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import { PICKUP_STOP_SCHEMA } from './pickup-manifest-schemas.js';
import type { PickupStopView } from './pickup-manifest-view.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { PICKUP_STOP_SKIP } from './pickup-manifests-providers.js';
import { STOP_SKIP_BODY } from './pickup-stop-skip-schemas.js';
import type { PickupStopSkip, SkipBody } from './pickup-stop-skip.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-stops/{id}/skip` (S1.23): Ops authorises that a stop is not worked. It requires `pickup.stop.skip` (Ops Staff, Senior Ops and
 * Platform Admin at their hubs; in no rider bundle), serves the Ops Portal alone, takes a browser session with its synchronizer token, the
 * `If-Match` of the stop's read (`getPickupStop`) and an `Idempotency-Key`, and answers `200` with the skipped stop and its new `ETag`. A rider,
 * a vendor and a caller without the key are `PERMISSION_DENIED` at the guard. The stop the path names is found or refused
 * (`HUB_SCOPE_VIOLATION` for a stop of another hub, `NOT_FOUND` for an id that matches nothing) before the request is validated.
 */
@Controller('pickup-stops')
export class PickupStopSkipController {
  constructor(
    @Optional()
    @Inject(PICKUP_STOP_SKIP)
    private readonly skipping: PickupStopSkip | undefined,
  ) {}

  @Post(':id/skip')
  @HttpCode(200)
  @ContractOperation('skipPickupStop')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: STOP_SKIP_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_STOP_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.RateLimited,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.stop.skip', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_stop', param: 'id' },
    providerInitiating: true,
  })
  async skip(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: SkipBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupStopView> {
    if (this.skipping === undefined) throw new OperationUnavailableError('skipPickupStop');
    const skipped = await this.skipping.skip(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'skipPickupStop'),
    });
    response.setHeader('ETag', skipped.etag);
    return skipped.stop;
  }
}
