import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Header,
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

import { NO_STORE_HEADERS } from '../platform/auth/staff/staff-setup-schemas.js';
import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { RIDER_DEVICE_ADMINISTRATION } from './rider-device-administration-providers.js';
import type {
  DeviceEnrolmentGrantView,
  RiderDeviceAdministration,
  RiderReregistrationRequest,
  RiderRevocationRequest,
} from './rider-device-administration.service.js';
import {
  DEVICE_ENROLMENT_GRANT_SCHEMA,
  DEVICE_REVOCATION_BODY,
  RIDER_DEVICE_REREGISTRATION_BODY,
} from './rider-schemas.js';
import {
  IDEMPOTENCY_KEY_SCHEMA,
  IF_MATCH_SCHEMA,
} from './staff-identity-administration-schemas.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /ops/riders/{riderId}/device/register` and `.../reregister` (S0.53b, S0.53c): the in-person start of a rider's device binding. Both
 * are Ops Portal operations of a browser session with its synchronizer token, count as the person acting, name the rider in the path (the
 * scope, `HUB_SCOPE_VIOLATION` or `NOT_FOUND`, is decided before the body is validated), and answer the enrolment URI the portal renders as a
 * QR code, `no-store`.
 *
 * - **`registerRiderDevice`** (`staff.device.register`: Senior Ops, or a Platform Admin whose grant reaches the rider's hub) takes an
 *   `Idempotency-Key` and no body, and is the one operation whose replay returns a secret, sealed.
 * - **`reregisterRiderDevice`** (`staff.device.reregister`: Senior Ops or a Platform Admin at the rider's own hub, deliberately narrower)
 *   takes the `If-Match` of the rider's read and a reason with a mandatory verification note.
 *
 * - **`revokeRiderDevice`** (S0.58, `staff.device.revoke`: Ops Staff, Senior Ops or a Platform Admin at the rider's own hub) takes a reason and
 *   nothing else, answers `204` and ends the rider's `ACTIVE` device and the live session on it in one act.
 *
 * Where the application is composed without what the service needs, all three fail closed (`503`).
 */
@Controller('ops/riders')
export class RiderDeviceAdministrationController {
  constructor(
    @Optional()
    @Inject(RIDER_DEVICE_ADMINISTRATION)
    private readonly service: RiderDeviceAdministration | undefined,
  ) {}

  @Post(':riderId/device/register')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('registerRiderDevice')
  @ApiParam({ name: 'riderId', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiResponse({ status: 200, schema: DEVICE_ENROLMENT_GRANT_SCHEMA, headers: NO_STORE_HEADERS })
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
  @RequiresPermission('staff.device.register', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'rider_identity', param: 'riderId' },
  })
  register(
    @Authorized() authorized: AuthorizedRequest,
    @Param('riderId') riderId: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<DeviceEnrolmentGrantView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('registerRiderDevice'));
    }
    return this.service.register(authorized, correlation(), riderId, {
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'registerRiderDevice'),
    });
  }

  @Post(':riderId/device/reregister')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('reregisterRiderDevice')
  @ApiParam({ name: 'riderId', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: RIDER_DEVICE_REREGISTRATION_BODY })
  @ApiResponse({ status: 200, schema: DEVICE_ENROLMENT_GRANT_SCHEMA, headers: NO_STORE_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.device.reregister', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'rider_identity', param: 'riderId' },
  })
  reregister(
    @Authorized() authorized: AuthorizedRequest,
    @Param('riderId') riderId: string,
    @Body() body: RiderReregistrationRequest,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<DeviceEnrolmentGrantView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('reregisterRiderDevice'));
    }
    return this.service.reregister(authorized, correlation(), riderId, ifMatch, body);
  }

  @Post(':riderId/device/revoke')
  @HttpCode(204)
  @ContractOperation('revokeRiderDevice')
  @ApiParam({ name: 'riderId', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: DEVICE_REVOCATION_BODY })
  @ApiResponse({ status: 204 })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.device.revoke', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'rider_identity', param: 'riderId' },
  })
  revoke(
    @Authorized() authorized: AuthorizedRequest,
    @Param('riderId') riderId: string,
    @Body() body: RiderRevocationRequest,
  ): Promise<void> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('revokeRiderDevice'));
    }
    return this.service.revoke(authorized, correlation(), riderId, body);
  }
}
