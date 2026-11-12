import type { Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import { SIGNED_IN_SESSION } from './support/api';
import { decodePainted } from './support/painted';
import { reachableNames, tabReachesLinks, watchPage, wcagViolations } from './support/page';
import { errorAnswer, stubPreSignInApi, type PreSignInApi } from './support/pre-sign-in-api';
import { accountButton } from './support/shell';

/**
 * The five pre-sign-in screens in a real browser (S0.43): `/sign-in`, `/sign-in/mfa`, `/setup/credential`, `/setup/mfa` and `/setup/mfa/complete`.
 * What jsdom cannot show is here: the fragment read and removed by a real history, the headers a real browser sends (the real `Origin`, no
 * `Referer`), a QR code that an independent decoder reads from what the browser *painted*, the keyboard in each engine, the layout at 320 px and
 * at enlarged text, and the contrast of everything with a form or a secret showing.
 *
 * The same file runs against the production build and against the development server, because development's strict mode runs every effect twice
 * and a page that reads a grant from a fragment is exactly where that shows. The API is a stand-in that answers the five operations as a test says;
 * everything in it is synthetic. The pages type and receive credential-shaped values, so these tests turn tracing, screenshots and video off for their
 * own contexts (playwright.config.ts: a trace is accepted only for pages that hold no credential).
 *
 * GBT-W16 is run in the engines at S0.46, against the real API over HTTPS (E, not run); this is the page's half of it.
 */
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

const GRANT = 'kJ3x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';
const EMAIL = 'officer@example.test';
const PASSWORD = 'a long enough passphrase';
const SEED = 'SENTINELSEED234567ABCDEFGH';
const URI = `otpauth://totp/Melarc:synthetic.officer?secret=${SEED}&issuer=Melarc&period=30`;
const CONTINUATION = 'SentinelContinuation-Zz9yY8xX7wW6vV5';
const CHALLENGE = {
  challenge_id: '5e1d7a90-2b4c-4f63-8a15-9c0e3d7b6f42',
  expires_at: '2026-10-24T09:05:00.000Z',
  trusted_browser_days: 7,
};
const CODE = '482916';
const PRIVILEGED = {
  authentication_ready: false,
  mfa_enrolment_required: true,
  mfa_provisioning: { otpauth_uri: URI },
  mfa_setup_token: CONTINUATION,
};

const field = (page: Page, label: string) => page.getByLabel(label, { exact: true });

/** Everything a page could have stored: a storage, a cookie, a database or a cache. */
const storedAnything = (page: Page): Promise<unknown> =>
  page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
const NOTHING_STORED = { local: 0, session: 0, cookie: '', databases: 0, caches: 0 };

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** The new privileged employee's way: the link, the first password, and the authenticator screen with its material. */
async function toTheAuthenticator(page: Page): Promise<PreSignInApi> {
  const api = await stubPreSignInApi(page, {
    credentialSetup: { status: 200, json: PRIVILEGED },
    enrolment: { status: 200, json: { authentication_ready: true } },
  });
  await page.goto(`/setup/credential#token=${GRANT}`);
  await field(page, 'New password (required)').fill(PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await expect(page.getByRole('region', { name: 'Authenticator set-up' })).toBeVisible();
  return api;
}

test.describe('a link page: the grant in the fragment (GBT-W16, the page’s half)', () => {
  // Break caught: the grant left in the address or in the history after it was read, or a link that redeems itself by being opened.
  test('is read once, removed from the address by replacing the entry, and redeems nothing by being opened', async ({
    page,
  }) => {
    const api = await stubPreSignInApi(page, {});
    await page.goto('/sign-in');
    await page.goto(`/setup/credential#token=${GRANT}`);

    await expect(page.getByRole('heading', { level: 1, name: 'Set your password' })).toBeVisible();
    await expect(page).toHaveURL('/setup/credential');
    expect(page.url()).not.toContain(GRANT);
    expect(await page.evaluate(() => window.location.hash)).toBe('');
    expect(api.requests).toEqual([]);
    expect(await storedAnything(page)).toEqual(NOTHING_STORED);

    // The entry was replaced: Back finds the page before it, and Forward finds an address with no grant in it.
    await page.goBack();
    await expect(page).toHaveURL('/sign-in');
    expect(page.url()).not.toContain(GRANT);
    await page.goForward();
    expect(page.url()).not.toContain(GRANT);
    await expect(
      page.getByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeVisible();
  });

  // Break caught: a form post or a navigation (which can carry `Origin: null`), a grant in the address or a header, or a referrer.
  test('redeems with a fetch that carries the real Origin, no Referer, and the grant in the body alone', async ({
    page,
    baseURL,
  }) => {
    const api = await stubPreSignInApi(page, {
      credentialSetup: { status: 200, json: { authentication_ready: true } },
    });
    await page.goto(`/setup/credential#token=${GRANT}`);
    await field(page, 'New password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your password is set' }),
    ).toBeVisible();

    expect(api.requests).toHaveLength(1);
    const [request] = api.requests;
    expect(request?.method).toBe('POST');
    expect(request?.origin).toBe(new URL(baseURL ?? '').origin);
    expect(request?.referer).toBeUndefined();
    expect(request?.search).toBe('');
    expect(request?.authorization).toBeUndefined();
    expect(request?.csrfToken).toBeUndefined();
    expect(request?.body).toEqual({ setup_token: GRANT, password: PASSWORD });
    expect(api.unexpected).toEqual([]);
    expect(await storedAnything(page)).toEqual(NOTHING_STORED);
  });

  test('asks the browser for no referrer while the page is open', async ({ page }) => {
    await stubPreSignInApi(page, {});
    await page.goto(`/setup/credential#token=${GRANT}`);
    await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();

    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  });

  // Break caught: one error that says which way a link failed, or a form for a link that carries nothing.
  for (const [name, address] of [
    ['no fragment', '/setup/credential'],
    ['an empty token', '/setup/credential#token='],
    ['two tokens', '/setup/credential#token=a&token=b'],
  ] as const) {
    test(`shows the one error for a link with ${name}, and sends nothing`, async ({ page }) => {
      const api = await stubPreSignInApi(page, {});
      await page.goto(address);

      await expect(
        page.getByRole('heading', { level: 1, name: 'This link cannot be used' }),
      ).toBeVisible();
      await expect(
        page.getByText(
          'This link cannot be used. It may have expired, or it may already have been used.',
        ),
      ).toBeVisible();
      await expect(field(page, 'New password (required)')).toHaveCount(0);
      expect(api.requests).toEqual([]);
    });
  }

  test('shows the one error when the grant is refused, and the password is not left behind', async ({
    page,
  }) => {
    await stubPreSignInApi(page, { credentialSetup: errorAnswer(401, 'SETUP_GRANT_INVALID') });
    await page.goto(`/setup/credential#token=${GRANT}`);
    await field(page, 'New password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Set password' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'This link cannot be used' }),
    ).toBeVisible();
    await expect(page.getByText(/Diagnostic text|SETUP_GRANT_INVALID/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(PASSWORD);
    // Focus moves to the outcome that replaced the form, so a keyboard user is not dropped at the top of the document.
    await expect(page.locator('main [tabindex="-1"]').first()).toBeFocused();
  });
});

test.describe('the sign-in in a browser', () => {
  // Break caught: a sign-in that does not reach the landing, that needs a second read, or that leaves the form's password behind.
  test('signs an ordinary employee in with the keyboard and lands on My work, with the shell’s sidebar and top bar', async ({
    page,
  }) => {
    const api = await stubPreSignInApi(page, { signIn: { status: 200, json: SIGNED_IN_SESSION } });
    const seen = watchPage(page);
    await page.goto('/sign-in');
    await expect(page.getByRole('navigation')).toHaveCount(0);

    await field(page, 'Work email (required)').fill(EMAIL);
    await field(page, 'Password (required)').fill(PASSWORD);
    await field(page, 'Password (required)').press('Enter');

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(1);
    await expect(accountButton(page)).toBeVisible();
    expect(api.requests.map((request) => request.operation)).toEqual(['signIn']);
    expect(api.requests[0]?.body).toEqual({ email: EMAIL, password: PASSWORD });
    expect(api.requests[0]?.origin).toBeDefined();
    expect(api.unexpected).toEqual([]);
    expect(seen.problems).toEqual([]);
    expect(await storedAnything(page)).toEqual(NOTHING_STORED);
  });

  // Break caught (AC-SLICE-000-02): the application shell, a session or any signed-in thing drawn for a challenge.
  test('takes a privileged employee to the second step, which is not the application, and completes it', async ({
    page,
  }) => {
    const api = await stubPreSignInApi(page, {
      signIn: { status: 202, json: CHALLENGE },
      secondStep: (attempt) =>
        attempt === 1
          ? errorAnswer(401, 'MFA_PROOF_INVALID')
          : { status: 200, json: SIGNED_IN_SESSION },
    });
    const seen = watchPage(page);
    await page.goto('/sign-in');
    await field(page, 'Work email (required)').fill(EMAIL);
    await field(page, 'Password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    await expect(page).toHaveURL('/sign-in/mfa');
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(accountButton(page)).toHaveCount(0);
    expect(page.url()).not.toContain(CHALLENGE.challenge_id);

    await field(page, 'Authenticator code (required)').fill(CODE);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect(field(page, 'Authenticator code (required)')).toHaveAccessibleDescription(
      /That code was not accepted\./,
    );
    await expect(field(page, 'Authenticator code (required)')).toBeFocused();
    await expect(field(page, 'Authenticator code (required)')).toHaveValue('');

    await field(page, 'Authenticator code (required)').fill('654321');
    await page.getByRole('button', { name: 'Verify and sign in' }).click();

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
    expect(api.requests.map((request) => request.operation)).toEqual([
      'signIn',
      'secondStep',
      'secondStep',
    ]);
    expect(api.requests[1]?.body).toEqual({ challenge_id: CHALLENGE.challenge_id, code: CODE });
    expect(api.unexpected).toEqual([]);
    // The one 401 is the wrong code this test sent on purpose, which a browser logs; nothing else went wrong.
    expect(seen.problems.filter((problem) => !problem.includes('/auth/staff/sign-in/mfa'))).toEqual(
      [],
    );
    expect(await storedAnything(page)).toEqual(NOTHING_STORED);
  });

  // Break caught: a reload of the second step finding a challenge that was kept for it.
  test('forgets the challenge on a reload: the second step goes back to the first', async ({
    page,
  }) => {
    await stubPreSignInApi(page, { signIn: { status: 202, json: CHALLENGE } });
    await page.goto('/sign-in');
    await field(page, 'Work email (required)').fill(EMAIL);
    await field(page, 'Password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible();

    await page.reload();

    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page).toHaveURL('/sign-in');
  });

  // Break caught (AC-SLICE-000-04, -91; ops-portal.md section 7): a refusal worded by cause, or a lock announced at the password step.
  test('words every refusal of the password step alike, empties the password and keeps the email', async ({
    page,
  }) => {
    await stubPreSignInApi(page, { signIn: errorAnswer(401, 'INVALID_CREDENTIALS') });
    await page.goto('/sign-in');
    await field(page, 'Work email (required)').fill(EMAIL);
    await field(page, 'Password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert')).toHaveText('The email or password is not correct.');
    await expect(field(page, 'Password (required)')).toHaveValue('');
    await expect(field(page, 'Password (required)')).toBeFocused();
    await expect(field(page, 'Work email (required)')).toHaveValue(EMAIL);
    await expect(page.getByText(/lock/i)).toHaveCount(0);
    await expect(page.getByText(/Diagnostic text|INVALID_CREDENTIALS/)).toHaveCount(0);
  });

  for (const [code, status, words] of [
    ['CHALLENGE_UNUSABLE', 401, 'This attempt is finished. Sign in again.'],
    ['CHALLENGE_EXPIRED', 401, 'That took too long. Sign in again.'],
    [
      'CREDENTIAL_LOCKED',
      403,
      'This account is locked for fifteen minutes. Recovering the password clears it.',
    ],
  ] as const) {
    // Break caught (ops-portal.md section 7): four refusals merged, or a finished attempt that still offers a field.
    test(`${code} ends the attempt in a state of its own and removes the form`, async ({
      page,
    }) => {
      await stubPreSignInApi(page, {
        signIn: { status: 202, json: CHALLENGE },
        secondStep: errorAnswer(status, code),
      });
      await page.goto('/sign-in');
      await field(page, 'Work email (required)').fill(EMAIL);
      await field(page, 'Password (required)').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await field(page, 'Authenticator code (required)').fill(CODE);
      await page.getByRole('button', { name: 'Verify and sign in' }).click();

      await expect(page.getByRole('alert')).toHaveText(words);
      await expect(field(page, 'Authenticator code (required)')).toHaveCount(0);
      await expect(page.getByRole('navigation')).toHaveCount(0);
    });
  }
});

test.describe('the authenticator in a browser', () => {
  // Break caught: a picture that decodes to something other than the whole provisioning address, or a key that is not the picture's.
  test('paints a QR code that decodes to the whole URI, beside the same key to type, shown once', async ({
    page,
  }) => {
    await toTheAuthenticator(page);
    const region = page.getByRole('region', { name: 'Authenticator set-up' });

    expect(
      await decodePainted(
        page,
        region.getByRole('img', { name: 'QR code for your authenticator app' }),
      ),
    ).toBe(URI);
    await expect(region.getByRole('textbox', { name: 'Setup key' })).toHaveValue(
      'SENT INEL SEED 2345 67AB CDEF GH',
    );
    await expect(page.locator('a[href^="otpauth"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /copy/i })).toHaveCount(0);
    await expect(page).toHaveURL('/setup/mfa');
    expect(page.url()).not.toContain(SEED);
  });

  // Break caught (OB-23): the seed or the continuation grant anywhere but the screen that shows them.
  test('keeps the seed in the page only: no storage, cookie or address, and not after a reload', async ({
    page,
  }) => {
    await toTheAuthenticator(page);

    expect(await storedAnything(page)).toEqual(NOTHING_STORED);
    expect(page.url()).not.toContain(SEED);
    expect(page.url()).not.toContain(CONTINUATION);

    await page.reload();

    // The entry remembers that the code was shown here (not the code): the page says what happened and what to do (run 7, Stage 2.4), and the seed is not on it.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your authenticator is not set up yet' }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SEED);
  });

  test('finishes with a proven code and says the next step is to sign in', async ({ page }) => {
    const api = await toTheAuthenticator(page);
    const seen = watchPage(page);

    await field(page, 'Authenticator code (required)').fill(CODE);
    await page.getByRole('button', { name: 'Finish set-up' }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Your authenticator is set up' }),
    ).toBeVisible();
    await expect(page.getByText('You are not signed in yet.')).toBeVisible();
    await expect(page).toHaveURL('/setup/mfa/complete');
    await expect(page.getByRole('navigation')).toHaveCount(0);
    expect(api.requests.at(-1)?.body).toEqual({ setup_token: CONTINUATION, totp_code: CODE });
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SEED);
    expect(seen.problems).toEqual([]);
    expect(await storedAnything(page)).toEqual(NOTHING_STORED);
  });

  // Break caught: the seed coming back with the back button after the person left, or kept by the browser's back-forward cache.
  test('is gone when the person leaves, and does not return with the back button', async ({
    page,
  }) => {
    await toTheAuthenticator(page);

    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SEED);

    // The page went away: the browser may keep it in its back-forward cache and show it again, or load it afresh. Either way the seed is not on it.
    await page.goBack();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Your authenticator is not set up yet' }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SEED);
  });

  // Break caught (the review of f6cf02b; run 7, Stage 4.3): the authenticator's material drawn again by a Back in the moment the next page is awaited. The test above leaves the page by a full
  // navigation, which loads everything afresh and proves nothing about the router. Here the person leaves **inside the application** and comes Back in the same task: the router has committed the
  // other address and then this one again, and React, which draws a page it leads to later (this application has no page that loads on demand, so none can be held for longer), has drawn
  // nothing in between. The page is still on the screen, and it must hold nothing a Back could show: it let the material go when the router moved (`releaseWhenRouterMoves`), so the page that
  // comes back says the code is gone and never draws the QR code or the key.
  test('does not draw the material again when the person leaves inside the application and comes Back before the next page is drawn', async ({
    page,
  }) => {
    await toTheAuthenticator(page);
    const region = page.getByRole('region', { name: 'Authenticator set-up' });
    await expect(region.getByRole('textbox', { name: 'Setup key' })).toHaveValue(
      'SENT INEL SEED 2345 67AB CDEF GH',
    );

    // An in-application move to the other screen of the family and straight Back, with nothing drawn in between.
    await page.evaluate(() => {
      window.history.pushState(null, '', '/sign-in');
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.history.back();
    });

    await expect(page).toHaveURL('/setup/mfa');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your authenticator is not set up yet' }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(SEED);
    await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toHaveCount(
      0,
    );
    await expect(page.getByRole('textbox', { name: 'Setup key' })).toHaveCount(0);
  });

  test('begins a re-enrolment from the link only when the person presses the button', async ({
    page,
  }) => {
    const api = await stubPreSignInApi(page, {
      beginReenrolment: {
        status: 200,
        json: { mfa_provisioning: { otpauth_uri: URI }, mfa_setup_token: CONTINUATION },
      },
    });
    await page.goto(`/setup/mfa#token=${GRANT}`);

    await expect(page.getByRole('button', { name: 'Begin set-up' })).toBeVisible();
    await expect(page).toHaveURL('/setup/mfa');
    expect(api.requests).toEqual([]);

    await page.getByRole('button', { name: 'Begin set-up' }).click();

    await expect(page.getByRole('region', { name: 'Authenticator set-up' })).toBeVisible();
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]?.body).toEqual({ setup_token: GRANT });
    expect(api.requests[0]?.referer).toBeUndefined();
  });

  // Break caught: a code drawn smaller than a camera can read at 320 px, or the page scrolling sideways.
  test('is drawn at least three pixels to a module at 320 px, and does not scroll sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await toTheAuthenticator(page);

    const picture = page.getByRole('img', { name: 'QR code for your authenticator app' });
    const geometry = await picture.evaluate((svg) => {
      const modules = Number(svg.getAttribute('viewBox')?.split(' ')[2]);
      return { modules, width: svg.getBoundingClientRect().width };
    });
    expect(geometry.width / geometry.modules).toBeGreaterThanOrEqual(3);
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    expect(await decodePainted(page, picture)).toBe(URI);
  });

  test('keeps the picture, the key and the form whole when text is enlarged to 200% at 320 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await toTheAuthenticator(page);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    for (const control of [
      page.getByRole('textbox', { name: 'Setup key' }),
      field(page, 'Authenticator code (required)'),
      page.getByRole('button', { name: 'Finish set-up' }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    }
  });
});

