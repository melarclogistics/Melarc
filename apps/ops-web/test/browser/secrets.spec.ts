import { expect, test, type Locator, type Page } from '@playwright/test';

import { stubApi } from './support/api';
import { decodePainted } from './support/painted';
import { watchPage, wcagViolations } from './support/page';

/**
 * The form components, the one-time secret and the QR code of the showcase, in a real browser (S0.39). What jsdom cannot
 * check is here: the keyboard in each engine, a code that a camera-grade decoder reads from what the browser *painted*, the
 * colours of that code in forced-colours mode, its size at 320 px, and the contrast of everything with a secret showing.
 * The picture is decoded by an independent library (jsQR, a development dependency), in Node, from a screenshot.
 */
const SHOWCASE = '/__showcase';

/** The synthetic provisioning URI of the showcase's secret demo. It enrols nothing for anyone. */
const DEMO_URI =
  'otpauth://totp/Melarc:synthetic.demo?secret=DEMODEMODEMODEMO&issuer=Melarc&period=30';

async function openShowcase(page: Page): Promise<void> {
  await page.goto(SHOWCASE);
  await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
}

async function showDemoSecret(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Show demo setup key' }).click();
  const region = page.getByRole('region', { name: 'Demo authenticator setup' });
  await expect(region).toBeVisible();
  return region;
}

const storedAnything = (page: Page): Promise<unknown> =>
  page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));

test.describe('the password and code fields in a browser', () => {
  // Break caught: a password toggle that only works with a pointer, a field that changes what is typed, or a toggle that
  // takes focus away from itself.
  test('the password field keeps what is typed, and its toggle works by keyboard', async ({
    page,
  }) => {
    await openShowcase(page);
    const field = page.getByRole('textbox', { name: 'Demo password (required)' });
    await expect(field).toHaveAttribute('type', 'password');

    await field.focus();
    await page.keyboard.type('  Zz9 pass phrase  ');
    await page.keyboard.press('Tab');
    const toggle = page.getByRole('button', { name: 'Show password' });
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(field).toHaveAttribute('type', 'text');
    await expect(field).toHaveValue('  Zz9 pass phrase  ');
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: 'Password shown' })).toBeAttached();
    await page.keyboard.press('Space');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
  });

  // Break caught: a code field that accepts letters, keeps a pasted space, or takes more digits than the code has.
  test('the code field keeps only the digits, at most six', async ({ page }) => {
    await openShowcase(page);
    const field = page.getByRole('textbox', { name: 'Demo code (required)' });
    await expect(field).toHaveAttribute('inputmode', 'numeric');
    await expect(field).toHaveAttribute('autocomplete', 'one-time-code');

    await field.fill('12 ab 34 56 78');

    await expect(field).toHaveValue('123456');
  });
});

test.describe('a form that submits, in a browser', () => {
  // Break caught: a failed submit that leaves focus on the button; a second Enter sending the work twice; a button that
  // does not say it is busy.
  test('focus goes to the first invalid field; a second submit while pending is ignored; the form ends ready again', async ({
    page,
  }) => {
    await openShowcase(page);
    await page.getByRole('button', { name: 'Submit sign-in demo' }).click();

    const password = page.getByRole('textbox', { name: 'Demo password (required)' });
    await expect(password).toBeFocused();
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAccessibleDescription(
      'Nothing is sent or stored. Enter a demo password.',
    );
    expect(await wcagViolations(page), 'with the errors showing').toEqual([]);

    await page.keyboard.type('Zz9 pass phrase');
    await page.getByRole('textbox', { name: 'Demo code (required)' }).fill('123456');
    await page.getByRole('textbox', { name: 'Demo code (required)' }).press('Enter');
    const busy = page.getByRole('button', { name: 'Submit sign-in demo' });
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await page.getByRole('textbox', { name: 'Demo code (required)' }).press('Enter');
    await busy.click();

    await expect(page.getByText('Demo submissions accepted:')).toContainText('1');
    await expect(busy).not.toHaveAttribute('aria-busy', 'true');
    await page.waitForTimeout(700);
    await expect(page.getByText('Demo submissions accepted:')).toContainText('1');
    await expect(password).toHaveValue('');
  });
});

