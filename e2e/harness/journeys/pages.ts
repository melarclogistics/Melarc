import { createHash } from 'node:crypto';

import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';

import type { SecretText } from '../secret-text.ts';

/**
 * What a person does on the Ops Portal screens, as the journeys of S0.46 do it: through the screens' own labels and roles, as a person
 * perceives them, and never by reaching into the page's state. Each function says what it expects to see next and fails with the
 * screen's heading or address, never with a value that was typed. A secret (a password, a code, a link) is used at once and kept nowhere.
 *
 * The journeys do not freeze the browser's clock: the API judges every expiry on the database's clock, and the page shows what the
 * server told it.
 */

/** The cookies of the browser session (SECURITY_DESIGN.md §13.2). */
export const SESSION_COOKIE = 'melarc_session';
export const CSRF_COOKIE = 'melarc_csrf';

/** The one persistent cookie of the staff sign-in (staff-authentication.md section 5.8), and the only path it is sent to. */
export const TRUSTED_COOKIE = 'melarc_trusted_browser';
export const TRUSTED_PATH = '/api/v1/auth/staff';

export async function expectHeading(page: Page, name: string | RegExp): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
}

/**
 * Opens a link a message carried, as the person it was for would. A failure to open it is reported with the path and not the address:
 * the address carries the token.
 */
export async function openLink(page: Page, link: SecretText): Promise<void> {
  const address = link.reveal();
  try {
    await page.goto(address);
  } catch {
    throw new Error(`The page could not open the captured link (${new URL(address).pathname}).`);
  }
}

/** Opens a link made of the setup secret of a bootstrap bundle, which is not a link: the secret goes after `#token=` (DEVELOPMENT.md). */
export async function openBootstrapSecret(page: Page, secret: SecretText): Promise<void> {
  await page.goto(`/setup/credential#token=${secret.reveal()}`);
}

/** The secret of a re-enrolment bundle goes after `#token=` of the authenticator screen, which the person then begins by pressing a button. */
export async function openReenrolmentSecret(page: Page, secret: SecretText): Promise<void> {
  await page.goto(`/setup/mfa#token=${secret.reveal()}`);
}

/** The "Set your password" screen: choose the password. Returns where the person is taken, which depends on whether the role needs an authenticator. */
export async function setPassword(
  page: Page,
  password: string,
): Promise<'sign-in' | 'authenticator'> {
  await expectHeading(page, 'Set your password');
  await page.getByLabel('New password').fill(password);
  await page.getByRole('button', { name: 'Set password' }).click();
  const authenticator = page.getByRole('heading', { level: 1, name: 'Set up your authenticator' });
  const done = page.getByRole('heading', { level: 1, name: 'Your password is set' });
  await expect(authenticator.or(done)).toBeVisible();
  return (await done.isVisible()) ? 'sign-in' : 'authenticator';
}

/** The setup key the authenticator screen shows for typing by hand: base32 in groups of four. The caller gives it to an `Authenticator`. */
export async function readSetupKey(page: Page): Promise<string> {
  await expectHeading(page, 'Set up your authenticator');
  return page.getByLabel('Setup key').inputValue();
}

/** Types a code on the authenticator screen and finishes the set-up. */
export async function finishSetUp(page: Page, code: string): Promise<void> {
  await page.getByLabel('Authenticator code').fill(code);
  await page.getByRole('button', { name: 'Finish set-up' }).click();
}

export async function expectAuthenticatorSetUp(page: Page): Promise<void> {
  await expectHeading(page, 'Your authenticator is set up');
}

export async function goToSignIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await expectHeading(page, 'Sign in');
}

/** Fills the password step and presses the button. It does not say what happens next: the caller waits for the screen it expects. */
export async function submitPassword(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('Work email').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export async function expectCodeStep(page: Page): Promise<void> {
  await expectHeading(page, 'Enter your code');
}

/** The choice the second step offers: remember this browser for the number of days the challenge carried. */
export function rememberChoice(page: Page): Locator {
  return page.getByRole('checkbox', { name: /^Remember this browser for \d+ days?$/ });
}

export async function submitCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Authenticator code').fill(code);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
}

/** The landing, My work: the first screen of a signed-in person, which greets them by name. */
export async function expectLanding(page: Page, name?: string): Promise<void> {
  await expectHeading(page, 'My work');
  await expect(page).toHaveURL(/\/$/);
  if (name !== undefined) await expect(page.getByRole('main').getByText(name)).toBeVisible();
}

/**
 * Opens the account menu of the top bar and waits until it has come in. The menu slides and grows into place, and Playwright presses an item only when its box has stood still for two frames: in
 * WebKit on a loaded runner "Sign out" was "not stable" for the 20 seconds an action may take (the hosted run of 12 November 2026, the journey of row 6, in two runs of four; a probe of the same
 * clicks in WebKit settled in under two and a half seconds every time, and the cause was not found). The wait is for the menu's own animations to finish and not for a time; motion is not what a
 * journey checks.
 */
export async function openAccountMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account menu' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await menu.evaluate(async (element) => {
    const moving = element.getAnimations({ subtree: true }).filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
    });
    await Promise.allSettled(moving.map((animation) => animation.finished));
  });
}

/** Signs out the way every signed-in screen offers: the account menu of the top bar, and its Sign out item. */
export async function signOut(page: Page): Promise<void> {
  await openAccountMenu(page);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expectHeading(page, 'Sign in');
}

/** Everything a browser keeps for this site is gone: the same person at another browser, or nobody. */
export async function clearBrowser(context: BrowserContext): Promise<void> {
  await context.clearCookies();
}

/** What a request from the page itself answered: a request made as the page's own code makes one, with the page's cookies and origin. */
export interface PageAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly etag: string | null;
}

/**
 * A request from the page to its own origin. It sends the CSRF token the way the Ops client does (the readable cookie echoed in a
 * header) and the `Origin` the browser adds itself. A body is JSON.
 */
export async function fromPage(
  page: Page,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<PageAnswer> {
  return page.evaluate(
    async ({ method, path, body, headers }) => {
      const csrf = document.cookie
        .split('; ')
        .find((each) => each.startsWith('melarc_csrf='))
        ?.slice('melarc_csrf='.length);
      const response = await fetch(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { status: response.status, body: parsed, etag: response.headers.get('etag') };
    },
    { method, path, body: options.body, headers: options.headers ?? {} },
  );
}

/** The `Set-Cookie` lines a response carried, one string each. Playwright keeps repeated header lines apart. */
export async function setCookieLines(response: Response): Promise<string[]> {
  return (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value);
}

/** A digest of a cookie value, so that two credentials can be compared without the value being printed. */
export function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The value of one cookie of the context, or undefined. */
export async function cookieValue(
  context: BrowserContext,
  name: string,
): Promise<string | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === name)?.value;
}
