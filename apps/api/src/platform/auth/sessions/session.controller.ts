import { randomUUID } from 'node:crypto';

import { Controller, Delete, Get, HttpCode, Inject, Optional, Res } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import type { Response } from 'express';

import { Authorized } from '../../authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../../authorization/authorized-request.js';
import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { currentRequestContext } from '../../logging/request-context.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeCookies, DescribeSecurity } from '../../openapi/operation-statements.js';
import { SERVED_SURFACES, Self } from '../../routes/access-declaration.js';
import { expireBrowserSessionCookies } from '../cookies/cookie-writer.js';
import type { CurrentSessionView } from './current-session.js';
import { SessionOperationsUnavailableError } from './session-errors.js';
import { SESSION_OPERATIONS } from './session-operations-providers.js';
import type { SessionOperations } from './session-operations.js';
import { CURRENT_SESSION_SCHEMA, SIGNED_OUT_HEADERS } from './session-schemas.js';

/** What correlates the transaction of an operation with the request being answered: the request's id. */
const correlationOf = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `GET /auth/session` and `DELETE /auth/session` (S0.34): the caller's own session, read and ended. Both are `self` operations: any
 * authenticated principal of the three surfaces, and no permission (so neither can answer `403 PERMISSION_DENIED`). The session is the
 * one the credential stands behind, found by the authentication step, and never one the request names.
 *
 * - **`getCurrentSession`** is a safe read: it needs no synchronizer token, and it is **`background`** for the idle lifetime of a
 *   browser session (decision A of 12 October 2026). A page reads it on its own, to know whose session this is and which entries to
 *   show, and a read that extended the idle lifetime would let a screen that does nothing but ask keep an unattended session alive.
 *   The one place a person's own action must be seen is any other operation; a person who only reloads this one is not "acting".
 * - **`signOut`** ends the session on the server whatever the client does with its cookies, and answers `204`. **A browser sign-out
 *   also expires `melarc_session` and `melarc_csrf`** (a literal `Max-Age=0`, the attributes they were issued with), and never the
 *   vendor's device cookie; a request authenticated by a Rider's bearer credential sets no cookie. It counts as the person acting,
 *   which changes nothing: the session it ends is not extended.
 *
 * Where the application is composed without what the service needs, both fail closed (`503`).
 */
@Controller('auth/session')
export class SessionController {
  constructor(
    @Optional()
    @Inject(SESSION_OPERATIONS)
    private readonly operations: SessionOperations | undefined,
  ) {}

  @Get()
  @ContractOperation('getCurrentSession')
  @ApiResponse({ status: 200, schema: CURRENT_SESSION_SCHEMA })
  @DescribeSecurity(['browserSession'], ['riderSession'])
  @DescribeErrors(ErrorCode.SessionInvalid)
  @Self({ surfaces: SERVED_SURFACES, activity: 'background' })
  getCurrentSession(@Authorized() authorized: AuthorizedRequest): Promise<CurrentSessionView> {
    return this.#operations().current(authorized, correlationOf());
  }

  @Delete()
  @HttpCode(204)
  @ContractOperation('signOut')
  @ApiResponse({ status: 204, headers: SIGNED_OUT_HEADERS })
  @DescribeCookies(204, ['melarc_session', 'melarc_csrf'], { for: 'browserSession' })
  @DescribeErrors(ErrorCode.CsrfValidationFailed, ErrorCode.SessionInvalid)
  @Self({ surfaces: SERVED_SURFACES, activity: 'qualifying' })
  async signOut(
    @Authorized() authorized: AuthorizedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.#operations().signOut(authorized, correlationOf());
    // Only a request that presented the browser's cookie has cookies to clear: a native client has none.
    if (authorized.credential === 'COOKIE') expireBrowserSessionCookies(response);
  }

  #operations(): SessionOperations {
    if (this.operations === undefined) throw new SessionOperationsUnavailableError();
    return this.operations;
  }
}
