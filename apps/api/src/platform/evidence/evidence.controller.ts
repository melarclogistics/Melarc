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
  Res,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Authorized } from '../authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import { OperationUnavailableError } from '../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../contract/contract-operation.js';
import { ETAG_HEADERS, IDEMPOTENCY_KEY_SCHEMA, IF_MATCH_SCHEMA } from '../http/contract-headers.js';
import { ErrorCode } from '../http/error-codes.js';
import { fingerprintOfRequest } from '../http/request-fingerprint-input.js';
import { currentRequestContext } from '../logging/request-context.js';
import { DescribeErrors } from '../openapi/described-errors.js';
import { DescribeServers, RIDER_SERVERS } from '../openapi/operation-statements.js';
import { Self } from '../routes/access-declaration.js';
import { EVIDENCE_SERVICE } from './evidence-providers.js';
import {
  EVIDENCE_CREATE_BODY,
  EVIDENCE_RETRIEVAL_SCHEMA,
  EVIDENCE_SCHEMA,
  EVIDENCE_UPLOAD_TICKET_SCHEMA,
  NO_STORE_HEADERS,
} from './evidence-schemas.js';
import type {
  EvidenceCreateBody,
  EvidenceRetrieval,
  EvidenceService,
  EvidenceTicket,
} from './evidence.service.js';
import type { EvidenceView } from './evidence-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The three evidence operations (S1.11; the contract's `createEvidence`, `completeEvidenceUpload` and `createEvidenceRetrievalAuthorization`). **Each is `x-permission: owner`**:
 * the route is a `self` route to the guard (authenticated, counted, the surface judged, and no permission decided), and the service asks for the grant of the key of the act the
 * record is about before anything is opened (`EvidenceService`). The Rider app declares and completes a record (the bearer credential, at the dedicated host as well as same-origin);
 * the Ops Portal asks for the way to read one. Where the application is composed without what the service needs, each fails closed (`503`).
 */
@Controller('evidence')
export class EvidenceController {
  constructor(
    @Optional()
    @Inject(EVIDENCE_SERVICE)
    private readonly service: EvidenceService | undefined,
  ) {}

  /** `POST /evidence`: step one of two. Declares a record and answers with the way to upload its bytes; a retry with the same `Idempotency-Key` is told the same. */
  @Post()
  @HttpCode(200)
  @ContractOperation('createEvidence')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: EVIDENCE_CREATE_BODY })
  @ApiResponse({ status: 200, schema: EVIDENCE_UPLOAD_TICKET_SCHEMA, headers: ETAG_HEADERS })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @Self({ surfaces: ['RIDER_ANDROID'], activity: 'qualifying', owner: true })
  async create(
    @Authorized() authorized: AuthorizedRequest,
    @Body() body: EvidenceCreateBody,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EvidenceTicket> {
    if (this.service === undefined) throw new OperationUnavailableError('createEvidence');
    const created = await this.service.create(authorized, correlation(), {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'createEvidence'),
    });
    response.setHeader('ETag', created.etag);
    return created.ticket;
  }

  /** `POST /evidence/{id}/complete`: step two. Looks at what arrived and, if it is what was declared, stores the record. */
  @Post(':id/complete')
  @HttpCode(200)
  @ContractOperation('completeEvidenceUpload')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiResponse({ status: 200, schema: EVIDENCE_SCHEMA })
  @DescribeServers(RIDER_SERVERS)
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceUploadExpired,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @Self({ surfaces: ['RIDER_ANDROID'], activity: 'qualifying', owner: true })
  async complete(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EvidenceView> {
    if (this.service === undefined) throw new OperationUnavailableError('completeEvidenceUpload');
    const completed = await this.service.complete(authorized, correlation(), id, { ifMatch });
    response.setHeader('ETag', completed.etag);
    return completed.evidence;
  }

  /**
   * `POST /evidence/{id}/retrieval-authorization`: a short-lived way to read one stored object, for the staff who hold the read permission of the subject. **It creates no state, and the
   * capability is returned to this caller alone**: `Cache-Control: no-store`, and it is in no log, metric, event or record.
   */
  @Post(':id/retrieval-authorization')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('createEvidenceRetrievalAuthorization')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: EVIDENCE_RETRIEVAL_SCHEMA, headers: NO_STORE_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @Self({ surfaces: ['OPS_PORTAL'], activity: 'qualifying', owner: true })
  retrieve(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
  ): Promise<EvidenceRetrieval> {
    if (this.service === undefined)
      throw new OperationUnavailableError('createEvidenceRetrievalAuthorization');
    return this.service.retrieve(authorized, correlation(), id);
  }
}
