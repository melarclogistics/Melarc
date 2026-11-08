import { randomUUID } from 'node:crypto';

import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { ApiQuery, ApiResponse } from '@nestjs/swagger';

import { Authorized } from '../platform/authorization/authorized-operation.decorator.js';
import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import { OperationUnavailableError } from '../platform/authorization/operation-unavailable-error.js';
import { ContractOperation } from '../platform/contract/contract-operation.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { currentRequestContext } from '../platform/logging/request-context.js';
import {
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_STATES,
} from '../platform/notifications/notification-vocabulary.js';
import { DescribeErrors } from '../platform/openapi/described-errors.js';
import { DescribeSecurity } from '../platform/openapi/operation-statements.js';
import { RequiresPermission } from '../platform/routes/access-declaration.js';
import { NOTIFICATION_LOG_SERVICE } from './notification-log-providers.js';
import { MAX_PAGE_SIZE, NOTIFICATION_LOG_PAGE_SCHEMA } from './notification-log-schemas.js';
import type {
  NotificationLogEntry,
  NotificationLogFilter,
  NotificationLogService,
} from './notification-log.service.js';

const correlation = (): string => currentRequestContext()?.requestId ?? randomUUID();

/** A query parameter is one string or absent; the contract has validated it against its schema, and a repeated one is not one. */
function filterOf(query: Record<string, unknown>): NotificationLogFilter {
  const take = (name: string): string | undefined => {
    const value = query[name];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'query', pointer: `/${name}`, rule: 'type' }],
      });
    }
    return value;
  };
  const state = take('state');
  const audience = take('audience');
  const channel = take('channel');
  const subjectId = take('subject_id');
  const size = take('page_size');
  const pageToken = take('page_token');
  return {
    ...(state === undefined ? {} : { state }),
    ...(audience === undefined ? {} : { audience }),
    ...(channel === undefined ? {} : { channel }),
    ...(subjectId === undefined ? {} : { subjectId }),
    ...(size === undefined ? {} : { pageSize: /^\d+$/.test(size) ? Number(size) : Number.NaN }),
    ...(pageToken === undefined ? {} : { pageToken }),
  };
}

/**
 * `GET /notifications` (S1.12e): the Ops message log, and with `channel=FEED&audience=OPS_FEED` the Ops feed. It requires
 * `notification.read` (Ops Staff, Senior Ops and Platform Admin at their own hub), serves the Ops Portal only, and takes a browser
 * session with no synchronizer token (a safe read). A vendor and a rider hold no such key and are refused by the guard.
 */
@Controller('notifications')
export class NotificationLogController {
  constructor(
    @Optional()
    @Inject(NOTIFICATION_LOG_SERVICE)
    private readonly service: NotificationLogService | undefined,
  ) {}

  @Get()
  @ContractOperation('listNotifications')
  @ApiQuery({
    name: 'state',
    required: false,
    schema: { type: 'string', enum: [...NOTIFICATION_STATES] },
  })
  @ApiQuery({
    name: 'audience',
    required: false,
    schema: { type: 'string', enum: [...NOTIFICATION_AUDIENCES] },
  })
  @ApiQuery({
    name: 'channel',
    required: false,
    schema: { type: 'string', enum: [...NOTIFICATION_CHANNELS] },
  })
  @ApiQuery({ name: 'subject_id', required: false, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'page_size',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: 25 },
  })
  @ApiQuery({ name: 'page_token', required: false, schema: { type: 'string' } })
  @ApiResponse({ status: 200, schema: NOTIFICATION_LOG_PAGE_SCHEMA })
  @DescribeSecurity(['browserSession'])
  @DescribeErrors(ErrorCode.PermissionDenied, ErrorCode.SessionInvalid, ErrorCode.ValidationFailed)
  @RequiresPermission('notification.read', { surfaces: ['OPS_PORTAL'], activity: 'qualifying' })
  list(
    @Authorized() authorized: AuthorizedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<{
    readonly items: readonly NotificationLogEntry[];
    readonly next_page_token: string | null;
  }> {
    if (this.service === undefined) {
      return Promise.reject(new OperationUnavailableError('listNotifications'));
    }
    return this.service.list(authorized, correlation(), filterOf(query));
  }
}
