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
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { MAX_PAGE_SIZE } from '../platform/http/pagination.js';
import { RUN_CUSTODY_HANDOVERS } from './fleet-providers.js';
import {
  RUN_CUSTODY_HANDOVER_PAGE_SCHEMA,
  RUN_CUSTODY_HANDOVER_SCHEMA,
} from './run-custody-handover-schemas.js';
import type { HandoverListFilter, RunCustodyHandovers } from './run-custody-handover.service.js';
import type { RunCustodyHandoverView } from './run-custody-handover-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): HandoverListFilter {
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
  const size = take('page_size');
  const pageToken = take('page_token');
  const manifestId = take('manifest_id');
  const state = take('state');
  return {
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
    ...(manifestId === undefined ? {} : { manifestId }),
    ...(state === undefined ? {} : { state }),
  };
}

/**
 * `GET /run-custody-handovers` and `GET /run-custody-handovers/{id}` (S1.24; `fleet.custody.read`): the custody handovers an actor is a party to, and
 * the one read of a handover whose `ETag` the acts on it take. They serve the Ops Portal and the Rider app, with a browser session or a rider
 * session and no synchronizer token (a safe read). **The scope is the database's and not a filter the caller passes**: a rider reads the handovers
 * it is a party to, as the one that hands over and as the one named to receive, and nothing of the run they are about; staff read the handovers of the
 * hubs of the grant. A named receiver learns of a handover here, because the apps are pull-only and no push exists for it.
 *
 * The read of one names its record by the path: `HUB_SCOPE_VIOLATION` for a staff caller on a handover of another hub, and `NOT_FOUND` for everyone
 * else, by one code path for a rider who is not a party to it and for an id that matches nothing.
 */
@Controller('run-custody-handovers')
export class RunCustodyHandoverReadsController {
  constructor(
    @Optional()
    @Inject(RUN_CUSTODY_HANDOVERS)
    private readonly custody: RunCustodyHandovers | undefined,
  ) {}

  @Get()
  @ContractOperation('listRunCustodyHandovers')
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiQuery({
    name: 'manifest_id',
    required: false,
    schema: { type: 'string', format: 'uuid' },
    description: 'Only the handovers of this run.',
  })
  @ApiQuery({
    name: 'state',
    required: false,
    schema: { type: 'string', enum: ['PENDING', 'COMPLETED', 'FAILED'] },
    description: 'Only the handovers in this state.',
  })
  @ApiResponse({ status: 200, schema: RUN_CUSTODY_HANDOVER_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'], ['riderSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('fleet.custody.read', {
    surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
    activity: 'qualifying',
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    readonly items: readonly RunCustodyHandoverView[];
    readonly next_page_token: string | null;
  }> {
    if (this.custody === undefined) {
      return Promise.reject(new OperationUnavailableError('listRunCustodyHandovers'));
    }
    return this.custody.list(authorized, correlation(), filterOf(query));
  }

  @Get(':id')
  @ContractOperation('getRunCustodyHandover')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: RUN_CUSTODY_HANDOVER_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'], ['riderSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('fleet.custody.read', {
    surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
    activity: 'qualifying',
    record: { entity: 'run_custody_handover', param: 'id' },
  })
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RunCustodyHandoverView> {
    if (this.custody === undefined) throw new OperationUnavailableError('getRunCustodyHandover');
    const read = await this.custody.get(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.handover;
  }
}
