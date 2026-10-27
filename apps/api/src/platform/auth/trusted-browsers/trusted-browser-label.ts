/**
 * The short description a person recognises a trusted browser by ("Chrome on Windows"), made from the request's `User-Agent` by a closed
 * list of browser and system names (domain-model.md §6.8 `TrustedBrowser`, field `label`).
 *
 * - **The header is never stored and never echoed**: only a name from the two lists below can reach the label, so nothing the client typed
 *   does, whatever it sent, and the label is always within the table's check (1 to 80 characters, no control character).
 * - It is **not a security control**. A client can send any header, so the label may say "Firefox on Linux" for another browser; it exists
 *   so that a person looking at their list can tell which entry is which.
 * - Order matters and is the order of the lists: Edge, Opera and Samsung Internet also say "Chrome", Chrome also says "Safari", and an
 *   Android browser also says "Linux".
 */

const BROWSERS: readonly (readonly [name: string, token: string])[] = [
  ['Edge', 'edg/'],
  ['Edge', 'edga/'],
  ['Edge', 'edgios/'],
  ['Opera', 'opr/'],
  ['Samsung Internet', 'samsungbrowser/'],
  ['Firefox', 'firefox/'],
  ['Firefox', 'fxios/'],
  ['Chrome', 'chrome/'],
  ['Chrome', 'crios/'],
  ['Safari', 'safari/'],
];

const SYSTEMS: readonly (readonly [name: string, token: string])[] = [
  ['Android', 'android'],
  ['iOS', 'iphone'],
  ['iOS', 'ipad'],
  ['iOS', 'ipod'],
  ['ChromeOS', 'cros'],
  ['Windows', 'windows'],
  ['macOS', 'macintosh'],
  ['macOS', 'mac os x'],
  ['Linux', 'linux'],
  ['Linux', 'x11'],
];

/** What the label says when nothing in the header is on the lists. */
export const UNRECOGNISED_BROWSER_LABEL = 'Unrecognised browser';

/** A `User-Agent` is read to its first 512 characters: no real browser says more, and the lists are matched, not parsed. */
const READ_LIMIT = 512;

function nameOf(
  list: readonly (readonly [name: string, token: string])[],
  header: string,
): string | undefined {
  return list.find(([, token]) => header.includes(token))?.[0];
}

/**
 * The label for a request's `User-Agent` header (`undefined` when it sent none or sent it more than once, which a framework hands over
 * as an array). Always a non-empty string of at most 40 characters made only of the names above.
 */
export function trustedBrowserLabel(userAgent: string | readonly string[] | undefined): string {
  if (typeof userAgent !== 'string') return UNRECOGNISED_BROWSER_LABEL;
  const header = userAgent.slice(0, READ_LIMIT).toLowerCase();
  const browser = nameOf(BROWSERS, header);
  const system = nameOf(SYSTEMS, header);
  if (browser !== undefined && system !== undefined) return `${browser} on ${system}`;
  if (browser !== undefined) return browser;
  if (system !== undefined) return `Browser on ${system}`;
  return UNRECOGNISED_BROWSER_LABEL;
}
