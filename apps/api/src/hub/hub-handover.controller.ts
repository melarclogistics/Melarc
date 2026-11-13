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
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { HUB_HANDOVER_ANSWER_SCHEMA, HUB_HANDOVER_SUBMIT_BODY } from './hub-handover-schemas.js';
import { HUB_HANDOVERS } from './hub-providers.js';
import type { HubHandoverBody, HubHandovers } from './hub-handover.service.js';
import type { HubIntakePreCountView } from './hub-intake-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-manifests/{id}/hub-handover` (S1.31): the custody holder hands the run's collected parcels to the hub, one row for each collected pickup request, and that is the run's
 * completion. It serves the Rider app alone, requires `hub.handover.submit`, takes the `If-Match` of the run's read, an `Idempotency-Key` (a retry is not a second handover: the same
 * key replays the answer) and the closed body, and answers `201` with the intakes it opened, in the order of the rows, as `HubIntakePreCount`: **no declaration, not even a zero one**.
 * A run that is not the rider's and an id that matches nothing are `NOT_ASSIGNED_RIDER`, the same; one whose parcels the rider does not hold is `NOT_CUSTODY_HOLDER`; an officer, a
 * vendor and a caller with no session never reach the service.
 */
@Controller('pickup-manifests')
export class HubHandoverController {
  constructor(
    @Optional()
    @Inject(HUB_HANDOVERS)
    private readonly handovers: HubHandovers | undefined,
  ) {}

  @Post(':id/hub-handover')
  @HttpCode(201)
  @ContractOperation('submitHubHandover')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: HUB_HANDOVER_SUBMIT_BODY })
  @ApiResponse({ status: 201, schema: HUB_HANDOVER_ANSWER_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotAssignedRider,
    ErrorCode.NotCustodyHolder,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.StopsUnresolved,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('hub.handover.submit', {
    surfaces: ['RIDER_ANDROID'],
    activity: 'qualifying',
  })
  async submit(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: HubHandoverBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<readonly HubIntakePreCountView[]> {
    if (this.handovers === undefined) throw new OperationUnavailableError('submitHubHandover');
    const submitted = await this.handovers.submit(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'submitHubHandover'),
    });
    return submitted.intakes;
  }
}
