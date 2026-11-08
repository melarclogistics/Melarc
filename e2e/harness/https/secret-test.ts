import { recordersThatAreOn } from '../evidence-policy.ts';
import { expect, test as base } from '../https-test.ts';

/**
 * The `test` a spec of the trusted HTTPS origin imports when it shows a secret (`tests/https-*.secret.test.ts`; S0.23). It is the HTTPS
 * test of `https-test.ts` with the one automatic fixture of `secret-test.ts`, for the same reason: before the test begins, the
 * recorders are read as they resolved, and the test fails at once if the trace, the video or the screenshots are on. The projects that
 * run these specs turn them off (`playwright.config.ts`); this makes that a fact about each test and not a hope about the configuration.
 *
 * The fixture asks for nothing that creates a page, so a test that refuses to start has recorded nothing.
 */
export const test = base.extend<{ evidenceIsOff: undefined }>({
  evidenceIsOff: [
    async ({ trace, video, screenshot }, use) => {
      const on = recordersThatAreOn({ trace, video, screenshot });
      if (on.length > 0) {
        throw new Error(
          `A test that shows a secret runs with ${on.join(', ')} on: its page would be kept in a report. Run it in an https-*-secret project and do not call test.use.`,
        );
      }
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
