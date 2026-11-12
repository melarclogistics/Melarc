import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../authorization/authorized-request.js';
import { OperationUnavailableError } from '../authorization/operation-unavailable-error.js';
import { ContractOperation } from '../contract/contract-operation.js';
import { ANY_HUB } from '../domain-ports/queue-counter.port.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import { currentRequestContext } from '../logging/request-context.js';
import { DescribeErrors } from '../openapi/described-errors.js';
import { DescribeSecurity } from '../openapi/operation-statements.js';
import { Self } from '../routes/access-declaration.js';
import { QUEUE_SUMMARY_SERVICE } from './queue-summary-providers.js';
import { QUEUE_SUMMARY_SCHEMA } from './queue-summary-schemas.js';
import type { QueueSummaryService, QueueSummaryView } from './queue-summary.service.js';

/** What correlates the transaction of an operation with the request being answered: the request's id. */
const correlationOf = (): string => currentRequestContext()?.requestId ?? randomUUID();

/**
 * The hub of the query (task C3): one string or absent. The contract has validated it against its schema (`format: uuid`), and a repeated
 * parameter is not one string, so it is refused as the lists refuse it.
 */
function hubOf(query: Record<string, unknown>): string | null {
  const value = query.hub_id;
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
      violations: [{ in: 'query', pointer: '/hub_id', rule: 'type' }],
    });
  }
  return value;
}

/**
 * `GET /ops/queue-summary` (task C1): how much work is waiting in each queue the calling session may read. It is a `self` operation of
 * the Ops Portal: any signed-in staff session may ask, and **no permission admits the call itself** (so it cannot answer `403
 * PERMISSION_DENIED` to a staff session); a Vendor or a Rider session is refused by the surface gate, as it is for any Ops operation.
 * What the session gets is decided entry by entry, by the keys of the queues' own lists (`QueueSummaryService`).
 *
 * It is **`background`** for the idle lifetime of a browser session, as `getCurrentSession` is (decision A of 12 October 2026): the Ops
 * Portal reads it on its own, to draw the counts beside the menu and on the landing, and a read the page makes by itself must not keep an
 * unattended session alive. The person's own act is the read of the page they open. Where the application is composed without what the
 * service needs, it fails closed (`503`).
 *
 * **`hub_id`** (task C3) is the filter every queue's list is given, so the counts are one hub's: it narrows and never widens, and it is
 * never part of the security context (`AC-HUBF-04`).
 */
@Controller('ops/queue-summary')
export class QueueSummaryController {
  constructor(
    @Optional()
    @Inject(QUEUE_SUMMARY_SERVICE)
    private readonly service: QueueSummaryService | undefined,
  ) {}

  @Get()
  @ContractOperation('getQueueSummary')
  @ApiQuery({ name: 'hub_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiResponse({ status: 200, schema: QUEUE_SUMMARY_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @Self({ surfaces: ['OPS_PORTAL'], activity: 'background' })
  getQueueSummary(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<QueueSummaryView> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('getQueueSummary'));
    }
    const hubId = hubOf(query);
    return this.service.read(authorized, correlationOf(), hubId === null ? ANY_HUB : { hubId });
  }
}
