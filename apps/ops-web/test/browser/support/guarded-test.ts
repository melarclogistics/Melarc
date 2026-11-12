import { expect, test as base } from '@playwright/test';

import { guardAgainstPermissionKeys, keysDrawn } from './permission-key-guard';

/**
 * Playwright's `test` with the guard against a permission key on a screen put on every test (run 7, Stage 2.3): an automatic fixture, so that no spec has to remember it. At the end of the
 * test, whether it looked or not, it fails when a key of the catalogue was drawn on any page of the test, as text or in an attribute. Every spec imports `test` from here and never from
 * `@playwright/test` (`test/browser-specs-use-the-guard.test.ts`); `expect` is Playwright's own.
 */
export const test = base.extend<{
  /** The keys this test draws on a page **on purpose**, because it is the proof that the watch sees them (a test of the guard itself): the test fails unless exactly these were drawn. Never set for a test of a screen. */
  permissionKeysOnPurpose: readonly string[];
  permissionKeyGuard: undefined;
}>({
  permissionKeysOnPurpose: [[], { option: true }],
  permissionKeyGuard: [
    async ({ context, permissionKeysOnPurpose }, use) => {
      const guard = await guardAgainstPermissionKeys(context);
      await use(undefined);
      const drawn = keysDrawn(await guard.finish());
      expect(
        drawn.sort(),
        'A permission key was on the screen (a refusal names the capability in plain words, never the key)',
      ).toEqual([...permissionKeysOnPurpose].sort());
    },
    { auto: true },
  ],
});

export { expect };
