import { randomUUID } from 'node:crypto';

import { Body, Controller, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
import { ApiBody, ApiParam, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import {
  APPROVAL_SCHEMA,
  ONE_PACKAGE_EXCEPTION_REQUEST_BODY,
} from './one-package-exception-schemas.js';
import type {
  ApprovalView,
  OnePackageExceptionBody,
  OnePackageExceptions,
} from './one-package-exception.service.js';
import { ONE_PACKAGE_EXCEPTIONS } from './pickup-requests-providers.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The one-package exception (S1.16): `POST /pickup-requests/{id}/one-package-exception` (Ops raises it, `pickup.exception.request`) and
 * `POST /pickup-requests/{id}/one-package-exception/approve` (any holder of `pickup.exception.approve` decides it). Both serve the Ops
 * Portal alone, take a browser session with its synchronizer token, and name the request in the path, whose hub and existence are answered
 * (`HUB_SCOPE_VIOLATION`, `NOT_FOUND`) before the request is validated. Both answer the uniform maker-checker record, the `Approval`.
 */
@Controller('pickup-requests')
export class OnePackageExceptionController {
  constructor(
    @Optional()
    @Inject(ONE_PACKAGE_EXCEPTIONS)
    private readonly service: OnePackageExceptions | undefined,
  ) {}

  @Post(':id/one-package-exception')
  @ContractOperation('requestOnePackageException')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: ONE_PACKAGE_EXCEPTION_REQUEST_BODY })
  @ApiResponse({ status: 201, schema: APPROVAL_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.exception.request', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  request(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: OnePackageExceptionBody,
  ): Promise<ApprovalView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('requestOnePackageException'));
    }
    return this.service.request(authorized, correlation(), id, body);
  }

  @Post(':id/one-package-exception/approve')
  @HttpCode(200)
  @ContractOperation('approveOnePackageException')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: APPROVAL_SCHEMA })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SelfApprovalForbidden,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('pickup.exception.approve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'pickup_request', param: 'id' },
  })
  approve(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
  ): Promise<ApprovalView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('approveOnePackageException'));
    }
    return this.service.approve(authorized, correlation(), id);
  }
}