test.describe('the form measure', () => {
  // Break caught: a form stretched across the whole half of the split screen, or across the whole window below it, where a line is too long to
  // read and a field too wide to scan; or squeezed to a sliver. The split screen's column is at most 30rem (DESIGN_SYSTEM section 13.1a), which
  // is what section 13.3's measure of 560 to 720 px yields to there, in the Product Owner's decision of 25 October 2026.
  for (const [name, address] of [
    ['the sign-in', '/sign-in'],
    ['the credential form', `/setup/credential#token=${GRANT}`],
  ] as const) {
    for (const width of [1280, 800] as const) {
      test(`keeps ${name} in a column of 400 to 480 px on a ${String(width)} px screen`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 });
        await stubPreSignInApi(page, {});
        await page.goto(address);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

        const box = await page.locator('.ui-form-page').boundingBox();

        expect(box?.width ?? 0).toBeGreaterThanOrEqual(400);
        expect(box?.width ?? 0).toBeLessThanOrEqual(480);
      });
    }
  }
});

test.describe('the split screen', () => {
  // Break caught: the photograph missing on a wide screen, in the wrong half, stretched, or drawn over the form; the form not beside it; a
  // decorative picture that a screen reader can reach or a keyboard can land on.
  test('puts the photograph in the left half and the form in the right from 1024 px, as tall as the window', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await stubPreSignInApi(page, {});
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    const art = page.locator('.ui-auth-art');
    await expect(art).toBeVisible();
    await expect(art).toHaveAttribute('aria-hidden', 'true');
    const [artBox, mainBox, bannerBox] = await Promise.all([
      art.boundingBox(),
      page.getByRole('main').boundingBox(),
      page.getByRole('banner').boundingBox(),
    ]);
    expect(artBox).toMatchObject({ x: 0, y: 0, width: 640, height: 800 });
    expect(mainBox?.x ?? 0).toBeGreaterThanOrEqual(640);
    expect(bannerBox?.x ?? 0).toBeGreaterThanOrEqual(640);
    await expect(
      page.getByRole('banner').getByRole('img', { name: 'Melarc Logistics' }),
    ).toBeVisible();

    // The photograph is a real picture: loaded, cropped to its place and not stretched, and it says nothing a screen reader would read. It is read once it has loaded: it is
    // a third of a megabyte, and a page that is drawn is not a picture that has arrived (a slow machine read `loaded: false` in the review of f6cf02b). A picture that never
    // loads still fails the test, at the end of the wait.
    const picture = art.locator('.ui-auth-art__picture img');
    await expect
      .poll(() =>
        picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    const photograph = await picture.evaluate((image: HTMLImageElement) => ({
      loaded: image.complete && image.naturalWidth > 0,
      fit: getComputedStyle(image).objectFit,
      alt: image.alt,
      src: image.currentSrc,
    }));
    expect(photograph).toMatchObject({ loaded: true, fit: 'cover', alt: '' });
    expect(photograph.src).toMatch(/auth-art-\d/);
    // Nothing in it can be operated or reached.
    await expect(art.locator('a, button, input, select, textarea, [tabindex]')).toHaveCount(0);
    // And the name of the product is plain text on the band of Ink beneath the picture.
    await expect(art.getByText('Melarc Logistics')).toBeVisible();
  });

  // Break caught: the photograph squeezing the form on a screen too narrow for both, or a half-empty page with the picture's room kept.
  test('draws no photograph under 1024 px, where the form has the window, and no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    await stubPreSignInApi(page, {});
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    await expect(page.locator('.ui-auth-art')).toBeHidden();
    const mainBox = await page.getByRole('main').boundingBox();
    expect((mainBox?.x ?? -1) + (mainBox?.width ?? 0) / 2, 'the form is centred').toBeCloseTo(
      400,
      -1,
    );
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
  });

  // Break caught: a photograph downloaded (a third of a megabyte) by a phone that never draws it.
  test('does not download the photograph where it is not drawn', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const photographs: string[] = [];
    // Images only: the development server also answers a small module for each file the code names (`?import`), which carries the address and
    // not the picture.
    page.on('request', (request) => {
      if (request.resourceType() === 'image' && /auth-art-\d/.test(request.url())) {
        photographs.push(request.url());
      }
    });
    await stubPreSignInApi(page, {});
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await page.waitForLoadState('load');

    expect(photographs).toEqual([]);
  });

  // Break caught: the words "Show password" back as text in a button, or an eye that does not say what it does, does not change with it, loses
  // focus when pressed, or shows the password when it was not asked to.
  test('shows the password by an eye that names what it does, and keeps focus on it', async ({
    page,
  }) => {
    await stubPreSignInApi(page, {});
    await page.goto('/sign-in');
    const password = field(page, 'Password (required)');
    await password.fill(PASSWORD);
    const show = page.getByRole('button', { name: 'Show password' });

    // It is a picture and has no text of its own; the name is its aria-label.
    expect(
      await show.evaluate((button) => ({
        text: button.textContent.trim(),
        pictures: button.querySelectorAll('svg').length,
      })),
    ).toEqual({ text: '', pictures: 1 });
    await expect(password).toHaveAttribute('type', 'password');

    await show.focus();
    await page.keyboard.press('Enter');

    const hide = page.getByRole('button', { name: 'Hide password' });
    await expect(hide).toBeFocused();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(password).toHaveValue(PASSWORD);

    await page.keyboard.press('Space');

    await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
    await expect(password).toHaveAttribute('type', 'password');
  });
});

