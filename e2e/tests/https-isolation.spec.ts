import { expect, test } from '../harness/https-test.ts';

/**
 * Isolation between tests over the trusted HTTPS origin (S0.23; the review of 12 October 2026, F04), in each engine. Firefox's context
 * is persistent (its trust store is a profile), and a persistent context keeps what a page stores; the harness therefore gives every
 * test a private copy of the seeded profile and removes it when the test ends (`harness/fresh-profile.ts`). This shows it on the real
 * fixture, not on a directory: one test stores a persistent cookie and a local-storage entry for the origin, and the next starts with
 * neither **and still validates the test CA**. The other engines get a fresh context from Playwright, and the same two tests hold
 * them to it.
 *
 * The values are synthetic names and words; nothing here is a credential.
 */
test.describe.configure({ mode: 'serial' });

const NAME = 'isolation-probe';

test.describe('one test’s browser state is not the next test’s', () => {
  test('one test stores a persistent cookie and a local-storage entry for the origin', async ({
    page,
    context,
    browserOrigin,
  }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    await context.addCookies([
      {
        name: NAME,
        value: 'written',
        url: browserOrigin,
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);
    await page.evaluate((name) => {
      localStorage.setItem(name, 'written');
    }, NAME);

    expect((await context.cookies(browserOrigin)).map((cookie) => cookie.name)).toContain(NAME);
    expect(await page.evaluate((name) => localStorage.getItem(name), NAME)).toBe('written');
  });

  // Break caught (F04): the profile shared between tests, so that the cookie and the entry of the test above are here; or a copy that
  // lost the certificate database, so that the origin is not trusted any more.
  test('the next test starts with neither, and the CA is still trusted', async ({
    page,
    context,
    browserOrigin,
  }) => {
    const response = await page.goto('/');

    expect(response?.status(), 'the CA must still be trusted in a fresh context').toBe(200);
    expect((await context.cookies(browserOrigin)).map((cookie) => cookie.name)).not.toContain(NAME);
    expect(await page.evaluate((name) => localStorage.getItem(name), NAME)).toBeNull();
  });
});
