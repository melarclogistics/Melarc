import { Body, Controller, HttpCode, Header, Inject, Optional, Post } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';

import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { Anonymous, type AnonymousClient } from '../../routes/access-declaration.js';
import { STAFF_SETUP_SERVICE } from './staff-setup-providers.js';
import { StaffSetupUnavailableError } from './staff-setup-errors.js';
import { setupTokenLimit } from './staff-setup-limit.js';
import {
  CREDENTIAL_SETUP_BODY,
  CREDENTIAL_SETUP_RESULT,
  MFA_ENROLMENT_BODY,
  MFA_ENROLMENT_RESULT,
  MFA_REENROLMENT_BEGIN_BODY,
  MFA_REENROLMENT_BEGUN,
  NO_STORE_HEADERS,
} from './staff-setup-schemas.js';
import type { StaffSetupService } from './staff-setup.service.js';

/** A page of the Ops Portal: the three operations serve staff, so only the Ops origin may call them (`403` for any other). */
const OPS_BROWSER: AnonymousClient = { kind: 'browser', surfaces: ['OPS_PORTAL'] };

interface CredentialSetupBody {
  readonly setup_token: string;
  readonly password: string;
}
interface MfaEnrolmentBody {
  readonly setup_token: string;
  readonly totp_code: string;
}
interface MfaReenrolmentBody {
  readonly setup_token: string;
}

interface ProvisioningBody {
  readonly mfa_provisioning: { readonly otpauth_uri: string };
  readonly mfa_setup_token: string;
}

/**
 * The three pre-session operations that bring a staff identity to a credential and a proven second factor (S0.31): the credential
 * setup, the proof of the first code and the beginning of a re-enrolment. Each is a browser pre-session mutation of the Ops Portal
 * (`Origin` held to the Ops origin before the token is examined), limited in the `rate_limit_recovery` bucket under the purpose-qualified
 * digest of the token it presents, and answers `no-store`. **None issues a session or sets a cookie.** The body is validated against
 * the contract before a handler runs, so what arrives here has the contract's shape; the service judges the rest.
 *
 * Each states what it takes and gives in the application's own description (`staff-setup-schemas.ts`, `DescribeErrors`), which the
 * conformance check compares with the contract. Where the application is composed without what the service needs, the three fail
 * closed (`503`), and nothing answers as if a credential had been set.
 */
@Controller('auth/staff/setup')
export class StaffSetupController {
  constructor(
    @Optional()
    @Inject(STAFF_SETUP_SERVICE)
    private readonly service: StaffSetupService | undefined,
  ) {}

  @Post('credential')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('completeStaffCredentialSetup')
  @ApiBody({ schema: CREDENTIAL_SETUP_BODY })
  @ApiResponse({ status: 200, schema: CREDENTIAL_SETUP_RESULT, headers: NO_STORE_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.RateLimited,
    ErrorCode.SetupGrantInvalid,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(setupTokenLimit('STAFF_CREDENTIAL_SETUP'), OPS_BROWSER)
  async completeCredentialSetup(
    @Body() body: CredentialSetupBody,
  ): Promise<
    | { authentication_ready: true; mfa_enrolment_required: false }
    | ({ authentication_ready: false; mfa_enrolment_required: true } & ProvisioningBody)
  > {
    const outcome = await this.#service().completeCredentialSetup({
      setupToken: body.setup_token,
      password: body.password,
    });
    if (outcome.authenticationReady) {
      return { authentication_ready: true, mfa_enrolment_required: false };
    }
    return {
      authentication_ready: false,
      mfa_enrolment_required: true,
      mfa_provisioning: { otpauth_uri: outcome.otpauthUri },
      mfa_setup_token: outcome.mfaSetupToken,
    };
  }

  @Post('mfa')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('completeMfaEnrolment')
  @ApiBody({ schema: MFA_ENROLMENT_BODY })
  @ApiResponse({ status: 200, schema: MFA_ENROLMENT_RESULT })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.MfaProofInvalid,
    ErrorCode.RateLimited,
    ErrorCode.SetupGrantInvalid,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(setupTokenLimit('MFA_ENROLMENT'), OPS_BROWSER)
  async completeMfaEnrolment(
    @Body() body: MfaEnrolmentBody,
  ): Promise<{ authentication_ready: true }> {
    await this.#service().completeMfaEnrolment({
      setupToken: body.setup_token,
      totpCode: body.totp_code,
    });
    return { authentication_ready: true };
  }

  @Post('mfa/begin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ContractOperation('beginMfaReenrolment')
  @ApiBody({ schema: MFA_REENROLMENT_BEGIN_BODY })
  @ApiResponse({ status: 200, schema: MFA_REENROLMENT_BEGUN, headers: NO_STORE_HEADERS })
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.RateLimited,
    ErrorCode.SetupGrantInvalid,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(setupTokenLimit('MFA_REENROLMENT'), OPS_BROWSER)
  async beginMfaReenrolment(@Body() body: MfaReenrolmentBody): Promise<ProvisioningBody> {
    const outcome = await this.#service().beginMfaReenrolment({ setupToken: body.setup_token });
    return {
      mfa_provisioning: { otpauth_uri: outcome.otpauthUri },
      mfa_setup_token: outcome.mfaSetupToken,
    };
  }

  #service(): StaffSetupService {
    if (this.service === undefined) throw new StaffSetupUnavailableError();
    return this.service;
  }
}
