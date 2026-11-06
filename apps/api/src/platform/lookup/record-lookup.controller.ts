import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';

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
import { RECORD_LOOKUP_PAGE_SCHEMA } from './record-lookup-schemas.js';
import type { RecordLookupService, RecordLookupView } from './record-lookup.service.js';

/** What correlates the transaction of an operation with the request being answered: the request's id. */
const correlationOf = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * `GET /ops/lookup?q=` (task C2): finds a record by its code, a name or a phone number typed in full. It is a `self` operation of the Ops Portal:
 * any signed-in staff session may ask, and **no permission admits the call itself**; a Vendor or a Rider session is refused by the surface gate, as
 * it is for any Ops operation. What the session is given is decided kind by kind, by the key of each kind's own read, and each kind is searched
 * in the scope of that key's grant (`RecordLookupService`).
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

  @Get()
  @ContractOperation('lookupRecords')
  @ApiQuery({
    name: 'q',
    required: true,
    schema: { type: 'string', minLength: 2, maxLength: 64 },
  })
  @ApiResponse({ status: 200, schema: RECORD_LOOKUP_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @Self({ surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  lookupRecords(
    @Authorized() authorized: AuthorizedRequest,
    @Query('q') q: unknown,
  ): Promise<RecordLookupView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('lookupRecords'));
    }
    return this.service.lookup(authorized, correlationOf(), q);
  }
}
