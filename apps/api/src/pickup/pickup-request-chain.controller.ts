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
import { ATTEMPT_EXTENSION_BODY, ESCALATION_BODY } from './chain-schemas.js';
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import type {
  EscalationBody,
  ExtensionBody,
  PickupRequestChain,
} from './pickup-request-chain.service.js';
import { PICKUP_REQUEST_SCHEMA } from './pickup-request-schemas.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { PICKUP_REQUEST_CHAIN } from './pickup-requests-providers.js';
import type { PickupRequestView } from './pickup-request-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The commands of the reschedule chain that are not a cancellation (S1.18): the force-extension of the attempt cap and the escalation.
 *
 * `POST /pickup-requests/{id}/attempt-extension` requires `pickup.attempt.extend` (hub Senior Ops and Platform Admin; Ops Staff are
 * `PERMISSION_DENIED`) and `POST /pickup-requests/{id}/escalate` requires `pickup.failure.resolve` (Ops, Senior Ops and Platform Admin). Both
 * serve the Ops Portal, take a browser session with its synchronizer token, an `Idempotency-Key` and the `If-Match` of the request's read, and
 * answer `200` with the request and its new version.
 *
 * The request the path names is found or refused (`HUB_SCOPE_VIOLATION` for Ops, `NOT_FOUND` for an id that matches nothing) before the body
 * is judged.
 */
@Controller('pickup-requests')
export class PickupRequestChainController {
  constructor(
    @Optional()
    @Inject(PICKUP_REQUEST_CHAIN)
    private readonly service: PickupRequestChain | undefined,
  ) {}

  @Post(':id/attempt-extension')
  @HttpCode(200)
  @ContractOperation('extendPickupAttempts')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: ATTEMPT_EXTENSION_BODY })
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
  @RequiresPermission('pickup.attempt.extend', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  async extend(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ExtensionBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('extendPickupAttempts');
    const extended = await this.service.extend(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'extendPickupAttempts'),
    });
    response.setHeader('ETag', extended.etag);
    return extended.request;
  }

  @Post(':id/escalate')
  @HttpCode(200)
  @ContractOperation('escalatePickupRequest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: ESCALATION_BODY })
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
  @RequiresPermission('pickup.failure.resolve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  async escalate(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: EscalationBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('escalatePickupRequest');
    const escalated = await this.service.escalate(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'escalatePickupRequest'),
    });
    response.setHeader('ETag', escalated.etag);
    return escalated.request;
  }
}
