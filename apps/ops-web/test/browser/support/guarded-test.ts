import { expect, test as base } from '@playwright/test';

import { guardAgainstPermissionKeys } from './permission-key-guard';

/**
 * Playwright's `test` with the guard against a permission key on a screen put on every test (run 7, Stage 2.3): an automatic fixture, so that no spec has to remember it. At the end of the
 * test, whether it looked or not, it fails when a key of the catalogue was drawn on any page of the test, as text or in an attribute. Every spec imports `test` from here and never from
 * `@playwright/test` (`test/browser-specs-use-the-guard.test.ts`); `expect` is Playwright's own.
 */
export const test = base.extend<{ permissionKeyGuard: undefined }>({
  permissionKeyGuard: [
    async ({ context }, use) => {
      const guard = await guardAgainstPermissionKeys(context);
      await use(undefined);
      const drawn = await guard.finish();
      expect(
        drawn,
        'A permission key was on the screen (a refusal names the capability in plain words, never the key)',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
