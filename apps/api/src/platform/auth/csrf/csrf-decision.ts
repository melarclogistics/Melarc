import type { TokenService } from '../ports/token-service.port.js';
import { judgeFetchMetadata } from './fetch-metadata.js';
import { headerLines, judgeOrigin } from './origin-policy.js';

/**
 * The CSRF, Origin and Fetch Metadata decision for one browser mutation (S0.25; SECURITY_DESIGN.md §13.8; permission-enforcement.md
 * §5.1 step 3), as a function of the request's headers and, for a cookie-authenticated request, of the synchronizer token its
 * session stored. It does no I/O and reads no clock: the guard asks it, and the guard decides what to do with the answer.
 *
 * **The checks run in a fixed order, and the first failure is the one reported**: `Origin`, then Fetch Metadata, then (for a
 * session) the synchronizer token. The order only decides which cause the audit names; outward every failure is the same
 * `403 CSRF_VALIDATION_FAILED`, so the order tells a caller nothing.
 *
 * - A **pre-session** browser mutation has no session and so no token; the exact allowlisted `Origin` is the whole defence of the
 *   operation (openapi.yaml, `OriginRefused`), with Fetch Metadata beside it where the browser sends it.
 * - A **cookie-authenticated** mutation needs all three: the token is compared in constant time with the hash the session stored
 *   (`TokenService.matches`); a missing header, a repeated header, a token that is not a token and a session that holds no hash are
 *   all a mismatch, and none of them is skipped.
 * - The token and its hash are never part of the answer: the cause is a word.
 *
 * It decides nothing for a native Rider operation or for a safe method; the guard does not ask it for those.
 */

export type CsrfCheck =
  | 'ORIGIN_MISSING'
  | 'ORIGIN_NULL'
  | 'ORIGIN_MALFORMED'
  | 'ORIGIN_UNLISTED'
  | 'FETCH_METADATA'
  | 'TOKEN_MISSING'
  | 'TOKEN_MISMATCH';

export type CsrfDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly check: CsrfCheck };

/** The synchronizer half, present exactly when the request is authenticated by a browser session cookie. */
export interface SynchronizerCheck {
  /** The hash the session stored when it was issued; null for a session that holds none, which can match nothing. */
  readonly storedHash: Uint8Array | null;
  readonly tokens: Pick<TokenService, 'matches'>;
}

export interface BrowserMutation {
  /** The origins configured for the surface this request is for: one for a session, the route's surfaces before one. */
  readonly allowedOrigins: readonly string[];
  readonly rawHeaders: readonly string[];
  /** Present for a cookie-authenticated mutation, absent for a pre-session one. */
  readonly synchronizer?: SynchronizerCheck;
}

const ORIGIN_CHECK = {
  MISSING: 'ORIGIN_MISSING',
  NULL: 'ORIGIN_NULL',
  MALFORMED: 'ORIGIN_MALFORMED',
  UNLISTED: 'ORIGIN_UNLISTED',
} as const;

export function decideBrowserMutation(request: BrowserMutation): CsrfDecision {
  const origin = judgeOrigin(request.rawHeaders, request.allowedOrigins);
  if (origin.kind === 'REFUSED') return { allowed: false, check: ORIGIN_CHECK[origin.cause] };

  if (judgeFetchMetadata(request.rawHeaders) === 'UNEXPECTED') {
    return { allowed: false, check: 'FETCH_METADATA' };
  }

  const { synchronizer } = request;
  if (synchronizer === undefined) return { allowed: true };

  const presented = headerLines(request.rawHeaders, 'x-csrf-token');
  if (presented.length === 0) return { allowed: false, check: 'TOKEN_MISSING' };
  const [token] = presented;
  if (
    presented.length > 1 ||
    token === undefined ||
    synchronizer.storedHash === null ||
    !synchronizer.tokens.matches(token, synchronizer.storedHash)
  ) {
    return { allowed: false, check: 'TOKEN_MISMATCH' };
  }
  return { allowed: true };
}
