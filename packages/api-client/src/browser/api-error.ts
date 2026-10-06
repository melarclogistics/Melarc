/**
 * What a failed call is, as the one value a caller can rely on.
 *
 * openapi-fetch reports a call as `{ data, error, response }` and leaves it to the caller to look at `error`. That
 * is not enough to tell success from failure: a 403 or a 502 with an empty body, a JSON body that is `null` or `0`,
 * and a 304 all have a falsy `error`, so `if (error)` takes a refused command for a success. The status is what
 * says, and {@link unwrap} reads it.
 */

/**
 * `http`: the API answered with a status that is not a success. `unexpected-response`: it answered with a
 * success status and something that is not the contract's JSON (a proxy's page, a truncated body). `network`: no
 * answer arrived, or not all of it.
 */
export type ApiErrorKind = 'http' | 'unexpected-response' | 'network';

export interface ApiErrorInit {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  /** The contract's `Error.code`, when the body was the contract's error envelope. */
  readonly code?: string;
  readonly requestId?: string;
}

/** The shape of a contract code and of a request id. Anything else in a body is not trusted enough to keep. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const REQUEST_ID = /^[0-9A-Za-z-]{1,64}$/;

/** Codes that mean the session has ended, whatever the operation (errors-and-enums.md section 4). */
export const SESSION_ENDED_CODES: ReadonlySet<string> = new Set([
  'SESSION_INVALID',
  'SESSION_SUPERSEDED',
]);

/**
 * A call that did not succeed. Its message is built from the status and the code, never from the response: a body
 * is the server's text, and an error message ends up in logs and on screens.
 */
export class ApiError extends Error {
  override name = 'ApiError';
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(init: ApiErrorInit) {
    const what =
      init.kind === 'network'
        ? 'The API did not answer'
        : init.kind === 'unexpected-response'
          ? `The API answered ${String(init.status)} with something that is not its JSON`
          : `The API answered ${String(init.status)}${init.code === undefined ? '' : ` ${init.code}`}`;
    super(what);
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
  }

  /** Whether the API said that the session has ended: the person must sign in again (or, for a vendor, was displaced). */
  get endsSession(): boolean {
    return this.code !== undefined && SESSION_ENDED_CODES.has(this.code);
  }
}

function stringField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

/** The error of a response that was not a success, built from what the response and its parsed body say. */
export function apiErrorFromResponse(response: Response, body: unknown): ApiError {
  const code = stringField(body, 'code');
  const requestId = response.headers.get('X-Request-Id') ?? stringField(body, 'request_id');
  return new ApiError({
    kind: 'http',
    status: response.status,
    ...(code !== undefined && ERROR_CODE.test(code) ? { code } : {}),
    ...(requestId !== undefined && REQUEST_ID.test(requestId) ? { requestId } : {}),
  });
}

/**
 * The data of a call, or an {@link ApiError}. A call succeeded when its response has a success status, which is
 * the only thing that says so: whether `error` is set depends on what the body happened to hold.
 *
 * A call with no content (a 204, or an empty success) has no data and returns `undefined`.
 */
export function unwrap<D>(result: {
  readonly data?: D;
  readonly error?: unknown;
  readonly response: Response;
}): D {
  if (!result.response.ok) throw apiErrorFromResponse(result.response, result.error);
  return result.data as D;
}
