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
  IDEMPOTENCY_KEY_SCHEMA,
  IF_MATCH_SCHEMA,
  INTAKE_ETAG_HEADERS,
} from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { HUB_ITEMIZATION } from './hub-providers.js';
import type { HubItemization, ItemizeBody, OrderPreviewView } from './itemization.service.js';
import {
  ORDER_ITEMIZE_BODY,
  ORDER_ITEMIZE_PREVIEW_BODY,
  ORDER_PREVIEW_SCHEMA,
  ORDER_SCHEMA,
} from './order-schemas.js';
import type { OrderView } from './order-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `itemizeOrder` (S1.36, `SLICE-001`): `POST /hub-intakes/{id}/orders` makes one order for one parcel of an intake, under `hub.intake.itemize`, for the Ops Portal's staff alone and in the hubs of the session's
 * grant. It takes the `ETag` of the intake's read as `If-Match` and an `Idempotency-Key` (a receiving officer retrying over a flaky hub connection must never make two priced orders for one parcel), and answers `201`
 * with the order: its price calculated and, for a parcel that has arrived, frozen, and the vendor's token after it in `Intake-ETag`. The price, the zone and the dates are the server's and are in no part of the body.
 */
@Controller('hub-intakes')
export class ItemizationController {
  constructor(
    @Optional()
    @Inject(HUB_ITEMIZATION)
    private readonly itemization: HubItemization | undefined,
  ) {}

  @Post(':id/orders')
  @HttpCode(201)
  @ContractOperation('itemizeOrder')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: ORDER_ITEMIZE_BODY })
  @ApiResponse({ status: 201, schema: ORDER_SCHEMA, headers: INTAKE_ETAG_HEADERS })
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
    record: { entity: 'pickup_intake', param: 'id' },
  })
  async itemize(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ItemizeBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderView> {
    if (this.itemization === undefined) throw new OperationUnavailableError('itemizeOrder');
    const made = await this.itemization.itemize(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'itemizeOrder'),
    });
    // The vendor's token after the order, so that the next order of the vendor is made on it with no read between. The order carries no `ETag` of its own: it is not the record this token is a version of.
    response.setHeader('Intake-ETag', made.intakeEtag);
    return made.order;
  }

  @Post(':id/orders/preview')
  @HttpCode(200)
  @ContractOperation('previewOrder')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: ORDER_ITEMIZE_PREVIEW_BODY })
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
    record: { entity: 'pickup_intake', param: 'id' },
  })
  preview(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ItemizeBody,
  ): Promise<OrderPreviewView> {
    if (this.itemization === undefined) {
      return Promise.reject(new OperationUnavailableError('previewOrder'));
    }
    return this.itemization.preview(authorized, correlation(), id, body);
  }
}
