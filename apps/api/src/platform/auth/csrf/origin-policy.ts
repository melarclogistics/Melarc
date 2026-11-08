/**
 * The `Origin` check of the browser policy (S0.25; SECURITY_DESIGN.md §13.8 "Client policy"; permission-enforcement.md §5.1 step 3).
 * A browser credential mutation, a pre-session one included, is served only when its `Origin` **exactly** matches an origin the
 * deployment configured for the surface it is for. A missing, `null` or unlisted `Origin` is refused.
 *
 * - **Exact, not "same site" or "contains".** The comparison is the string a browser writes (`scheme://host[:port]`, lower case,
 *   no path, no trailing slash, no default port), against the configured origins, which are held in that same form
 *   (`config/origins.ts`). `https://OPS.example`, `https://ops.example/`, `https://ops.example:443` and `https://ops.example.evil`
 *   are none of them `https://ops.example`.
 * - **One value.** The header is read from the raw header lines, because Node joins repeated lines of this header with a comma: two
 *   `Origin` lines are refused whatever they say, and cannot be made to look like one by the join.
 * - **`null` is a value a browser really sends** (a sandboxed frame, a redirect across origins, a `file:` page) and is never an
 *   allowed origin. The word must be exactly `null`.
 * - The list handed in is the list **for this request** (the surface of the route, or of the session), so a staff session cannot be
 *   used from the Vendor origin and the other way round; this function knows nothing of surfaces.
 *
 * The result names the cause for the log and the audit; outward every cause is the same refusal.
 */

export type OriginRefusal = 'MISSING' | 'NULL' | 'MALFORMED' | 'UNLISTED';

export type OriginVerdict =
  | { readonly kind: 'ALLOWED'; readonly origin: string }
  | { readonly kind: 'REFUSED'; readonly cause: OriginRefusal };

/** An http or https origin as a browser serialises it: the scheme, `://`, and a host with an optional port, nothing after it. */
const SERIALISED_ORIGIN = /^https?:\/\/[^\s/?#@]+$/;

/** The values of every line of the named header, in the order they arrived. `rawHeaders` alternates names and values. */
export function headerLines(rawHeaders: readonly string[], name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === wanted) values.push(rawHeaders[index + 1] ?? '');
  }
  return values;
}

export function judgeOrigin(
  rawHeaders: readonly string[],
  allowedOrigins: readonly string[],
): OriginVerdict {
  const lines = headerLines(rawHeaders, 'origin');
  if (lines.length === 0) return { kind: 'REFUSED', cause: 'MISSING' };
  const [value] = lines;
  if (lines.length > 1 || value === undefined) return { kind: 'REFUSED', cause: 'MALFORMED' };
  if (value === 'null') return { kind: 'REFUSED', cause: 'NULL' };
  if (!SERIALISED_ORIGIN.test(value)) return { kind: 'REFUSED', cause: 'MALFORMED' };
  return allowedOrigins.includes(value)
    ? { kind: 'ALLOWED', origin: value }
    : { kind: 'REFUSED', cause: 'UNLISTED' };
}
