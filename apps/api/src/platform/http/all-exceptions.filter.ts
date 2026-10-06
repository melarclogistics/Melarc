import { STATUS_CODES } from 'node:http';

import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';

import { REQUEST_ID_HEADER } from '../logging/request-middleware.js';
import { ApiException } from './api-exception.js';
import { ErrorCode } from './error-codes.js';

/** The body of an answer before the request id is added. */
interface Rendered {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** A 4xx status carried by the framework or by Express middleware (body-parser throws these). */
function clientErrorStatus(exception: unknown): number | undefined {
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : (exception as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/**
 * The single place a failure becomes a response. Nothing from the failure itself is ever copied into
 * the body: no message, no path, no stack. Framework default bodies echo the method and path, and
 * body-parser errors carry the raw body, so each case is rendered from fixed text.
 */
function render(exception: unknown): { rendered: Rendered; serverFault: boolean } {
  if (exception instanceof ApiException) {
    // Its text is written by the platform, never taken from the request (see ApiException).
    const { code, message, details } = exception;
    return {
      serverFault: false,
      rendered: {
        status: exception.getStatus(),
        body: details === undefined ? { code, message } : { code, message, details },
      },
    };
  }

  const status = clientErrorStatus(exception);
  if (status === 404) {
    return {
      serverFault: false,
      rendered: { status, body: { code: ErrorCode.NotFound, message: 'Resource not found' } },
    };
  }
  if (status === 400) {
    // The contract answers 400 with VALIDATION_FAILED. Nest 12 turns a body-parser SyntaxError into a
    // BadRequestException whose message can quote the request body, so the text here is fixed.
    return {
      serverFault: false,
      rendered: {
        status,
        body: { code: ErrorCode.ValidationFailed, message: 'The request is not valid' },
      },
    };
  }
  if (status !== undefined) {
    // The catalogue has no code for this client error, so the body carries none either.
    return {
      serverFault: false,
      rendered: { status, body: { message: STATUS_CODES[status] ?? 'Bad Request' } },
    };
  }

  // The specification answers infrastructure and unexpected failures "by the platform, outside the
  // operation contract" (errors-and-enums.md §4; SECURITY_DESIGN.md §15.3): a deliberately code-less
  // body, so it can never be mistaken for a value of the closed Error.code enumeration.
  return {
    serverFault: true,
    rendered: { status: 500, body: { message: 'Internal server error' } },
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { rendered, serverFault } = render(exception);

    // The exception goes to the log only through the redacting logger's error serializer.
    if (serverFault) this.logger.error({ err: exception }, 'unhandled error');

    // An answer that has already left cannot be replaced: writing again would throw out of the filter.
    if (response.headersSent) return;

    response.status(rendered.status).json({
      ...rendered.body,
      request_id: response.getHeader(REQUEST_ID_HEADER),
    });
  }
}
