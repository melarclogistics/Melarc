import { expect, type BrowserContext, type Page } from '@playwright/test';

import type { StackConnection } from '../connection.ts';
import { Authenticator } from '../totp.ts';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  expectAuthenticatorSetUp,
  expectCodeStep,
  expectHeading,
  expectLanding,
  finishSetUp,
  fromPage,
  goToSignIn,
  readSetupKey,
  rememberChoice,
  setCookieLines,
  submitCode,
  submitPassword,
  TRUSTED_COOKIE,
} from './pages.ts';
import type { PersonState } from './world.ts';

/**
 * The acts the staff journeys are made of (S0.46): what a maker, an approver, a new employee and an administrator do on the Ops Portal
 * screens. Each one says what it expects to see next, and fails with the screen it is on and never with a secret that was typed.
 */

/** The custody folder of a stack of the journeys. */
export function custodyOf(stack: StackConnection): string {
  if (stack.custodyDirectory === undefined) throw new Error('The stack has no custody folder.');
  return stack.custodyDirectory;
}

/** Enrols an authenticator on the screen that shows its key, and keeps the authenticator with the person. */
export async function enrolAuthenticator(page: Page, state: PersonState): Promise<void> {
  state.authenticator = new Authenticator(await readSetupKey(page));
  await finishSetUp(page, await state.authenticator.next());
  await expectAuthenticatorSetUp(page);
}

/** The names of the fields of a JSON value, at any depth. */
export function fieldNamesOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(fieldNamesOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([name, inner]) => [name, ...fieldNamesOf(inner)]);
}

/** What the browser stored for the session after a sign-in: the attributes of AC-SLICE-000-127, and no value. */
export async function expectBrowserSessionCookies(context: BrowserContext): Promise<void> {
  // All of the context's cookies, not the ones for an address: the list for an `http` address leaves out a `Secure` cookie, which is
  // not sent there, though the browser stored it. The context holds this site's cookies and no other's.
  const stored = await context.cookies();
  const session = stored.find((cookie) => cookie.name === SESSION_COOKIE);
  const csrf = stored.find((cookie) => cookie.name === CSRF_COOKIE);
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
  expect(session?.httpOnly, 'the session cookie is HttpOnly').toBe(true);
  expect(csrf?.httpOnly, 'the CSRF cookie is readable by script').toBe(false);
}

/** The attributes the server wrote, as it wrote them: neither cookie carries a `Max-Age` or an `Expires`. */
export function expectNoLifetimeInSetCookies(lines: readonly string[]): void {
  const named = (name: string) => lines.filter((line) => line.startsWith(`${name}=`));
  expect(named(SESSION_COOKIE), 'one Set-Cookie line for the session').toHaveLength(1);
  expect(named(CSRF_COOKIE), 'one Set-Cookie line for the CSRF token').toHaveLength(1);
  for (const line of lines) {
    expect(/;\s*max-age=/i.test(line), 'a session cookie carries no Max-Age').toBe(false);
    expect(/;\s*expires=/i.test(line), 'a session cookie carries no Expires').toBe(false);
  }
  const session = named(SESSION_COOKIE)[0] ?? '';
  expect(/;\s*httponly/i.test(session), 'the session cookie is HttpOnly').toBe(true);
  expect(/;\s*secure/i.test(session), 'the session cookie is Secure').toBe(true);
  expect(/;\s*samesite=lax/i.test(session), 'the session cookie is SameSite=Lax').toBe(true);
}

export interface SignedIn {
  /** The `Set-Cookie` lines of the answer that issued the session. */
  readonly setCookies: readonly string[];
}

/**
 * A privileged person signs in through the two screens: the password, then a code from their authenticator. It returns what the
 * answer that issued the session set, so a journey can judge the cookies as the server wrote them.
 */
