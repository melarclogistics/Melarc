import type { ConsoleMessage, Page } from '@playwright/test';

import { KEY_PATTERN_FLAGS, keyPatternSource } from '../../support/permission-catalogue';
import {
  PERMISSION_KEY_LOG_PREFIX,
  watchForPermissionKeys,
  type PermissionKeyWatchOptions,
} from '../../support/permission-key-watch';

/**
 * **The browser half of "a permission key is on no screen", for every test** (PRODUCT_DESIGN_DIRECTION section 6.5; run 7, Stage 2.3). `watchPage` records a key as a problem, and a test
 * failed on it only when it asserted `watch.problems` (a refusal test, a spec that never called `watchPage`, did not). This guard is put on the browser context of every test by the
 * automatic fixture of `guarded-test.ts`: the document of every page the context opens is watched from its first byte, and `finish()` gives every key that was drawn, as text or in an
 * attribute, on any page, at any moment of the test, so that the fixture fails the test at its end whether or not the test looked.
 */
export interface PermissionKeyGuard {
  /** Waits until what the pages have said so far has been heard, and gives every key drawn, each with where it was. */
  readonly finish: () => Promise<string[]>;
}

/** What the guard asks of a context: tests give it a context of their own, with no browser. */
export interface GuardedContext {
  readonly addInitScript: (
    script: typeof watchForPermissionKeys,
    options: PermissionKeyWatchOptions,
  ) => Promise<unknown>;
  readonly on: (
    event: 'console',
    listener: (message: Pick<ConsoleMessage, 'type' | 'text'>) => void,
  ) => unknown;
  readonly pages: () => readonly Pick<Page, 'evaluate'>[];
}

export async function guardAgainstPermissionKeys(
  context: GuardedContext,
): Promise<PermissionKeyGuard> {
  const drawn: string[] = [];
  context.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.startsWith(PERMISSION_KEY_LOG_PREFIX)) drawn.push(text);
  });
  await context.addInitScript(watchForPermissionKeys, {
    source: keyPatternSource(),
    flags: KEY_PATTERN_FLAGS,
    log: true,
  });
  return {
    finish: async () => {
      // A round trip to each page: what it wrote to its console before this was asked has been heard when the answer comes.
      await Promise.all(
        context.pages().map((page) => page.evaluate(() => undefined).catch(() => undefined)),
      );
      return [...drawn];
    },
  };
}
