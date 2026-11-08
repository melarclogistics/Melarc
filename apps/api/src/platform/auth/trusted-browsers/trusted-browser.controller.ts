import { randomUUID } from 'node:crypto';

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { ApiParam, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Authorized } from '../../authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../../authorization/authorized-request.js';
import { OperationUnavailableError } from '../../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../../contract/contract-operation.js';
import { ErrorCode } from '../../http/error-codes.js';
import { currentRequestContext } from '../../logging/request-context.js';
import { DescribeTrustedBrowserCookie } from '../../openapi/described-cookie-parameter.js';
import { DescribeErrors } from '../../openapi/described-errors.js';
import { DescribeOptionalCookies, DescribeSecurity } from '../../openapi/operation-statements.js';
import { Self } from '../../routes/access-declaration.js';
import { expireTrustedBrowserCookie } from '../cookies/cookie-writer.js';
import { presentedTrustedBrowser } from './trusted-browser-credential.js';
import { TRUSTED_BROWSER_OPERATIONS } from './trusted-browser-providers.js';
import type { TrustedBrowserOperations } from './trusted-browser-operations.js';
import {
  TRUSTED_BROWSER_LIST_SCHEMA,
  TRUSTED_BROWSER_REMOVED_HEADERS,
} from './trusted-browser-schemas.js';
import type { TrustedBrowserView } from './trusted-browser-view.js';

/** What correlates the transaction of an operation with the request being answered: the request's id. */
const correlationOf = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `GET /auth/staff/trusted-browsers` and `DELETE /auth/staff/trusted-browsers/{id}` (staff-authentication.md §5.8): the signed-in person's
 * own trusted browsers, listed and removed. Both are `self` operations of the Ops Portal: any signed-in staff session, and no permission.
 * The cookie is sent to this path (`Path=/api/v1/auth/staff`), so a request can say which of the person's browsers it is: the list marks
 * it `current`, and removing it clears the cookie (`Max-Age=0`). Where the application is composed without what the service needs, both
 * fail closed (`503`).
 */
@Controller('auth/staff/trusted-browsers')
export class TrustedBrowserController {
  constructor(
    @Optional()
    @Inject(TRUSTED_BROWSER_OPERATIONS)
    private readonly operations: TrustedBrowserOperations | undefined,
  ) {}

  @Get()
  @ContractOperation('listTrustedBrowsers')
  @DescribeTrustedBrowserCookie()
  @ApiResponse({ status: 200, schema: TRUSTED_BROWSER_LIST_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid)
  @Self({ surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Req() request: Request,
  ): Promise<{ readonly items: readonly TrustedBrowserView[] }> {
    return this.#operations().list(
      authorized,
      correlationOf(),
      presentedTrustedBrowser(request.headers),
    );
  }

  @Delete(':id')
  @HttpCode(204)
  @ContractOperation('revokeTrustedBrowser')
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @DescribeTrustedBrowserCookie()
  @ApiResponse({ status: 204, headers: TRUSTED_BROWSER_REMOVED_HEADERS })
  @DescribeOptionalCookies(204, ['melarc_trusted_browser'])
  @DescribeSecurity(['browserSession', 'csrfToken'])
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.NotFound,
    ErrorCode.PermissionDenied,
    ErrorCode.SessionInvalid,
  )
  @Self({ surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  async revoke(
    @Authorized() authorized: AuthorizedRequest,
    @Param('id') id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const removed = await this.#operations().revoke(
      authorized,
      correlationOf(),
      id,
      presentedTrustedBrowser(request.headers),
    );
    // The browser asking is the one removed: its cookie goes with it, so it stops presenting a credential that no longer stands for anything.
    if (removed.clearsCookie) expireTrustedBrowserCookie(response);
  }

  #operations(): TrustedBrowserOperations {
    if (this.operations === undefined) throw new OperationUnavailableError('trustedBrowsers');
    return this.operations;
  }
}