export async function signInWithAuthenticator(
  page: Page,
  state: PersonState,
  name = state.person.fullName,
): Promise<SignedIn> {
  if (state.authenticator === undefined) throw new Error('The person has no authenticator.');
  await goToSignIn(page);
  await submitPassword(page, state.person.workEmail, state.password);
  await expectCodeStep(page);
  // The code first, which may wait for the clock to reach a step the server still takes; the wait for the answer starts after it.
  const code = await state.authenticator.next();
  // The answer to the second step is the one that issues the session.
  const issued = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/auth/staff/sign-in/mfa' &&
      response.request().method() === 'POST',
  );
  await submitCode(page, code);
  const answer = await issued;
  expect(answer.status()).toBe(200);
  await expectLanding(page, name);
  return { setCookies: await setCookieLines(answer) };
}

/**
 * A person signs in as they do: a privileged one through the two screens, anyone else through one. A person who has set up an
 * authenticator is signed in with it.
 */
export async function signInAs(page: Page, state: PersonState): Promise<void> {
  if (state.authenticator !== undefined) {
    await signInWithAuthenticator(page, state);
    return;
  }
  await goToSignIn(page);
  await submitPassword(page, state.person.workEmail, state.password);
  await expectLanding(page, state.person.fullName);
}

/** The roles the creation screen offers, by name, without the note it adds to a role that needs a Platform Admin. */
export async function offeredRoles(page: Page): Promise<string[]> {
  const labels = await page.getByLabel('Role').locator('option').allTextContents();
  return labels
    .filter((label) => label !== 'Choose a role')
    .map((label) => label.replace(/ \(needs a Platform Admin to approve\)$/, ''));
}

/** The maker's half: the form of `/admin/staff/new`, filled and sent. Returns once the screen says the profile is waiting for approval. */
export async function createProfile(
  page: Page,
  profile: { fullName: string; workEmail: string; role: string; hub?: string },
): Promise<void> {
  await page.goto('/admin/staff/new');
  await expectHeading(page, 'Add a staff profile');
  await page.getByLabel('Full name').fill(profile.fullName);
  await page.getByLabel('Work email').fill(profile.workEmail);
  const labels = await page.getByLabel('Role').locator('option').allTextContents();
  const label = labels.find(
    (each) => each === profile.role || each.startsWith(`${profile.role} (`),
  );
  expect(label, `the role ${profile.role} is offered`).toBeDefined();
  await page.getByLabel('Role').selectOption({ label: label ?? '' });
  // A profile has no primary hub unless one is chosen, and a hub's own acts need one.
  if (profile.hub !== undefined)
    await page.getByLabel('Primary hub').selectOption({ label: profile.hub });
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Profile created' })).toBeVisible();
  await expect(page.getByText(`${profile.fullName} is waiting for approval.`)).toBeVisible();
}

