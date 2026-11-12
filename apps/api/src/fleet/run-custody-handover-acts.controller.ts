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
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { RUN_CUSTODY_HANDOVERS } from './fleet-providers.js';
import {
  RUN_CUSTODY_HANDOVER_ACCEPT_BODY,
  RUN_CUSTODY_HANDOVER_CREATE_BODY,
  RUN_CUSTODY_HANDOVER_FAIL_BODY,
  RUN_CUSTODY_HANDOVER_SCHEMA,
} from './run-custody-handover-schemas.js';
import type {
  AcceptBody,
  CreateBody,
  FailBody,
  RunCustodyHandovers,
} from './run-custody-handover.service.js';
import type { RunCustodyHandoverView } from './run-custody-handover-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The three acts on the custody of a run (S1.24), addressed by the run: `POST /pickup-manifests/{id}/custody-handover` (open one),
 * `.../custody-handover/accept` and `.../custody-handover/fail`.
 *
 * - **Opening and failing** are Ops's (`fleet.custody.initiate`, Ops Staff and Senior Ops at their hubs, Platform Admin at every hub): the Ops Portal alone,
 *   a browser session with its synchronizer token and the `If-Match` of what they act on (the run's `ETag` to open, the handover's to fail), and
 *   for failing an `Idempotency-Key`. A rider cannot use them, because the rider who needs a handover is the one who cannot act.
 * - **Accepting** is the named receiving rider's, or Ops's where the hub is the destination (`fleet.custody.accept`): it serves the Ops Portal
 *   and the Rider app. The run the path names is found or refused for **staff** before the request is validated (`HUB_SCOPE_VIOLATION` for a run
 *   of another hub, `NOT_FOUND` for an id that matches nothing); for a **rider** the guard looks nothing up, because a rider who acts on custody
 *   that is not its own is told `NOT_ASSIGNED_RIDER`, in one answer for every case, by the operation itself.
 */
@Controller('pickup-manifests')
export class RunCustodyHandoverActsController {
  constructor(
    @Optional()
    @Inject(RUN_CUSTODY_HANDOVERS)
    private readonly custody: RunCustodyHandovers | undefined,
  ) {}

  @Post(':id/custody-handover')
  @HttpCode(200)
  @ContractOperation('initiateRunCustodyHandover')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: RUN_CUSTODY_HANDOVER_CREATE_BODY })
  @ApiResponse({ status: 200, schema: RUN_CUSTODY_HANDOVER_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.RiderUnavailable,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('fleet.custody.initiate', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_manifest', param: 'id' },
  })
  async initiate(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: CreateBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RunCustodyHandoverView> {
    if (this.custody === undefined) {
      throw new OperationUnavailableError('initiateRunCustodyHandover');
    }
    const opened = await this.custody.initiate(authorized, correlation(), id, { body, ifMatch });
    response.setHeader('ETag', opened.etag);
    return opened.handover;
  }

  @Post(':id/custody-handover/accept')
  @HttpCode(200)
  @ContractOperation('acceptRunCustodyHandover')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: RUN_CUSTODY_HANDOVER_ACCEPT_BODY })
  @ApiResponse({ status: 200, schema: RUN_CUSTODY_HANDOVER_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotAssignedRider,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('fleet.custody.accept', {
    surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
    activity: 'qualifying',
    record: { entity: 'pickup_manifest', param: 'id', surfaces: ['OPS_PORTAL'] },
  })
  async accept(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: AcceptBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RunCustodyHandoverView> {
    if (this.custody === undefined) {
      throw new OperationUnavailableError('acceptRunCustodyHandover');
    }
    const accepted = await this.custody.accept(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'acceptRunCustodyHandover'),
    });
    response.setHeader('ETag', accepted.etag);
    return accepted.handover;
  }

  @Post(':id/custody-handover/fail')
  @HttpCode(200)
  @ContractOperation('failRunCustodyHandover')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: RUN_CUSTODY_HANDOVER_FAIL_BODY })
  @ApiResponse({ status: 200, schema: RUN_CUSTODY_HANDOVER_SCHEMA, headers: ETAG_HEADERS })
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
  @RequiresPermission('fleet.custody.initiate', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_manifest', param: 'id' },
  })
  async fail(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: FailBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RunCustodyHandoverView> {
    if (this.custody === undefined) throw new OperationUnavailableError('failRunCustodyHandover');
    const failed = await this.custody.fail(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'failRunCustodyHandover'),
    });
    response.setHeader('ETag', failed.etag);
    return failed.handover;
  }
}
