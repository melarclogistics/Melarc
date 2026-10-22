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
import {
  ETAG_HEADERS,
  MAX_PAGE_SIZE,
  MAX_SEARCH_LENGTH,
  STAFF_IDENTITY_PAGE_SCHEMA,
  STAFF_IDENTITY_SCHEMA,
} from './staff-identity-schemas.js';
import { STAFF_IDENTITIES_SERVICE } from './staff-identities-providers.js';
import type {
  StaffIdentitiesService,
  StaffIdentityView,
  StaffListFilter,
} from './staff-identities.service.js';
import { STAFF_STATUSES } from './staff-identity.schema.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): StaffListFilter {
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
 * `GET /staff-identities` and `GET /staff-identities/{id}` (S0.35): the reads of staff identities, for discovery and for the ETag a
 * staff-targeted mutation takes. Both require `staff.read` (Senior Ops at its hubs, Platform Admin; **not Ops Staff, by design**),
 * serve the Ops Portal alone, and take a browser session with no synchronizer token (a safe read). The read of one names its record by
 * the path: whether the caller can see it is decided before the request is validated, `HUB_SCOPE_VIOLATION` by the scope probe or
 * `NOT_FOUND`. A read the person makes by opening a screen is the person acting.
 */
@Controller('staff-identities')
export class StaffIdentitiesController {
  constructor(
    @Optional()
    @Inject(STAFF_IDENTITIES_SERVICE)
    private readonly service: StaffIdentitiesService | undefined,
  ) {}

  @Get()
  @ContractOperation('listStaffIdentities')
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...STAFF_STATUSES] },
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
  @ApiResponse({ status: 200, schema: STAFF_IDENTITY_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('staff.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    readonly items: readonly StaffIdentityView[];
    readonly next_page_token: string | null;
  }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listStaffIdentities'));
    }
    return this.service.list(authorized, correlation(), filterOf(query));
  }

  @Get(':id')
  @ContractOperation('getStaffIdentity')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: STAFF_IDENTITY_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @RequiresPermission('staff.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'staff_identity', param: 'id' },
  })
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffIdentityView> {
    if (this.service === undefined) throw new OperationUnavailableError('getStaffIdentity');
    const read = await this.service.get(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.identity;
  }
}
