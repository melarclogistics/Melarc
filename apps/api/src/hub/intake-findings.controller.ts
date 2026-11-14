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
import {
  DISCREPANCY_ADJUDICATION_BODY,
  HUB_INTAKE_POST_COUNT_SCHEMA,
  INTAKE_CONDITION_BODY,
} from './hub-intake-schemas.js';
import type { HubIntakePostCountView } from './hub-intake-view.js';
import { HUB_INTAKE_FINDINGS } from './hub-providers.js';
import type {
  DiscrepancyBody,
  HubIntakeFindings,
  IntakeConditionBody,
} from './intake-findings.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * What is found at an intake after its blind count (S1.34, `SLICE-001`): `POST /hub-intakes/{id}/condition` (the receiver records a condition and its evidence, under `hub.intake.count`) and
 * `POST /hub-intakes/{id}/discrepancy` (Senior Ops adjudicates, under `hub.osd.adjudicate`, which Ops Staff do not hold: `PERMISSION_DENIED` at the guard, before the body is read). Both are for the
 * Ops Portal's staff alone, by the hubs of the session's grant, take the `ETag` of the intake's read as `If-Match`, and answer `200` with `HubIntakePostCount`, its `condition_findings`
 * and the new `ETag`. The condition takes an `Idempotency-Key`; the adjudication, as the contract has it, takes none.
 */
@Controller('hub-intakes')
export class IntakeFindingsController {
  constructor(
    @Optional()
    @Inject(HUB_INTAKE_FINDINGS)
    private readonly findings: HubIntakeFindings | undefined,
  ) {}

  @Post(':id/condition')
  @HttpCode(200)
  @ContractOperation('recordIntakeCondition')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: INTAKE_CONDITION_BODY })
  @ApiResponse({ status: 200, schema: HUB_INTAKE_POST_COUNT_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
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
  @RequiresPermission('hub.intake.count', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_intake', param: 'id' },
  })
  async recordCondition(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: IntakeConditionBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HubIntakePostCountView> {
    if (this.findings === undefined) throw new OperationUnavailableError('recordIntakeCondition');
    const found = await this.findings.recordCondition(authorized, correlation(), id, {
      body,
      ifMatch,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'recordIntakeCondition'),
    });
    response.setHeader('ETag', found.etag);
    return found.intake;
  }

  @Post(':id/discrepancy')
  @HttpCode(200)
  @ContractOperation('adjudicateDiscrepancy')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: DISCREPANCY_ADJUDICATION_BODY })
  @ApiResponse({ status: 200, schema: HUB_INTAKE_POST_COUNT_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.EvidenceNotStored,
    ErrorCode.HubScopeViolation,
    ErrorCode.InsufficientAuthority,
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
  async adjudicate(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: DiscrepancyBody,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HubIntakePostCountView> {
    if (this.findings === undefined) throw new OperationUnavailableError('adjudicateDiscrepancy');
    const found = await this.findings.adjudicate(authorized, correlation(), id, { body, ifMatch });
    response.setHeader('ETag', found.etag);
    return found.intake;
  }
}
