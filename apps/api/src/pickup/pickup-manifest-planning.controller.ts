import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Put,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import {
  MANIFEST_CANCEL_BODY,
  MANIFEST_STOP_ORDER_BODY,
  RIDER_ASSIGNMENT_BODY,
} from './pickup-manifest-planning-schemas.js';
import type { PickupManifestPlanning } from './pickup-manifest-planning.service.js';
import { PICKUP_MANIFEST_PLANNING } from './pickup-manifests-providers.js';
import { PICKUP_MANIFEST_SCHEMA } from './pickup-manifest-schemas.js';
import type { PickupManifestView } from './pickup-manifest-view.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `PUT /pickup-manifests/{id}/stops`, `POST /pickup-manifests/{id}/assign-rider` and `POST /pickup-manifests/{id}/cancel` (S1.21): Ops
 * orders, gives a rider to, and cancels a manifest before it goes out. They serve the Ops Portal alone, take a browser session with its
 * synchronizer token and the `If-Match` of the manifest's read (its `ETag` digests the stops), answer `200` with the manifest, its stops
 * and the new `ETag`, and a rider, a vendor and a caller without the permission are `PERMISSION_DENIED` at the guard.
 *
 * The ordering and the cancellation require `pickup.manifest.create` and take an `Idempotency-Key`; the assignment requires
 * `pickup.manifest.assign` (a different key held by the same actors, so that assigning is its own grant) and takes none. The manifest the
 * path names is found or refused (`HUB_SCOPE_VIOLATION` for a manifest of another hub, `NOT_FOUND` for an id that matches nothing) before
 * the request is validated.
 */
@Controller('pickup-manifests')
export class PickupManifestPlanningController {
  constructor(
    @Optional()
    @Inject(PICKUP_MANIFEST_PLANNING)
    private readonly planning: PickupManifestPlanning | undefined,
  ) {}

  @Put(':id/stops')
  @HttpCode(200)
  @ContractOperation('setManifestStopOrder')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: MANIFEST_STOP_ORDER_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_MANIFEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.manifest.create', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_manifest', param: 'id' },
  })
  async setStopOrder(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: { readonly ordered_stop_ids: readonly string[] },
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupManifestView> {
    if (this.planning === undefined) throw new OperationUnavailableError('setManifestStopOrder');
    const planned = await this.planning.setStopOrder(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'setManifestStopOrder'),
    });
    response.setHeader('ETag', planned.etag);
    return planned.manifest;
  }

  @Post(':id/assign-rider')
  @HttpCode(200)
  @ContractOperation('assignRider')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: RIDER_ASSIGNMENT_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_MANIFEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NoServiceableMotorcycle,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.RiderUnavailable,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.manifest.assign', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_manifest', param: 'id' },
  })
  async assignRider(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: { readonly rider_id: string },
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupManifestView> {
    if (this.planning === undefined) throw new OperationUnavailableError('assignRider');
    const planned = await this.planning.assignRider(authorized, correlation(), id, {
      body,
      ifMatch,
    });
    response.setHeader('ETag', planned.etag);
    return planned.manifest;
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ContractOperation('cancelPickupManifest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: MANIFEST_CANCEL_BODY })
  @ApiResponse({ status: 200, schema: PICKUP_MANIFEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.RunAlreadyStarted,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.manifest.create', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_manifest', param: 'id' },
  })
  async cancel(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: { readonly note: string },
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupManifestView> {
    if (this.planning === undefined) throw new OperationUnavailableError('cancelPickupManifest');
    const planned = await this.planning.cancel(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'cancelPickupManifest'),
    });
    response.setHeader('ETag', planned.etag);
    return planned.manifest;
  }
}
