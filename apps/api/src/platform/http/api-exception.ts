import { HttpException } from '@nestjs/common';

import { ErrorCode, statusOf } from './error-codes.js';

/**
 * The headers the contract declares on an error response (contracts/openapi.yaml, `components.headers`, by way of the responses
 * that use them), and so the only ones an error answer may set. Today that is `Retry-After`, whole seconds, on the `503` of
 * `TRUST_DATA_UNAVAILABLE` and on the `429` told to a caller who has a session (`ApiException.rateLimited`). `error-codes.test.ts`
 * compares this list with the contract both ways: a header added to an error
 * response of the contract must be added here with the rule for its value, and one dropped from the contract must be dropped
 * here. A header an operation sets on a *success* is declared by its response and is not this list's business.
 */
export const DECLARED_ERROR_HEADERS = ['Retry-After'] as const;

type DeclaredErrorHeader = (typeof DECLARED_ERROR_HEADERS)[number];

/** The rule for the value of each declared header: `Retry-After` is a whole number of seconds, one or more. */
const HEADER_VALUE: Readonly<Record<DeclaredErrorHeader, RegExp>> = {
  'Retry-After': /^[1-9]\d{0,8}$/,
};

/**
 * A refusal that carries a catalogue code. Its `message` and `details` are rendered to the client
 * as written, so they must be fixed text or values the platform computed, never request input. Its `headers` are only those
 * the contract declares for an error response, with a value that header's schema allows: anything else is refused here, when the
 * exception is made, and never reaches a client.
 */
export class ApiException extends HttpException {
  readonly headers: Readonly<Partial<Record<DeclaredErrorHeader, string>>>;

  constructor(
    readonly code: ErrorCode,
    status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string>> = {},
  ) {
    super({ code, message }, status);
    for (const [name, value] of Object.entries(headers)) {
      const declared = DECLARED_ERROR_HEADERS.find((each) => each === name);
      if (declared === undefined) {
        throw new TypeError(`${name} is not a header the contract declares on an error response`);
      }
      if (!HEADER_VALUE[declared].test(value)) {
        throw new TypeError(`The value of ${name} is not what the contract declares for it`);
      }
    }
    this.headers = headers;
  }

  /** An exception for a code, with the status the contract gives it (`statusOf`). It refuses a code whose status is undecided. */
  static of(
    code: ErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    headers?: Readonly<Record<string, string>>,
  ): ApiException {
    return new ApiException(code, statusOf(code), message, details, headers);
  }

  /**
   * The `429 RATE_LIMITED` told to a caller who **has a session** (`AC-SLICE-000-131`; errors-and-enums.md §4, A2 of the audit): it carries
   * `Retry-After`, the whole seconds until the limiter admits that session again. The limiter's own wait is already a whole number from one
   * to its window; this is the one place a refusal turns it into the header, rounding up and never telling a wait of nought, so a client
   * sent back early is not refused once more. An answer given before a session exists is made with `of` and carries none (an attacker is
   * not told how long to wait), and the contract declares it with a response of its own (`RateLimitedAnonymous`).
   */
  static rateLimited(retryAfterSeconds: number): ApiException {
    return ApiException.of(ErrorCode.RateLimited, 'Too many requests', undefined, {
      'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
    });
  }
}
