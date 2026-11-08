import { randomUUID } from 'node:crypto';

import { Body, Controller, Headers, HttpCode, Inject, Optional, Param, Post } from '@nestjs/common';
import { ApiBody, ApiHeader, ApiParam, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import type { RecoveryRequestView } from '../platform/auth/recovery/administrator-recovery.js';
import {
  CREDENTIAL_RECOVERY_INITIATION_BODY,
  RECOVERY_REQUEST_SCHEMA,
} from '../platform/auth/recovery/recovery-schemas.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import {
  IF_MATCH_SCHEMA,
  SETUP_GRANT_REISSUE_BODY,
  SETUP_GRANT_SCHEMA,
} from '../staff/staff-identity-administration-schemas.js';
import { VENDOR_CREDENTIAL_ADMINISTRATION } from './vendor-credential-administration-providers.js';
import type {
  VendorCredentialAdministration,
  VendorRecoveryRequest,
  VendorReissueRequest,
  VendorSetupGrantView,
} from './vendor-credential-administration.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /ops/vendors/{id}/credential/setup/reissue` (S0.47b, `reissueVendorCredentialSetup`): a fresh `VENDOR_CREDENTIAL_SETUP` grant for
 * an approved account that holds no secret, queued to its registered delivery channel with the account identifier, the earlier pending
 * grant superseded. The approval authority of the vendor's organisation exercised again (`vendor.organization.approve`), at the vendor's
 * own hub: the account is the record the route names, and its hub is its organisation's. An Ops Portal operation of a browser session with
 * its synchronizer token; the token is never returned.
 */
@Controller('ops/vendors')
export class VendorCredentialAdministrationController {
  constructor(
    @Optional()
    @Inject(VENDOR_CREDENTIAL_ADMINISTRATION)
    private readonly service: VendorCredentialAdministration | undefined,
  ) {}

  @Post(':id/credential/setup/reissue')
  @HttpCode(200)
  @ContractOperation('reissueVendorCredentialSetup')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'If-Match', required: true, schema: IF_MATCH_SCHEMA })
  @ApiBody({ schema: SETUP_GRANT_REISSUE_BODY })
  @ApiResponse({ status: 200, schema: SETUP_GRANT_SCHEMA })
  @DescribeErrors(
    ErrorCode.CredentialDeliveryFailed,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.HubScopeViolation,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.ReasonNotActive,
    ErrorCode.ReasonRequired,
    ErrorCode.SessionInvalid,
    ErrorCode.StateConflict,
    ErrorCode.ValidationFailed,
  )
  @RequiresPermission('vendor.organization.approve', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'vendor_account', param: 'id' },
  })
  reissue(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: VendorReissueRequest,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<VendorSetupGrantView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('reissueVendorCredentialSetup'));
    }
    return this.service.reissue(authorized, correlation(), id, ifMatch, body);
  }

  /**
   * `POST /ops/vendors/{id}/credential/recover` (S0.51b, `recoverVendorCredential`): a Platform Admin starts the recovery of an account's
   * existing shared secret; the link goes to the delivery channel with the account identifier, and the answer never carries its token.
   */
  @Post(':id/credential/recover')
  @HttpCode(200)
  @ContractOperation('recoverVendorCredential')
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
  @RequiresPermission('vendor.credential.recover', {
    surfaces: ['OPS_PORTAL'],
    activity: 'qualifying',
    record: { entity: 'vendor_account', param: 'id' },
  })
  recover(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Body() body: VendorRecoveryRequest,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<RecoveryRequestView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('recoverVendorCredential'));
    }
    return this.service.recover(authorized, correlation(), id, ifMatch, body);
  }
}
