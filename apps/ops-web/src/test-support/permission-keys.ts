import { onTestFinished } from 'vitest';

import { KEY_PATTERN_FLAGS, keyPatternSource } from '../../test/support/permission-catalogue';
import {
  watchForPermissionKeys,
  type PermissionKeyWatch,
} from '../../test/support/permission-key-watch';

/**
 * **A permission key is on no screen, as the page tests draw it** (PRODUCT_DESIGN_DIRECTION section 6.5): from the first render of a test, every text and every attribute
 * the document gets is read for a key of the catalogue, and the test fails when one is found, whichever way it came to be there (a name put together at run time, a value
 * an answer carried, a word the table of words got wrong), which the guard that reads the source cannot see. `renderApp` and `renderWithProviders` start it; a test that
 * draws with Testing Library's own `render` is not watched.
 *
 * A test that means to draw a key (the proof of this watch) calls {@link watchPermissionKeys} itself, reads `finish()`, and does not use the helpers.
 */
let active: PermissionKeyWatch | undefined;

export function watchPermissionKeys(): PermissionKeyWatch {
  return watchForPermissionKeys({
    source: keyPatternSource(),
    flags: KEY_PATTERN_FLAGS,
    log: false,
  });
}

/** Starts watching for the test that is running (once), and fails the test when it ends if a key was on the screen. */
export function failWhenAPermissionKeyIsDrawn(): void {
  if (active !== undefined) return;
  const watch = watchPermissionKeys();
  active = watch;
  onTestFinished(() => {
    active = undefined;
    const hits = watch.finish();
    if (hits.length > 0) {
      throw new Error(
        `A permission key was on the screen (a refusal names the capability in plain words, never the key):\n  ${hits.join('\n  ')}`,
      );
    }
  });
}
