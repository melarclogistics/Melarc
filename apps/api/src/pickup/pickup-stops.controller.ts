import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Param, Res } from '@nestjs/common';
import { ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { PICKUP_STOP_SCHEMA } from './pickup-manifest-schemas.js';
import { PICKUP_MANIFESTS_SERVICE } from './pickup-manifests-providers.js';
import type { PickupManifestsService, PickupStopView } from './pickup-manifests.service.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `GET /pickup-stops/{id}` (S1.22): one stop and the `ETag` that the stop's operations take as `If-Match`. It requires `pickup.read` and serves
 * the Ops Portal and the Rider app, with a browser session or a rider session and no synchronizer token (a safe read). The stop is read in the
 * caller's own context, so what a caller sees of stops is what it sees of manifests: staff by the hubs of the grant, a rider by assignment from
 * dispatch. Whether the caller can see the record is decided before the request is validated: `HUB_SCOPE_VIOLATION` by the scope probe for a
 * staff caller on a stop of another hub, and `NOT_FOUND` for everyone else and for an id that matches nothing, by one code path. A vendor
 * session is `PERMISSION_DENIED` at the guard: the vendor's read of its own stop is a deferred capability (OB-S1-23).
 */
@Controller('pickup-stops')
export class PickupStopsController {
  constructor(
    @Optional()
    @Inject(PICKUP_MANIFESTS_SERVICE)
    private readonly service: PickupManifestsService | undefined,
  ) {}

  @Get(':id')
  @ContractOperation('getPickupStop')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: PICKUP_STOP_SCHEMA, headers: ETAG_HEADERS })
  @DescribeSecurity(['browserSession'], ['riderSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.read', {
    surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
    activity: 'qualifying',
    record: { entity: 'pickup_stop', param: 'id' },
  })
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupStopView> {
    if (this.service === undefined) throw new OperationUnavailableError('getPickupStop');
    const read = await this.service.getStop(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.stop;
  }
}
