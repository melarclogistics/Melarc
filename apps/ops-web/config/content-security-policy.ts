/**
 * The Content-Security-Policy of the browser surfaces, built from configuration (architecture/SECURITY_DESIGN.md section 14, the Product Owner's decision of 5 November 2026; Run D, OB-S1-107).
 *
 * **One builder, many readers.** The edge of the HTTPS run (`e2e/harness/https-front.ts`) sends the policy, and the browser baseline of the portal's specs (`test/browser/support/strict-policy.ts`) proves
 * the portal works under it: both take it from here, so the baseline can never say "works under the policy" of a policy the edge does not send. It is a pure module with no dependency, so that
 * the front of the end-to-end harness, which is not part of the portal's build, can import it as it is.
 *
 * **What moves, and what never does.** Evidence photos are sent to, and read from, the evidence store (an object store on another origin) by the browser itself: the upload is a `fetch` (`connect-src`) and a
 * photo is an `<img>` (`img-src`). Those two directives alone take the store's origin when one is configured, and stay `'self'` when none is; every other directive is the same with or without it, and
 * `script-src` stays `'self'` whatever the configuration says.
 */

/**
 * The variable the deployment owner sets on the edge that sends the policy (the front of the HTTPS run reads it; a production edge is configured the same way): the **https origin of the evidence store**,
 * scheme, host and port if it is not the default, no path. Left unset or blank, the portal may draw and send nothing but its own origin's.
 */
export const EVIDENCE_STORE_ORIGIN_VARIABLE = 'MELARC_EVIDENCE_STORE_ORIGIN';

/** A host name as DNS has it: labels of letters, digits and hyphens (punycode included), never starting or ending with a hyphen, and nothing else (no `*`, no `;`, no `,`). */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i;

/**
 * The origin of the evidence store as it goes into the policy: `https://host[:port]`, lower-cased, without the default port. **It refuses what is not an origin**: a scheme other than https, a path,
 * a query, a fragment, credentials, a wildcard, a character that would end a directive (`;`) or a source (`,` or a space), or text with white space around it. A policy that took such a value
 * would either widen what the browser may reach or fail to hold at all, and the person who set it must be told so, not left with a policy that quietly differs from the one they wrote.
 */
export function evidenceOriginOf(value: string): string {
  const refuse = (why: string): never => {
    throw new Error(
      `The evidence store's origin must be an https origin: scheme, host and, if not the default, port, and nothing else (${why}).`,
    );
  };
  // The parser trims what it is given, so the white space that it would hide is refused here.
  if (value !== value.trim()) return refuse('it has white space around it');
  // As it is spelled, an origin is `https://` and an authority and at most one slash: a path that the parser would resolve away (`/..`) is still a path somebody wrote, and so is a query or a fragment, even an empty one.
  if (!/^https:\/\/[^/?#]+\/?$/i.test(value)) {
    return refuse(
      /^https:/i.test(value)
        ? 'it has a path, a query or a fragment'
        : 'the scheme is not https, or it is blank',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse('it is not a URL');
  }
  // What the parser keeps beyond the origin and a slash (credentials, a backslash that it reads as a path) makes the address differ from its origin.
  if (url.href !== `${url.origin}/`) return refuse('it has credentials or more than an origin');
  // The host is a host name: no wildcard, no `;` that would end a directive, no `,` that would end a source, no IP literal, no trailing dot.
  if (!HOST.test(url.hostname)) return refuse('the host is not a host name');
  // A name and not an address: an object store has a name, and a policy must not name a machine by its number. The URL parser turns every spelling of an IPv4 address (`2130706433`, `0x7f.1`) into the dotted
  // form, so the one check below sees them all; an IPv6 literal was refused above, by its brackets.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    return refuse('the host is an address, not a name');
  }
  return url.origin;
}

/**
 * The evidence store's origin the environment names, or `undefined` when it names none (the variable is unset or blank). A value that is set and is not an origin is an error that names the variable:
 * a deployment that meant to allow the store and mistyped it fails at start, where it is seen, and not at the first photo, where it is a mystery.
 */
export function evidenceOriginFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = environment[EVIDENCE_STORE_ORIGIN_VARIABLE];
  if (value === undefined || value.trim() === '') return undefined;
  try {
    return evidenceOriginOf(value.trim());
  } catch (error) {
    throw new Error(
      `${EVIDENCE_STORE_ORIGIN_VARIABLE}: ${error instanceof Error ? error.message : 'not an origin'}`,
      { cause: error },
    );
  }
}

export interface PolicyOptions {
  /** The evidence store's origin (see `evidenceOriginOf`). Left out, `connect-src` and `img-src` are `'self'`. */
  readonly evidenceOrigin?: string | undefined;
}

/**
 * The policy: no inline script, no eval, nothing from another origin, no framing; inline style alone is allowed (the UI library under the primitives inserts `<style>` elements, and a style cannot run code). The
 * evidence store's origin, when one is given, is added to `connect-src` and `img-src` and to no other directive.
 */
export function contentSecurityPolicy(options: PolicyOptions = {}): string {
  const store =
    options.evidenceOrigin === undefined ? undefined : evidenceOriginOf(options.evidenceOrigin);
  const reachable = store === undefined ? "'self'" : `'self' ${store}`;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${reachable}`,
    "font-src 'self'",
    `connect-src ${reachable}`,
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
