import type { IncomingHttpHeaders } from 'node:http';

/** The cookie of a browser session (contracts/openapi.yaml, `browserSession`; SECURITY_DESIGN.md §13.2). */
export const SESSION_COOKIE_NAME = 'melarc_session';

/**
 * What a request presents as its session credential. The three authentication models never mix (SECURITY_DESIGN.md §13.8): a
 * browser session travels in the cookie and a Rider's in a bearer credential, and a request that presents both, or the session
 * cookie twice, has no single credential to judge and is refused rather than resolved in favour of one of them.
 */
export type PresentedCredential =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'AMBIGUOUS' }
  | { readonly kind: 'COOKIE'; readonly token: string }
  | { readonly kind: 'BEARER'; readonly token: string };

const BEARER = /^bearer(?: (.*))?$/i;

/** The values of the session cookie among the pairs of a `Cookie` header, in the order sent. Names compare exactly. */
function sessionCookieValues(header: string): string[] {
  const found: string[] = [];
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      found.push(pair.slice(separator + 1).trim());
    }
  }
  return found;
}

/**
 * How many `Authorization` header lines the request sent. Node keeps only the first of a duplicated `Authorization` header in
 * `headers` (and joins a duplicated `Cookie`), so a second credential can be seen only in the raw lines, which alternate name and value.
 */
function authorizationLines(rawHeaders: readonly string[]): number {
  let lines = 0;
  for (let at = 0; at < rawHeaders.length; at += 2) {
    if (rawHeaders[at]?.toLowerCase() === 'authorization') lines += 1;
  }
  return lines;
}

const headerText = (value: string | readonly string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join('; ') : (value as string | undefined);

/**
 * Reads the credential from the headers and does nothing to it: it is not decoded, trimmed (but for the optional space around a
 * cookie pair), unquoted or normalised, because what is presented is what is hashed and looked up, and a value that is not a
 * well-formed token simply matches nothing (`TokenService.hash` says so).
 *
 * - The cookie is the **session cookie by exact name**. Two of it, with the same value or not, are ambiguous: a second one can
 *   only come from a sibling scope that the client did not intend, and which of the two a server reads first is not a rule.
 * - A bearer credential is `Authorization: Bearer <token>`, the scheme in any case. A different scheme is not ours and is no
 *   credential. A `Bearer` with nothing usable after it is still a bearer credential, of an empty token, so that it is refused as
 *   a bad credential and not mistaken for a request that has none.
 * - A cookie and a bearer credential together are ambiguous, and so are two `Authorization` header lines, however alike: Node keeps
 *   only the first of them in `headers`, so they are counted in `rawHeaders`.
 */
export function presentedCredential(
  headers: IncomingHttpHeaders,
  rawHeaders: readonly string[],
): PresentedCredential {
  const cookieHeader = headerText(headers.cookie);
  const cookies = cookieHeader === undefined ? [] : sessionCookieValues(cookieHeader);
  const authorization = headerText(headers.authorization);
  const bearer = authorization === undefined ? null : BEARER.exec(authorization);

  if (cookies.length > 1 || authorizationLines(rawHeaders) > 1) return { kind: 'AMBIGUOUS' };
  const cookie = cookies[0];
  if (cookie !== undefined && bearer !== null) return { kind: 'AMBIGUOUS' };
  if (cookie !== undefined) return { kind: 'COOKIE', token: cookie };
  if (bearer !== null) return { kind: 'BEARER', token: bearer[1] ?? '' };
  return { kind: 'NONE' };
}
