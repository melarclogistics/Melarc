import type { Response } from 'express';

/**
 * The three cookies of the identity slice (contracts/openapi.yaml, root `x-cookies`; SECURITY_DESIGN.md §13.2). The names are the
 * contract's; `cookie-writer.test.ts` compares them with it, and judges every line the writer makes with the contract's own
 * cookie checker, so a drift of either is a failing test and not a quiet change in what a browser stores.
 */
export const COOKIES = {
  session: 'melarc_session',
  csrf: 'melarc_csrf',
  vendorDevice: 'melarc_vendor_device',
} as const;

export type CookieName = (typeof COOKIES)[keyof typeof COOKIES];

/** The vendor device credential's lifetime: 400 days, renewed at each vendor sign-in (SECURITY_DESIGN.md §13.2). */
const VENDOR_DEVICE_MAX_AGE_SECONDS = 34_560_000;

/**
 * A cookie value is an opaque token in its displayed form (base64url, SECURITY_DESIGN.md §14.9). The rule is on the characters,
 * so that nothing that could end the field, add an attribute or begin another cookie can be written, and on a length that rules
 * out an empty or a trivially guessable value; it does not fix the token's length, which `TokenService` owns.
 */
const TOKEN_VALUE = /^[A-Za-z0-9_-]{22,128}$/;

interface CookieKind {
  /** Whether script on the page can read it. Only the CSRF token is meant to be read: the client echoes it in a header. */
  readonly httpOnly: boolean;
  /** Seconds of life for a cookie that outlives the browser session; a browser-session cookie has none. */
  readonly maxAgeSeconds?: number;
}

const KIND: Readonly<Record<CookieName, CookieKind>> = {
  [COOKIES.session]: { httpOnly: true },
  [COOKIES.csrf]: { httpOnly: false },
  [COOKIES.vendorDevice]: { httpOnly: true, maxAgeSeconds: VENDOR_DEVICE_MAX_AGE_SECONDS },
};

function checked(name: string): CookieName {
  const known = Object.values(COOKIES).find((each) => each === name);
  if (known === undefined) throw new TypeError(`${name} is not a cookie of the identity slice`);
  return known;
}

/** The attributes every cookie of the slice carries: host-only (no `Domain`), the whole site, `Secure`, `SameSite=Lax`. */
function attributes(kind: CookieKind): string {
  return `Path=/; ${kind.httpOnly ? 'HttpOnly; ' : ''}Secure; SameSite=Lax`;
}

/**
 * One `Set-Cookie` field line, the only place one is made. An issued cookie carries its value and its attributes (and a
 * persistent cookie its lifetime); an expired one has an empty value, the literal `Max-Age=0` and the attributes it was issued
 * with, so that the deletion matches the scope the cookie was set in. Express's own `clearCookie` writes an `Expires` in the past
 * and no `Max-Age`, which is not the decision (SECURITY_DESIGN.md §13.2; SLICE-000-FINAL-DECISIONS.md §11), so it is not used.
 */
export function setCookieLine(
  name: CookieName,
  value: string | undefined,
  options: { readonly httpOnly: boolean; readonly maxAgeSeconds?: number },
): string {
  checked(name);
  const kind: CookieKind = options;
  if (value === undefined) return `${name}=; Max-Age=0; ${attributes(kind)}`;
  if (!TOKEN_VALUE.test(value)) throw new TypeError(`The value of ${name} is not a token`);
  const lifetime =
    kind.maxAgeSeconds === undefined ? '' : `; Max-Age=${String(kind.maxAgeSeconds)}`;
  return `${name}=${value}; ${attributes(kind)}${lifetime}`;
}

/**
 * Each line is a field of its own (`append`, never a joined list: a browser stores the cookies of a comma-separated field
 * as one, if at all). Every value is judged before any line is written, so a refusal leaves the response as it was.
 */
function appendLines(response: Response, lines: readonly string[]): void {
  for (const line of lines) response.append('Set-Cookie', line);
}

/** The cookies a browser sign-in sets: the session and the CSRF token, both browser-session cookies (no `Max-Age`). */
export function issueBrowserSessionCookies(
  response: Response,
  tokens: { readonly session: string; readonly csrf: string },
): void {
  appendLines(response, [
    setCookieLine(COOKIES.session, tokens.session, KIND[COOKIES.session]),
    setCookieLine(COOKIES.csrf, tokens.csrf, KIND[COOKIES.csrf]),
  ]);
}

/**
 * What a browser sign-out sends: the session and CSRF cookies expired. **The vendor device cookie is never among them, and there
 * is no function here that expires it**: clearing the browser-session cookies must not delete the long-lived registration of
 * the vendor's browser, which is what makes it a second factor.
 */
export function expireBrowserSessionCookies(response: Response): void {
  appendLines(response, [
    setCookieLine(COOKIES.session, undefined, KIND[COOKIES.session]),
    setCookieLine(COOKIES.csrf, undefined, KIND[COOKIES.csrf]),
  ]);
}

/** The registered-browser credential a vendor sign-in (or the setup that establishes it) sets or renews. */
export function issueVendorDeviceCookie(response: Response, value: string): void {
  appendLines(response, [setCookieLine(COOKIES.vendorDevice, value, KIND[COOKIES.vendorDevice])]);
}
