import { createHash } from 'node:crypto';

import { expect, test } from '../harness/https/secret-test.ts';

/**
 * @shows-secret
 * The cookies of the identity slice in each engine, over the trusted HTTPS origin (S0.23; security matrix `GBT-W13`: "cookies are
 * `Secure`, `HttpOnly` where specified, host-only, `Path`- and `SameSite`-correct; the session credential is rotated"). The routes are
 * the harness's own technical routes that set and expire the cookies with the product's cookie writer and random values (a real
 * sign-in is not built, so this is evidence about the browser and the writer, **fixture/platform verified**, and not about a sign-in).
 * A cookie value is a credential in the real flow, so the spec runs with the recorders off, and compares hashes and booleans and
 * never a value.
 */
const SESSION = 'melarc_session';
const CSRF = 'melarc_csrf';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

test.describe('the session cookies in the browser', () => {
  // Break caught: an attribute lost in this engine (a cookie that is stored without Secure, readable by script when it should not be,
  // sent to a sibling host, or sent cross-site), which would be a hole that a Chromium-only run never sees.
  test('stores the cookies as the product sets them: Secure, host-only, Path=/, SameSite=Lax, and HttpOnly for the session only', async ({
    page,
    context,
    browserOrigin,
  }) => {
    await page.goto('/');

    const status = await page.evaluate(
      async () => (await fetch('/api/v1/e2e/cookies/issue', { method: 'POST' })).status,
    );
    const stored = await context.cookies(browserOrigin);

    expect(status).toBe(200);
    const session = stored.find((cookie) => cookie.name === SESSION);
    const csrf = stored.find((cookie) => cookie.name === CSRF);
    expect(session, 'the session cookie was stored').toBeDefined();
    expect(csrf, 'the CSRF cookie was stored').toBeDefined();
    for (const cookie of [session, csrf]) {
      const name = cookie?.name ?? 'cookie';
      expect(cookie?.secure, `${name} is Secure`).toBe(true);
      expect(cookie?.sameSite, `${name} SameSite`).toBe('Lax');
      expect(cookie?.path, `${name} Path`).toBe('/');
      // Host-only: no Domain attribute, which the browser reports as the host itself and not as ".host".
      expect(cookie?.domain.startsWith('.'), `${name} is host-only`).toBe(false);
      // A browser-session cookie: no lifetime of its own.
      expect(cookie?.expires, `${name} has no expiry`).toBe(-1);
    }
    expect(session?.httpOnly).toBe(true);
    expect(csrf?.httpOnly).toBe(false);
  });

  // Break caught: the session cookie readable by script, or the CSRF token not readable by it (the client echoes it in a header).
  test('lets script read the CSRF token and not the session cookie', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => fetch('/api/v1/e2e/cookies/issue', { method: 'POST' }));

    const visible = await page.evaluate(() =>
      document.cookie.split(';').map((each) => each.trim().split('=')[0]),
    );

    expect(visible).toContain(CSRF);
    expect(visible).not.toContain(SESSION);
  });

  // Break caught: a stored cookie the browser does not send back, or a CSRF header that does not match what the cookie holds; the
  // facts the guard of S0.25 judges.
  test('sends both cookies back to the same origin, and the CSRF header the page echoes equals the CSRF cookie', async ({
    page,
  }) => {
    await page.goto('/');
    await page.evaluate(() => fetch('/api/v1/e2e/cookies/issue', { method: 'POST' }));

    const seen = await page.evaluate(async () => {
      const token = document.cookie
        .split(';')
        .map((each) => each.trim())
        .find((each) => each.startsWith('melarc_csrf='))
        ?.slice('melarc_csrf='.length);
      const response = await fetch('/api/v1/e2e/echo', {
        method: 'POST',
        headers: { 'x-csrf-token': token ?? '' },
      });
      return (await response.json()) as {
        cookieNames: string[];
        csrfHeaderPresent: boolean;
        csrfHeaderMatchesCookie: boolean;
      };
    });

    expect(seen.cookieNames).toEqual([CSRF, SESSION].toSorted());
    expect(seen.csrfHeaderPresent).toBe(true);
    expect(seen.csrfHeaderMatchesCookie).toBe(true);
  });

  // Break caught: a sign-out that leaves a cookie behind, or a sign-in that issues the same credential again (it is rotated).
  test('replaces the credential at each issue, and a sign-out expires both cookies', async ({
    page,
    context,
    browserOrigin,
  }) => {
    await page.goto('/');
    const valueOf = async (name: string) =>
      (await context.cookies(browserOrigin)).find((cookie) => cookie.name === name)?.value ?? '';

    await page.evaluate(() => fetch('/api/v1/e2e/cookies/issue', { method: 'POST' }));
    const first = sha256(await valueOf(SESSION));
    await page.evaluate(() => fetch('/api/v1/e2e/cookies/issue', { method: 'POST' }));
    const second = sha256(await valueOf(SESSION));
    await page.evaluate(() => fetch('/api/v1/e2e/cookies/expire', { method: 'POST' }));
    const remaining = (await context.cookies(browserOrigin)).map((cookie) => cookie.name);

    expect(first).not.toBe(sha256(''));
    expect(second).not.toBe(first);
    expect(remaining).not.toContain(SESSION);
    expect(remaining).not.toContain(CSRF);
  });
});
