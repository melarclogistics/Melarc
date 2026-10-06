import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';

import { runWithRequestContext } from './request-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Gives every request a server-generated id and writes one completion line for it.
 *
 * An id supplied by the client is ignored: trusting it would let a caller forge correlation and put
 * chosen text into the log. Honouring an edge-assigned id needs a trusted-proxy decision first.
 *
 * The completion line is an allowlist: method, route template, status, duration. Never the query
 * string, headers, cookies, body or path parameters, so no secret can be there to redact.
 */
export function createRequestMiddleware(logger: Logger): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    response.setHeader(REQUEST_ID_HEADER, requestId);

    response.on('close', () => {
      const status = response.statusCode;
      const route = request.route as { path?: unknown } | undefined;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      logger[level](
        {
          request_id: requestId,
          method: request.method,
          route: typeof route?.path === 'string' ? `${request.baseUrl}${route.path}` : null,
          status,
          duration_ms: Math.round(durationMs * 10) / 10,
          aborted: !response.writableFinished,
        },
        'request completed',
      );
    });

    runWithRequestContext({ requestId }, next);
  };
}
