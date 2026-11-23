import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Patch,
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
import { HUB_ITEMIZATION, HUB_ORDER_REVERSALS } from './hub-providers.js';
import type {
  AmendBody,
  AmendPreviewBody,
  HubItemization,
  OrderPreviewView,
} from './itemization.service.js';
import {
  ORDER_AMEND_BODY,
  ORDER_AMEND_PREVIEW_BODY,
  ORDER_PREVIEW_SCHEMA,
  ORDER_REVERSAL_BODY,
  ORDER_REVERSAL_SCHEMA,
  ORDER_SCHEMA,
} from './order-schemas.js';
import type { OrderReversals, ReversalBody, ReversalView } from './order-reversals.service.js';
import type { OrderView } from './order-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

const ETAG_HEADERS = {
  ETag: {
    description: 'The opaque validator of the order as it now stands (the one `getOrder` gives).',
    schema: { type: 'string' },
  },
} as const;

/**
 * The two controlled changes of an order (Stage 7; the external review of 19 November 2026): `amendOrder` (`PATCH /orders/{id}`, `hub.intake.itemize`: an order that is not yet confirmed is corrected, on the
 * version that was read, with a reason, and recalculated) and `reverseOrderArrival` (`POST /orders/{id}/arrival-reversal`, `hub.osd.adjudicate`: a senior takes back the arrival of a parcel whose order is
 * confirmed, with a reason, keeping the order's price and trail). Both are for the Ops Portal's staff alone, in the hubs of the session's grant, and take an `Idempotency-Key` and an `If-Match`.
 */
@Controller()
export class OrderChangesController {
  constructor(
    @Optional()
    @Inject(HUB_ITEMIZATION)
    private readonly itemization: HubItemization | undefined,
    @Optional()
    @Inject(HUB_ORDER_REVERSALS)
    private readonly reversals: OrderReversals | undefined,
  ) {}

  @Patch('orders/:id')
  @HttpCode(200)
  @ContractOperation('amendOrder')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: ORDER_AMEND_BODY })
  @ApiResponse({ status: 200, schema: ORDER_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CarrierCostRequired,
    ErrorCode.CommitmentSourceUnresolved,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.MarginNotConfigured,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.ServiceDateNotPermitted,
    ErrorCode.SessionInvalid,
    ErrorCode.SettingMissing,
    ErrorCode.SizeClassRequired,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
    ErrorCode.ValueDeclarationRequired,
  )
  @RequiresPermission('hub.intake.itemize', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'order', param: 'id' },
  })
  async amend(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: AmendBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderView> {
    if (this.itemization === undefined) throw new OperationUnavailableError('amendOrder');
    const done = await this.itemization.amend(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'amendOrder'),
    });
    response.setHeader('ETag', done.etag);
    return done.order;
  }

  @Post('orders/:id/amendment-preview')
  @HttpCode(200)
  @ContractOperation('previewOrderAmendment')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: ORDER_AMEND_PREVIEW_BODY })
  @ApiResponse({ status: 200, schema: ORDER_PREVIEW_SCHEMA })
  @DescribeErrors(
    ErrorCode.CarrierCostRequired,
    ErrorCode.CommitmentSourceUnresolved,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.HubScopeViolation,
    ErrorCode.MarginNotConfigured,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.ServiceDateNotPermitted,
    ErrorCode.SessionInvalid,
    ErrorCode.SettingMissing,
    ErrorCode.SizeClassRequired,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
    ErrorCode.ValueDeclarationRequired,
  )
  @RequiresPermission('hub.intake.itemize', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'order', param: 'id' },
  })
  previewAmendment(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: AmendPreviewBody,
  ): Promise<OrderPreviewView> {
    if (this.itemization === undefined) {
      return Promise.reject(new OperationUnavailableError('previewOrderAmendment'));
    }
    return this.itemization.previewAmendment(authorized, correlation(), id, body);
  }

  @Post('orders/:id/arrival-reversal')
  @HttpCode(200)
  @ContractOperation('reverseOrderArrival')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: ORDER_REVERSAL_BODY })
  @ApiResponse({ status: 200, schema: ORDER_REVERSAL_SCHEMA })
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
  @RequiresPermission('hub.osd.adjudicate', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'order', param: 'id' },
  })
  reverse(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ReversalBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<ReversalView> {
    if (this.reversals === undefined) {
      return Promise.reject(new OperationUnavailableError('reverseOrderArrival'));
    }
    return this.reversals.reverse(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'reverseOrderArrival'),
    });
  }
}
