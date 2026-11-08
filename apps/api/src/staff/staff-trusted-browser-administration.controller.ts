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
  Req,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  TRUSTED_BROWSER_LIST_SCHEMA,
  TRUSTED_BROWSERS_REVOKED_SCHEMA,
} from '../platform/auth/trusted-browsers/trusted-browser-schemas.js';
import type { TrustedBrowserView } from '../platform/auth/trusted-browsers/trusted-browser-view.js';
import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { IDEMPOTENCY_KEY_SCHEMA } from './staff-identity-administration-schemas.js';
import { STAFF_TRUSTED_BROWSER_ADMINISTRATION } from './staff-session-administration-providers.js';
import { SESSION_REVOKE_BODY } from './staff-session-administration-schemas.js';
import type { StaffTrustedBrowserAdministration } from './staff-trusted-browser-administration.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `GET /ops/staff/{id}/trusted-browsers` and `POST /ops/staff/{id}/trusted-browsers/revoke` (staff-authentication.md §5.8): another
 * person's trusted browsers, listed and removed by a Platform Admin. `staff.session.revoke` at tier `P` for both; the identity is named in
 * the path and its scope and existence are answered before the body is read. Neither returns anything that could be used to sign in.
 */
@Controller('ops/staff')
export class StaffTrustedBrowserController {
  constructor(
    @Optional()
    @Inject(STAFF_TRUSTED_BROWSER_ADMINISTRATION)
    private readonly service: StaffTrustedBrowserAdministration | undefined,
  ) {}

  @Get(':id/trusted-browsers')
  @ContractOperation('listStaffTrustedBrowsers')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: TRUSTED_BROWSER_LIST_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(
    ErrorCode.HubScopeViolation,
    ErrorCode.InsufficientAuthority,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @RequiresPermission('staff.session.revoke', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'staff_identity', param: 'id' },
    tier: { minimum: 'P' },
  })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
  ): Promise<{ readonly items: readonly TrustedBrowserView[] }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listStaffTrustedBrowsers'));
    }
    return this.service.list(authorized, correlation(), id);
  }

  @Post(':id/trusted-browsers/revoke')
  @HttpCode(200)
  @ContractOperation('revokeStaffTrustedBrowsers')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: SESSION_REVOKE_BODY })
  @ApiResponse({ status: 200, schema: TRUSTED_BROWSERS_REVOKED_SCHEMA })
  // Browser sessions only, with the synchronizer token, like the read beside it (the audit of 26 October 2026): a Rider's bearer
  // credential is no credential of this operation, and is refused at the credential boundary as it is for the read.
  @DescribeSecurity(['browserSession', 'csrfToken'])
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
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
    record: { entity: 'staff_identity', param: 'id' },
    tier: { minimum: 'P' },
  })
  revoke(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: { readonly reason_code: string; readonly note?: string },
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
  ): Promise<{ readonly revoked: number }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('revokeStaffTrustedBrowsers'));
    }
    return this.service.revoke(authorized, correlation(), id, {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'revokeStaffTrustedBrowsers'),
    });
  }
}
