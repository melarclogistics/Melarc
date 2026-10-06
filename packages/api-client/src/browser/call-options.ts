import type { FetchOptions, FetchResponse } from 'openapi-fetch';

import type { paths } from '../generated/schema.ts';
import { BrowserTransportError } from './send-boundary.ts';

/**
 * Everything a call may bring besides the operation itself. The underlying client takes many more options
 * (`credentials`, `redirect`, `baseUrl`, `fetch`, `Request`, `middleware`, the serializers, anything a
 * `RequestInit` holds) and acts on all of them; they decide where, how and by what a request is sent, so they
 * belong to the transport and not to a call. A feature that needs another option adds it here, on purpose.
 *
 * This one list is both the run-time gate and the compile-time type, so the two cannot drift apart.
 */
export const CALL_OPTIONS = ['params', 'body', 'parseAs', 'signal', 'headers'] as const;
export type CallOption = (typeof CALL_OPTIONS)[number];

const ALLOWED: ReadonlySet<string> = new Set(CALL_OPTIONS);

/**
 * The options of one call, checked: a new object with exactly the allowed options the caller owns, so that
 * nothing the caller (or a getter, or a prototype) changes afterwards can reach the client. Any other option is
 * refused by name, whatever its value, and the value is not repeated.
 */
export function checkedCallOptions(
  init: unknown,
): Partial<Record<CallOption, unknown>> | undefined {
  if (init === undefined) return undefined;
  if (typeof init !== 'object' || init === null || Array.isArray(init)) {
    throw new BrowserTransportError('The options of a call must be an object.');
  }

  const refused = Object.keys(init).filter((key) => !ALLOWED.has(key));
  if (refused.length > 0) {
    throw new BrowserTransportError(
      `Refusing the call option${refused.length === 1 ? '' : 's'} ${refused.join(', ')}: the browser ` +
        'transport decides where, how and by what a request is sent. A call may use: ' +
        `${CALL_OPTIONS.join(', ')}.`,
    );
  }

  const source = init as Record<string, unknown>;
  const checked: Partial<Record<CallOption, unknown>> = {};
  for (const key of CALL_OPTIONS) {
    if (Object.hasOwn(source, key)) checked[key] = source[key];
  }
  refuseUnsafePathParameters(checked.params);
  return checked;
}

/**
 * A value that, put into the URL, is not one real segment: `..` climbs a segment, `.` and an empty value drop
 * one. The call would reach a different route inside /api/v1 than the operation it names (GET
 * /pickup-requests/{id} with `.` is GET /pickup-requests/), which the final boundary cannot see because the
 * request is still under the API path. Every other value is encoded into one segment by the client
 * (`encodeURIComponent` turns `/` and `%` into escapes), so only these three need refusing.
 */
function isNotOneSegment(value: unknown): boolean {
  const single = Array.isArray(value) && value.length === 1 ? (value[0] as unknown) : value;
  return single === '' || single === '.' || single === '..';
}

function refuseUnsafePathParameters(params: unknown): void {
  if (typeof params !== 'object' || params === null) return;
  const path = (params as { path?: unknown }).path;
  if (typeof path !== 'object' || path === null) return;

  const refused = Object.entries(path).filter(([, value]) => isNotOneSegment(value));
  if (refused.length > 0) {
    throw new BrowserTransportError(
      `Refusing the path parameter${refused.length === 1 ? '' : 's'} ${refused
        .map(([name]) => name)
        .join(', ')}: a path parameter must be one real segment, not an empty value, "." or "..".`,
    );
  }
}

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

/** The method of a generic `request` call, as given, when it is one the contract's HTTP verbs name. */
export function checkedMethod(method: unknown): string {
  if (typeof method !== 'string' || !HTTP_METHODS.has(method.toLowerCase())) {
    throw new BrowserTransportError('The method of a request must be one of the eight HTTP verbs.');
  }
  return method;
}

// ---------------------------------------------------------------------------------------------------------
// The types. They are the underlying client's own (openapi-fetch 0.17.0: ClientMethod, MaybeOptionalInit and
// InitParam) with two changes: a call's options are cut down to CALL_OPTIONS, and an option outside the list
// is an error, where the original accepts any key (`Init & { [key: string]: unknown }`). The answer is the
// original's `FetchResponse`, so the generated typing of every operation is unchanged; the type tests in
// browser-client.test.ts compare the two.

type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace';
type MediaType = `${string}/${string}`;

/** The paths of the contract that have an operation for `Method`. */
type PathsWithMethod<Method extends HttpMethod> = {
  [Pathname in keyof paths]: paths[Pathname] extends Record<Method, unknown> ? Pathname : never;
}[keyof paths];

// The shape openapi-fetch's FetchResponse requires of an operation. `Extract` leaves the operation itself
// untouched (an intersection with an index signature of `any` would turn every property of it into `any`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the constraint FetchResponse declares
type OperationObject = Record<string | number, any>;

type OperationOf<Path extends keyof paths, Method extends HttpMethod> = Extract<
  Method extends keyof paths[Path] ? paths[Path][Method] : never,
  OperationObject
>;

/** The keys of `T` that must be given. `never` when there are none. */
type RequiredKeysOf<T> = {
  [K in keyof T]-?: Partial<Pick<T, K>> extends Pick<T, K> ? never : K;
}[keyof T];

/**
 * The underlying client's options for an operation, cut down to the options a call may use. For no operation
 * at all (`never`, which is what a path typed `as never` gives) there are no options, as in the original.
 */
type CallInit<Operation> = [Operation] extends [never]
  ? never
  : Pick<FetchOptions<Operation>, Extract<keyof FetchOptions<Operation>, CallOption>>;

/** The options may be left out altogether when the operation needs no parameter and no body. */
type MaybeOptionalInit<Operation> =
  RequiredKeysOf<CallInit<Operation>> extends never
    ? CallInit<Operation> | undefined
    : CallInit<Operation>;

/** An option outside CALL_OPTIONS is an error, in a literal and in a variable alike. */
type Exact<Init> = Init & Readonly<Record<Exclude<keyof Init, CallOption>, never>>;

type InitParam<Init> =
  RequiredKeysOf<Init> extends never ? [init?: Exact<Init>] : [init: Exact<Init>];

type RestrictedMethod<Method extends HttpMethod> = <
  Path extends PathsWithMethod<Method>,
  Init extends MaybeOptionalInit<OperationOf<Path, Method>>,
>(
  url: Path,
  ...init: InitParam<Init>
) => Promise<FetchResponse<OperationOf<Path, Method>, Init, MediaType>>;

type RestrictedRequest = <
  Method extends HttpMethod,
  Path extends PathsWithMethod<Method>,
  Init extends MaybeOptionalInit<OperationOf<Path, Method>>,
>(
  method: Method,
  url: Path,
  ...init: InitParam<Init>
) => Promise<FetchResponse<OperationOf<Path, Method>, Init, MediaType>>;

/**
 * The typed client for the contract's operations, with no way to add middleware, replace the send function or
 * pass the transport's options. It is frozen.
 */
export interface RestrictedClient {
  readonly request: RestrictedRequest;
  readonly GET: RestrictedMethod<'get'>;
  readonly PUT: RestrictedMethod<'put'>;
  readonly POST: RestrictedMethod<'post'>;
  readonly DELETE: RestrictedMethod<'delete'>;
  readonly OPTIONS: RestrictedMethod<'options'>;
  readonly HEAD: RestrictedMethod<'head'>;
  readonly PATCH: RestrictedMethod<'patch'>;
  readonly TRACE: RestrictedMethod<'trace'>;
}
