import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { guardBrowserContext } from '../harness/browser-guard.ts';
import { originAnswers } from '../harness/https-probe.ts';
import { expect, test } from '../harness/https-test.ts';
import { TLS_FILES, tlsDirectoryFrom } from '../harness/tls-material.ts';
import { classifyNavigationFailure } from '../harness/trust-failure.ts';
import { withUntrustedBrowser } from '../harness/untrusted-browser.ts';

/**
 * The per-engine spike of the trusted HTTPS origin (S0.23; implementation plan §11.5): how this engine is made to trust the disposable
 * CA, in a store of the run's own, and **what that proves**. The positive test is that the Ops shell loads over HTTPS in this engine
 * with the certificate validated (never `ignoreHTTPSErrors`); the negative test is that a browser of the same engine, launched
 * without the mechanism (in an environment of its own that reaches no store of the run: `harness/untrusted-browser.ts`), refuses the
 * same origin **with the engine's own certificate diagnostic** (`harness/trust-failure.ts`): a
 * timeout, a name or connection that did not work, a blocked request, a crash and a closed page all fail a navigation too, and none
 * is evidence, so a failure with any other signature fails the test and is diagnosed, never accepted. Beside the refusal the test
 * shows the endpoint is up and its leaf validates against the CA for a client that trusts that CA (`harness/https-probe.ts`), so the
 * refusal is attributable to trust alone. Together they show the trust is the CA's, and that the page loaded because it validated
 * and not because validation was off.
 *
 * Each test attaches the mechanism and the browser version as evidence, which is the record "per engine which mechanism works". An
 * engine whose mechanism does not work fails here; it is reported blocked, never green.
 */
test.describe('the trusted HTTPS origin, in each engine', () => {
  test('loads the Ops shell over HTTPS, the certificate validated against the disposable CA', async ({
    page,
    browser,
    browserName,
    browserOrigin,
    engineTrust,
  }, testInfo) => {
    expect(browserOrigin).toMatch(/^https:\/\/localhost:\d+$/);

    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();
    expect(
      await page.evaluate(() => ({ secure: window.isSecureContext, protocol: location.protocol })),
    ).toEqual({ secure: true, protocol: 'https:' });
    await testInfo.attach('trust-mechanism', {
      contentType: 'application/json',
      body: JSON.stringify({
        engine: browserName,
        version: browser.version(),
        mechanism: engineTrust?.supported === true ? engineTrust.trust.mechanism : 'none',
        basis: engineTrust?.supported === true ? engineTrust.trust.basis : 'none',
        origin: browserOrigin,
        proves:
          'the page loaded over TLS with no certificate error, so this engine validated the leaf against the disposable CA',
      }),
    });
  });

  // Break caught: trust that is not the CA's: a page that loads because validation was off, or because the machine's store held
  // the CA; and a refusal that is not the certificate's (F03): a deadline, a name that did not resolve, a blocked request, a crash.
  //
  // The tag is how WebKit is given its two stages (`playwright.config.ts`, `harness/https-run.ts`): WebKit's only trust is the system
  // store, so a browser "without the mechanism" exists only before the CA is put there, and this test is the one that runs before.
  test(
    'refuses the same origin, with the engine’s certificate diagnostic, in a browser of this engine that does not have the mechanism',
    { tag: '@untrusted-control' },
    async (
      { playwright, browserName, browserOrigin, launchOptions, externalRequests },
      testInfo,
    ) => {
      // The endpoint is up and its leaf validates against the CA, for a client that trusts that CA and nothing else: whatever the browser
      // then does is attributable to trust, and a failure of this line is a failure of the origin, not of the engine.
      const directory = tlsDirectoryFrom(process.env);
      if (directory === undefined)
        throw new Error('the test certificates are gone from the environment');
      const answered = await originAnswers(
        browserOrigin,
        readFileSync(join(directory, TLS_FILES.ca)),
      );
      expect(answered, 'the origin must answer a client that trusts the test CA').toBe(200);

      // The browser is launched in an environment of its own, given explicitly (`harness/untrusted-browser.ts`). Playwright merges the
      // project's launch defaults, which carry the trusted environment (for Chromium the HOME whose NSS database holds the CA), under
      // any option that is left out, so deleting `env` from a copy of the project's options brought the trusted HOME back and Chromium
      // loaded the origin it must refuse (the first hosted run, 13 October 2026). Certificate validation stays fully on.
      await withUntrustedBrowser(
        playwright[browserName],
        launchOptions,
        async (untrusting) => {
          const context = await untrusting.newContext({ serviceWorkers: 'block' });
          await guardBrowserContext(context, browserOrigin, (url) => externalRequests.push(url));
          const page = await context.newPage();

          const failure = await page.goto(browserOrigin).then(
            () => undefined,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );

          expect(failure, 'an untrusted CA must be refused').toBeDefined();
          const verdict = classifyNavigationFailure(browserName, failure ?? '');
          await testInfo.attach('untrusted-refusal', {
            contentType: 'application/json',
            body: JSON.stringify({
              engine: browserName,
              version: untrusting.version(),
              environment:
                'a disposable empty home, no variable that names a certificate store, nothing of the run’s TLS directory',
              verdict,
              refusedWith: failure?.split('\n')[0],
            }),
          });
          // Only the engine's own certificate diagnostic is evidence. Any other signature is a failure to diagnose, with the message above.
          expect(
            verdict,
            `the refusal is not this engine's certificate rejection; diagnose it: ${failure?.split('\n')[0] ?? ''}`,
          ).toBe('CERTIFICATE_REJECTED');
        },
        { trustedPaths: [directory] },
      );
    },
  );
});
