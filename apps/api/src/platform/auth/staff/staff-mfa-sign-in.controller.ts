import { Body, Controller, Headers, HttpCode, Inject, Optional, Post, Res } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeCookies, DescribeOptionalCookies } from '../../openapi/operation-statements.js';
import { Anonymous, type AnonymousClient } from '../../routes/access-declaration.js';
import { issueBrowserSessionCookies, issueTrustedBrowserCookie } from '../cookies/cookie-writer.js';
import type { CurrentSessionView } from '../sessions/current-session.js';
import { trustedBrowserLabel } from '../trusted-browsers/trusted-browser-label.js';
import { StaffSetupUnavailableError } from './staff-setup-errors.js';
import { STAFF_MFA_SIGN_IN_LIMIT } from './staff-mfa-sign-in-limit.js';
import { STAFF_MFA_SIGN_IN_SERVICE } from './staff-mfa-sign-in-providers.js';
import { MFA_SIGN_IN_BODY } from './staff-mfa-sign-in-schemas.js';
import type { StaffMfaSignInService } from './staff-mfa-sign-in.service.js';
import { CURRENT_SESSION_SCHEMA, SESSION_ISSUED_HEADERS } from './staff-sign-in-schemas.js';

/** A page of the Ops Portal: the second step is served to the Ops origin alone (`403` for any other). */
const OPS_BROWSER: AnonymousClient = { kind: 'browser', surfaces: ['OPS_PORTAL'] };

interface MfaSignInBody {
  readonly challenge_id: string;
  readonly code: string;
  readonly trust_browser?: boolean;
}

/**
 * `POST /auth/staff/sign-in/mfa` (S0.33). A browser pre-session mutation of the Ops Portal: the `Origin` is held to the Ops origin
 * before the code is examined or counted, and the request is limited in the privileged MFA bucket under the challenge reference it
 * carries. **The only response that can establish a privileged session after a code** is the `200` here, with the session and the two
 * cookies; with `trust_browser: true` it also sets `melarc_trusted_browser` (staff-authentication.md §5.8), the one persistent cookie of
 * the staff sign-in. The label of the browser is made from its `User-Agent` by a closed list, and the header itself goes no further.
 */
@Controller('auth/staff')
export class StaffMfaSignInController {
  constructor(
    @Optional()
    @Inject(STAFF_MFA_SIGN_IN_SERVICE)
    private readonly service: StaffMfaSignInService | undefined,
  ) {}

  @Post('sign-in/mfa')
  @HttpCode(200)
  @ContractOperation('completeStaffMfaSignIn')
  @ApiBody({ schema: MFA_SIGN_IN_BODY })
  @ApiResponse({ status: 200, schema: CURRENT_SESSION_SCHEMA, headers: SESSION_ISSUED_HEADERS })
  @DescribeCookies(200, ['melarc_session', 'melarc_csrf'])
  @DescribeOptionalCookies(200, ['melarc_trusted_browser'])
  @DescribeErrors(
    ErrorCode.ChallengeExpired,
    ErrorCode.ChallengeUnusable,
    ErrorCode.CredentialLocked,
    ErrorCode.CsrfValidationFailed,
    ErrorCode.InvalidCredentials,
    ErrorCode.MfaEnrolmentRequired,
    ErrorCode.MfaProofInvalid,
    ErrorCode.RateLimited,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(STAFF_MFA_SIGN_IN_LIMIT, OPS_BROWSER)
  async completeSignIn(
    @Body() body: MfaSignInBody,
    @Headers('user-agent') userAgent: string | readonly string[] | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CurrentSessionView> {
    if (this.service === undefined) throw new StaffSetupUnavailableError();
    const outcome = await this.service.completeSignIn({
      challengeId: body.challenge_id,
      code: body.code,
      trustBrowser: body.trust_browser === true,
      browserLabel: trustedBrowserLabel(userAgent),
    });
    if (outcome.kind !== 'SESSION') throw new Error('The second step issues a session or refuses');
    response.setHeader('Cache-Control', 'no-store');
    const csrf = outcome.session.csrfToken;
    // A browser session is always issued with its synchronizer token; one without is a defect and sets no cookie.
    if (csrf === null) throw new Error('A browser session was issued without a synchronizer token');
    issueBrowserSessionCookies(response, { session: outcome.session.token, csrf });
    // Only a person who asked to be remembered and whose code was accepted has one: the credential is shown here once.
    if (outcome.trustedBrowser !== undefined) {
      issueTrustedBrowserCookie(response, outcome.trustedBrowser.token);
    }
    return outcome.view;
  }
}
