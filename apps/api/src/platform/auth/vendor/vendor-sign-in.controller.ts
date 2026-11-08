import { Body, Controller, HttpCode, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { OperationUnavailableError } from '../../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeCookies, DescribeSecurity } from '../../openapi/operation-statements.js';
import { Anonymous } from '../../routes/access-declaration.js';
import { issueBrowserSessionCookies, issueVendorDeviceCookie } from '../cookies/cookie-writer.js';
import type { CurrentSessionView } from '../sessions/current-session.js';
import { CURRENT_SESSION_SCHEMA } from '../sessions/session-schemas.js';
import { presentedVendorDevice } from './vendor-device-credential.js';
import { VENDOR_SIGN_IN_SERVICE } from './vendor-sign-in-providers.js';
import { VENDOR_SIGN_IN_LIMIT } from './vendor-sign-in-limit.js';
import type { VendorSignInService } from './vendor-sign-in.service.js';
import { VENDOR_BROWSER } from './vendor-setup.controller.js';
import { DEVICE_ISSUED_HEADERS, VENDOR_SIGN_IN_BODY } from './vendor-setup-schemas.js';

interface VendorSignInBody {
  readonly account_identifier: string;
  readonly secret: string;
}

/**
 * `POST /auth/vendor/sign-in` (S0.48, `vendorSignIn`): the shared credential of a vendor organisation, signed in from its registered
 * browser. Not anonymous: the contract's `vendorDevice` scheme is the browser's `melarc_vendor_device` cookie, read here as it was sent and
 * handed to the service (only its hash goes further). A browser pre-session mutation of the Vendor PWA (`Origin` held to the Vendor origin
 * before anything is examined), limited in `rate_limit_vendor_signin` on the account and the recognised browser, answered `no-store`. The
 * session travels in `melarc_session` and `melarc_csrf`, and **the browser's own credential is set again with a fresh lifetime, never
 * replaced**. Composed without what the service needs, it fails closed (`503`).
 */
@Controller('auth/vendor')
export class VendorSignInController {
  constructor(
    @Optional()
    @Inject(VENDOR_SIGN_IN_SERVICE)
    private readonly service: VendorSignInService | undefined,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  @ContractOperation('vendorSignIn')
  @ApiBody({ schema: VENDOR_SIGN_IN_BODY })
  @ApiResponse({ status: 200, schema: CURRENT_SESSION_SCHEMA, headers: DEVICE_ISSUED_HEADERS })
  @DescribeCookies(200, ['melarc_session', 'melarc_csrf', 'melarc_vendor_device'])
  @DescribeSecurity(['vendorDevice'])
  @DescribeErrors(
    ErrorCode.CredentialLocked,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.InvalidCredentials,
    ErrorCode.RateLimited,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(VENDOR_SIGN_IN_LIMIT, VENDOR_BROWSER)
  async signIn(
    @Body() body: VendorSignInBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CurrentSessionView> {
    if (this.service === undefined) throw new OperationUnavailableError('vendorSignIn');
    const device = presentedVendorDevice(request.headers);
    const outcome = await this.service.signIn({
      accountIdentifier: body.account_identifier,
      secret: body.secret,
      device,
    });
    response.setHeader('Cache-Control', 'no-store');
    const csrf = outcome.session.csrfToken;
    // A browser session is always issued with its synchronizer token; one without is a defect and sets no cookie.
    if (csrf === null || device === undefined)
      throw new Error('A vendor session was issued without its synchronizer token or browser');
    issueBrowserSessionCookies(response, { session: outcome.session.token, csrf });
    // Renewed, not re-issued: the credential the browser presented, with a fresh lifetime.
    issueVendorDeviceCookie(response, device);
    return outcome.view;
  }
}
