import { ApiError, apiErrorFromResponse } from '@melarc/api-client/browser';

/**
 * What a call to the API is, once it has been read: the data and the three things about the answer that a command
 * needs and `unwrap` does not keep (the status, the version in `ETag`, the request id), or an {@link OperationFailure}.
 *
 * It is a bounded reading of the response the generated client already returns (`{ data, error, response }`), made in
 * the application, so no generated file is edited and no wire type is written by hand. Everything it keeps from a
 * response is checked for the shape the contract declares, because a response is the server's text (or a proxy's)
 * and ends up on screens and in logs.
 */
export interface Answer<D> {
  readonly data: D;
  readonly status: number;
  /**
   * The version of the record, exactly as sent: an entity tag, kept to send back in `If-Match`. It is never read into;
   * a value that is not an entity tag is dropped, so it can never be sent back as a version.
   */
  readonly etag: string | undefined;
  readonly requestId: string | undefined;
}

/**
 * One place a request was refused, as a `VALIDATION_FAILED` declares it: where (`body`, `query`, ...), the JSON pointer
 * or parameter name, and the rule. It holds no value, and no text of the server's: the copy comes from the form that
 * knows the field, and a validation message never echoes what was typed.
 */
export interface Violation {
  readonly in: string;
  readonly pointer: string;
  readonly rule: string;
}

/** The most violations kept. A request that breaks more than this has broken the form, not the field. */
export const MAX_VIOLATIONS = 32;

const MAX_POINTER_LENGTH = 256;
const PLACE = /^[a-z]{1,16}$/;
const RULE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
// RFC 9110 entity-tag: an optional weak marker and a quoted run of printable characters other than the quote itself.
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]{0,254}"$/;

function violationOf(entry: unknown): Violation | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { in: place, pointer, rule } = entry as Record<string, unknown>;
  if (typeof place !== 'string' || typeof pointer !== 'string' || typeof rule !== 'string') {
    return undefined;
  }
  if (!PLACE.test(place) || !RULE.test(rule)) return undefined;
  // A control character is not part of any name or pointer the contract has, and would not survive being logged.
  // eslint-disable-next-line no-control-regex
  if (pointer.length > MAX_POINTER_LENGTH || /[\u0000-\u001f\u007f]/.test(pointer))
    return undefined;
  return { in: place, pointer, rule };
}

function violationsOf(body: unknown): Violation[] {
  if (typeof body !== 'object' || body === null) return [];
  const details = (body as Record<string, unknown>).details;
  if (typeof details !== 'object' || details === null) return [];
  const list = (details as Record<string, unknown>).violations;
  if (!Array.isArray(list)) return [];
  const kept: Violation[] = [];
  for (const entry of list as unknown[]) {
    const violation = violationOf(entry);
    if (violation !== undefined) kept.push(violation);
    if (kept.length === MAX_VIOLATIONS) break;
  }
  return kept;
}

/**
 * A call the API refused or could not answer, with the declared details `ApiError` leaves out. It is an `ApiError`
 * (same kind, status, code, request id and message), so the end of a session is noticed in the one place it is, and a
 * page that only wants the code needs nothing else.
 */
export class OperationFailure extends ApiError {
  override name = 'OperationFailure';
  readonly violations: readonly Violation[];

  constructor(base: ApiError, violations: readonly Violation[]) {
    super({
      kind: base.kind,
      ...(base.status === undefined ? {} : { status: base.status }),
      ...(base.code === undefined ? {} : { code: base.code }),
      ...(base.requestId === undefined ? {} : { requestId: base.requestId }),
    });
    this.violations = violations;
  }
}

function etagOf(response: Response): string | undefined {
  const value = response.headers.get('ETag');
  return value !== null && ENTITY_TAG.test(value) ? value : undefined;
}

function requestIdOf(response: Response): string | undefined {
  const value = response.headers.get('X-Request-Id');
  return value !== null && /^[0-9A-Za-z-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Reads the result of a call made with the browser client. Success is the response's status, never whether `error` is
 * set (a 403 with an empty body has no `error`); anything else throws an {@link OperationFailure}.
 */
export function answerOf<D>(result: {
  readonly data?: D;
  readonly error?: unknown;
  readonly response: Response;
}): Answer<D> {
  const { response } = result;
  if (!response.ok) {
    throw new OperationFailure(
      apiErrorFromResponse(response, result.error),
      violationsOf(result.error),
    );
  }
  return {
    data: result.data as D,
    status: response.status,
    etag: etagOf(response),
    requestId: requestIdOf(response),
  };
}

/**
 * An answer that is not the API's although its status said success: JSON that is not the shape the contract declares for the call (a
 * proxy's page, a list from another version). It is judged where the data is read, and it fails like any answer the API did not give.
 */
export function unexpectedResponse(status: number): ApiError {
  return new ApiError({ kind: 'unexpected-response', status });
}

/**
 * Whether a failure says the record is not there: the API answered `404`. A refused permission, a record in another hub and a fault do not,
 * and a screen that treats a missing record as done (ending a session that had already ended) must not take them for it.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === 404;
}

/**
 * Whether a failure says the person is not signed in: the API answered `401`. A refused permission (`403`), a fault
 * and a connection that dropped do not, and none of them may sign a person out.
 */
export function isNotSignedIn(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'http' && error.status === 401;
}
