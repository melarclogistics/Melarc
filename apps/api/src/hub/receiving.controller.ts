import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Param, Query } from '@nestjs/common';
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
import { HUB_RECEIVING_READS } from './hub-providers.js';
import type {
  MissingParcelView,
  ReceivingListFilter,
  ReceivingPage,
  ReceivingReads,
  ReceivingRunSummaryView,
  ReceivingRunView,
} from './receiving-reads.service.js';
import {
  MISSING_PARCEL_PAGE_SCHEMA,
  RECEIVING_RUN_PAGE_SCHEMA,
  RECEIVING_RUN_SCHEMA,
} from './receiving-schemas.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): ReceivingListFilter {
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
  const hubId = take('hub_id');
  const q = take('q');
  const view = take('view');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(hubId === undefined ? {} : { hubId }),
    ...(q === undefined ? {} : { q }),
    ...(view === undefined ? {} : { view }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

const HUB_ID_QUERY = { name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } } as const;
const PAGE_SIZE_QUERY = {
  name: 'page_size',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
} as const;
const PAGE_TOKEN_QUERY = { name: 'page_token', required: false, schema: { type: 'string' } } as const;

/**
 * The receiving side's reads by run (Run D, S1.35b; D-D2, D-D4; features/hub/hub-intake.md sections 5.1 and 5.6): `GET /receiving-runs` (the queue by run), `GET /receiving-runs/{manifest_id}` (a run's
 * page: its vendors, their door photos and their parcels) and `GET /missing-parcels` (the list *Missing - being searched for*). Each is for the Ops Portal's staff alone, under `hub.read`, by the hubs of the
 * session's grant, and is a safe read with no synchronizer token. **Names, never numbers**: a rider, a vendor and an officer are said by display name, and no phone number is in any answer.
 */
@Controller()
export class ReceivingController {
  constructor(
    @Optional()
    @Inject(HUB_RECEIVING_READS)
    private readonly reads: ReceivingReads | undefined,
  ) {}

  @Get('receiving-runs')
  @ContractOperation('listReceivingRuns')
  @ApiQuery(HUB_ID_QUERY)
  @ApiQuery({
    name: 'q',
    required: false,
    schema: { type: 'string', minLength: 2, maxLength: 64 },
  })
  @ApiQuery({
    name: 'view',
    required: false,
    schema: { type: 'string', enum: ['waiting', 'needs_decision', 'all'], default: 'waiting' },
  })
  @ApiQuery(PAGE_SIZE_QUERY)
  @ApiQuery(PAGE_TOKEN_QUERY)
  @ApiResponse({ status: 200, schema: RECEIVING_RUN_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('hub.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  listRuns(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<ReceivingPage<ReceivingRunSummaryView>> {
    if (this.reads === undefined) {
      return Promise.reject(new OperationUnavailableError('listReceivingRuns'));
    }
    return this.reads.listRuns(authorized, correlation(), filterOf(query));
  }

  @Get('receiving-runs/:manifest_id')
  @ContractOperation('getReceivingRun')
  @ApiParam({ name: 'manifest_id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: RECEIVING_RUN_SCHEMA })
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
    record: { entity: 'pickup_manifest', param: 'manifest_id' },
  })
  getRun(
    @Authorized() authorized: AuthorizedRequest,
    @Param('manifest_id') manifestId: string,
  ): Promise<ReceivingRunView> {
    if (this.reads === undefined) {
      return Promise.reject(new OperationUnavailableError('getReceivingRun'));
    }
    return this.reads.getRun(authorized, correlation(), manifestId);
  }

  @Get('missing-parcels')
  @ContractOperation('listMissingParcels')
  @ApiQuery(HUB_ID_QUERY)
  @ApiQuery({
    name: 'view',
    required: false,
    schema: { type: 'string', enum: ['searching', 'vendor_to_tell'], default: 'searching' },
  })
  @ApiQuery(PAGE_SIZE_QUERY)
  @ApiQuery(PAGE_TOKEN_QUERY)
  @ApiResponse({ status: 200, schema: MISSING_PARCEL_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('hub.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  listMissing(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<ReceivingPage<MissingParcelView>> {
    if (this.reads === undefined) {
      return Promise.reject(new OperationUnavailableError('listMissingParcels'));
    }
    return this.reads.listMissing(authorized, correlation(), filterOf(query));
  }
}
