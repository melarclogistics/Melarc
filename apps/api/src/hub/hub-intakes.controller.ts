import { randomUUID } from 'node:crypto';

import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import {
  INTAKE_STATES,
  HUB_INTAKE_PAGE_SCHEMA,
  HUB_INTAKE_VIEW_SCHEMA,
} from './hub-intake-schemas.js';
import type { HubIntakeView } from './hub-intake-view.js';
import { HUB_INTAKES } from './hub-providers.js';
import type { HubIntakeFilter, HubIntakePage, HubIntakes } from './hub-intakes.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): HubIntakeFilter {
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
  const state = take('state');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(state === undefined ? {} : { state }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

/**
 * The receiving side of the hub (S1.32, `SLICE-001`): `GET /hub-intakes` (the awaiting-receive queue), `GET /hub-intakes/{id}` and `POST /hub-intakes/{id}/lock`. Each is for the Ops
 * Portal's staff alone, by the hubs of the session's grant: the reads under `hub.read`, the lock under `hub.intake.count`; a vendor and a rider are refused by the surface and again by the
 * service. **No answer carries the rider's declaration before the count commits** (`HubIntakePreCount` has no such property; `AC-SLICE-001-37`, `-77`).
 *
 * The lock's request is `background` activity: it is the page keeping its own lock, not the person acting, so that a page left open on a receiving screen never keeps an unattended
 * session alive (the person's own acts, the reads and the count, are what extend it).
 */
@Controller('hub-intakes')
export class HubIntakesController {
  constructor(
    @Optional()
    @Inject(HUB_INTAKES)
    private readonly intakes: HubIntakes | undefined,
  ) {}

  @Get()
  @ContractOperation('listHubIntakes')
  @ApiQuery({
    name: 'state',
    required: false,
    schema: { type: 'string', enum: [...INTAKE_STATES] },
  })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: HUB_INTAKE_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'], ['riderSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('hub.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<HubIntakePage> {
    if (this.intakes === undefined) {
      return Promise.reject(new OperationUnavailableError('listHubIntakes'));
    }
    return this.intakes.list(authorized, correlation(), filterOf(query));
  }

  @Get(':id')
  @ContractOperation('getHubIntake')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: HUB_INTAKE_VIEW_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'], ['riderSession'])
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
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HubIntakeView> {
    if (this.intakes === undefined) throw new OperationUnavailableError('getHubIntake');
    const read = await this.intakes.get(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.intake;
  }

  @Post(':id/lock')
  @HttpCode(200)
  @ContractOperation('acquireIntakeLock')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: HUB_INTAKE_VIEW_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('hub.intake.count', {
    surfaces: ['OPS_PORTAL'],
    activity: 'background',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  acquireLock(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
  ): Promise<HubIntakeView> {
    if (this.intakes === undefined) {
      return Promise.reject(new OperationUnavailableError('acquireIntakeLock'));
    }
    return this.intakes.acquireLock(authorized, correlation(), id);
  }
}
