import type { IncomingHttpHeaders } from 'node:http';

import { COOKIES } from '../cookies/cookie-writer.js';

/**
 * What a request presents as its trusted-browser credential: the cookie `melarc_trusted_browser` by exact name, and nothing else (it is
 * sent to `Path=/api/v1/auth/staff` and is read there alone). **It is not decoded, trimmed (but for the optional space around a cookie
 * pair) or normalised**, because what is presented is what is hashed, and a value that is not a well-formed token matches nothing
 * (`TokenService.hash` says so).
 *
 * Two of the cookie, with the same value or not, are **no credential**: a second one can only come from a sibling scope the client did not
 * intend, and which of the two a server reads first is not a rule. It is treated as absent and never reported, as an unknown or an
 * expired one is (staff-authentication.md §5.8: "an invalid credential is never mentioned").
 */
export function presentedTrustedBrowser(headers: IncomingHttpHeaders): string | undefined {
  const header = headers.cookie;
  const text = Array.isArray(header) ? header.join('; ') : header;
  if (text === undefined) return undefined;
  const found: string[] = [];
  for (const pair of text.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === COOKIES.trustedBrowser) {
      found.push(pair.slice(separator + 1).trim());
    }
  }
  return found.length === 1 ? found[0] : undefined;
}
