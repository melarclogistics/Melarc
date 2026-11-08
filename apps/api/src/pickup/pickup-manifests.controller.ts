import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IDEMPOTENCY_KEY_SCHEMA } from '../platform/http/contract-headers.js';
import { PICKUP_MANIFEST_STATES } from './pickup-manifest.schema.js';
import type {
  CreateManifestBody,
  PickupManifestCreation,
} from './pickup-manifest-creation.service.js';
import {
  PICKUP_MANIFEST_CREATE_BODY,
  PICKUP_MANIFEST_PAGE_SCHEMA,
  PICKUP_MANIFEST_SCHEMA,
} from './pickup-manifest-schemas.js';
import {
  PICKUP_MANIFEST_CREATION,
  PICKUP_MANIFESTS_SERVICE,
} from './pickup-manifests-providers.js';
import type {
  PickupManifestListFilter,
  PickupManifestsService,
  PickupManifestView,
} from './pickup-manifests.service.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { MAX_PAGE_SIZE } from '../platform/http/pagination.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): PickupManifestListFilter {
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
  const state = take('state');
  const serviceDate = take('service_date');
  return {
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
    ...(state === undefined ? {} : { state }),
    ...(serviceDate === undefined ? {} : { serviceDate }),
  };
}

/**
 * `POST /pickup-manifests`, `GET /pickup-manifests` and `GET /pickup-manifests/{id}` (S1.20): Ops builds a `DRAFT` manifest from
 * confirmed, unmanifested requests, and reads manifests; a rider reads the ones assigned to it once they are dispatched. A manifest is
 * never vendor-owned and never read by a vendor (the registry's vendor read of its own stop is a deferred capability, OB-S1-23), so no
 * route here serves the Vendor app: a vendor session is `PERMISSION_DENIED` at the guard, and row-level security shows it nothing even if
 * a route were added.
 *
 * Creation requires `pickup.manifest.create` (Ops Staff, Senior Ops and Platform Admin at their hubs), serves the Ops Portal alone, takes
 * a browser session with its synchronizer token and an `Idempotency-Key` (a retry must not claim a request twice), and answers `201` with
 * the new manifest, its stops and the version it can be changed with. The reads require `pickup.read`, serve the Ops Portal and the Rider
 * app, and take a browser session or a rider session with no synchronizer token (a safe read).
 *
 * The read of one names its record by the path: whether the caller can see it is decided before the request is validated,
 * `HUB_SCOPE_VIOLATION` by the scope probe for a staff caller on a manifest of another hub, and `NOT_FOUND` for everyone else, by one code
 * path for a rider asking for a colleague's run (or one not yet dispatched) and for an id that matches nothing.
 */
@Controller('pickup-manifests')
export class PickupManifestsController {
  constructor(
    @Optional()
    @Inject(PICKUP_MANIFEST_CREATION)
    private readonly creation: PickupManifestCreation | undefined,
    @Optional()
    @Inject(PICKUP_MANIFESTS_SERVICE)
    private readonly service: PickupManifestsService | undefined,
  ) {}

  @Post()
  @ContractOperation('createPickupManifest')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: PICKUP_MANIFEST_CREATE_BODY })
  @ApiResponse({ status: 201, schema: PICKUP_MANIFEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.AlreadyManifested,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.manifest.create', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
  })
  async create(
    @Authorized() authorized: AuthorizedRequest,
    @Body() body: CreateManifestBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupManifestView> {
    if (this.creation === undefined) throw new OperationUnavailableError('createPickupManifest');
    const made = await this.creation.create(authorized, correlation(), {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'createPickupManifest'),
    });
    response.setHeader('ETag', made.etag);
    return made.manifest;
  }

  @Get()
  @ContractOperation('listPickupManifests')
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiQuery({
    name: 'state',
    required: false,
    schema: { type: 'string', enum: [...PICKUP_MANIFEST_STATES] },
    description: 'Only the manifests in this state.',
  })
  @ApiQuery({
    name: 'service_date',
    required: false,
    schema: { type: 'string', format: 'date' },
    description:
      "Only the manifests worked on this day: their `service_date`, a day of the hub's calendar (`YYYY-MM-DD`).",
  })
  @ApiResponse({ status: 200, schema: PICKUP_MANIFEST_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'], ['riderSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('pickup.read', {
    surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
    activity: 'qualifying',
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    readonly items: readonly PickupManifestView[];
    readonly next_page_token: string | null;
  }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listPickupManifests'));
    }
    return this.service.list(authorized, correlation(), filterOf(query));
  }

  @Get(':id')
  @ContractOperation('getPickupManifest')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: PICKUP_MANIFEST_SCHEMA, headers: ETAG_HEADERS })
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
    record: { entity: 'pickup_manifest', param: 'id' },
  })
  async getOne(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupManifestView> {
    if (this.service === undefined) throw new OperationUnavailableError('getPickupManifest');
    const read = await this.service.get(authorized, correlation(), id);
    response.setHeader('ETag', read.etag);
    return read.manifest;
  }
}
