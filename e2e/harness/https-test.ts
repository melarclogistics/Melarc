import { join } from 'node:path';

import { guardBrowserContext } from './browser-guard.ts';
import { ENGINES, planEngineTrust, trustRootOf, type Engine } from './engine-trust.ts';
import { withFreshProfile } from './fresh-profile.ts';
import { expect, test as base } from './playwright.ts';
import { TLS_FILES, tlsDirectoryFrom } from './tls-material.ts';

/**
 * The `test` of the specs of the trusted HTTPS origin (S0.23; `tests/https-*.spec.ts` and `https-*.secret.test.ts`). It is the
 * harness's test with the browser pointed at the HTTPS origin and made to trust the disposable CA the way its engine allows
 * (`engine-trust.ts`): never by turning certificate validation off (`ignoreHTTPSErrors` is not trust evidence), and never by a trust
 * change outside the run's own directory.
 *
 * - **Blocked is not green.** Without test certificates (`MELARC_E2E_TLS_DIR`) there is no HTTPS origin. A spec then does not run:
 *   it is **skipped, with the reason**, on a developer machine; and in CI (`CI` is set) it **fails**, because a pipeline that
 *   cannot run the proofs has not proved them.
 * - **The boundary is the HTTPS origin.** The context may reach that origin and nothing else, the plain HTTP Ops origin included,
 *   as the harness's contexts may reach their own (`browser-guard.ts`); service workers are blocked.
 * - **Firefox is launched from a private copy of its seeded profile for each test** (a persistent context): its trust store is the
 *   profile's `cert9.db`, and a persistent context keeps what a page stores, so the seed is a template that is never launched from
 *   (`fresh-profile.ts`) and the copy is removed when the test ends. Chromium is launched with the environment its trust mechanism needs
 *   (`HOME`), set in the project's launch options (`playwright.config.ts`) for the browser process only, and WebKit with none (its
 *   trust is the system store, which the run changes on a GitHub-hosted runner: `system-trust.ts`); both get a fresh context from
 *   Playwright as any test does.
 *
 * Contexts are made here and not by Playwright's own fixture because Firefox's has to be persistent; the options of the project
 * that this test needs (the launch options, the context options) are read from the same fixtures Playwright reads them from.
 */
export interface HttpsFixtures {
  /** What makes this engine trust the CA, as planned for this run; `undefined` when there are no test certificates. */
  engineTrust: ReturnType<typeof planEngineTrust> | undefined;
}

const isEngine = (name: string): name is Engine => (ENGINES as readonly string[]).includes(name);

/** The reason a spec of the HTTPS origin cannot run, said once, where the skip and the failure both read it. */
export const BLOCKED =
  'blocked: the trusted HTTPS origin needs the disposable test certificates (MELARC_E2E_TLS_DIR, made by `pnpm --filter @melarc/e2e run tls:generate` on a machine cleared for key material); none were given';

export const test = base.extend<HttpsFixtures>({
  browserOrigin: async ({ stack }, use, testInfo) => {
    const origin = stack.httpsOrigin;
    if (origin === undefined) {
      if (process.env.CI !== undefined) {
        throw new Error(
          `${BLOCKED}. In CI that is a failure: a run that cannot make the proofs has not made them.`,
        );
      }
      testInfo.skip(true, BLOCKED);
      throw new Error(BLOCKED);
    }
    await use(origin);
  },

  engineTrust: async ({ browserName }, use) => {
    const directory = tlsDirectoryFrom(process.env);
    await use(
      directory === undefined || !isEngine(browserName)
        ? undefined
        : planEngineTrust(browserName, {
            root: trustRootOf(directory),
            caPath: join(directory, TLS_FILES.ca),
          }),
    );
  },

  context: async (
    {
      browserOrigin,
      browser,
      browserName,
      playwright,
      launchOptions,
      contextOptions,
      engineTrust,
      externalRequests,
    },
    use,
  ) => {
    const options = { ...contextOptions, baseURL: browserOrigin, serviceWorkers: 'block' } as const;
    const template =
      engineTrust?.supported === true ? engineTrust.trust.profileTemplate : undefined;
    if (browserName === 'firefox' && template !== undefined) {
      // A private copy of the seeded profile for this test, removed when it ends: nothing a test stores is there for the next.
      await withFreshProfile(
        template,
        (directory) =>
          playwright.firefox.launchPersistentContext(directory, { ...launchOptions, ...options }),
        async (context) => {
          await guardBrowserContext(context, browserOrigin, (url) => externalRequests.push(url));
          await use(context);
        },
      );
      return;
    }
    const context = await browser.newContext(options);
    await guardBrowserContext(context, browserOrigin, (url) => externalRequests.push(url));
    await use(context);
    await context.close();
  },
});

export { expect };
