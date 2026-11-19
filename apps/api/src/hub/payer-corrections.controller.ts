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
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { HUB_PAYER_CORRECTIONS } from './hub-providers.js';
import {
  PAYER_CORRECTION_DECISION_BODY,
  PAYER_CORRECTION_REQUEST_BODY,
  PAYER_CORRECTION_SCHEMA,
} from './order-schemas.js';
import type {
  PayerCorrectionDecisionBody,
  PayerCorrectionRequestBody,
  PayerCorrectionView,
  PayerCorrections,
} from './payer-corrections.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

const ETAG_HEADERS = {
  ETag: {
    description: 'The opaque validator of the correction as it now stands.',
    schema: { type: 'string' },
  },
} as const;

/**
 * The payer correction after the price froze (S1.39): `requestPayerCorrection` (`pricing.correction.create`, the maker) and `approvePayerCorrection` (`pricing.correction.approve`, the checker, who is not the
 * maker unless a Platform Admin). Staff of the Ops Portal alone, in the hubs of the session's grant; both take an `Idempotency-Key` and an `If-Match` (the order's `ETag` from `getOrder`, and the correction's).
 */
@Controller()
export class PayerCorrectionsController {
  constructor(
    @Optional()
    @Inject(HUB_PAYER_CORRECTIONS)
    private readonly corrections: PayerCorrections | undefined,
  ) {}

  @Post('orders/:id/payer-correction')
  @HttpCode(201)
  @ContractOperation('requestPayerCorrection')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: PAYER_CORRECTION_REQUEST_BODY })
  @ApiResponse({ status: 201, schema: PAYER_CORRECTION_SCHEMA, headers: ETAG_HEADERS })
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
  @RequiresPermission('pricing.correction.create', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'order', param: 'id' },
  })
  async request(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: PayerCorrectionRequestBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayerCorrectionView> {
    if (this.corrections === undefined) {
      throw new OperationUnavailableError('requestPayerCorrection');
    }
    const done = await this.corrections.request(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'requestPayerCorrection'),
    });
    response.setHeader('ETag', done.etag);
    return done.correction;
  }

  @Post('payer-corrections/:id/decision')
  @HttpCode(200)
  @ContractOperation('approvePayerCorrection')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: PAYER_CORRECTION_DECISION_BODY })
  @ApiResponse({ status: 200, schema: PAYER_CORRECTION_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SelfApprovalForbidden,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pricing.correction.approve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'payer_correction', param: 'id' },
  })
  async decide(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: PayerCorrectionDecisionBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PayerCorrectionView> {
    if (this.corrections === undefined) {
      throw new OperationUnavailableError('approvePayerCorrection');
    }
    const done = await this.corrections.decide(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'approvePayerCorrection'),
    });
    response.setHeader('ETag', done.etag);
    return done.correction;
  }
}
