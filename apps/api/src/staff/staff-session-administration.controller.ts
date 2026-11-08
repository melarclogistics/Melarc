import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { SESSION_PRINCIPAL_TIERS } from '../platform/authorization/tier-policy.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IF_MATCH_SCHEMA } from './staff-identity-administration-schemas.js';
import {
  STAFF_MFA_RESET,
  STAFF_SESSION_ADMINISTRATION,
} from './staff-session-administration-providers.js';
import type { MfaResetView, StaffMfaReset } from './staff-mfa-reset.service.js';
import {
  MFA_RESET_BODY,
  MFA_RESET_RESULT,
  SESSION_LIST_SCHEMA,
  SESSION_REVOKE_BODY,
  SESSION_SCHEMA,
} from './staff-session-administration-schemas.js';
import type {
  SessionListQuery,
  SessionView,
  StaffSessionAdministration,
} from './staff-session-administration.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

const PRINCIPAL_TYPES = ['STAFF', 'RIDER', 'VENDOR'] as const;

/** A query parameter is one string; the contract has validated its shape, and a repeated one is not one. */
function queryOf(query: Record<string, unknown>): SessionListQuery {
  const { principal_type: type, principal_id: id } = query;
  if (
    typeof id !== 'string' ||
    typeof type !== 'string' ||
    !(PRINCIPAL_TYPES as readonly string[]).includes(type)
  ) {
    throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
      violations: [{ in: 'query', pointer: '/principal_type', rule: 'type' }],
    });
  }
  return { principal_type: type as SessionListQuery['principal_type'], principal_id: id };
}

/**
 * `GET /auth/sessions` and `POST /auth/sessions/{id}/revoke` (S0.37): the live sessions of another principal, and the administrative end
 * of one. The list is a safe read of a browser session with no synchronizer token (`staff.read`, at the tier of the principal's type);
 * the revocation names the session in the path and its scope and existence are answered before the body is read (`staff.session.revoke`,
 * at the tier of the session's principal type). Neither returns anything that could present or rebuild a session.
 */
@Controller('auth/sessions')
export class StaffSessionController {
  constructor(
    @Optional()
    @Inject(STAFF_SESSION_ADMINISTRATION)
    private readonly service: StaffSessionAdministration | undefined,
  ) {}

  @Get()
  @ContractOperation('listSessions')
  @ApiQuery({
    name: 'principal_type',
    required: true,
    schema: { type: 'string', enum: [...PRINCIPAL_TYPES] },
  })
  @ApiQuery({ name: 'principal_id', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: SESSION_LIST_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.InsufficientAuthority,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.read', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    // The tier of the principal's type is asked before the query is validated (F03 of 23 October 2026); the service asks it again.
    tier: { byQuery: { param: 'principal_type', tiers: SESSION_PRINCIPAL_TIERS } },
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{ readonly items: readonly SessionView[] }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listSessions'));
    }
    return this.service.list(authorized, correlation(), queryOf(query));
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ContractOperation('revokeSession')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: SESSION_REVOKE_BODY })
  @ApiResponse({ status: 200, schema: SESSION_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.InsufficientAuthority,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.session.revoke', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'session', param: 'id' },
    tier: { rule: 'session_principal' },
  })
  revoke(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: { readonly reason_code: string; readonly note?: string },
  ): Promise<SessionView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('revokeSession'));
    }
    return this.service.revoke(authorized, correlation(), id, body);
  }
}

/**
 * `POST /ops/staff/{id}/mfa/reset` (S0.37, `resetStaffMfa`): a Platform Admin resets another privileged identity's second factor.
 * It takes the `If-Match` of the identity's read, answers counts and an expiry and **never** a seed, a token or a QR, and creates
 * neither a factor nor a session.
 */
@Controller('ops/staff')
export class StaffMfaResetController {
  constructor(
    @Optional()
    @Inject(STAFF_MFA_RESET)
    private readonly service: StaffMfaReset | undefined,
  ) {}

  @Post(':id/mfa/reset')
  @HttpCode(200)
  @ContractOperation('resetStaffMfa')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: MFA_RESET_BODY })
  @ApiResponse({ status: 200, schema: MFA_RESET_RESULT })
  @DescribeErrors(
    ErrorCode.CredentialDeliveryFailed,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SelfApprovalForbidden,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.mfa.reset', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'staff_identity', param: 'id' },
  })
  reset(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: { readonly reason_code: string; readonly note?: string },
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<MfaResetView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('resetStaffMfa'));
    }
    return this.service.reset(authorized, correlation(), id, ifMatch, body);
  }
}
