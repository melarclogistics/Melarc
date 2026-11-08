import { randomUUID } from 'node:crypto';

import { Body, Controller, Headers, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiResponse } from '@nestjs/swagger';
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
import { IDEMPOTENCY_KEY_SCHEMA } from '../platform/http/contract-headers.js';
import { PICKUP_REQUEST_CREATE_BODY, PICKUP_REQUEST_SCHEMA } from './pickup-request-schemas.js';
import { ETAG_HEADERS } from '../platform/http/contract-headers.js';
import { PICKUP_REQUEST_CREATION } from './pickup-requests-providers.js';
import type { CreatePickupBody, PickupRequestCreation } from './pickup-request-creation.service.js';
import type { PickupRequestView } from './pickup-request-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-requests` (S1.14): the booking, by Ops or by a vendor for itself. It requires `pickup.request.create` (Ops Staff, Senior
 * Ops and Platform Admin at their hubs; a Vendor for its own organisation), serves the Ops Portal and the Vendor app, takes a browser
 * session with its synchronizer token and an `Idempotency-Key` (a retry from a phone on mobile data must not book twice), and answers
 * `201` with the new `PENDING` request, its indicative estimate and the version it can be confirmed with. Where the application is
 * composed without what the service needs, it fails closed (`503`).
 */
@Controller('pickup-requests')
export class PickupRequestCreationController {
  constructor(
    @Optional()
    @Inject(PICKUP_REQUEST_CREATION)
    private readonly service: PickupRequestCreation | undefined,
  ) {}

  @Post()
  @ContractOperation('createPickupRequest')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: PICKUP_REQUEST_CREATE_BODY })
  @ApiResponse({ status: 201, schema: PICKUP_REQUEST_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CorridorDayNotPermitted,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.DestinationUnresolved,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.PermissionDenied,
    ErrorCode.PickupMinimumNotMet,
    ErrorCode.SenderIdentityAmbiguous,
    ErrorCode.SenderSuspended,
    ErrorCode.ServiceDateNotPermitted,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
    ErrorCode.ValueDeclarationRequired,
    ErrorCode.ZoneNotServicedOnDate,
  )
  @RequiresPermission('pickup.request.create', {
    surfaces: ['OPS_PORTAL', 'VENDOR_PWA'],
    activity: 'qualifying',
  })
  async create(
    @Authorized() authorized: AuthorizedRequest,
    @Body() body: CreatePickupBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<PickupRequestView> {
    if (this.service === undefined) throw new OperationUnavailableError('createPickupRequest');
    const made = await this.service.create(authorized, correlation(), {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'createPickupRequest'),
    });
    response.setHeader('ETag', made.etag);
    return made.request;
  }
}
