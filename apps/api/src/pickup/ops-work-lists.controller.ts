import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';

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
import {
  COLLECTION_DISPUTE_PAGE_SCHEMA,
  COLLECTION_SHORTFALL_PAGE_SCHEMA,
  OPS_HANDSHAKE_PAGE_SCHEMA,
  PICKUP_FAILURE_PAGE_SCHEMA,
} from './ops-work-list-schemas.js';
import type {
  CollectionDisputeView,
  CollectionShortfallView,
  OpsHandshakeView,
  PickupFailureView,
} from './ops-work-list-views.js';
import { PICKUP_OPS_WORK_LISTS } from './ops-work-lists-providers.js';
import type { PickupOpsWorkLists, WorkListFilter, WorkListPage } from './ops-work-lists.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): WorkListFilter {
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
  const open = take('open');
  const hubId = take('hub_id');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(open === undefined ? {} : { open }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

/**
 * The Ops work lists of the collection and the failure (D-A3, OB-S1-70; plan S1.30): `GET /collection-disputes`, `GET /handshakes-for-ops`,
 * `GET /collection-shortfalls` and `GET /pickup-failures`. Each is a list for the Ops Portal's staff alone, under an existing key (`pickup.read`,
 * `pickup.handshake.override` for the two of the door, `pickup.failure.resolve` for the decision queue), by the hubs of the session's grant, and takes a browser
 * session with no synchronizer token (a safe read). A vendor and a rider are refused by the surface and again by the service. The filters are the same four
 * for each: `open`, `hub_id`, `page_size` and `page_token`.
 */
@Controller()
export class OpsWorkListsController {
  constructor(
    @Optional()
    @Inject(PICKUP_OPS_WORK_LISTS)
    private readonly lists: PickupOpsWorkLists | undefined,
  ) {}

  @Get('collection-disputes')
  @ContractOperation('listCollectionDisputes')
  @ApiQuery({ name: 'open', required: false, schema: { type: 'boolean' } })
  @ApiQuery({ name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: COLLECTION_DISPUTE_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('pickup.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  listDisputes(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<WorkListPage<CollectionDisputeView>> {
    if (this.lists === undefined) {
      return Promise.reject(new OperationUnavailableError('listCollectionDisputes'));
    }
    return this.lists.listCollectionDisputes(authorized, correlation(), filterOf(query));
  }

  @Get('handshakes-for-ops')
  @ContractOperation('listHandshakesForOps')
  @ApiQuery({ name: 'open', required: false, schema: { type: 'boolean' } })
  @ApiQuery({ name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: OPS_HANDSHAKE_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('pickup.handshake.override', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
  })
  listHandshakes(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<WorkListPage<OpsHandshakeView>> {
    if (this.lists === undefined) {
      return Promise.reject(new OperationUnavailableError('listHandshakesForOps'));
    }
    return this.lists.listHandshakesForOps(authorized, correlation(), filterOf(query));
  }

  @Get('collection-shortfalls')
  @ContractOperation('listCollectionShortfalls')
  @ApiQuery({ name: 'open', required: false, schema: { type: 'boolean' } })
  @ApiQuery({ name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: COLLECTION_SHORTFALL_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('pickup.handshake.override', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
  })
  listShortfalls(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<WorkListPage<CollectionShortfallView>> {
    if (this.lists === undefined) {
      return Promise.reject(new OperationUnavailableError('listCollectionShortfalls'));
    }
    return this.lists.listCollectionShortfalls(authorized, correlation(), filterOf(query));
  }

  @Get('pickup-failures')
  @ContractOperation('listPickupFailures')
  @ApiQuery({ name: 'open', required: false, schema: { type: 'boolean' } })
  @ApiQuery({ name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: PICKUP_FAILURE_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('pickup.failure.resolve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
  })
  listFailures(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<WorkListPage<PickupFailureView>> {
    if (this.lists === undefined) {
      return Promise.reject(new OperationUnavailableError('listPickupFailures'));
    }
    return this.lists.listPickupFailures(authorized, correlation(), filterOf(query));
  }
}
