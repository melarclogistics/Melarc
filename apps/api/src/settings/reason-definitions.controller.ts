import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';

import { ContractOperation } from '../platform/contract/contract-operation.js';
import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import {
  REASON_BRANCHES,
  REASON_CHECKPOINTS,
  REASON_DEFINITIONS_SCHEMA,
  REASON_OPERATIONS,
} from './reason-definitions-schemas.js';
import { REASON_DEFINITIONS_SERVICE } from './reason-definitions-providers.js';
import type {
  ReasonDefinitionView,
  ReasonDefinitionsService,
  ReasonFilter,
} from './reason-definitions.service.js';

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): ReasonFilter {
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
  const domain = take('domain');
  const checkpoint = take('checkpoint');
  const operation = take('operation');
  const branch = take('branch');
  return {
    ...(domain === undefined ? {} : { domain }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(operation === undefined ? {} : { operation }),
    ...(branch === undefined ? {} : { branch }),
  };
}

/**
 * `GET /reason-definitions` (S0.35): the operational reason catalogue, filterable by domain, checkpoint, operation and branch. It
 * requires `settings.reason.read`, which Ops Staff, Senior Ops and Platform Admin hold and a Rider holds for assigned work, and it
 * serves the Ops Portal and the Rider app (a Vendor is refused by the surface gate). A read the person makes by opening a form that
 * offers reasons counts as the person acting, which changes nothing for a Rider (no idle rule).
 */
@Controller('reason-definitions')
export class ReasonDefinitionsController {
  constructor(
    @Optional()
    @Inject(REASON_DEFINITIONS_SERVICE)
    private readonly service: ReasonDefinitionsService | undefined,
  ) {}

  @Get()
  @ContractOperation('listReasonDefinitions')
  @ApiQuery({ name: 'domain', required: false, schema: { type: 'string' } })
  @ApiQuery({
    name: 'checkpoint',
    required: false,
    schema: { type: 'string', enum: [...REASON_CHECKPOINTS] },
  })
  @ApiQuery({
    name: 'operation',
    required: false,
    schema: { type: 'string', enum: [...REASON_OPERATIONS] },
  })
  @ApiQuery({
    name: 'branch',
    required: false,
    schema: { type: 'string', enum: [...REASON_BRANCHES] },
  })
  @ApiResponse({ status: 200, schema: REASON_DEFINITIONS_SCHEMA })
  @DescribeSecurity(['browserSession'], ['riderSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('settings.reason.read', {
    surfaces: ['OPS_PORTAL', 'RIDER_ANDROID'],
    activity: 'qualifying',
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<readonly ReasonDefinitionView[]> {
    return this.service === undefined
      ? Promise.reject(new OperationUnavailableError('listReasonDefinitions'))
      : this.service.list(
          authorized,
          currentRequestContext()?.requestId ?? randomUUID(),
          filterOf(query),
        );
  }
}
