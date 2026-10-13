import { recordersThatAreOn } from './evidence-policy.ts';
import { expect, test as base } from './playwright.ts';

/**
 * The `test` a spec that shows a secret imports (`<name>.secret.test.ts`). It is the harness's test with one automatic fixture:
 * before the test begins, the recorders are read **as they resolved** (every `test.use` of the file and of the project applied), and
 * the test fails at once if the trace, the video or the screenshots are on. The project that runs secret specs turns them off
 * (`evidence-policy.ts`); this is what makes that a fact about each test and not a hope about the configuration.
 *
 * The fixture asks for nothing that creates a page, so a test that refuses to start has recorded nothing.
 */
export const test = base.extend<{ evidenceIsOff: undefined }>({
  evidenceIsOff: [
    async ({ trace, video, screenshot }, use) => {
      const on = recordersThatAreOn({ trace, video, screenshot });
      if (on.length > 0) {
        throw new Error(
          `A test that shows a secret runs with ${on.join(', ')} on: its page would be kept in a report. Run it in the chromium-secret project and do not call test.use.`,
        );
      }
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
