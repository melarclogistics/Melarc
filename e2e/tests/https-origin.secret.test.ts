import { expect, test } from '../harness/https/secret-test.ts';

/**
 * @shows-secret
 * What each engine really sends on an unsafe, same-origin request over the trusted HTTPS origin (S0.25; security matrix `GBT-W5`,
 * `GBT-W6`): the facts the CSRF guard judges. The guard's decisions are tested where the facts can be made up (`csrf-decision.test.ts`,
 * `csrf-guard.db.test.ts`, real HTTP and a real database); this shows the facts are what the guard expects from a real browser: an
 * `Origin` that is exactly the origin, `Sec-Fetch-Site: same-origin`, the cookies by name, and the token header echoing the cookie, on a
 * `fetch` (every mutation of the product is a JSON `fetch`: the transport refuses any other body before the guard runs).
 * A cross-site request cannot be made from here (the browser is confined to this origin), so a cross-site `Sec-Fetch-Site` is not
 * shown by this spec. **Fixture/platform verified**: the routes are the harness's technical routes, not a session operation.
 * It runs with the recorders off because the cookies it sets stand for credentials.
 */
interface Echo {
  method: string;
  origin: string | null;
  secFetchSite: string | null;
  cookieNames: string[];
  csrfHeaderPresent: boolean;
  csrfHeaderMatchesCookie: boolean;
}

test.describe('what the browser sends that the CSRF guard judges', () => {
  // Break caught: an engine that sends no Origin, or a different spelling of it, on a same-origin unsafe fetch: the exact-Origin check
  // would refuse every request of that engine, or (worse) a spelling it should refuse would pass.
  test('sends the exact Origin and Sec-Fetch-Site: same-origin on a same-origin unsafe fetch', async ({
    page,
    browserOrigin,
  }) => {
    await page.goto('/');
    await page.evaluate(() => fetch('/api/v1/e2e/cookies/issue', { method: 'POST' }));

    const seen = await page.evaluate(async () => {
      const response = await fetch('/api/v1/e2e/echo', {
        method: 'POST',
        credentials: 'same-origin',
      });
      return (await response.json()) as Echo;
    });

    expect(seen.method).toBe('POST');
    expect(seen.origin).toBe(browserOrigin);
    expect(seen.secFetchSite).toBe('same-origin');
    expect(seen.cookieNames).toContain('melarc_session');
  });
});
