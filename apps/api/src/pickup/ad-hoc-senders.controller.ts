import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { AD_HOC_SENDER_LIST } from './ad-hoc-sender-schemas.js';
import { AD_HOC_SENDERS_SERVICE } from './pickup-requests-providers.js';
import type { AdHocSenderView, AdHocSendersService } from './ad-hoc-senders.service.js';

/**
 * `GET /ad-hoc-senders?phone=` (S1.14): the office finds a walk-in who has used Melarc before. It requires `vendor.read` and serves the
 * Ops Portal alone, with a browser session and no synchronizer token (a safe read). The phone is required, as entered; an unknown one is an
 * empty list.
 */
@Controller('ad-hoc-senders')
export class AdHocSendersController {
  constructor(
    @Optional()
    @Inject(AD_HOC_SENDERS_SERVICE)
    private readonly service: AdHocSendersService | undefined,
  ) {}

  @Get()
  @ContractOperation('findAdHocSender')
  @ApiQuery({ name: 'phone', required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: AD_HOC_SENDER_LIST })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('vendor.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  find(
    @Authorized() authorized: AuthorizedRequest,
    @Query('phone') phone: unknown,
  ): Promise<{ readonly items: readonly AdHocSenderView[] }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('findAdHocSender'));
    }
    return this.service.find(
      authorized,
      currentRequestContext()?.requestId ?? randomUUID(),
      typeof phone === 'string' ? phone : '',
    );
  }
}
