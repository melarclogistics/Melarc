import { randomUUID } from 'node:crypto';

import { Controller, Get, HttpCode, Inject, Optional, Param, Res } from '@nestjs/common';
import { ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { HUB_ORDER_READS } from './hub-providers.js';
import type { HubOrderReads, IntakeSummaryView, ReadOrder } from './order-reads.service.js';
import { INTAKE_SUMMARY_SCHEMA, ORDER_SCHEMA } from './order-schemas.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

const ETAG_HEADERS = {
  ETag: {
    description: 'The opaque validator of what this read returned.',
    schema: { type: 'string' },
  },
} as const;

/**
 * The two reads of Stage 7's close (S1.38): `getOrder` (`pricing.read`, for the staff of the order's hub and for the vendor whose order it is, the vendor without the recipient, the serial and IMEI, the
 * officer who judged the size and the carrier's cost) and `getIntakeSummary` (`pickup.read`, the vendor-facing summary of a **closed** intake, field-filtered by construction). The summary is a safe read:
 * a vendor reads its own and staff read the hubs of their grant; anything else is one that does not exist.
 */
@Controller()
export class OrderReadsController {
  constructor(
    @Optional()
    @Inject(HUB_ORDER_READS)
    private readonly reads: HubOrderReads | undefined,
  ) {}

  @Get('orders/:id')
  @HttpCode(200)
  @ContractOperation('getOrder')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: ORDER_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @RequiresPermission('pricing.read', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'background',
    record: { entity: 'order', param: 'id' },
  })
  async getOrder(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadOrder['order']> {
    if (this.reads === undefined) throw new OperationUnavailableError('getOrder');
    const read = await this.reads.getOrder(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.order;
  }

  @Get('hub-intakes/:id/summary')
  @HttpCode(200)
  @ContractOperation('getIntakeSummary')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: INTAKE_SUMMARY_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @RequiresPermission('pickup.read', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'background',
    record: { entity: 'pickup_intake', param: 'id', surfaces: ['OPS_PORTAL'] },
  })
  getSummary(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
  ): Promise<IntakeSummaryView> {
    if (this.reads === undefined) {
      return Promise.reject(new OperationUnavailableError('getIntakeSummary'));
    }
    return this.reads.getSummary(authorized, correlation(), id);
  }
}
