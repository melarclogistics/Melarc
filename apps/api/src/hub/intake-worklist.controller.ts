import { randomUUID } from 'node:crypto';

import { Controller, Get, HttpCode, Inject, Optional, Param, Query } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { HUB_INTAKE_WORKLIST } from './hub-providers.js';
import {
  WORKLIST_VIEWS,
  type ClosedExceptionPageView,
  type ClosureAssessmentView,
  type IntakeWorklist,
  type IntakeWorklistView,
  type WorklistFilter,
} from './intake-worklist.service.js';
import {
  CLOSED_EXCEPTION_PAGE_SCHEMA,
  CLOSURE_ASSESSMENT_SCHEMA,
  INTAKE_ORDER_LIST_SCHEMA,
} from './order-schemas.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): WorklistFilter {
  const take = (name: string): string | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'query', pointer: `/${name}`, rule: 'type' }],
      });
    }
    return value;
  };
  const view = take('view');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(view === undefined ? {} : { view }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

/**
 * The receiving officer's way into an intake's work (Stage 7): `listIntakeOrders` (`hub.read`: the parcel worklist with the counts of the whole intake, no price) and `getIntakeClosure` (`hub.intake.close`:
 * what a close would find). Staff of the Ops Portal alone, by the hubs of the session's grant; safe reads with no synchronizer token.
 */
@Controller()
export class IntakeWorklistController {
  constructor(
    @Optional()
    @Inject(HUB_INTAKE_WORKLIST)
    private readonly worklist: IntakeWorklist | undefined,
  ) {}

  @Get('hub-intakes/:id/orders')
  @HttpCode(200)
  @ContractOperation('listIntakeOrders')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'view',
    required: false,
    schema: { type: 'string', enum: [...WORKLIST_VIEWS], default: 'all' },
  })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: INTAKE_ORDER_LIST_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('hub.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<IntakeWorklistView> {
    if (this.worklist === undefined) {
      return Promise.reject(new OperationUnavailableError('listIntakeOrders'));
    }
    return this.worklist.list(authorized, correlation(), id, filterOf(query));
  }

  @Get('hub-intake-exceptions')
  @HttpCode(200)
  @ContractOperation('listClosedIntakeExceptions')
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: CLOSED_EXCEPTION_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('hub.intake.close_exception', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
  })
  exceptions(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<ClosedExceptionPageView> {
    if (this.worklist === undefined) {
      return Promise.reject(new OperationUnavailableError('listClosedIntakeExceptions'));
    }
    const { pageSize, pageToken } = filterOf(query);
    return this.worklist.exceptions(authorized, correlation(), {
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(pageToken === undefined ? {} : { pageToken }),
    });
  }

  @Get('hub-intakes/:id/closure')
  @HttpCode(200)
  @ContractOperation('getIntakeClosure')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: CLOSURE_ASSESSMENT_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @RequiresPermission('hub.intake.close', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  closure(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
  ): Promise<ClosureAssessmentView> {
    if (this.worklist === undefined) {
      return Promise.reject(new OperationUnavailableError('getIntakeClosure'));
    }
    return this.worklist.closure(authorized, correlation(), id);
  }
}
