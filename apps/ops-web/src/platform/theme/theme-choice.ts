/**
 * The person's choice of theme: **the one thing the Ops Portal keeps in the browser** (PRODUCT_DESIGN_DIRECTION section 7; approved by the
 * Product Owner on 5 November 2026, and the one key and the one module confirmed on 6 November 2026, decision A11). It is a non-sensitive
 * preference: `light` or `dark`, under one key of the browser's local storage. A person who has not chosen (or who chose `system`) has
 * nothing stored, and the portal follows the operating system's setting, as `tokens.css` does when the root has no `data-theme`.
 *
 * **Two files touch web storage, and no others.** This module is the only module of the application that does (the ESLint rule that bans it has one
 * exception, for this file, and only for `localStorage`; `scripts/eslint-rules.test.ts` holds the exception to this path): it reads, writes and
 * removes the key. `public/theme-init.js` is the other: a classic script of the page that only **reads** the key, before the first paint, and is
 * no module of the application (the rule does not reach it; `test/theme-init.test.ts` holds it to this module's key). A session, a token, a
 * credential or anything about a person is never stored in either, or anywhere else in the browser.
 *
 * The choice is shown by the root's `data-theme` attribute, which is what `tokens.css` and `useResolvedTheme` read. It is applied twice: before
 * the first paint by `public/theme-init.js` (a classic script in the head of `index.html`, because a module script is deferred and the page could
 * paint once in the system theme first, and an inline script is refused by the content-security policy), and again by `startThemeChoice` when the
 * application starts, so that a page whose pre-paint script did not run still shows the person's choice. `startThemeChoice` is also where the choice of
 * another tab of the browser is followed (audit B10, 7 November 2026): the listener of the `storage` event is registered there, once, and not by each
 * component that watches the choice, so that every page follows it, with or without a theme control on the screen.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_CHOICES = ['system', 'light', 'dark'] as const satisfies readonly ThemeChoice[];

/** The one key. `public/theme-init.js` holds the same text, and `test/theme-init.test.ts` fails when the two differ. */
export const THEME_STORAGE_KEY = 'melarc-theme';

/**
 * The choice that is stored, or `system` when nothing valid is: no key, a value that is not one of the three, or storage that cannot be read
 * (a private window, blocked site data). A stored `system` is not written (`saveThemeChoice` removes the key), so it reads as nothing.
 */
export function storedThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** The choice the page shows now: the root's `data-theme`, or `system` when it has none (or one that is not a theme). */
export function currentThemeChoice(): ThemeChoice {
  const shown = document.documentElement.dataset.theme;
  return shown === 'light' || shown === 'dark' ? shown : 'system';
}

/** Shows a choice: `light` and `dark` are set on the root, and `system` takes the attribute off, which hands the theme back to the system. */
export function applyThemeChoice(choice: ThemeChoice): void {
  if (choice === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = choice;
  }
}

/**
 * Shows a choice and keeps it. `system` removes the key, so that nothing about the person stays in the browser once they go back to following
 * their system. A storage that refuses the write (full, blocked) does not undo the choice for the page the person is on: it lasts until the page
 * is reloaded, which is all that can be promised.
 */
export function saveThemeChoice(choice: ThemeChoice): void {
  applyThemeChoice(choice);
  try {
    if (choice === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    // Storage is not available: the choice is the page's for now.
  }
}

let stopFollowingStorage: (() => void) | undefined;

/**
 * Applies what is stored to the root, and follows the choice of another tab of the same browser from now on: its `storage` event is the stored value
 * arriving here, and it is shown here too, so two tabs never disagree for long. Called once, when the application starts (`main.tsx`), and **the one
 * place the event is listened for**: a second call replaces the listener and never adds one. It returns the function that stops following (for the
 * tests; the application follows for as long as the page lives).
 */
export function startThemeChoice(): () => void {
  applyThemeChoice(storedThemeChoice());
  stopFollowingStorage?.();
  const onStorage = (event: StorageEvent): void => {
    // A null key is `localStorage.clear()`: the stored choice is gone, whatever it was.
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    applyThemeChoice(storedThemeChoice());
  };
  window.addEventListener('storage', onStorage);
  const stop = (): void => {
    window.removeEventListener('storage', onStorage);
    if (stopFollowingStorage === stop) stopFollowingStorage = undefined;
  };
  stopFollowingStorage = stop;
  return stop;
}

/**
 * Tells `listener` whenever the choice shown changes, by whoever changes it (the control, another tab through `startThemeChoice`, a test). It
 * listens to the root's `data-theme` and to nothing in storage: a component that watches the choice adds no listener of the browser's.
 */
export function subscribeThemeChoice(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    observer.disconnect();
  };
}
