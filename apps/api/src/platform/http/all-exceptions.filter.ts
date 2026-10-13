import { STATUS_CODES } from 'node:http';

import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { Logger } from 'pino';

import { REQUEST_ID_HEADER } from '../logging/request-middleware.js';
import { PIPELINE_ANSWER_KEY } from './admission/response-keys.js';
import { ApiException } from './api-exception.js';
import { ErrorCode } from './error-codes.js';
import { classifyFailure } from './operational-failure.js';

/** The body of an answer before the request id is added. */
export interface Rendered {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** The headers the answer sets: only those the contract declares for an error response (see `ApiException`). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** What goes to the log for a failure: the level, the line, and the facts beside the error. Nothing of a body or a header. */
interface Report {
  readonly level: 'error' | 'warn';
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * The platform's answers for a failure of its own resources (S0.20; plan OB-37 and OB-55), by fixed text, never by anything the
 * failure says. Both are outside the operation contract and carry no `code` (SECURITY_DESIGN.md §15.3; errors-and-enums.md §4):
 * an outage is `503`, and a commit that may have happened is a `500` of its own that never invites a retry. Neither sends
 * `Retry-After`, because no retained specification sets a figure for one.
 */
export const OPERATIONAL_FAILURE: Rendered = {
  status: 503,
  body: { message: 'Service unavailable' },
};
const COMMIT_OUTCOME_UNKNOWN: Rendered = {
  status: 500,
  body: { message: 'The outcome of the request could not be confirmed' },
};

/**
 * A 4xx status carried by the framework or by Express middleware (body-parser throws these). Another error that
 * happens to have a numeric `status` (a client library's, an upstream's) does not count: a 401 or a 429 from a
 * dependency is not one for the caller of this API. The `http-errors` convention marks an error meant for the
 * client with `expose`, and that is what the body parser's errors carry.
 */
function clientErrorStatus(exception: unknown): number | undefined {
  let status: unknown;
  if (exception instanceof HttpException) {
    status = exception.getStatus();
  } else {
    const carried = exception as { status?: unknown; expose?: unknown } | null;
    status = carried?.expose === true ? carried.status : undefined;
  }
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

function answeredByPipeline(response: Response): boolean {
  // A response of a test double may carry no `locals`.
  return (response.locals as Record<string, unknown> | undefined)?.[PIPELINE_ANSWER_KEY] === true;
}

/** The error Node raises when something sets a header or a status on a response that has already been sent. */
function isHeadersAlreadySent(exception: unknown): boolean {
  return (exception as { code?: unknown } | null)?.code === 'ERR_HTTP_HEADERS_SENT';
}

/**
 * The single place a failure becomes a response. Nothing from the failure itself is ever copied into
 * the body: no message, no path, no stack. Framework default bodies echo the method and path, and
 * body-parser errors carry the raw body, so each case is rendered from fixed text.
 */
function render(exception: unknown): { rendered: Rendered; report: Report | undefined } {
  if (exception instanceof ApiException) {
    // Its text is written by the platform, never taken from the request (see ApiException).
    const { code, message, details } = exception;
    return {
      report: undefined,
      rendered: {
        status: exception.getStatus(),
        body: details === undefined ? { code, message } : { code, message, details },
        headers: exception.headers,
      },
    };
  }

  const status = clientErrorStatus(exception);
  if (status === 404) {
    return {
      report: undefined,
      rendered: { status, body: { code: ErrorCode.NotFound, message: 'Resource not found' } },
    };
  }
  if (status === 400) {
    // The contract answers 400 with VALIDATION_FAILED. Nest 12 turns a body-parser SyntaxError into a
    // BadRequestException whose message can quote the request body, so the text here is fixed.
    return {
      report: undefined,
      rendered: {
        status,
        body: { code: ErrorCode.ValidationFailed, message: 'The request is not valid' },
      },
    };
  }
  if (status !== undefined) {
    // The catalogue has no code for this client error, so the body carries none either.
    return {
      report: undefined,
      rendered: { status, body: { message: STATUS_CODES[status] ?? 'Bad Request' } },
    };
  }

  // The specification answers infrastructure and unexpected failures "by the platform, outside the
  // operation contract" (errors-and-enums.md §4; SECURITY_DESIGN.md §15.3): a deliberately code-less
  // body, so it can never be mistaken for a value of the closed Error.code enumeration. Three readings, kept apart on the wire:
  // an outage (503), a commit that may have happened (500 with its own text) and anything else (500).
  const failure = classifyFailure(exception);
  if (failure.kind === 'operational') {
    return {
      rendered: OPERATIONAL_FAILURE,
      report: { level: 'warn', message: 'request failed: the service could not do the work' },
    };
  }
  if (failure.kind === 'commit-outcome-unknown') {
    return {
      rendered: COMMIT_OUTCOME_UNKNOWN,
      report: {
        level: 'error',
        message: 'request failed: the outcome of its commit is unknown',
        fields: { reason: failure.reason },
      },
    };
  }
  return {
    report: { level: 'error', message: 'unhandled error' },
    rendered: { status: 500, body: { message: 'Internal server error' } },
  };
}

/**
 * Answers a request with the failure it ended in. The filter below uses it for everything Nest handles; the
 * fallback for requests no route answers uses it too (see NotFoundFallback), so that one function, and not
 * Express's default page, is what a client ever sees of a failure.
 */
export function sendFailure(response: Response, exception: unknown, logger: Logger): void {
  // The work of a request the pipeline answered for it (it outlasted its budget) has now ended and found the response sent: the
  // framework's attempt to send its result is refused. That is the expected end of such work and not a defect, so it is said
  // once, as a warning, and does not page. Any other failure of that work is still reported as what it is.
  if (answeredByPipeline(response) && isHeadersAlreadySent(exception)) {
    logger.warn(
      'the work of a request the pipeline had answered has ended; its result was not sent',
    );
    return;
  }
  const { rendered, report } = render(exception);

  // The exception goes to the log only through the redacting logger's error serializer.
  if (report !== undefined) {
    logger[report.level]({ err: exception, ...report.fields }, report.message);
  }

  writeFailure(response, rendered);
}

/**
 * Writes a rendered answer: its status and body with the request id. An answer that has already left cannot be replaced, and
 * writing again would throw out of the filter, so this does nothing then. A transport refusal (`admission/transport-refusal.ts`)
 * answers through this and not through `sendFailure`, because it is logged once, in the completion line of the request, and a
 * flood of refused requests must not write a second line for each.
 */
export function writeFailure(response: Response, rendered: Rendered): void {
  if (response.headersSent) return;

  for (const [name, value] of Object.entries(rendered.headers ?? {}))
    response.setHeader(name, value);
  response.status(rendered.status).json({
    ...rendered.body,
    request_id: response.getHeader(REQUEST_ID_HEADER),
  });
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    sendFailure(host.switchToHttp().getResponse<Response>(), exception, this.logger);
  }
}
