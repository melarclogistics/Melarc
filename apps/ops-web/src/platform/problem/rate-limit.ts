/**
 * The one handling of a request the API refused for being too fast (`RATE_LIMITED`, `429`): its words and its wait (Product Owner, 7 November
 * 2026, A2 of the audit; surfaces/ops-portal.md section 8, which owns the rule; the server's side, and the `Retry-After` it gives a signed-in
 * caller, is `AC-SLICE-000-131`). Everything about a `429` that a screen needs comes from here, so no screen words or times one of its own.
 *
 * - **The words** are {@link RATE_LIMITED_MESSAGE}: calm and plain, never a fault, a lockout or a reason to leave. `problemOf` gives them to
 *   every `rate-limited` failure that has no words of its own (the screens reached before sign-in keep theirs: their answer carries no wait),
 *   and the command palette (step R4) shows them in its status line and not in an error alert.
 * - **The wait** is what the API asked for in `Retry-After` (whole seconds, from 1 to 60), kept to the ceiling when it is longer, and a few
 *   seconds when the header is missing or cannot be used. `problemOf` carries it as `waitSeconds`, and the page keeps its automatic reads
 *   still for that long (`platform/query/read-hold.ts`). A read the person asks for by pressing a control is never held.
 * - **Nothing is tried again by itself**: the query client never retries a `429` (`shouldRetryQuery`), and the end of a hold sends one read for
 *   what was held back, not a read of the one that was refused.
 */

/** What a person is told, exactly (the Product Owner's words). */
export const RATE_LIMITED_MESSAGE = "You're going a little fast. Try again in a few seconds.";

/** The wait, in seconds, when the API gave none or one that cannot be used: a few seconds. */
export const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 5;

/**
 * The longest wait the page keeps, in seconds. The limiter's window is a minute, so no honest `Retry-After` is longer, and a longer one (a proxy's,
 * a fault's) must not stop the page reading for an hour.
 */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

/**
 * `Retry-After` as the API sends it to a signed-in caller: whole seconds, one or more. Anything else (an HTTP date, a fraction, nought, a
 * negative, text, nothing) is not a wait the page can honour, and is `undefined`; the default wait stands in for it.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!/^[0-9]{1,9}$/.test(text)) return undefined;
  const seconds = Number(text);
  return seconds >= 1 ? seconds : undefined;
}

/** The wait the page keeps for a refusal, in whole seconds: what the API asked, no more than the ceiling, or the default when it asked for nothing usable. */
export function rateLimitWaitSeconds(asked: number | undefined): number {
  if (asked === undefined || !Number.isFinite(asked) || asked < 1) {
    return DEFAULT_RATE_LIMIT_WAIT_SECONDS;
  }
  return Math.min(Math.ceil(asked), MAX_RATE_LIMIT_WAIT_SECONDS);
}
