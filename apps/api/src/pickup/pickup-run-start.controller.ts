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
import { DescribeServers, RIDER_SERVERS } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import { PICKUP_RUN_EXECUTION } from './pickup-manifests-providers.js';
import { PICKUP_MANIFEST_SCHEMA } from './pickup-manifest-schemas.js';
import type { PickupManifestView } from './pickup-manifest-view.js';
import type { PickupRunExecution } from './pickup-run-execution.service.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-manifests/{id}/start` (S1.22): the rider starts the run it was given. It serves the Rider app alone (a bearer credential,
 * reachable at the dedicated non-browser host as well as same-origin), requires `pickup.run.execute`, takes the `If-Match` of the run's read
 * (its `ETag` digests the stops, so a run that changed since the rider read it is `STATE_CONFLICT`) and no body and no `Idempotency-Key` (a
 * second start of a run that has started is `STATE_CONFLICT`, and a retry after a lost answer reads the run again), and answers `200` with the
 * run, its stops and the new `ETag`. A run that is not the rider's, and an id that matches nothing, are `NOT_ASSIGNED_RIDER`, the same; an
 * officer, a vendor and a caller with no session never reach the service.
 */
@Controller('pickup-manifests')
export class PickupRunStartController {
  constructor(
    @Optional()
    @Inject(PICKUP_RUN_EXECUTION)
    private readonly execution: PickupRunExecution | undefined,
  ) {}

  @Post(':id/start')
  @HttpCode(200)
  @ContractOperation('startRun')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiResponse({ status: 200, schema: PICKUP_MANIFEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.ManifestEmpty,
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
  async start(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupManifestView> {
    if (this.execution === undefined) throw new OperationUnavailableError('startRun');
    const started = await this.execution.start(authorized, correlation(), id, { ifMatch });
    response.setHeader('ETag', started.etag);
    return started.manifest;
  }
}
