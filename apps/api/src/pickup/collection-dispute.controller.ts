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
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import {
  COLLECTION_DISPUTE_CREATE_BODY,
  COLLECTION_DISPUTE_SCHEMA,
} from './collection-dispute-schemas.js';
import type { CollectionDisputeView, DisputeBody, Disputes } from './collection-dispute.service.js';
import { PICKUP_DISPUTES } from './pickup-manifests-providers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /pickup-stops/{id}/dispute` (S1.29): the vendor disputes the collection of its own pickup. It serves the Vendor app alone, requires
 * `pickup.collection.confirm` (the rider holds the key too, to enter a code, and is refused by the surface), takes a browser session with its
 * synchronizer token, an `Idempotency-Key` and the closed body, and answers `201` with the reconciliation item. A stop that is not this vendor's and
 * an id that matches nothing are `NOT_FOUND`, the same. It never reverses physical completion: the stop stays as it closed.
 */
@Controller('pickup-stops')
export class CollectionDisputeController {
  constructor(
    @Optional()
    @Inject(PICKUP_DISPUTES)
    private readonly disputes: Disputes | undefined,
  ) {}

  @Post(':id/dispute')
  @HttpCode(201)
  @ContractOperation('disputeCollection')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: COLLECTION_DISPUTE_CREATE_BODY })
  @ApiResponse({ status: 201, schema: COLLECTION_DISPUTE_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.collection.confirm', {
    surfaces: ['VENDOR_PWA'],
    activity: 'qualifying',
  })
  async raise(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: DisputeBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<CollectionDisputeView> {
    if (this.disputes === undefined) throw new OperationUnavailableError('disputeCollection');
    const raised = await this.disputes.raise(authorized, correlation(), id.toLowerCase(), {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'disputeCollection'),
    });
    return raised.dispute;
  }
}
