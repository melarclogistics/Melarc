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
  Req,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { IDEMPOTENCY_KEY_SCHEMA } from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeServers, RIDER_SERVERS } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import type {
  Handshakes,
  OverrideBody,
  ResolveBody,
  SmsFallbackBody,
  VerifyBody,
} from './collection-handshake.service.js';
import {
  HANDSHAKE_ISSUED_SCHEMA,
  HANDSHAKE_OVERRIDE_BODY,
  HANDSHAKE_RESOLVE_BODY,
  HANDSHAKE_SCHEMA,
  HANDSHAKE_VERIFY_BODY,
  SMS_FALLBACK_REQUEST_BODY,
} from './handshake-schemas.js';
import type { HandshakeIssuedView, HandshakeView } from './handshake-view.js';
import { PICKUP_HANDSHAKES } from './pickup-manifests-providers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The collection handshake's five routes (S1.27), all on a stop: `POST /pickup-stops/{id}/handshake` (the rider asks for the code of a stop it
 * counted), `/handshake/verify` (the vendor enters the code its rider shows, or the rider enters the code the sender or the vendor read out),
 * `/handshake/sms-fallback` (the rider, when the portal path is unusable), `/handshake/ops-override` and `/handshake/resolve` (Ops, when the ladder
 * has failed or the code has run out). The first three serve the Rider app (and, for entering a code, the Vendor app) and require
 * `pickup.collection.confirm`; the last two serve the Ops Portal alone and require `pickup.handshake.override` and `pickup.handshake.resolve`. The
 * stop the path names is, for Ops, found or refused (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`) before the request is validated; for a rider or a vendor an id
 * that is not theirs answers as the operation says (`NOT_ASSIGNED_RIDER`, `NOT_FOUND`), the same as an id that matches nothing.
 *
 * **The code is in the answer of `initiateHandshake` and nowhere else**: no other answer, log, metric or event repeats it.
 */
@Controller('pickup-stops')
export class CollectionHandshakeController {
  constructor(
    @Optional()
    @Inject(PICKUP_HANDSHAKES)
    private readonly handshakes: Handshakes | undefined,
  ) {}

  @Post(':id/handshake')
  @HttpCode(201)
  @ContractOperation('initiateHandshake')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiResponse({ status: 201, schema: HANDSHAKE_ISSUED_SCHEMA })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CollectionNotRecorded,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.ManifestNotStarted,
    ErrorCode.NotAssignedRider,
    ErrorCode.PermissionDenied,
    ErrorCode.RateLimited,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.collection.confirm', {
    surfaces: ['RIDER_ANDROID'],
    activity: 'qualifying',
    providerInitiating: true,
  })
  async initiate(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<HandshakeIssuedView> {
    if (this.handshakes === undefined) throw new OperationUnavailableError('initiateHandshake');
    const issued = await this.handshakes.initiate(authorized, correlation(), id.toLowerCase(), {
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'initiateHandshake'),
    });
    return issued.handshake;
  }

  @Post(':id/handshake/verify')
  @HttpCode(200)
  @ContractOperation('verifyHandshake')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: HANDSHAKE_VERIFY_BODY })
  @ApiResponse({ status: 200, schema: HANDSHAKE_SCHEMA })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.AttemptsExhausted,
    ErrorCode.CodeExpired,
    ErrorCode.CodeInvalid,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.NotAssignedRider,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.collection.confirm', {
    surfaces: ['VENDOR_PWA', 'RIDER_ANDROID'],
    activity: 'qualifying',
  })
  async verify(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: VerifyBody,
  ): Promise<HandshakeView> {
    if (this.handshakes === undefined) throw new OperationUnavailableError('verifyHandshake');
    const verified = await this.handshakes.verify(
      authorized,
      correlation(),
      id.toLowerCase(),
      body,
    );
    return verified.handshake;
  }

  @Post(':id/handshake/sms-fallback')
  @HttpCode(202)
  @ContractOperation('requestSmsHandshakeFallback')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: SMS_FALLBACK_REQUEST_BODY })
  @ApiResponse({ status: 202, schema: HANDSHAKE_SCHEMA })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CollectionNotRecorded,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.ManifestNotStarted,
    ErrorCode.NoRegisteredNumber,
    ErrorCode.NotAssignedRider,
    ErrorCode.PermissionDenied,
    ErrorCode.RateLimited,
    ErrorCode.SessionInvalid,
    ErrorCode.SmsFallbackLimitReached,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.collection.confirm', {
    surfaces: ['RIDER_ANDROID'],
    activity: 'qualifying',
    providerInitiating: true,
  })
  async smsFallback(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: SmsFallbackBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<HandshakeView> {
    if (this.handshakes === undefined) {
      throw new OperationUnavailableError('requestSmsHandshakeFallback');
    }
    const sent = await this.handshakes.requestSmsFallback(
      authorized,
      correlation(),
      id.toLowerCase(),
      {
        body,
        idempotencyKey,
        fingerprint: fingerprintOfRequest(request, 'requestSmsHandshakeFallback'),
      },
    );
    return sent.handshake;
  }

  @Post(':id/handshake/ops-override')
  @HttpCode(200)
  @ContractOperation('authoriseHandshakeOverride')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: HANDSHAKE_OVERRIDE_BODY })
  @ApiResponse({ status: 200, schema: HANDSHAKE_SCHEMA })
  @DescribeErrors(
    ErrorCode.CollectionNotRecorded,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.handshake.override', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_stop', param: 'id' },
  })
  async authoriseOverride(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: OverrideBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<HandshakeView> {
    if (this.handshakes === undefined) {
      throw new OperationUnavailableError('authoriseHandshakeOverride');
    }
    const authorised = await this.handshakes.authoriseOverride(authorized, correlation(), id, {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'authoriseHandshakeOverride'),
    });
    return authorised.handshake;
  }

  @Post(':id/handshake/resolve')
  @HttpCode(200)
  @ContractOperation('resolveHandshake')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: HANDSHAKE_RESOLVE_BODY })
  @ApiResponse({ status: 200, schema: HANDSHAKE_SCHEMA })
  @DescribeErrors(
    ErrorCode.CollectionNotRecorded,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.handshake.resolve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_stop', param: 'id' },
  })
  async resolve(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ResolveBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<HandshakeView> {
    if (this.handshakes === undefined) throw new OperationUnavailableError('resolveHandshake');
    const resolved = await this.handshakes.resolve(authorized, correlation(), id, {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'resolveHandshake'),
    });
    return resolved.handshake;
  }
}
