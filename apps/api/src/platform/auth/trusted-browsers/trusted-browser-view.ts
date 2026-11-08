import type { StoredTrustedBrowser } from './trusted-browser-store.js';

/** `TrustedBrowser` of the contract: what its owner or an administrator sees, and nothing that could be used to sign in. */
export interface TrustedBrowserView {
  readonly id: string;
  readonly label: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_used_at: string | null;
  readonly current: boolean;
}

/** The view of a stored trusted browser. `current` is true for the one browser that presented its credential with this request. */
export function trustedBrowserView(
  browser: StoredTrustedBrowser,
  currentId: string | null,
): TrustedBrowserView {
  return {
    id: browser.id,
    label: browser.label,
    created_at: browser.createdAt.toISOString(),
    expires_at: browser.expiresAt.toISOString(),
    last_used_at: browser.lastUsedAt === null ? null : browser.lastUsedAt.toISOString(),
    current: currentId !== null && browser.id === currentId,
  };
}
