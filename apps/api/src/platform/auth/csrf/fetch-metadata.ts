import { headerLines } from './origin-policy.js';

/**
 * Fetch Metadata for a browser mutation (S0.25; SECURITY_DESIGN.md §13.8: "Fetch Metadata is checked for an unexpected cross-site
 * browser mutation"; `GBT-W15`). A browser says where a request came from in `Sec-Fetch-Site`, a header page script cannot set or
 * change. The two surfaces of Melarc are separate origins that call their own API path, so the only value a browser mutation can
 * legitimately carry is **`same-origin`**.
 *
 * - `same-origin` is expected.
 * - `cross-site` is the attack this check exists for. `same-site` (a sibling host of the same registrable domain, such as the Vendor
 *   surface calling the Ops one) and `none` (a request the user agent made on its own, such as a typed address) are as unexpected
 *   for a mutation, and so is any other word, or a repeated line, or a value in another case: the check refuses what it cannot
 *   read.
 * - **No header is not an attack.** A client that sends none (an older browser, a script, a test client) is judged by the `Origin`
 *   and the synchronizer token alone, which is the specified fallback. Nothing here treats a missing header as proof of a native
 *   client, or as a reason to skip the other checks.
 *
 * `Sec-Fetch-Mode` and `Sec-Fetch-Dest` are not read: the transport refuses every body that is not JSON before this check, which
 * already excludes a form post, and a rule beyond the retained policy is not invented here.
 */

export type FetchMetadataVerdict = 'ABSENT' | 'SAME_ORIGIN' | 'UNEXPECTED';

export function judgeFetchMetadata(rawHeaders: readonly string[]): FetchMetadataVerdict {
  const lines = headerLines(rawHeaders, 'sec-fetch-site');
  if (lines.length === 0) return 'ABSENT';
  return lines.length === 1 && lines[0] === 'same-origin' ? 'SAME_ORIGIN' : 'UNEXPECTED';
}
