import { Body, Controller, HttpCode, Inject, Optional, Post, Res } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeCookies } from '../../openapi/operation-statements.js';
import { Anonymous, type AnonymousClient } from '../../routes/access-declaration.js';
import { issueBrowserSessionCookies } from '../cookies/cookie-writer.js';
import type { CurrentSessionView } from '../sessions/current-session.js';
import { StaffSetupUnavailableError } from './staff-setup-errors.js';
import { STAFF_SIGN_IN_SERVICE } from './staff-sign-in-providers.js';
import { STAFF_SIGN_IN_LIMIT } from './staff-sign-in-limit.js';
import {
  CURRENT_SESSION_SCHEMA,
  MFA_CHALLENGE_SCHEMA,
  SESSION_ISSUED_HEADERS,
  STAFF_SIGN_IN_BODY,
} from './staff-sign-in-schemas.js';
import type { StaffSignInService } from './staff-sign-in.service.js';

/** A page of the Ops Portal: the staff sign-in is served to the Ops origin alone (`403` for any other). */
const OPS_BROWSER: AnonymousClient = { kind: 'browser', surfaces: ['OPS_PORTAL'] };

interface StaffSignInBody {
  readonly email: string;
  readonly password: string;
}

/**
 * `POST /auth/staff/sign-in` (S0.32). A browser pre-session mutation of the Ops Portal: the `Origin` is held to the Ops origin before
 * the password is examined or counted, and the request is limited in the staff sign-in bucket under the canonical address it carries.
 *
 * **Two outcomes with two status codes, not one status with two meanings**: an Ops Staff member is answered `200` with the session
 * and the two cookies; a Senior Ops or Platform Admin is answered `202` with an MFA challenge and **no cookie of any kind**. A test
 * can then assert "no privileged session before a proven second factor" against the contract. Every refusal is `422`
 * `INVALID_CREDENTIALS`, the same for every reason.
 */
@Controller('auth/staff')
export class StaffSignInController {
  constructor(
    @Optional()
    @Inject(STAFF_SIGN_IN_SERVICE)
    private readonly service: StaffSignInService | undefined,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  @ContractOperation('staffSignIn')
  @ApiBody({ schema: STAFF_SIGN_IN_BODY })
  @ApiResponse({ status: 200, schema: CURRENT_SESSION_SCHEMA, headers: SESSION_ISSUED_HEADERS })
  @ApiResponse({ status: 202, schema: MFA_CHALLENGE_SCHEMA })
  @DescribeCookies(200, ['melarc_session', 'melarc_csrf'])
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.InvalidCredentials,
    ErrorCode.MfaRequired,
    ErrorCode.RateLimited,
    ErrorCode.ValidationFailed,
  )
  @Anonymous(STAFF_SIGN_IN_LIMIT, OPS_BROWSER)
  async signIn(
    @Body() body: StaffSignInBody,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CurrentSessionView | { challenge_id: string; expires_at: string }> {
    if (this.service === undefined) throw new StaffSetupUnavailableError();
    const outcome = await this.service.signIn({ email: body.email, password: body.password });
    response.setHeader('Cache-Control', 'no-store');
    if (outcome.kind === 'CHALLENGE') {
      // Accepted, not complete: no session, no cookie, a challenge that grants nothing.
      response.status(202);
      return { challenge_id: outcome.challengeId, expires_at: outcome.expiresAt.toISOString() };
    }
    const csrf = outcome.session.csrfToken;
    // A browser session is always issued with its synchronizer token; one without is a defect and sets no cookie.
    if (csrf === null) throw new Error('A browser session was issued without a synchronizer token');
    issueBrowserSessionCookies(response, { session: outcome.session.token, csrf });
    return outcome.view;
  }
}
