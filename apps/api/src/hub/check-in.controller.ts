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
import {
  ETAG_HEADERS,
  IDEMPOTENCY_KEY_SCHEMA,
  IF_MATCH_SCHEMA,
} from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import type {
  CheckInFinishBody,
  CheckedIntake,
  ExtraParcelBody,
  HubCheckIns,
  IntakeCorrectionBody,
  ParcelAnswer,
  ParcelArrivalBody,
} from './check-in.service.js';
import { HUB_CHECK_INS } from './hub-providers.js';
import {
  CHECK_IN_FINISH_BODY,
  EXTRA_PARCEL_BODY,
  HUB_INTAKE_CHECK_IN_SCHEMA,
  INTAKE_CORRECTION_BODY,
  INTAKE_CORRECTED_SCHEMA,
  INTAKE_PARCEL_ANSWER_SCHEMA,
  PARCEL_ARRIVAL_BODY,
} from './receiving-schemas.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The acts of the check-in of a vendor's parcels (Run D, S1.35b; D-D2, D-D8): `PUT /intake-parcels/{parcel_id}/arrival` (a tap on a parcel's photo), `POST /hub-intakes/{id}/check-in` ("All N here", or the
 * vendor as tapped), `POST /hub-intakes/{id}/extra-parcels` (an extra with a photo taken at the hub) and `POST /hub-intakes/{id}/correction` (a senior officer's correction with a reason). Each is for the Ops
 * Portal's staff alone, by the hubs of the session's grant: the first three under `hub.intake.count`, the correction under `hub.osd.adjudicate`, which Ops Staff do not hold (`PERMISSION_DENIED` at the guard,
 * before the body is read). **A tap takes neither an `Idempotency-Key` nor an `If-Match`**; the finish and the correction take both; an extra takes a key.
 */
@Controller()
export class CheckInController {
  constructor(
    @Optional()
    @Inject(HUB_CHECK_INS)
    private readonly checkIns: HubCheckIns | undefined,
  ) {}

  @Put('intake-parcels/:parcel_id/arrival')
  @HttpCode(200)
  @ContractOperation('recordParcelArrival')
  @ApiParam({ name: 'parcel_id', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: PARCEL_ARRIVAL_BODY })
  @ApiResponse({ status: 200, schema: INTAKE_PARCEL_ANSWER_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('hub.intake.count', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'intake_parcel', param: 'parcel_id' },
  })
  recordArrival(
    @Authorized() authorized: AuthorizedRequest,
    @Param('parcel_id') parcelId: string,
    @Body() body: ParcelArrivalBody,
  ): Promise<ParcelAnswer> {
    if (this.checkIns === undefined) {
      return Promise.reject(new OperationUnavailableError('recordParcelArrival'));
    }
    return this.checkIns.recordArrival(authorized, correlation(), parcelId, body);
  }

  @Post('hub-intakes/:id/check-in')
  @HttpCode(200)
  @ContractOperation('finishCheckIn')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: CHECK_IN_FINISH_BODY })
  @ApiResponse({ status: 200, schema: HUB_INTAKE_CHECK_IN_SCHEMA, headers: ETAG_HEADERS })
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
  @RequiresPermission('hub.intake.count', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  async finish(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: CheckInFinishBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CheckedIntake['intake']> {
    if (this.checkIns === undefined) throw new OperationUnavailableError('finishCheckIn');
    const done = await this.checkIns.finish(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'finishCheckIn'),
    });
    response.setHeader('ETag', done.etag);
    return done.intake;
  }

  @Post('hub-intakes/:id/extra-parcels')
  @HttpCode(200)
  @ContractOperation('addExtraParcel')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: EXTRA_PARCEL_BODY })
  @ApiResponse({ status: 200, schema: INTAKE_PARCEL_ANSWER_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('hub.intake.count', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  addExtra(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ExtraParcelBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<ParcelAnswer> {
    if (this.checkIns === undefined) {
      return Promise.reject(new OperationUnavailableError('addExtraParcel'));
    }
    return this.checkIns.addExtra(authorized, correlation(), id, {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'addExtraParcel'),
    });
  }

  @Post('hub-intakes/:id/correction')
  @HttpCode(200)
  @ContractOperation('correctIntakeCount')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: INTAKE_CORRECTION_BODY })
  @ApiResponse({ status: 200, schema: INTAKE_CORRECTED_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
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
  @RequiresPermission('hub.osd.adjudicate', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  async correct(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: IntakeCorrectionBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CheckedIntake['intake']> {
    if (this.checkIns === undefined) throw new OperationUnavailableError('correctIntakeCount');
    const done = await this.checkIns.correct(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'correctIntakeCount'),
    });
    response.setHeader('ETag', done.etag);
    return done.intake;
  }
}
