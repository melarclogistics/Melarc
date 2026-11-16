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
import type { BlindCountBody, HubBlindCounts } from './blind-count.service.js';
import { BLIND_COUNT_BODY, HUB_INTAKE_POST_COUNT_SCHEMA } from './hub-intake-schemas.js';
import type { HubIntakePostCountView } from './hub-intake-view.js';
import { HUB_BLIND_COUNTS } from './hub-providers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /hub-intakes/{id}/count` (S1.33): a receiver commits the physical count of an intake, blind. For the Ops Portal's staff alone, under `hub.intake.count`, by the hubs of the session's
 * grant; takes the `ETag` of the intake's read as `If-Match` and an `Idempotency-Key`; the body is the count and nothing else (a body that carries the rider's declaration is
 * `VALIDATION_FAILED`, and nothing is committed). It answers `200` with `HubIntakePostCount`, **which reveals the comparison, the declaration and the photos of the parcels counted at the
 * door for the first time**, and the new `ETag`. A second receiver's count, a stale `ETag` and a missing one are `STATE_CONFLICT`; the lock is no part of any of them.
 */
@Controller('hub-intakes')
export class BlindCountController {
  constructor(
    @Optional()
    @Inject(HUB_BLIND_COUNTS)
    private readonly counts: HubBlindCounts | undefined,
  ) {}

  @Post(':id/count')
  @HttpCode(200)
  @ContractOperation('submitBlindCount')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: BLIND_COUNT_BODY })
  @ApiResponse({ status: 200, schema: HUB_INTAKE_POST_COUNT_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.BlindCountViolated,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('hub.intake.count', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  async submit(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: BlindCountBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HubIntakePostCountView> {
    if (this.counts === undefined) throw new OperationUnavailableError('submitBlindCount');
    const counted = await this.counts.submit(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'submitBlindCount'),
    });
    response.setHeader('ETag', counted.etag);
    return counted.intake;
  }
}
