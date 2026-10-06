/** The readable synchronizer cookie (contracts/openapi.yaml, `x-cookies.melarc_csrf`). */
export const CSRF_COOKIE_NAME = 'melarc_csrf';

/** The header that echoes it (contracts/openapi.yaml, the `csrfToken` security scheme). */
export const CSRF_HEADER_NAME = 'X-CSRF-Token';

/**
 * The CSRF token in a `document.cookie`-style string, exactly as the server issued it, or undefined when
 * there is none. The value is echoed, never decoded or trimmed: the server compares a hash of what it set.
 * An empty value counts as absent, and when the name appears twice the first one is used.
 */
export function readCsrfToken(cookies: string): string | undefined {
  for (const pair of cookies.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== CSRF_COOKIE_NAME) continue;
    const value = pair.slice(separator + 1);
    return value === '' ? undefined : value;
  }
  return undefined;
}