/** Opens a profile from the list at `/admin/staff` (the queue for an approver), as a person finds one. */
export async function openProfile(page: Page, fullName: string): Promise<string> {
  await page.goto('/admin/staff?view=all');
  await expectHeading(page, 'Staff');
  await expect(page.getByRole('table', { name: 'Staff profiles' })).toBeVisible();
  await page.getByRole('link', { name: fullName }).click();
  await expectHeading(page, fullName);
  const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/** The checker's half: finds the profile in the queue of `/admin/staff`, opens it and approves the version the page read. */
export async function approveProfile(
  page: Page,
  fullName: string,
  workEmail: string,
): Promise<string> {
  await page.goto('/admin/staff');
  await expectHeading(page, 'Staff');
  await expect(page.getByRole('table', { name: 'Staff profiles' })).toBeVisible();
  await page.getByRole('link', { name: fullName }).click();
  await expectHeading(page, fullName);
  const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await page.getByRole('button', { name: 'Approve profile' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Approve profile' }).click();
  await expect(
    page.getByText(`${fullName} is approved. A setup link is on its way to ${workEmail}.`),
  ).toBeVisible();
  return id;
}

/**
 * Answers a dialog that asks for a reason: the first reason of the catalogue the screen offered, a note, and the dialog's own confirming
 * act. The reason is the catalogue's and never typed.
 */
export async function giveReasonAndConfirm(
  page: Page,
  confirmLabel: string,
  note = 'Recorded by the staff journeys of the integrated harness.',
): Promise<void> {
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  const reason = dialog.getByLabel('Reason');
  await expect(reason.locator('option').nth(1)).toBeAttached();
  await reason.selectOption({ index: 1 });
  const noteField = dialog.getByLabel('Note');
  if (await noteField.count()) await noteField.fill(note);
  await dialog.getByRole('button', { name: confirmLabel }).click();
}

/** The first reason code the catalogue gives an operation (and branch), read by the page itself as the screens read it. */
export async function reasonCodeFor(
  page: Page,
  operation: string,
  branch?: string,
): Promise<string> {
  const query = new URLSearchParams({ operation, ...(branch === undefined ? {} : { branch }) });
  const answer = await fromPage(page, 'GET', `/api/v1/reason-definitions?${query.toString()}`);
  expect(answer.status).toBe(200);
  // The catalogue is a plain list of reasons, as the screens read it.
  const items = Array.isArray(answer.body)
    ? (answer.body as { code: string; active?: boolean }[])
    : [];
  const first = items.find((reason) => reason.active !== false)?.code;
  expect(first, `the catalogue offers a reason for ${operation}`).toBeDefined();
  return first ?? '';
}

/**
 * A privileged person signs in and **chooses to remember the browser** (staff-authentication.md section 5.8): the second step offers the
 * choice off, with the number of days the server carried; ticking it and presenting a code issues the trusted browser with the session.
 * It returns what the answer that issued the session set, which now includes the one persistent cookie.
 */
export async function signInRemembering(
  page: Page,
  state: PersonState,
  name = state.person.fullName,
): Promise<SignedIn> {
  if (state.authenticator === undefined) throw new Error('The person has no authenticator.');
  await goToSignIn(page);
  await submitPassword(page, state.person.workEmail, state.password);
  await expectCodeStep(page);
  const choice = rememberChoice(page);
  // Off until the person turns it on, and worded with the server's number of days.
  await expect(choice).not.toBeChecked();
  await expect(choice).toHaveAccessibleName('Remember this browser for 7 days');
  await choice.check();
  const code = await state.authenticator.next();
  const issued = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/auth/staff/sign-in/mfa' &&
      response.request().method() === 'POST',
  );
  await submitCode(page, code);
  const answer = await issued;
  expect(answer.status()).toBe(200);
  await expectLanding(page, name);
  return { setCookies: await setCookieLines(answer) };
}

/** Answers a dialog that asks for a confirmation and nothing else: its own confirming act, and the dialog is gone. */
export async function giveConfirmation(page: Page, confirmLabel: string): Promise<void> {
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: confirmLabel }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
}

export interface RememberedSignIn extends SignedIn {
  /** Whether the page went to the second step on the way: a remembered browser does not. */
  readonly askedForCode: boolean;
  /** Whether the browser sent the trusted-browser credential with the password step (it is sent to the staff sign-in routes). */
  readonly sentCredential: boolean;
}

/** The password alone, on a browser that was remembered: the landing comes at once, from the answer of the first step. */
export async function signInOnRememberedBrowser(
  page: Page,
  state: PersonState,
  name = state.person.fullName,
): Promise<RememberedSignIn> {
  const secondStep: string[] = [];
  const watch = (request: { url(): string }) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/v1/auth/staff/sign-in/mfa') secondStep.push(path);
  };
  page.on('request', watch);
  try {
    await goToSignIn(page);
    const issued = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/v1/auth/staff/sign-in' &&
        response.request().method() === 'POST',
    );
    await submitPassword(page, state.person.workEmail, state.password);
    const answer = await issued;
    expect(answer.status()).toBe(200);
    await expectLanding(page, name);
    // The cookie header as the browser sent it, judged and never printed.
    const sent = (await answer.request().allHeaders()).cookie ?? '';
    return {
      setCookies: await setCookieLines(answer),
      askedForCode: secondStep.length > 0,
      sentCredential: sent.includes(`${TRUSTED_COOKIE}=`),
    };
  } finally {
    page.off('request', watch);
  }
}
