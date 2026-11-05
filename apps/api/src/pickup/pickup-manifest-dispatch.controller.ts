import { randomUUID } from 'node:crypto';

import { Controller, Headers, HttpCode, Inject, Optional, Param, Post, Res } from '@nestjs/common';
import { ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import type { PickupManifestDispatch } from './pickup-manifest-dispatch.service.js';
import { PICKUP_MANIFEST_DISPATCH } from './pickup-manifests-providers.js';
import { PICKUP_MANIFEST_SCHEMA } from './pickup-manifest-schemas.js';
import type { PickupManifestView } from './pickup-manifest-view.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-manifests/{id}/dispatch` (S1.21): Ops sends a draft manifest out to its rider. It serves the Ops Portal alone, takes a
 * browser session with its synchronizer token and the `If-Match` of the manifest's read (its `ETag` digests the stops), takes no body and
 * no `Idempotency-Key` (a second dispatch of a manifest that has gone out is `STATE_CONFLICT`, and a retry after a lost answer reads the
 * manifest again), answers `200` with the manifest, its stops, the summary each stop to be worked now carries and the new `ETag`, and a
 * rider, a vendor and a caller without `pickup.manifest.dispatch` are `PERMISSION_DENIED` at the guard. The manifest the path names is
 * found or refused (`HUB_SCOPE_VIOLATION` for a manifest of another hub, `NOT_FOUND` for an id that matches nothing) before the request
 * is validated.
 */
@Controller('pickup-manifests')
export class PickupManifestDispatchController {
  constructor(
    @Optional()
    @Inject(PICKUP_MANIFEST_DISPATCH)
    private readonly dispatching: PickupManifestDispatch | undefined,
  ) {}

  @Post(':id/dispatch')
  @HttpCode(200)
  @ContractOperation('dispatchManifest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiResponse({ status: 200, schema: PICKUP_MANIFEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.ManifestEmpty,
    ErrorCode.NoServiceableMotorcycle,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.RateLimited,
    ErrorCode.RiderUnavailable,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.manifest.dispatch', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_manifest', param: 'id' },
    providerInitiating: true,
  })
  async dispatch(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupManifestView> {
    if (this.dispatching === undefined) throw new OperationUnavailableError('dispatchManifest');
    const dispatched = await this.dispatching.dispatch(authorized, correlation(), id, { ifMatch });
    response.setHeader('ETag', dispatched.etag);
    return dispatched.manifest;
  }
}
