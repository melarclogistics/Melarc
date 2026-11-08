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
import { CUTOFF_EXCEPTION_RESOLUTION_BODY } from './cutoff-exception-schemas.js';
import type {
  CutoffExceptionResolution,
  CutoffResolutionBody,
} from './cutoff-exception.service.js';
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import { PICKUP_REQUEST_SCHEMA } from './pickup-request-schemas.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { CUTOFF_EXCEPTION_RESOLUTION } from './pickup-requests-providers.js';
import type { PickupRequestView } from './pickup-request-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-requests/{id}/cutoff-exception` (S1.15): Ops decides a booking that was confirmed past the hub's cutoff, approving it for
 * its day or rescheduling it to the next operating day, under a note. It requires `pickup.request.confirm`, serves the Ops Portal alone,
 * takes a browser session with its synchronizer token, an `Idempotency-Key` and the `If-Match` of the request's read, and answers `200`
 * with the request it resolved and its new version.
 */
@Controller('pickup-requests')
export class CutoffExceptionController {
  constructor(
    @Optional()
    @Inject(CUTOFF_EXCEPTION_RESOLUTION)
    private readonly service: CutoffExceptionResolution | undefined,
  ) {}

  @Post(':id/cutoff-exception')
  @HttpCode(200)
  @ContractOperation('resolveCutoffException')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: CUTOFF_EXCEPTION_RESOLUTION_BODY })
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
  @RequiresPermission('pickup.request.confirm', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  async resolve(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: CutoffResolutionBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('resolveCutoffException');
    const resolved = await this.service.resolve(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'resolveCutoffException'),
    });
    response.setHeader('ETag', resolved.etag);
    return resolved.request;
  }
}
