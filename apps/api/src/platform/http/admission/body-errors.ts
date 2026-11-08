import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';

import { markBodyParseFailure } from './parse-failure.js';
import { refuseTransport } from './transport-refusal.js';

/** The `type` the body parser puts on the errors it raises (`http-errors` convention); anything else has none. */
function typeOf(error: unknown): string | undefined {
  const type = (error as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : undefined;
}

/**
 * What the platform makes of an error the JSON body parser raised, placed straight after the parser (S0.20):
 *
 * - a body that is not valid JSON (`entity.parse.failed`, which includes the `__proto__` refusal of the reviver) is **not
 *   refused here**. It is marked and the request goes on, so the guards answer it first and the validation step, which is where
 *   the refusal order puts it, answers `VALIDATION_FAILED` (`AC-SLICE-000-130`);
 * - a body over the limit, an encoding or a charset the parser will not read, and a body whose length does not agree with its
 *   framing, are transport refusals, answered as the receipt limits answer them;
 * - anything else is not the body's fault and is passed on to the filter as the failure it is.
 *
 * A request already answered by the receipt limits (they answer when the limit is crossed, and the parser meets the same
 * limit a moment later) is left as it is.
 */
export function bodyErrors(): ErrorRequestHandler {
  return (error: unknown, request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) return;
    switch (typeOf(error)) {
      case 'entity.parse.failed':
        markBodyParseFailure(request);
        next();
        return;
      case 'entity.too.large':
        refuseTransport(response, 'body-too-large');
        return;
      case 'encoding.unsupported':
        refuseTransport(response, 'compressed-body');
        return;
      case 'charset.unsupported':
        refuseTransport(response, 'unsupported-charset');
        return;
      case 'request.size.invalid':
      case 'request.aborted':
        refuseTransport(response, 'invalid-framing');
        return;
      default:
        next(error);
    }
  };
}
