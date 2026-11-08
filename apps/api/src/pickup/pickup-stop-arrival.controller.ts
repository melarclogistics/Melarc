import { randomUUID } from 'node:crypto';

import {
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
import { ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeServers, RIDER_SERVERS } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IDEMPOTENCY_KEY_SCHEMA } from '../platform/http/contract-headers.js';
import { PICKUP_RUN_EXECUTION } from './pickup-manifests-providers.js';
import { PICKUP_STOP_SCHEMA } from './pickup-manifest-schemas.js';
import type { PickupStopView } from './pickup-manifest-view.js';
import type { PickupRunExecution } from './pickup-run-execution.service.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-stops/{id}/arrive` (S1.22): the rider says it has arrived at a stop of its run, in any order. It serves the Rider app alone (a
 * bearer credential, reachable at the dedicated non-browser host as well as same-origin), requires `pickup.run.execute`, takes an
 * `Idempotency-Key` (a retry is not a second arrival: the same key replays the answer) and no body and no `If-Match`, and answers `200` with
 * the stop and its `ETag`. A stop that is not the rider's, and an id that matches nothing, are `NOT_ASSIGNED_RIDER`, the same; a run that has
 * not started is `MANIFEST_NOT_STARTED`; an officer, a vendor and a caller with no session never reach the service.
 */
@Controller('pickup-stops')
export class PickupStopArrivalController {
  constructor(
    @Optional()
    @Inject(PICKUP_RUN_EXECUTION)
    private readonly execution: PickupRunExecution | undefined,
  ) {}

  @Post(':id/arrive')
  @HttpCode(200)
  @ContractOperation('arriveAtPickupStop')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiResponse({ status: 200, schema: PICKUP_STOP_SCHEMA, headers: ETAG_HEADERS })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.ManifestNotStarted,
    ErrorCode.NotAssignedRider,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.run.execute', {
    surfaces: ['RIDER_ANDROID'],
    activity: 'qualifying',
  })
  async arrive(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupStopView> {
    if (this.execution === undefined) throw new OperationUnavailableError('arriveAtPickupStop');
    const arrived = await this.execution.arrive(authorized, correlation(), id, {
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'arriveAtPickupStop'),
    });
    response.setHeader('ETag', arrived.etag);
    return arrived.stop;
  }
}
