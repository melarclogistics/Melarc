import { randomUUID } from 'node:crypto';

import { Body, Controller, HttpCode, Inject, Optional, Post } from '@nestjs/common';
import { ApiBody, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import { OperationUnavailableError } from '../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../contract/contract-operation.js';
import { ErrorCode } from '../http/error-codes.js';
import { currentRequestContext } from '../logging/request-context.js';
import { DescribeErrors } from '../openapi/described-errors.js';
import { DescribeSecurity } from '../openapi/operation-statements.js';
import { Self } from '../routes/access-declaration.js';
import { RECORD_LOOKUP_SERVICE } from './record-lookup-providers.js';
import {
  RECORD_LOOKUP_PAGE_SCHEMA,
  RECORD_LOOKUP_REQUEST_SCHEMA,
} from './record-lookup-schemas.js';
import type { RecordLookupService, RecordLookupView } from './record-lookup.service.js';

/** What correlates the transaction of an operation with the request being answered: the request's id. */
const correlationOf = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `POST /ops/lookup` with the body `{ "q": "..." }` (task C2; the method and the body are the Product Owner's decision of 6 November 2026): finds a
 * record by its code, a name or a phone number typed in full. **It is a POST that changes nothing**, so that a phone number typed in full is in the
 * body and never in a URL, which proxies and monitoring tools may keep. It therefore follows the API's conventions for a POST that changes nothing:
 * it is protected as every staff POST is (the CSRF guard judges every method that is not safe, so the session's cookie, the synchronizer token and
 * the Ops Portal's `Origin` are required), its answer is `Cache-Control: no-store`, and it takes **no** `Idempotency-Key` (repeating it repeats a read).
 *
 * It is a `self` operation of the Ops Portal: any signed-in staff session may ask, and **no permission admits the call itself**; a Vendor session is
 * refused by the surface gate (`PERMISSION_DENIED`), as it is for any Ops operation, and a Rider's bearer credential, which this browser-only operation
 * does not take, is `SESSION_INVALID` (`AC-LOOKUP-07`). What the session is given is decided kind by kind, by the key of each kind's own read, and each
 * kind is searched in the scope of that key's grant (`RecordLookupService`).
 *
 * **It is counted and bounded** (the audit of 7 November 2026, A5): the authentication step counts every request of the session in its one bucket of
 * API requests (`rate_limit_authenticated_api`) before the CSRF check and before this runs, and the request past the limit is `RATE_LIMITED` (`429`);
 * the lookup has no limiter of its own. Every statement of the lookup is bounded at 3 seconds (`RECORD_LOOKUP_STATEMENT_TIMEOUT_MS`), and a search
 * that outlasts it is the platform's failed read, `503` with no code (`AC-LOOKUP-14`, `-15`).
 *
 * It is **`qualifying`** activity: a search typed into the top bar is the person's own act, unlike the counts the portal reads on its own. Where
 * the application is composed without what the service needs, it fails closed (`503`).
 */
@Controller('ops/lookup')
export class RecordLookupController {
  constructor(
    @Optional()
    @Inject(RECORD_LOOKUP_SERVICE)
    private readonly service: RecordLookupService | undefined,
  ) {}

  @Post()
  @HttpCode(200)
  @ContractOperation('lookupRecords')
  @ApiBody({ schema: RECORD_LOOKUP_REQUEST_SCHEMA })
  @ApiResponse({ status: 200, schema: RECORD_LOOKUP_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession', 'csrfToken'])
  @DescribeErrors(
    ErrorCode.CsrfValidationFailed,
    ErrorCode.PermissionDenied,
    ErrorCode.RateLimited,
    ErrorCode.SessionInvalid,
    ErrorCode.ValidationFailed,
  )
  @Self({ surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  lookupRecords(
    @Authorized() authorized: AuthorizedRequest,
    @Body() body: unknown,
  ): Promise<RecordLookupView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('lookupRecords'));
    }
    // The contract has judged the body before this runs (an object with the one field `q`, 2 to 64 characters); the service judges the text again
    // (trimmed, no NUL), and a body that somehow is not an object reaches it as "no text".
    const q = typeof body === 'object' && body !== null ? (body as { q?: unknown }).q : undefined;
    return this.service.lookup(authorized, correlationOf(), q);
  }
}
