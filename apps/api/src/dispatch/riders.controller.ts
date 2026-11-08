import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Param, Query, Res } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { RIDER_STATUSES } from '../platform/auth/rider/rider-vocabulary.js';
import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { RIDER_DETAIL_SCHEMA, RIDER_PAGE_SCHEMA } from '../staff/rider-schemas.js';
import { ETAG_HEADERS, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH } from '../staff/staff-identity-schemas.js';
import { RIDERS_SERVICE } from './riders-providers.js';
import type {
  RiderDeviceView,
  RiderListFilter,
  RiderView,
  RidersService,
} from './riders.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): RiderListFilter {
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
  const status = take('status');
  const hubId = take('hub_id');
  const q = take('q');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(status === undefined ? {} : { status }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(q === undefined ? {} : { q }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

/**
 * `GET /ops/riders` and `GET /ops/riders/{riderId}` (S0.53a): the reads an officer finds the target of a device operation with, and the
 * ETag that `reregisterRiderDevice` takes. Both require `dispatch.read` (Ops Staff, Senior Ops and Platform Admin at their hubs), serve the
 * Ops Portal alone and take a browser session with no synchronizer token (a safe read): **the Rider bundle holds `dispatch.read` as well,
 * and a rider's bearer credential is refused all the same**, so the roster is never reachable from a handset: an operation that serves the
 * browser takes no bearer credential, and answers one as a request with no usable session (`401 SESSION_INVALID`, S0.25), as every Ops-only
 * operation does. A Vendor's browser session is authenticated and refused by the surface gate (`403 PERMISSION_DENIED`). The read of one
 * names its record by the path: whether the caller can see it is decided before the request is validated, `HUB_SCOPE_VIOLATION` by the scope
 * probe or `NOT_FOUND`.
 */
@Controller('ops/riders')
export class RidersController {
  constructor(
    @Optional()
    @Inject(RIDERS_SERVICE)
    private readonly service: RidersService | undefined,
  ) {}

  @Get()
  @ContractOperation('listRiders')
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...RIDER_STATUSES] },
  })
  @ApiQuery({ name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'q',
    required: false,
    schema: { type: 'string', maxLength: MAX_SEARCH_LENGTH },
  })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: RIDER_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('dispatch.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{ readonly items: readonly RiderView[]; readonly next_page_token: string | null }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listRiders'));
    }
    return this.service.list(authorized, correlation(), filterOf(query));
  }

  @Get(':riderId')
  @ContractOperation('getRider')
  @ApiParam({ name: 'riderId', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: RIDER_DETAIL_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @RequiresPermission('dispatch.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'rider_identity', param: 'riderId' },
  })
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('riderId') riderId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ readonly rider: RiderView; readonly devices: readonly RiderDeviceView[] }> {
    if (this.service === undefined) throw new OperationUnavailableError('getRider');
    const read = await this.service.get(authorized, correlation(), riderId);
    response.setHeader('ETag', read.etag);
    return read.detail;
  }
}
