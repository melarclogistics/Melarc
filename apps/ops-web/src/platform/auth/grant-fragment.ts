/**
 * The grant a link carries (SECURITY_DESIGN section 13.9a; surfaces/ops-portal.md section 7, "the three link pages"). A setup, recovery or
 * re-enrolment link puts its single-use token in the URL **fragment**, `#token=<token>`: a fragment is never sent to a server, never in a
 * `Referer`, and is read by the page alone. The page reads it once (`useGrantToken`), removes it from the address at once and holds the token
 * in memory only.
 *
 * This is the reading, and it is strict because what it reads is put into a request: exactly one `token` and nothing else in the fragment,
 * made of the characters a link's value is made of (and the percent-encoding of them), that decodes to printable ASCII. It does not decide
 * what a grant looks like beyond that (its length, its alphabet): the server judges the grant, and one error answers every grant that is not
 * good, so a value this accepts that the server refuses is the same page as a link that expired.
 */

/** The most characters a token may have. A grant is 43 characters; a fragment longer than this is not one. */
export const MAX_GRANT_LENGTH = 512;

const PREFIX = '#token=';
/** What a link's value is made of: unreserved characters and the percent-encoding of the rest. No `&`, `=`, `#`, `+` or space. */
const LINK_VALUE = /^[A-Za-z0-9._~%-]+$/;
const PRINTABLE_ASCII = /^[!-~]+$/;

/** The token of a fragment (`location.hash`, with its `#`), or nothing when the fragment does not carry exactly one. */
export function tokenFromHash(hash: string): string | undefined {
  if (!hash.startsWith(PREFIX)) return undefined;
  const raw = hash.slice(PREFIX.length);
  if (raw === '' || raw.length > MAX_GRANT_LENGTH * 3 || !LINK_VALUE.test(raw)) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (decoded.length > MAX_GRANT_LENGTH || !PRINTABLE_ASCII.test(decoded)) return undefined;
  return decoded;
}
