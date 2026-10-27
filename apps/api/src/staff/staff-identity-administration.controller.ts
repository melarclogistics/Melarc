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
import { ErrorCode } from '../platform/http/error-codes.js';
import { fingerprintOfRequest } from '../platform/http/request-fingerprint-input.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import type { RecoveryRequestView } from '../platform/auth/recovery/administrator-recovery.js';
import {
  CREDENTIAL_RECOVERY_INITIATION_BODY,
  RECOVERY_REQUEST_SCHEMA,
} from '../platform/auth/recovery/recovery-schemas.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import {
  STAFF_CREDENTIAL_RECOVERY,
  STAFF_IDENTITY_ADMINISTRATION,
} from './staff-administration-providers.js';
import type {
  CredentialRecoveryInitiation,
  StaffCredentialRecovery,
} from './staff-credential-recovery.service.js';
import type {
  ApprovalRequest,
  CreateStaffRequest,
  ReissueRequest,
  SetupGrantView,
  StaffIdentityAdministration,
} from './staff-identity-administration.service.js';
import {
  IDEMPOTENCY_KEY_SCHEMA,
  IF_MATCH_SCHEMA,
  SETUP_GRANT_REISSUE_BODY,
  SETUP_GRANT_SCHEMA,
  STAFF_IDENTITY_APPROVAL_BODY,
  STAFF_IDENTITY_CREATE_BODY,
} from './staff-identity-administration-schemas.js';
import { ETAG_HEADERS, STAFF_IDENTITY_SCHEMA } from './staff-identity-schemas.js';
import type { StaffIdentityView } from './staff-identity-view.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /staff-identities` and `POST /staff-identities/{id}/approve` (S0.36): the maker's act and the checker's. Both are Ops Portal
 * operations of a browser session with its synchronizer token, and both count as the person acting.
 *
 * - **`createStaffIdentity`** (`staff.identity.create`) takes an `Idempotency-Key` and answers the new profile with its ETag. The profile
 *   is always `PENDING_APPROVAL` and of origin `MAKER_CHECKER`; the schema has no member for a status, a maker, a credential or a factor.
 * - **`approveStaffIdentity`** (`staff.identity.approve`) names the profile in the path (the scope, `HUB_SCOPE_VIOLATION` or `NOT_FOUND`,
 *   and the tier the profile's bundle needs, `INSUFFICIENT_AUTHORITY`, are decided before the body is validated) and takes the `If-Match`
 *   of the profile's read. It answers the settled profile with its new ETag.
 *
 * Where the application is composed without what the service needs, both fail closed (`503`).
 */
@Controller('staff-identities')
export class StaffIdentityAdministrationController {
  constructor(
    @Optional()
    @Inject(STAFF_IDENTITY_ADMINISTRATION)
    private readonly service: StaffIdentityAdministration | undefined,
  ) {}

  @Post()
  @HttpCode(200)
  @ContractOperation('createStaffIdentity')
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: IDEMPOTENCY_KEY_SCHEMA })
  @ApiBody({ schema: STAFF_IDENTITY_CREATE_BODY })
  @ApiResponse({ status: 200, schema: STAFF_IDENTITY_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.IdempotencyKeyConflict,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
    ErrorCode.WorkEmailInUse,
  )
  @RequiresPermission('staff.identity.create', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  async create(
    @Authorized() authorized: AuthorizedRequest,
    @Body() body: CreateStaffRequest,
    @Headers('idempotency-key') idempotencyKey: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffIdentityView> {
    if (this.service === undefined) throw new OperationUnavailableError('createStaffIdentity');
    const made = await this.service.create(authorized, correlation(), {
      body,
      idempotencyKey,
      fingerprint: fingerprintOfRequest(request, 'createStaffIdentity'),
    });
    response.setHeader('ETag', made.etag);
    return made.identity;
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ContractOperation('approveStaffIdentity')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: STAFF_IDENTITY_APPROVAL_BODY })
  @ApiResponse({ status: 200, schema: STAFF_IDENTITY_SCHEMA, headers: ETAG_HEADERS })
  @DescribeErrors(
    ErrorCode.CredentialDeliveryFailed,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.InsufficientAuthority,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SelfApprovalForbidden,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.identity.approve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'staff_identity', param: 'id' },
    tier: { rule: 'staff_identity_bundle' },
  })
  async approve(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ApprovalRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffIdentityView> {
    if (this.service === undefined) throw new OperationUnavailableError('approveStaffIdentity');
    const decided = await this.service.decide(authorized, correlation(), id, ifMatch, body);
    response.setHeader('ETag', decided.etag);
    return decided.identity;
  }
}

/**
 * `POST /ops/staff/{id}/credential/setup/reissue` (S0.36, `reissueStaffCredentialSetup`): a new `STAFF_CREDENTIAL_SETUP` grant for an
 * approved identity that holds no credential, queued to its verified work email, the earlier pending grant superseded. It is the
 * authority of the approval exercised again (`staff.identity.approve`), at the tier the profile's bundle needs. The token is never
 * returned.
 */
@Controller('ops/staff')
export class StaffCredentialSetupController {
  constructor(
    @Optional()
    @Inject(STAFF_IDENTITY_ADMINISTRATION)
    private readonly service: StaffIdentityAdministration | undefined,
    @Optional()
    @Inject(STAFF_CREDENTIAL_RECOVERY)
    private readonly recovery: StaffCredentialRecovery | undefined,
  ) {}

  @Post(':id/credential/setup/reissue')
  @HttpCode(200)
  @ContractOperation('reissueStaffCredentialSetup')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: SETUP_GRANT_REISSUE_BODY })
  @ApiResponse({ status: 200, schema: SETUP_GRANT_SCHEMA })
  @DescribeErrors(
    ErrorCode.CredentialDeliveryFailed,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.InsufficientAuthority,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.identity.approve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'staff_identity', param: 'id' },
    tier: { rule: 'staff_identity_bundle' },
  })
  reissue(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: ReissueRequest,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<SetupGrantView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('reissueStaffCredentialSetup'));
    }
    return this.service.reissue(authorized, correlation(), id, ifMatch, body);
  }

  /**
   * `POST /ops/staff/{id}/credential/recover` (S0.51b, `recoverStaffCredential`): a Platform Admin starts the recovery of a staff member's
   * existing password; the link goes to the verified work email, and the answer says where the request stands and never carries its token.
   */
  @Post(':id/credential/recover')
  @HttpCode(200)
  @ContractOperation('recoverStaffCredential')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: CREDENTIAL_RECOVERY_INITIATION_BODY })
  @ApiResponse({ status: 200, schema: RECOVERY_REQUEST_SCHEMA })
  @DescribeErrors(
    ErrorCode.CredentialDeliveryFailed,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('staff.credential.recover', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'staff_identity', param: 'id' },
  })
  recover(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: CredentialRecoveryInitiation,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<RecoveryRequestView> {
    if (this.recovery === undefined) {
      return Promise.reject(new OperationUnavailableError('recoverStaffCredential'));
    }
    return this.recovery.recover(authorized, correlation(), id, ifMatch, body);
  }
}
