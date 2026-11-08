import { NO_EVIDENCE } from '../harness/evidence-policy.ts';
import { expect, test } from '../harness/secret-test.ts';

/**
 * The canary of the project that runs the specs which show a secret (the audit of 11 October 2026, F06). It is a spec like the ones
 * the identity slice will add: it puts something on a page that must not be kept, in the project whose recorders are off, with the
 * `test` that checks it. It passes, and while it does the project is not empty (the test inventory refuses a project that runs
 * nothing) and a regression in how the project is configured fails here: the project, the resolved options, what is attached.
 *
 * The page holds a sentinel, not a credential. @shows-secret
 */
test('a page that shows a secret runs with the recorders off and leaves nothing attached', async ({
  page,
}, testInfo) => {
  await page.setContent('<main><p id="shown">sentinel-for-the-canary-only</p></main>');
  await expect(page.locator('#shown')).toBeVisible();

  expect(testInfo.project.name).toBe('chromium-secret');
  expect(testInfo.project.use).toMatchObject(NO_EVIDENCE);
  // Nothing is attached by the test, and nothing by the harness: a failure attaches logs, which a pass does not.
  expect(testInfo.attachments).toEqual([]);
});
