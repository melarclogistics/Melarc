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
import { IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../platform/http/contract-headers.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeServers, RIDER_SERVERS } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import {
  COLLECTION_RECORD_CREATE_BODY,
  COLLECTION_RECORD_SCHEMA,
  PARCEL_PHOTO_EXCEPTION_CREATE_BODY,
  PARCEL_PHOTO_EXCEPTION_SCHEMA,
} from './collection-schemas.js';
import type { CollectionRecordView } from './collection-record-view.js';
import type {
  CollectionBody,
  Collections,
  ParcelPhotoExceptionBody,
  ParcelPhotoExceptionView,
} from './collection.service.js';
import { PICKUP_COLLECTION } from './pickup-manifests-providers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-stops/{id}/collect` (S1.26): the rider records what it counted at the door. It serves the Rider app alone (a bearer credential,
 * reachable at the dedicated non-browser host as well as same-origin), requires `pickup.collection.confirm` (a vendor holds the key too, to enter
 * a code, and is refused by the surface), takes the `If-Match` of the stop's read, an `Idempotency-Key` (a retry is not a second record: the same
 * key replays the answer) and the closed body, and answers `200` with the record. A stop that is not the rider's and an id that matches nothing
 * are `NOT_ASSIGNED_RIDER`, the same; a run that has not started is `MANIFEST_NOT_STARTED`; an officer, a vendor and a caller with no session never
 * reach the service. The stop stays `ARRIVED`: the handshake closes it.
 */
@Controller('pickup-stops')
export class CollectionController {
  constructor(
    @Optional()
    @Inject(PICKUP_COLLECTION)
    private readonly collections: Collections | undefined,
  ) {}

  @Post(':id/collect')
  @HttpCode(200)
  @ContractOperation('recordCollection')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: COLLECTION_RECORD_CREATE_BODY })
  @ApiResponse({ status: 200, schema: COLLECTION_RECORD_SCHEMA })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.ManifestNotStarted,
    ErrorCode.NotAssignedRider,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
    ErrorCode.ZeroCollectionIsFailure,
  )
  @RequiresPermission('pickup.collection.confirm', {
    surfaces: ['RIDER_ANDROID'],
    activity: 'qualifying',
    // A short count writes an envelope for the notification lane (OB-S1-51: an Ops feed entry, no text), and every operation that writes one carries the sub-ceiling
    // (`provider-initiating-coverage.test.ts` holds the two sets to each other).
    providerInitiating: true,
  })
  async record(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: CollectionBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<CollectionRecordView> {
    if (this.collections === undefined) throw new OperationUnavailableError('recordCollection');
    const recorded = await this.collections.record(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'recordCollection'),
    });
    return recorded.record;
  }

  /**
   * `POST /pickup-stops/{id}/parcel-photo-exception` (D-A10, 12 November 2026): an officer of the stop's hub lets the stop's count through without parcel photos, for the day the
   * camera fails or the photos cannot be sent. The Ops Portal alone; `pickup.handshake.override`; an `Idempotency-Key` and a required note. Once made, the stop's count takes no parcel
   * photos; it is made once, before the count, and never changed or removed.
   */
  @Post(':id/parcel-photo-exception')
  @HttpCode(200)
  @ContractOperation('authoriseParcelPhotoException')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: PARCEL_PHOTO_EXCEPTION_CREATE_BODY })
  @ApiResponse({ status: 200, schema: PARCEL_PHOTO_EXCEPTION_SCHEMA })
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
  @RequiresPermission('pickup.handshake.override', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_stop', param: 'id' },
  })
  async authorisePhotoException(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ParcelPhotoExceptionBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<ParcelPhotoExceptionView> {
    if (this.collections === undefined) {
      throw new OperationUnavailableError('authoriseParcelPhotoException');
    }
    const authorised = await this.collections.authorisePhotoException(
      authorized,
      correlation(),
      id,
      {
        body,
        idempotencyKey,
        fingerprint: fingerprintOfRequest(request, 'authoriseParcelPhotoException'),
      },
    );
    return authorised.exception;
  }
}
