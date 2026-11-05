import { useSyncExternalStore } from 'react';

/** The theme that applies to the page now: `light` or `dark` (design/DESIGN_SYSTEM.md section 31). */
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const canAskTheSystem = (): boolean => typeof window.matchMedia === 'function';

/**
 * The theme the way tokens.css decides it: the root's `data-theme` when a person has chosen one, and otherwise the operating system's
 * setting. A component whose look is all tokens never needs this (the tokens switch themselves); it is for a library that has to be
 * told the theme in a prop, such as the toaster. It reads nothing from storage: the choice, once the toggle exists (redesign step R4), is
 * written to the root's attribute, and this follows the attribute.
 */
export function resolveTheme(): ResolvedTheme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return canAskTheSystem() && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = canAskTheSystem() ? window.matchMedia(DARK_QUERY) : undefined;
  media?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onChange);
  };
}

/** The theme that applies now, kept up to date when the attribute or the system setting changes. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, resolveTheme, () => 'light');
}
