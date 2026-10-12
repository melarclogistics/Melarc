import { randomUUID } from 'node:crypto';

import {
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { RATE_LIMITER, type RateLimiter } from '../auth/ports/rate-limiter.port.js';
import { holdAuthenticatedSession } from '../auth/sessions/request-session.js';
import { AuthenticationUnavailableError } from '../auth/sessions/session-errors.js';
import { presentedCredential } from '../auth/sessions/session-credentials.js';
import {
  SESSION_AUTHENTICATOR,
  type AuthenticationOutcome,
  type SessionAuthenticator,
} from '../auth/sessions/session-authenticator.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { LimiterUnavailableError } from '../limiter/limiter-errors.js';
import { currentRequestContext } from '../logging/request-context.js';
import { accessKindOf } from './access-kind.js';

/**
 * Step 2 of the refusal order: authentication (permission-enforcement.md §5.1; S0.24). A route that needs a principal (`self`,
 * `permission`) is served only to a request whose session credential names a live session. A request with no usable session is
 * `401 SESSION_INVALID` (`SESSION_SUPERSEDED` for a displaced vendor session alone), never `403` (`AC-SLICE-000-44`); the cause is
 * the authenticator's to keep and is never outward.
 *
 * - **It runs after the rate limit and before CSRF, authorization and validation**, so a caller with no session learns nothing of
 *   the operation's schema.
 * - **The authenticated-API bucket is applied here, to the session just found** (`rate_limit_authenticated_api`, keyed on the
 *   session id): keyed on a credential that had not been verified it would let any caller invent keys and fill the limiter's table
 *   (plan §7.16, finding on step 1). A limiter that cannot decide, or none composed, fails closed (`503`).
 * - **A credential with no authenticator composed is not judged by guess**: `503`, the operational failure. A request that presents
 *   no credential is refused `401` whether or not one is composed.
 * - The session is kept beside the request (`authenticatedSessionOf`) for the slots after this one. A route that is anonymous or
 *   technical is not authenticated by this guard, and a session cookie it carries is not looked at.
 *
 * What it does not do is authorize: the slots after it do, and until S0.26 builds the authorization step they refuse every route
 * that needs a principal (`403 PERMISSION_DENIED`), so an authenticated session still serves nothing it was not built to.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(SESSION_AUTHENTICATOR)
    private readonly authenticator: SessionAuthenticator | undefined,
    @Optional() @Inject(RATE_LIMITER) private readonly limiter: RateLimiter | undefined,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = accessKindOf(this.reflector, context);
    if (kind !== 'self' && kind !== 'permission') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const credential = presentedCredential(request.headers, request.rawHeaders);
    // Nothing to judge, or two credentials to choose between: refused without a statement, and with or without a store composed.
    if (credential.kind === 'NONE' || credential.kind === 'AMBIGUOUS') {
      throw ApiException.of(ErrorCode.SessionInvalid, 'No usable session');
    }
    if (this.authenticator === undefined) throw new AuthenticationUnavailableError();

    const outcome: AuthenticationOutcome = await this.authenticator.authenticate(
      credential,
      currentRequestContext()?.requestId ?? randomUUID(),
    );
    if (outcome.kind === 'REFUSED') {
      throw outcome.code === 'SESSION_SUPERSEDED'
        ? ApiException.of(ErrorCode.SessionSuperseded, 'Session superseded')
        : ApiException.of(ErrorCode.SessionInvalid, 'No usable session');
    }

    // Keyed on the session that was found, after it was found, and with no transaction of this request's open.
    if (this.limiter === undefined) throw new LimiterUnavailableError();
    const decision = await this.limiter.admit(
      'rate_limit_authenticated_api',
      outcome.authenticated.session.id,
    );
    if (!decision.allowed) throw ApiException.of(ErrorCode.RateLimited, 'Too many requests');

    holdAuthenticatedSession(request, outcome.authenticated);
    return true;
  }
}
