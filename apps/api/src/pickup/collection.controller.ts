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
import { COLLECTION_RECORD_CREATE_BODY, COLLECTION_RECORD_SCHEMA } from './collection-schemas.js';
import type { CollectionRecordView } from './collection-record-view.js';
import type { CollectionBody, Collections } from './collection.service.js';
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
}
