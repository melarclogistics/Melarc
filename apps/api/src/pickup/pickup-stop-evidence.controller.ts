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
import { PICKUP_STOP_EVIDENCE } from './pickup-stop-evidence-providers.js';
import { STOP_EVIDENCE_LIST_SCHEMA } from './pickup-stop-evidence-schemas.js';
import type { StopEvidenceFilter, PickupStopEvidence } from './pickup-stop-evidence.service.js';
import { STOP_EVIDENCE_PURPOSES, type StopEvidenceListView } from './pickup-stop-evidence-views.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): StopEvidenceFilter {
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
  const purpose = take('purpose');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(purpose === undefined ? {} : { purpose }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

/**
 * `GET /pickup-stops/{id}/evidence` (S1.30; the Product Owner's decision D-A10): the evidence of a stop with the progress of its parcel photos and the exception that let its count
 * through without them. It requires `pickup.read` and serves the Ops Portal's staff alone, with a browser session and no synchronizer token (a safe read). Whether the caller may see the
 * stop is decided before the request is validated, as for `getPickupStop`: `HUB_SCOPE_VIOLATION` by the scope probe for a staff caller on a stop of another hub, `NOT_FOUND` for an id that
 * matches nothing. A vendor and a rider are `PERMISSION_DENIED` at the guard.
 */
@Controller('pickup-stops')
export class PickupStopEvidenceController {
  constructor(
    @Optional()
    @Inject(PICKUP_STOP_EVIDENCE)
    private readonly evidence: PickupStopEvidence | undefined,
  ) {}

  @Get(':id/evidence')
  @ContractOperation('listPickupStopEvidence')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'purpose',
    required: false,
    schema: { type: 'string', enum: [...STOP_EVIDENCE_PURPOSES] },
  })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: STOP_EVIDENCE_LIST_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_stop', param: 'id' },
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<StopEvidenceListView> {
    if (this.evidence === undefined) {
      return Promise.reject(new OperationUnavailableError('listPickupStopEvidence'));
    }
    return this.evidence.list(authorized, correlation(), id, filterOf(query));
  }
}