test.describe('the one-time secret and the QR code in a browser', () => {
  // Break caught: the code or the key drawn wrongly (what the browser paints is what a camera sees), or the key shown
  // differing from the code's.
  test('the painted QR code decodes to the whole URI, and the key beside it is the same key', async ({
    page,
  }) => {
    await openShowcase(page);
    const region = await showDemoSecret(page);

    const code = region.getByRole('img', { name: 'Demo QR code' });
    expect(await decodePainted(page, code)).toBe(DEMO_URI);
    await expect(region.getByRole('textbox', { name: 'Demo setup key' })).toHaveValue(
      'DEMO DEMO DEMO DEMO',
    );
    expect(await wcagViolations(page), 'with the secret showing').toEqual([]);
  });

  // Break caught: the nominal size lost: a code drawn smaller than four CSS pixels to a module with room to spare.
  test('is drawn four pixels to a module where there is room', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openShowcase(page);
    const region = await showDemoSecret(page);

    const geometry = await region.getByRole('img', { name: 'Demo QR code' }).evaluate((svg) => {
      const modules = Number(svg.getAttribute('viewBox')?.split(' ')[2]);
      return { modules, width: svg.getBoundingClientRect().width };
    });

    // The picture's box includes its one-pixel border, so a code drawn at four pixels to a module measures a little over four.
    expect(geometry.width / geometry.modules).toBeGreaterThanOrEqual(4);
    expect(geometry.width / geometry.modules).toBeLessThan(4.1);
  });

  // Break caught: a code that is too small for a camera: under three CSS pixels to a module at 320 px (the picture shrinks to a narrow
  // container, so four is the size where there is room, asserted by the test below), or clipped there.
  test('is drawn at least three pixels to a module at 320 px, without sideways scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);
    const region = await showDemoSecret(page);

    const code = region.getByRole('img', { name: 'Demo QR code' });
    const geometry = await code.evaluate((svg) => {
      const modules = Number(svg.getAttribute('viewBox')?.split(' ')[2]);
      return { modules, width: svg.getBoundingClientRect().width };
    });
    expect(geometry.width / geometry.modules).toBeGreaterThanOrEqual(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    expect(await decodePainted(page, code)).toBe(DEMO_URI);
    expect(await wcagViolations(page)).toEqual([]);
  });

  // Break caught: the code following the user's colours and becoming light on dark, or a pale frame, in Windows high
  // contrast: many scanners read dark on light only.
  test('stays black on white under forced colours', async ({ page, browserName }) => {
    test.skip(
      browserName === 'webkit',
      'Playwright cannot emulate forced colours in WebKit; the colour rule is a stylesheet rule that every engine applies, and the other engines check it.',
    );
    await page.emulateMedia({ forcedColors: 'active' });
    await openShowcase(page);
    const region = await showDemoSecret(page);
    const code = region.getByRole('img', { name: 'Demo QR code' });

    const fills = await code.evaluate((svg) => ({
      modules: getComputedStyle(svg.querySelector('.ui-qr__modules') ?? svg).fill,
      background: getComputedStyle(svg.querySelector('.ui-qr__background') ?? svg).fill,
    }));
    expect(fills).toEqual({ modules: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)' });
    expect(await decodePainted(page, code)).toBe(DEMO_URI);
  });

  // Break caught: the secret kept anywhere in the browser, or sent anywhere, while it is shown.
  test('puts nothing in storage and makes no request while the secret is shown', async ({
    page,
    baseURL,
  }) => {
    const seen = watchPage(page);
    await openShowcase(page);
    const before = seen.requests.length;

    await showDemoSecret(page);

    expect(await storedAnything(page)).toEqual({
      local: 0,
      session: 0,
      cookie: '',
      databases: 0,
      caches: 0,
    });
    expect(seen.requests.slice(before)).toEqual([]);
    expect(seen.problems).toEqual([]);
    for (const url of seen.requests) expect(new URL(url).origin, url).toBe(baseURL);
    expect(page.url()).not.toContain('DEMODEMO');
  });

  // Break caught: the secret left on the screen at completion, when the page is hidden (what the back-forward cache keeps),
  // or after the person leaves and comes back.
  test('is gone at completion, when the page is hidden, and after leaving and coming back', async ({
    page,
  }) => {
    await stubApi(page);
    await openShowcase(page);

    const region = await showDemoSecret(page);
    await region.getByRole('button', { name: 'Done with the demo key' }).click();
    await expect(page.getByRole('region', { name: 'Demo authenticator setup' })).toHaveCount(0);
    expect(await page.content()).not.toContain('DEMO DEMO');

    await showDemoSecret(page);
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    await expect(page.getByRole('region', { name: 'Demo authenticator setup' })).toHaveCount(0);

    await showDemoSecret(page);
    await page.getByRole('link', { name: 'Go to the start page' }).first().click();
    await expect(page).toHaveURL('/');
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Demo authenticator setup' })).toHaveCount(0);
    expect(await page.content()).not.toMatch(/DEMO DEMO|secret=DEMO/);
  });

  // Break caught: a layout that breaks with the secret showing and the text enlarged.
  test('does not break the layout with the secret showing and text at 200%', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await openShowcase(page);
    await showDemoSecret(page);

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, input')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent || element.getAttribute('aria-label')),
    );
    expect(clipped).toEqual([]);
  });
});

