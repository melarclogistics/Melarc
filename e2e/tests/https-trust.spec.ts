import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { guardBrowserContext } from '../harness/browser-guard.ts';
import { originAnswers } from '../harness/https-probe.ts';
import { expect, test } from '../harness/https-test.ts';
import { TLS_FILES, tlsDirectoryFrom } from '../harness/tls-material.ts';
import { classifyNavigationFailure } from '../harness/trust-failure.ts';

/**
 * The per-engine spike of the trusted HTTPS origin (S0.23; implementation plan §11.5): how this engine is made to trust the disposable
 * CA, in a store of the run's own, and **what that proves**. The positive test is that the Ops shell loads over HTTPS in this engine
 * with the certificate validated (never `ignoreHTTPSErrors`); the negative test is that a browser of the same engine, launched
 * without the mechanism, refuses the same origin **with the engine's own certificate diagnostic** (`harness/trust-failure.ts`): a
 * timeout, a name or connection that did not work, a blocked request, a crash and a closed page all fail a navigation too, and none
 * is evidence, so a failure with any other signature fails the test and is diagnosed, never accepted. Beside the refusal the test
 * shows the endpoint is up and its leaf validates against the CA for a client that trusts that CA (`harness/https-probe.ts`), so the
 * refusal is attributable to trust alone. Together they show the trust is the CA's, and that the page loaded because it validated
 * and not because validation was off.
 *
 * Each test attaches the mechanism and the browser version as evidence, which is the record "per engine which mechanism works". An
 * engine whose mechanism does not work fails here; it is reported blocked, never green (WebKit's is a candidate until it passes).
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
  test('refuses the same origin, with the engine’s certificate diagnostic, in a browser of this engine that does not have the mechanism', async ({
    playwright,
    browserName,
    browserOrigin,
    launchOptions,
    externalRequests,
  }, testInfo) => {
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

    const withoutTrust = { ...launchOptions };
    delete withoutTrust.env;
    const untrusting = await playwright[browserName].launch(withoutTrust);
    try {
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
          verdict,
          refusedWith: failure?.split('\n')[0],
        }),
      });
      // Only the engine's own certificate diagnostic is evidence. Any other signature is a failure to diagnose, with the message above.
      expect(
        verdict,
        `the refusal is not this engine's certificate rejection; diagnose it: ${failure?.split('\n')[0] ?? ''}`,
      ).toBe('CERTIFICATE_REJECTED');
    } finally {
      await untrusting.close();
    }
  });
});