test.describe('the frame’s move of focus to the new page’s heading', () => {
  // Break caught: the heading taking focus only after the new page has been painted and can already be typed into, which loses the first
  // keystrokes of a quick typist or of an autofill and made a field fill in WebKit type into nothing one run in eight. The observer's callback
  // runs when the page's markup has just been committed and before the browser has painted it, so it sees the focus a person would start from.
  test('has moved focus to the heading by the time the next page’s form exists', async ({
    page,
  }) => {
    await stubPreSignInApi(page, { signIn: { status: 202, json: CHALLENGE } });
    await page.addInitScript(() => {
      new MutationObserver(() => {
        const state = window as unknown as { focusWhenFormArrived?: string };
        if (
          state.focusWhenFormArrived === undefined &&
          document.querySelector('input[name="code"]') !== null
        ) {
          state.focusWhenFormArrived = document.activeElement?.tagName ?? 'none';
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/sign-in');
    await field(page, 'Work email (required)').fill(EMAIL);
    await field(page, 'Password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();

    expect(
      await page.evaluate(
        () => (window as unknown as { focusWhenFormArrived?: string }).focusWhenFormArrived,
      ),
    ).toBe('H1');
    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeFocused();
  });
});

test.describe('the keyboard and the focus ring', () => {
  // Break caught: a tab order that is not the reading order, a skipped field, or a focus ring that is missing.
  test('walks the sign-in form by Tab in reading order, each stop with the focus ring', async ({
    page,
  }) => {
    await stubPreSignInApi(page, {});
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    const tabs = await tabReachesLinks(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    const expected = [
      ...(tabs ? ['Skip to main content'] : []),
      'Work email (required)',
      'Password (required)',
      'Show password',
      'Sign in',
    ];
    const names = await reachableNames(page, tabs);
    expect(names.slice(0, expected.length)).toEqual(expected);

    for (const name of expected) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null) return { name: '', width: 0 };
        // An input is named by its label, an icon button (the eye of the password) by its aria-label, a link or a button by its text.
        const label =
          element instanceof HTMLInputElement
            ? (element.labels?.[0]?.textContent ?? '')
            : (element.getAttribute('aria-label') ?? element.textContent);
        return { name: label.trim(), width: parseFloat(getComputedStyle(element).outlineWidth) };
      });
      expect(stop.name).toBe(name);
      if (name !== 'Skip to main content') expect(stop.width, name).toBeGreaterThan(0);
    }
  });
});

/** Each state of the five screens that a person can be looking at with no session, reached the way a person reaches it. */
const STATES: { name: string; reach: (page: Page) => Promise<void> }[] = [
  {
    name: 'the empty sign-in',
    reach: async (page) => {
      await stubPreSignInApi(page, {});
      await page.goto('/sign-in');
      await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    },
  },
  {
    name: 'the sign-in with its errors',
    reach: async (page) => {
      await stubPreSignInApi(page, {});
      await page.goto('/sign-in');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(field(page, 'Work email (required)')).toHaveAttribute('aria-invalid', 'true');
    },
  },
  {
    name: 'the sign-in after a refusal',
    reach: async (page) => {
      await stubPreSignInApi(page, { signIn: errorAnswer(401, 'INVALID_CREDENTIALS') });
      await page.goto('/sign-in');
      await field(page, 'Work email (required)').fill(EMAIL);
      await field(page, 'Password (required)').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('alert')).toBeVisible();
    },
  },
  {
    name: 'the second step',
    reach: async (page) => {
      await stubPreSignInApi(page, { signIn: { status: 202, json: CHALLENGE } });
      await page.goto('/sign-in');
      await field(page, 'Work email (required)').fill(EMAIL);
      await field(page, 'Password (required)').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    },
  },
  {
    name: 'the second step after a locked account',
    reach: async (page) => {
      await stubPreSignInApi(page, {
        signIn: { status: 202, json: CHALLENGE },
        secondStep: errorAnswer(403, 'CREDENTIAL_LOCKED'),
      });
      await page.goto('/sign-in');
      await field(page, 'Work email (required)').fill(EMAIL);
      await field(page, 'Password (required)').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await field(page, 'Authenticator code (required)').fill(CODE);
      await page.getByRole('button', { name: 'Verify and sign in' }).click();
      await expect(page.getByRole('alert')).toBeVisible();
    },
  },
  {
    name: 'the credential form',
    reach: async (page) => {
      await stubPreSignInApi(page, {});
      await page.goto(`/setup/credential#token=${GRANT}`);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Set your password' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the credential form with its error',
    reach: async (page) => {
      await stubPreSignInApi(page, {});
      await page.goto(`/setup/credential#token=${GRANT}`);
      await field(page, 'New password (required)').fill('short');
      await page.getByRole('button', { name: 'Set password' }).click();
      await expect(field(page, 'New password (required)')).toHaveAttribute('aria-invalid', 'true');
    },
  },
  {
    name: 'the link that cannot be used',
    reach: async (page) => {
      await stubPreSignInApi(page, {});
      await page.goto('/setup/credential');
      await expect(
        page.getByRole('heading', { level: 1, name: 'This link cannot be used' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the ordinary employee’s confirmation',
    reach: async (page) => {
      await stubPreSignInApi(page, {
        credentialSetup: { status: 200, json: { authentication_ready: true } },
      });
      await page.goto(`/setup/credential#token=${GRANT}`);
      await field(page, 'New password (required)').fill(PASSWORD);
      await page.getByRole('button', { name: 'Set password' }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Your password is set' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the authenticator',
    reach: async (page) => {
      await toTheAuthenticator(page);
    },
  },
  {
    name: 'the authenticator after a wrong code',
    reach: async (page) => {
      await toTheAuthenticator(page);
      // A route registered later answers first: from here the enrolment is refused.
      await stubPreSignInApi(page, { enrolment: errorAnswer(401, 'MFA_PROOF_INVALID') });
      await field(page, 'Authenticator code (required)').fill(CODE);
      await page.getByRole('button', { name: 'Finish set-up' }).click();
      await expect(field(page, 'Authenticator code (required)')).toHaveAccessibleDescription(
        /not set up yet/,
      );
    },
  },
  {
    name: 'the begin button of a re-enrolment link',
    reach: async (page) => {
      await stubPreSignInApi(page, {});
      await page.goto(`/setup/mfa#token=${GRANT}`);
      await expect(page.getByRole('button', { name: 'Begin set-up' })).toBeVisible();
    },
  },
  {
    name: 'the authenticator’s confirmation',
    reach: async (page) => {
      await toTheAuthenticator(page);
      await field(page, 'Authenticator code (required)').fill(CODE);
      await page.getByRole('button', { name: 'Finish set-up' }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Your authenticator is set up' }),
      ).toBeVisible();
    },
  },
];

test.describe('every screen and state, at the verified widths', () => {
  for (const { width, height } of VIEWPORTS) {
    for (const state of STATES) {
      // Break caught: a state that clips, scrolls sideways, fails contrast with layout, or has an unlabelled control; or one that shows the shell.
      test(`${state.name} has no WCAG 2.2 A or AA violation, no sideways scrolling and no shell at ${String(width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await state.reach(page);

        expect(await wcagViolations(page)).toEqual([]);
        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        await expect(page.getByRole('navigation')).toHaveCount(0);
        await expect(accountButton(page)).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      });
    }
  }
});

// Break caught (G05 of the audit of 26 October 2026): a sign-in answer whose flow was called off was still accepted. A request on its way when
// the person leaves the page, or when another sign-in begins, delivers its answer to a screen that has gone; the answer must change nothing:
// no session, no navigation to the landing, no word. A browser delivers the answer all the same (a request that loses the race with its
// cancellation, or a stand-in that ignores the signal), so these tests do not rely on the request being aborted: the answer is let through.
test.describe('a sign-in answered after its flow was called off (G05, in the browser)', () => {
  const JSON_ANSWER = { 'content-type': 'application/json', 'cache-control': 'no-store' };

  /**
   * Takes the cancellation signal off every request the page sends, before the page loads. A browser that is told to abort a request does
   * abort it, and then the late answer never arrives to be refused; the case that matters is the one where it does arrive (a request that
   * loses the race with its cancellation, or one whose answer was already being read), and the page must refuse it by its own flow and not by
   * the request's signal.
   */
  const deafToCancellation = (page: Page) =>
    page.addInitScript(() => {
      const send = window.fetch.bind(window);
      window.fetch = (input, init) =>
        input instanceof Request
          ? send(new Request(input.clone(), { signal: null }), init)
          : send(input, init);
    });

  /** Moves the router within the app, as a link would, without reloading the page: a reload would end the request with the page. */
  const goWithin = (page: Page, path: string) =>
    page.evaluate((to) => {
      window.history.pushState({}, '', to);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);

  /** Lets the page act on what it was just given, if it is going to: two frames after a short turn of the event loop. */
  const letThePageAct = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                resolve();
              });
            });
          }, 50);
        }),
    );

  /**
   * The sign-in is answered by this test and not by the stand-in: the first request is held until `release()` and then answered `200` with a
   * session; every later one is answered `202`, a challenge. `answered()` resolves once the held answer has been given to the browser.
   */
  async function firstSignInHeld(page: Page) {
    const api = await stubPreSignInApi(page, {});
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let given: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      given = resolve;
    });
    const sent: number[] = [];
    // Registered after the stand-in's catch-all, so that it answers first.
    await page.route('**/api/v1/auth/staff/sign-in', async (route) => {
      sent.push(sent.length + 1);
      if (sent.length === 1) {
        await held;
        await route.fulfill({ status: 200, headers: JSON_ANSWER, json: SIGNED_IN_SESSION });
        given();
        return;
      }
      await route.fulfill({ status: 202, headers: JSON_ANSWER, json: CHALLENGE });
    });
    return { api, sent, release, answered };
  }

  async function submitSignIn(page: Page) {
    await field(page, 'Work email (required)').fill(EMAIL);
    await field(page, 'Password (required)').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
  }

  test('does not sign the person in, or take them to the landing, when they left before the answer', async ({
    page,
  }) => {
    const { api, sent, release, answered } = await firstSignInHeld(page);
    await deafToCancellation(page);
    await page.goto('/sign-in');
    await submitSignIn(page);
    await expect.poll(() => sent.length).toBe(1);
    await goWithin(page, '/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

    release();
    await answered;
    await letThePageAct(page);

    expect(new URL(page.url()).pathname).toBe('/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    // A session read would mean the page had gone on to the landing.
    expect(api.unexpected).toEqual([]);
  });

  test('does not let the late success of an earlier sign-in take over a newer one', async ({
    page,
  }) => {
    const { api, sent, release, answered } = await firstSignInHeld(page);
    await deafToCancellation(page);
    await page.goto('/sign-in');
    await submitSignIn(page);
    await expect.poll(() => sent.length).toBe(1);
    await goWithin(page, '/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await goWithin(page, '/sign-in');
    await submitSignIn(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();

    release();
    await answered;
    await letThePageAct(page);

    expect(new URL(page.url()).pathname).toBe('/sign-in/mfa');
    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  test('does not sign the person in from the second step when they left before the code was checked', async ({
    page,
  }) => {
    const api = await stubPreSignInApi(page, { signIn: { status: 202, json: CHALLENGE } });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let given: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => {
      given = resolve;
    });
    let checked = 0;
    await page.route('**/api/v1/auth/staff/sign-in/mfa', async (route) => {
      checked += 1;
      await held;
      await route.fulfill({ status: 200, headers: JSON_ANSWER, json: SIGNED_IN_SESSION });
      given();
    });
    await deafToCancellation(page);
    await page.goto('/sign-in');
    await submitSignIn(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Enter your code' })).toBeVisible();
    await field(page, 'Authenticator code (required)').fill(CODE);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await expect.poll(() => checked).toBe(1);
    await goWithin(page, '/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

    release();
    await answered;
    await letThePageAct(page);

    expect(new URL(page.url()).pathname).toBe('/no-such-page');
    await expect(page.getByRole('navigation')).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });
});
