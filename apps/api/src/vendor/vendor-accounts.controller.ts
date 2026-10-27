import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Param, Query, Res } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { VENDOR_ACCOUNT_STATUSES } from '../platform/auth/vendor/vendor-vocabulary.js';
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
import { ETAG_HEADERS, MAX_PAGE_SIZE, MAX_SEARCH_LENGTH } from '../staff/staff-identity-schemas.js';
import {
  VENDOR_ACCOUNT_DETAIL_SCHEMA,
  VENDOR_ACCOUNT_PAGE_SCHEMA,
} from './vendor-account-schemas.js';
import { VENDOR_ACCOUNTS_SERVICE } from './vendor-accounts-providers.js';
import type {
  RegisteredDeviceView,
  VendorAccountsService,
  VendorAccountView,
  VendorListFilter,
} from './vendor-accounts.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): VendorListFilter {
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
 * `GET /ops/vendors` and `GET /ops/vendors/{id}` (S0.47a): the reads an officer finds the target of a vendor credential operation with,
 * and the ETag that operation takes. Both require `vendor.read` (Ops Staff and Senior Ops at their hubs, Platform Admin and Finance at
 * every hub), serve the Ops Portal alone and take a browser session with no synchronizer token (a safe read). The read of one names its
 * record by the path: whether the caller can see it is decided before the request is validated, `HUB_SCOPE_VIOLATION` by the scope probe
 * (the account's hub is its organisation's) or `NOT_FOUND`.
 */
@Controller('ops/vendors')
export class VendorAccountsController {
  constructor(
    @Optional()
    @Inject(VENDOR_ACCOUNTS_SERVICE)
    private readonly service: VendorAccountsService | undefined,
  ) {}

  @Get()
  @ContractOperation('listVendorAccounts')
  @ApiQuery({
    name: 'status',
    required: false,
    schema: { type: 'string', enum: [...VENDOR_ACCOUNT_STATUSES] },
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
  @ApiResponse({ status: 200, schema: VENDOR_ACCOUNT_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('vendor.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    readonly items: readonly VendorAccountView[];
    readonly next_page_token: string | null;
  }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listVendorAccounts'));
    }
    return this.service.list(authorized, correlation(), filterOf(query));
  }

  @Get(':id')
  @ContractOperation('getVendorAccount')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: VENDOR_ACCOUNT_DETAIL_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @RequiresPermission('vendor.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'vendor_account', param: 'id' },
  })
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{
    readonly account: VendorAccountView;
    readonly devices: readonly RegisteredDeviceView[];
  }> {
    if (this.service === undefined) throw new OperationUnavailableError('getVendorAccount');
    const read = await this.service.get(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.detail;
  }
}
