import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Param, Query, Res } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

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
import { PICKUP_REQUEST_PAGE_SCHEMA, PICKUP_REQUEST_SCHEMA } from './pickup-request-schemas.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { CUTOFF_EXCEPTION_STATES } from './pickup-request.schema.js';
import { EXCEPTION_STATES } from './pickup-requests.service.js';
import { PICKUP_REQUESTS_SERVICE } from './pickup-requests-providers.js';
import type {
  PickupListFilter,
  PickupRequestsService,
  PickupRequestView,
} from './pickup-requests.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): PickupListFilter {
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
  const serviceDate = take('service_date');
  const manifested = take('manifested');
  const exceptionState = take('one_package_exception_state');
  const cutoffExceptionState = take('cutoff_exception_state');
  const hubId = take('hub_id');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(state === undefined ? {} : { state }),
    ...(serviceDate === undefined ? {} : { serviceDate }),
    ...(manifested === undefined ? {} : { manifested }),
    ...(exceptionState === undefined ? {} : { exceptionState }),
    ...(cutoffExceptionState === undefined ? {} : { cutoffExceptionState }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

/**
 * `GET /pickup-requests` and `GET /pickup-requests/{id}` (S1.13): the reads of pickup requests, for the queue and for the ETag a
 * mutation takes. Both require `pickup.read` (Ops Staff, Senior Ops and Platform Admin at their hubs; a Vendor for its own organisation),
 * serve the Ops Portal and the Vendor app, and take a browser session with no synchronizer token (a safe read). **They are not served to a
 * Rider** (task A3.1 of the audit follow-up, the Product Owner's decision of 7 November 2026; surfaces/rider-android.md: "Not a rider act ...
 * the rider reads the stop", and the registry gives a Rider no request): a Rider holds `pickup.read` for its assigned stops, but these routes
 * name neither the Rider surface nor the Rider's bearer credential, so a Rider's bearer is `SESSION_INVALID` here, as it is on every staff read.
 *
 * The read of one names its record by the path: whether the caller can see it is decided before the request is validated,
 * `HUB_SCOPE_VIOLATION` by the scope probe for a staff caller on a request of another hub, and `NOT_FOUND` for everyone else, by one
 * code path for a vendor asking for another's request and for an id that matches nothing (`AC-SLICE-001-79`).
 */
@Controller('pickup-requests')
export class PickupRequestsController {
  constructor(
    @Optional()
    @Inject(PICKUP_REQUESTS_SERVICE)
    private readonly service: PickupRequestsService | undefined,
  ) {}

  @Get()
  @ContractOperation('listPickupRequests')
  @ApiQuery({ name: 'state', required: false, schema: { type: 'string' } })
  @ApiQuery({ name: 'service_date', required: false, schema: { type: 'string', format: 'date' } })
  @ApiQuery({ name: 'manifested', required: false, schema: { type: 'boolean' } })
  @ApiQuery({
    name: 'one_package_exception_state',
    required: false,
    schema: { type: 'string', enum: [...EXCEPTION_STATES] },
  })
  @ApiQuery({
    name: 'cutoff_exception_state',
    required: false,
    schema: { type: 'string', enum: [...CUTOFF_EXCEPTION_STATES] },
  })
  @ApiQuery({ name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: PICKUP_REQUEST_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('pickup.read', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    readonly items: readonly PickupRequestView[];
    readonly next_page_token: string | null;
  }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listPickupRequests'));
    }
    return this.service.list(authorized, correlation(), filterOf(query));
  }

  @Get(':id')
  @ContractOperation('getPickupRequest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: PICKUP_REQUEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.read', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('getPickupRequest');
    const read = await this.service.get(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.request;
  }
}
