/**
 * What the contract fixes about a trusted browser (staff-authentication.md §5.8; SECURITY_DESIGN.md §13.5a; domain-model.md §6.8
 * `TrustedBrowser`). These are constants of the contract and not settings: the project cannot add a setting to a database that was seeded
 * before the key existed, and a setting that is missing stops Senior Ops and Platform Admin from signing in (settings.md §7.5).
 */

/** Days a trusted browser lasts, from the moment it is issued. Absolute: nothing moves it. */
export const TRUSTED_BROWSER_DAYS = 7;

/** The most valid trusted browsers an identity holds; issuing another removes the oldest (`REPLACED`). */
export const TRUSTED_BROWSER_LIMIT = 5;

/**
 * Why a trusted browser stopped being usable (state-machines.md §23). `SELF` and `ADMINISTRATOR` are acts of a person; `FACTOR_RESET` is an
 * administrator's reset of the authenticator, `FACTOR_REPLACED` a new authenticator enrolled in place of the one the browser was trusted
 * with, `CREDENTIAL_CHANGED` a new password (written by the recovery that replaces a credential, which is not built yet), and `REPLACED` the
 * oldest of an identity's five giving way to a sixth.
 */
export const TRUSTED_BROWSER_REVOCATION_CAUSES = [
  'SELF',
  'ADMINISTRATOR',
  'FACTOR_RESET',
  'FACTOR_REPLACED',
  'CREDENTIAL_CHANGED',
  'REPLACED',
] as const;
export type TrustedBrowserRevocationCause = (typeof TRUSTED_BROWSER_REVOCATION_CAUSES)[number];
