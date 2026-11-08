import type { IncomingHttpHeaders } from 'node:http';

import { COOKIES } from '../cookies/cookie-writer.js';

/**
 * What a request presents as its registered browser's credential: the cookie `melarc_vendor_device` by exact name, and nothing else
 * (SECURITY_DESIGN.md section 13.8a; nobody types it). **It is not decoded, trimmed (but for the optional space around a cookie pair) or
 * normalised**: what is presented is what is hashed, and a value that is not a well-formed token matches nothing (`TokenService.hash`).
 *
 * Two of the cookie, with the same value or not, are **no credential**: a second can only come from a scope the client did not intend, and
 * which a server reads first is not a rule. It is treated as absent, as an unknown one is, and never reported.
 */
export function presentedVendorDevice(headers: IncomingHttpHeaders): string | undefined {
  const header = headers.cookie;
  const text = Array.isArray(header) ? header.join('; ') : header;
  if (text === undefined) return undefined;
  const found: string[] = [];
  for (const pair of text.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === COOKIES.vendorDevice) {
      found.push(pair.slice(separator + 1).trim());
    }
  }
  return found.length === 1 ? found[0] : undefined;
}