test.describe('a secret asked for from the server and answered after the person has moved on (U02, review of 24 October 2026)', () => {
  /** The seed inside DEMO_URI, as it is written and as the key field groups it: neither may be anywhere once the secret is gone. */
  const SEED_FORMS = ['DEMODEMODEMODEMO', 'DEMO DEMO DEMO DEMO'];

  /**
   * Answers the showcase's request for a demo key (the fixture of `SecretDemo`) with the made-up enrolment answer, but only when the test
   * lets it go: the request is in flight until `release()`. Everything else on `/api` is not stubbed here and is not asked for.
   */
  async function holdTheAnswer(page: Page) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requestedNow: () => void = () => undefined;
    const requested = new Promise<void>((resolve) => {
      requestedNow = resolve;
    });
    await page.route('**/api/v1/auth/staff/setup/credential', async (route) => {
      requestedNow();
      await gate;
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            authentication_ready: false,
            mfa_enrolment_required: true,
            mfa_provisioning: { otpauth_uri: DEMO_URI },
            mfa_setup_token: 'synthetic-demo-mfa-token',
          }),
        });
      } catch {
        // The page called the request off before the answer came: there is nobody to answer.
      }
    });
    return { requested, release };
  }

  async function nothingOfTheSecret(page: Page): Promise<void> {
    // The answer, if the page took it, is drawn within a moment: give it that moment before saying nothing came.
    await page.waitForTimeout(400);
    await expect(page.getByRole('region', { name: 'Demo authenticator setup' })).toHaveCount(0);
    const html = await page.content();
    for (const form of SEED_FORMS) expect(html, form).not.toContain(form);
    expect(await storedAnything(page)).toEqual({
      local: 0,
      session: 0,
      cookie: '',
      databases: 0,
      caches: 0,
    });
  }

  const ask = (page: Page) =>
    page.getByRole('button', { name: 'Ask the server for a demo setup key' }).click();

  // Break caught: a control that shows nothing wrong because the fixture shows nothing at all.
  test('shows the key when nothing happened between the request and the answer', async ({
    page,
  }) => {
    const held = await holdTheAnswer(page);
    await openShowcase(page);

    await ask(page);
    await held.requested;
    held.release();

    const region = page.getByRole('region', { name: 'Demo authenticator setup' });
    await expect(region).toBeVisible();
    await expect(region.getByRole('textbox', { name: 'Demo setup key' })).toHaveValue(
      'DEMO DEMO DEMO DEMO',
    );
  });

  // Break caught: the page staying mounted while the address changes under it (a step, a query string), so that the answer to a question
  // asked on the earlier address is drawn on the later one.
  test('shows nothing when the address changes under the page before the answer arrives', async ({
    page,
  }) => {
    const held = await holdTheAnswer(page);
    await openShowcase(page);

    await ask(page);
    await held.requested;
    await page.getByRole('link', { name: 'Same page, next step' }).click();
    await expect(page).toHaveURL(/step=2/);
    held.release();

    await nothingOfTheSecret(page);
  });

  // Break caught: the page, with the answer to a request still on its way, kept by the browser and shown again: `pagehide` is the last
  // thing a page that is about to be kept in the back-forward cache runs.
  test('shows nothing when the page is hidden before the answer arrives', async ({ page }) => {
    const held = await holdTheAnswer(page);
    await openShowcase(page);

    await ask(page);
    await held.requested;
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    held.release();

    await nothingOfTheSecret(page);
  });
});
