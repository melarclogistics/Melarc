import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { DECORATORS, type OpenAPIObject } from '@nestjs/swagger';

import { ErrorCode, statusOf } from '../http/error-codes.js';
import {
  ACCESS_DECLARATION_KEY,
  needsSession,
  type AccessDeclaration,
} from '../routes/access-declaration.js';
import { ERROR_BODY_SCHEMA, RETRY_AFTER_HEADERS } from './described-errors.js';
import { operationsOf } from './operation-statements.js';

/**
 * The `429` of the authenticated limiter, stated in the application's own description of every operation it covers (A2 of the audit, 7
 * November 2026; `AC-SLICE-000-131`; errors-and-enums.md §4).
 *
 * The authentication guard counts **every** request of a route that needs a session in the session's one bucket
 * (`rate_limit_authenticated_api`, settings.md §7.7) and refuses the one past the limit with `429 RATE_LIMITED` and a `Retry-After`. That is a
 * fact about the platform and not about any one operation, so it is stated here, from the same answer the guard asks (`needsSession`, read from
 * each route's access declaration), and not in a hundred and eighty decorators that a new operation could forget. For each such operation the
 * description gets `RATE_LIMITED` in its `x-error-codes` and a `429` response that carries the error envelope and the `Retry-After` header; an
 * operation that already states the code with `@DescribeErrors` (the five that cause a text, the lookup) keeps its own and gains the header.
 *
 * **The conformance check holds the contract to it** (`pnpm run contract:check`): an operation that needs a session and whose contract does
 * not declare the `429` (the shared `RateLimited`, whose `Retry-After` is the contract's `RetryAfter`) is a finding. The operations reached
 * before a session exists are not touched: their `429` is declared with `RateLimitedAnonymous`, carries no wait, and is stated by their own
 * decorators.
 */
export function applyRateLimitStatement(document: OpenAPIObject, app: INestApplication): void {
  const operations = operationsOf(document);
  const status = String(statusOf(ErrorCode.RateLimited));

  for (const moduleRef of app.get(ModulesContainer, { strict: false }).values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== 'function') continue;
      const classAccess = Reflect.getMetadata(ACCESS_DECLARATION_KEY, controller) as
        AccessDeclaration | undefined;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const access =
          (Reflect.getMetadata(ACCESS_DECLARATION_KEY, handler) as AccessDeclaration | undefined) ??
          classAccess;
        if (!needsSession(access)) continue;

        const operationId = (
          Reflect.getMetadata(DECORATORS.API_OPERATION, handler) as
            { readonly operationId?: string } | undefined
        )?.operationId;
        // A route the description leaves out (`@ApiExcludeEndpoint`) has nowhere to put the statement: the conformance check reports it.
        const operation = operationId === undefined ? undefined : operations.get(operationId);
        if (operation === undefined) continue;
        stateTheLimit(operation, status);
      }
    }
  }
}

function stateTheLimit(operation: Record<string, unknown>, status: string): void {
  const codes = Array.isArray(operation['x-error-codes'])
    ? (operation['x-error-codes'] as readonly string[])
    : [];
  operation['x-error-codes'] = [...new Set([...codes, ErrorCode.RateLimited])].toSorted();

  const responses = (operation.responses ??= {}) as Record<string, Record<string, unknown>>;
  // A copy of the response the operation already states, or the one the platform states: never an object another operation may share.
  responses[status] = {
    ...(responses[status] ?? {
      description: 'Too Many Requests',
      content: { 'application/json': { schema: structuredClone(ERROR_BODY_SCHEMA) } },
    }),
    headers: structuredClone(RETRY_AFTER_HEADERS),
  };
}
