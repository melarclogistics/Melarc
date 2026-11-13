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
import { DescribeServers, RIDER_SERVERS } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { PICKUP_FAILURE_BODY } from './pickup-failure-schemas.js';
import type { FailureBody, PickupFailures } from './pickup-failure.service.js';
import { PICKUP_FAILURES } from './pickup-manifests-providers.js';
import { PICKUP_STOP_SCHEMA } from './pickup-manifest-schemas.js';
import type { PickupStopView } from './pickup-manifest-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-stops/{id}/fail` (S1.28): the rider says that the stop it has arrived at failed. It serves the Rider app alone (a bearer credential,
 * reachable at the dedicated non-browser host as well as same-origin), requires `pickup.failure.report`, takes the `If-Match` of the stop's read, an
 * `Idempotency-Key` (a retry is not a second failure: the same key replays the answer) and the closed body, and answers `200` with the stop and its
 * `ETag`. A stop that is not the rider's and an id that matches nothing are `NOT_ASSIGNED_RIDER`, the same; a run that has not started is
 * `MANIFEST_NOT_STARTED`; an officer, a vendor and a caller with no session never reach the service. The stop becomes `FAILED`, which is terminal.
 */
@Controller('pickup-stops')
export class PickupFailureController {
  constructor(
    @Optional()
    @Inject(PICKUP_FAILURES)
    private readonly failures: PickupFailures | undefined,
  ) {}

  @Post(':id/fail')
  @HttpCode(200)
  @ContractOperation('reportPickupFailure')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: PICKUP_FAILURE_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_STOP_SCHEMA, headers: ETAG_HEADERS })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.ManifestNotStarted,
    ErrorCode.NotAssignedRider,
    ErrorCode.PermissionDenied,
    ErrorCode.PickupDoorWaitNotElapsed,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.failure.report', {
    surfaces: ['RIDER_ANDROID'],
    activity: 'qualifying',
    // A failure writes the envelope of the sender's text (S1.28), so the route carries the sub-ceiling of the operations that can cause an outbound text.
    providerInitiating: true,
  })
  async report(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: FailureBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupStopView> {
    if (this.failures === undefined) throw new OperationUnavailableError('reportPickupFailure');
    const failed = await this.failures.report(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'reportPickupFailure'),
    });
    response.setHeader('ETag', failed.etag);
    return failed.stop;
  }
}
