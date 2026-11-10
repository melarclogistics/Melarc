import { expect, type BrowserContext, type Page } from '@playwright/test';

import type { StackConnection } from '../connection.ts';
import { takeBundle } from '../custody.ts';
import { arrange, observe, resumeAdministrator } from '../database.ts';
import type { Sandbox } from '../playwright.ts';
import { Authenticator } from '../totp.ts';
import {
  approveProfile,
  createProfile,
  custodyOf,
  enrolAuthenticator,
  expectBrowserSessionCookies,
  expectNoLifetimeInSetCookies,
  fieldNamesOf,
  giveConfirmation,
  giveReasonAndConfirm,
  offeredRoles,
  openProfile,
  reasonCodeFor,
  signInAs,
  signInOnRememberedBrowser,
  signInRemembering,
  signInWithAuthenticator,
} from './actions.ts';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  TRUSTED_COOKIE,
  TRUSTED_PATH,
  clearBrowser,
  cookieValue,
  digestOf,
  expectAuthenticatorSetUp,
  expectCodeStep,
  expectHeading,
  finishSetUp,
  fromPage,
  goToSignIn,
  openBootstrapSecret,
  openLink,
  openReenrolmentSecret,
  readSetupKey,
  setCookieLines,
  setPassword,
  signOut,
  submitCode,
  submitPassword,
} from './pages.ts';
import {
  administratorStartsStaffRecovery,
  selfServiceStaffRecovery,
  vendorRecovery,
} from './recovery-journeys.ts';
import { manifestsAndCustody } from './manifest-journeys.ts';
import { riderHandsets, vendorBrowsersAndSessions } from './rider-journeys.ts';
import { introduce, worldOf } from './world.ts';

/**
 * The staff journeys of the Ops Portal (S0.46; demonstration rows 1 to 6, 12, 13 (staff) and 14 of SLICE-000.md section 5.1, and
 * AC-SLICE-000-115; the recovery journeys of rows 10a and 11 are added by S0.52, `recovery-journeys.ts`), walked through the real screens, the real API, a real database and the real delivery worker, from the two
 * bootstrap administrators. **They are one story told in order**, each journey a test, and a failure stops the rest (the specs run them
 * serially): a later journey stands on the people an earlier one made.
 *
 * The same journeys run over plain HTTP in Chromium (`pnpm run test:e2e`, a diagnostic: the cookies are `Secure`, which an engine may
 * or may not honour on a loopback address) and, as the evidence of AC-SLICE-000-127, over the trusted HTTPS origin in Chromium, Firefox
 * and WebKit (`pnpm run test:e2e:https`, CI). Each spec file registers `STAFF_JOURNEYS` and nothing else, so the two cannot drift.
 *
 * Nothing here edits the database by hand. Time passes by the harness's arrangements (a grant, a challenge, a session or a lock is
 * aged in SQL, the way the database tests do it, because the application has no time-travel switch), and the two administrators come
 * from the real `bootstrap:seed`. A journey that passed only with a manual edit would be refused by the demonstration itself.
 */
export interface JourneyContext {
  readonly page: Page;
  readonly context: BrowserContext;
  readonly stack: StackConnection;
  readonly sandbox: Sandbox;
  /** The one origin the browser reaches: the plain Ops origin, or the trusted HTTPS one. */
  readonly origin: string;
}

export interface Journey {
  readonly title: string;
  run(journey: JourneyContext): Promise<void>;
}

/** The grant a captured link carries, from the fragment of its address. */
function grantOf(link: { reveal(): string }): string {
  const token = new URLSearchParams(new URL(link.reveal()).hash.slice(1)).get('token');
  if (token === null || token === '') throw new Error('The captured link carries no grant.');
  return token;
}

/** Row 4 and row 5: the first bootstrap administrator, from the secret in their custody bundle to a signed-in session. */
async function firstAdministrator({ page, context, stack, origin }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const ada = world.person('ada');

  // Nobody is signed in: the real session check says so.
  await page.goto('/sign-in');
  expect((await fromPage(page, 'GET', '/api/v1/auth/session')).status).toBe(401);

  // The bundle is handed over and its file goes (the command's own instruction: delete it after handover).
  const bundle = takeBundle(custodyOf(stack), ada.person.workEmail, 'BOOTSTRAP_SETUP');
  await openBootstrapSecret(page, bundle.secret);
  // GBT-W16: the screen read the secret once from the fragment and replaced the entry, so it is not in the address.
  await expect(page).toHaveURL(/\/setup\/credential$/);
  expect(page.url()).not.toContain('token');
  // Nothing of the grant is kept where script or a later page could read it, and opening the page redeemed nothing.
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  const redeeming = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/v1/auth/staff/setup/credential',
  );
  expect(await setPassword(page, ada.password)).toBe('authenticator');
  // GBT-W16: the request that redeems the grant carries the real `Origin`, no `Referer`, no grant in its address, and the grant in its body.
  const redeem = await redeeming;
  const sent = await redeem.allHeaders();
  expect(sent.origin).toBe(origin);
  expect(sent.referer).toBeUndefined();
  expect(redeem.url()).not.toContain('token');
  expect(redeem.postData() ?? '').toContain('setup_token');
  ada.authenticator = new Authenticator(await readSetupKey(page));

  // Row 5 (AC-SLICE-000-32): the password is set and no code is proven yet. The password step now answers a challenge and no
  // session, sets no cookie, and nothing the person holds is a session.
  const beside = await context.newPage();
  await beside.goto('/sign-in');
  const attempt = await fromPage(beside, 'POST', '/api/v1/auth/staff/sign-in', {
    body: { email: ada.person.workEmail, password: ada.password },
  });
  expect(attempt.status).toBe(202);
  expect(await cookieValue(context, SESSION_COOKIE)).toBeUndefined();
  expect(await cookieValue(context, CSRF_COOKIE)).toBeUndefined();
  expect((await fromPage(beside, 'GET', '/api/v1/auth/session')).status).toBe(401);
  await beside.close();

  await finishSetUp(page, await ada.authenticator.next());
  await expectAuthenticatorSetUp(page);
  expect(
    (await observe(stack.database.name, 'factors', ada.person.workEmail)).map((row) => row.status),
  ).toEqual(['ACTIVE']);

  // Ordinary sign-in thereafter, with the cookies as the server wrote them (AC-SLICE-000-127, the Ops half).
  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await expectHeading(page, 'Sign in');
  const first = await signInWithAuthenticator(page, ada);
  expectNoLifetimeInSetCookies(first.setCookies);
  await expectBrowserSessionCookies(context);

  // The session read returns the permission keys the session holds, and no token and no bundle contents (AC-SLICE-000-83).
  const session = await fromPage(page, 'GET', '/api/v1/auth/session');
  expect(session.status).toBe(200);
  const body = session.body as {
    permissions?: string[];
    principal_display_name?: string;
    principal_id?: string;
  };
  expect(body.principal_display_name).toBe(ada.person.fullName);
  ada.id = body.principal_id;
  expect(body.permissions).toEqual(expect.arrayContaining(['staff.identity.create', 'staff.read']));
  // The names of the fields, at any depth: no token, no bundle or snapshot, no secret or hash. (The values include permission keys, one
  // of which, `permission.assignable_bundle.read`, has "bundle" in its name: it is a permission and not a bundle's contents.)
  expect(
    fieldNamesOf(session.body).filter((name) =>
      /token|bundle|snapshot|secret|hash|csrf/i.test(name),
    ),
  ).toEqual([]);
  expect(Object.keys(body).toSorted()).toEqual([
    'authorized_hub_ids',
    'authorized_hubs',
    'expires_at',
    'id',
    'issued_at',
    'last_activity_at',
    'permissions',
    'principal_display_name',
    'principal_id',
    'principal_type',
    'state',
  ]);
  const firstDigest = digestOf((await cookieValue(context, SESSION_COOKIE)) ?? '');

  // A second sign-in rotates the credential: the session cookie is a different one.
  await signOut(page);
  await signInWithAuthenticator(page, ada);
  const secondDigest = digestOf((await cookieValue(context, SESSION_COOKIE)) ?? '');
  expect(secondDigest).not.toBe(firstDigest);

  await signOut(page);
}

/** Row 4a: a continuation grant lapses before a code is proven; the provisioning command gives a fresh secret; no database edit. */
async function lapsedContinuation({ page, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const bola = world.person('bola');
  const database = stack.database.name;
  const email = bola.person.workEmail;

  const bundle = takeBundle(custodyOf(stack), email, 'BOOTSTRAP_SETUP');
  await openBootstrapSecret(page, bundle.secret);
  expect(await setPassword(page, bola.password)).toBe('authenticator');
  const stale = new Authenticator(await readSetupKey(page));

  // Let the continuation grant (the one that proves a code) lapse, and then prove a code: the grant is dead.
  await arrange(database, 'expire-setup-grant', email, 'MFA_ENROLMENT');
  await finishSetUp(page, await stale.next());
  await expectHeading(page, 'This link cannot be used');

  // The password was set and no factor was proven: the person cannot sign in. The password step says nothing about the factor; the second
  // step refuses (AC-SLICE-000-123), and that attempt counts toward no lock.
  await goToSignIn(page);
  await submitPassword(page, email, bola.password);
  await expectCodeStep(page);
  await submitCode(page, await stale.next());
  await expect(page.getByText(/cannot sign in until your authenticator is set up/i)).toBeVisible();
  expect(await observe(database, 'lock', email)).toEqual([{ failures: 0, locked: false }]);

  // The provisioning command, as an operator runs it. It refuses for the administrator who already holds an active factor.
  await resumeAdministrator(database, custodyOf(stack), email);
  await expect(
    resumeAdministrator(database, custodyOf(stack), world.person('ada').person.workEmail),
  ).rejects.toThrow();

  const fresh = takeBundle(custodyOf(stack), email, 'MFA_REENROLMENT');
  await openReenrolmentSecret(page, fresh.secret);
  await expectHeading(page, 'Set up your authenticator');
  await page.getByRole('button', { name: 'Begin set-up' }).click();
  bola.authenticator = new Authenticator(await readSetupKey(page));
  await finishSetUp(page, await bola.authenticator.next());
  await expectAuthenticatorSetUp(page);

  // The same password signs in: nothing was reset, and no administrator bypassed anything.
  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await signInWithAuthenticator(page, bola);
  await signOut(page);
  expect((await observe(database, 'factors', email)).map((row) => row.status).at(-1)).toBe(
    'ACTIVE',
  );
}

/**
 * Row 1 and AC-SLICE-000-115: an Ops Staff profile created by one administrator, found and approved by the other with the version they
 * read, a setup link that reaches the work email, a password the employee chooses, and a session. The maker supplies no credential.
 */
async function opsStaffSetUpAndSignIn({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const ada = world.person('ada');
  const bola = world.person('bola');
  const kofi = introduce(world, 'kofi.ops', 'Kofi Ops');

  // The maker: Ada signs in and adds a profile, from the New menu of the top bar.
  await signInAs(page, ada);
  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('menuitem', { name: 'Add a staff profile' }).click();
  await expectHeading(page, 'Add a staff profile');

  // AC-SLICE-000-115: the role field offers exactly the roles the operation returns, by name, and none of its own.
  const read = await fromPage(page, 'GET', '/api/v1/staff-role-bundles/assignable');
  expect(read.status).toBe(200);
  const bundles = (
    read.body as {
      items: { id: string; name: string; requires_platform_admin_approval: boolean }[];
    }
  ).items;
  expect(bundles.length).toBeGreaterThan(0);
  for (const bundle of bundles) {
    expect(Object.keys(bundle).toSorted()).toEqual([
      'id',
      'name',
      'requires_platform_admin_approval',
    ]);
  }
  const offered = await offeredRoles(page);
  expect(offered.toSorted()).toEqual(bundles.map((bundle) => bundle.name).toSorted());
  expect(offered.filter((name) => /rider|vendor/i.test(name))).toEqual([]);
  expect(offered).toContain('Ops Staff');

  await createProfile(page, {
    fullName: kofi.person.fullName,
    workEmail: kofi.person.workEmail,
    role: 'Ops Staff',
  });
  await clearBrowser(context);

  // The checker: Bola finds it in the queue and approves it.
  await signInAs(page, bola);
  kofi.id = await approveProfile(page, kofi.person.fullName, kofi.person.workEmail);
  await clearBrowser(context);

  // The worker captured the message to the work email; the link carries a grant in the fragment of a setup address.
  const message = await world.inbox.next({ to: kofi.person.workEmail });
  expect(new URL(message.link.reveal()).pathname).toBe('/setup/credential');
  // A boolean, not the fragment: a failed assertion prints what it was given, and the fragment is the grant.
  expect(/^#token=./.test(new URL(message.link.reveal()).hash), 'the link carries a grant').toBe(
    true,
  );

  // The employee opens the link, chooses their own password and signs in. No second factor: the role needs none.
  await openLink(page, message.link);
  expect(await setPassword(page, kofi.password)).toBe('sign-in');
  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await signInAs(page, kofi);
  // Ops Staff hold neither staff.read nor the approval: the menu has no entry for the staff pages, and the page says what the account cannot do, in plain words and not by the key.
  await expect(page.getByRole('link', { name: 'Staff', exact: true })).toHaveCount(0);
  await page.goto('/admin/staff');
  await expect(
    page.getByText('Your account can’t see staff profiles. Ask an administrator for access.'),
  ).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('staff.read');
  await signOut(page);
}

/**
 * Rows 2 and 3, and AC-SLICE-000-85 and -118: a privileged profile is set up with an authenticator and signs in through two steps; one
 * that never proves a factor reaches the second step and is stopped there, and that attempt counts toward no lock. A Platform Admin
 * approves a profile they made; the other administrator approves the second.
 */
async function privilegedSetUp({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const ada = world.person('ada');
  const bola = world.person('bola');
  const sena = introduce(world, 'sena.senior', 'Sena Senior');
  const yaw = introduce(world, 'yaw.unenrolled', 'Yaw Unenrolled');
  const database = stack.database.name;

  await signInAs(page, ada);
  for (const person of [sena, yaw]) {
    await createProfile(page, {
      fullName: person.person.fullName,
      workEmail: person.person.workEmail,
      role: 'Senior Ops',
    });
  }
  // A Platform Admin approves a profile they made (the Product Owner's decision of 25 October 2026): Ada approves Yaw herself.
  yaw.id = await approveProfile(page, yaw.person.fullName, yaw.person.workEmail);
  await clearBrowser(context);

  // The other administrator approves the second.
  await signInAs(page, bola);
  sena.id = await approveProfile(page, sena.person.fullName, sena.person.workEmail);
  await clearBrowser(context);

  // Row 2: Sena sets a password, and then, with no session yet, enrols and proves an authenticator.
  const senaMessage = await world.inbox.next({ to: sena.person.workEmail });
  await openLink(page, senaMessage.link);
  expect(await setPassword(page, sena.password)).toBe('authenticator');
  expect((await fromPage(page, 'GET', '/api/v1/auth/session')).status).toBe(401);
  await enrolAuthenticator(page, sena);
  await page.getByRole('link', { name: 'Go to sign-in' }).click();
  await signInAs(page, sena);
  // The session is privileged: 480 minutes absolute (SECURITY_DESIGN.md §13.3).
  const session = (await fromPage(page, 'GET', '/api/v1/auth/session')).body as {
    issued_at: string;
    expires_at: string;
  };
  expect(Date.parse(session.expires_at) - Date.parse(session.issued_at)).toBe(480 * 60_000);
  await signOut(page);

  // Row 3: Yaw sets a password and never proves a factor.
  const yawMessage = await world.inbox.next({ to: yaw.person.workEmail });
  await openLink(page, yawMessage.link);
  expect(await setPassword(page, yaw.password)).toBe('authenticator');

  // The password step answers the same `202` and the same shape, whether or not a factor exists (it says nothing of the factor).
  await goToSignIn(page);
  const enrolled = await fromPage(page, 'POST', '/api/v1/auth/staff/sign-in', {
    body: { email: sena.person.workEmail, password: sena.password },
  });
  const unenrolled = await fromPage(page, 'POST', '/api/v1/auth/staff/sign-in', {
    body: { email: yaw.person.workEmail, password: yaw.password },
  });
  expect([enrolled.status, unenrolled.status]).toEqual([202, 202]);
  expect(Object.keys(unenrolled.body as object).toSorted()).toEqual(
    Object.keys(enrolled.body as object).toSorted(),
  );
  expect(await cookieValue(context, SESSION_COOKIE)).toBeUndefined();

  // At the second step the one without a factor is stopped, with no session and no cookie.
  await submitPassword(page, yaw.person.workEmail, yaw.password);
  await expectCodeStep(page);
  await submitCode(page, '123456');
  await expect(page.getByText(/cannot sign in until your authenticator is set up/i)).toBeVisible();
  expect(await cookieValue(context, SESSION_COOKIE)).toBeUndefined();
  // ... and that attempt is not a wrong code: it counts toward no lock.
  expect(await observe(database, 'lock', yaw.person.workEmail)).toEqual([
    { failures: 0, locked: false },
  ]);
}

/**
 * Row 6: another Platform Admin resets an authenticator (a self-reset is refused), the person's sessions end, they enrol a new one from
 * the link that reaches them alone, a wrong code leaves it unproven, and only the new authenticator signs them in.
 */
async function resetAuthenticator({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const ada = world.person('ada');
  const bola = world.person('bola');
  const sena = world.person('sena.senior');
  const database = stack.database.name;

  // Sena has a live session on an old browser: its cookies are kept for later.
  await signInAs(page, sena);
  const oldBrowser = await context.cookies();
  await clearBrowser(context);

  // A Platform Admin cannot reset their own authenticator: the screen says so, and the server refuses.
  await signInAs(page, ada);
  const own = (await fromPage(page, 'GET', '/api/v1/auth/session')).body as {
    principal_id: string;
  };
  await page.goto(`/admin/staff/${own.principal_id}/mfa/reset`);
  await expect(page.getByText('You cannot reset your own authenticator.')).toBeVisible();
  const reason = await reasonCodeFor(page, 'resetStaffMfa', 'FACTOR_ACTIVE');
  const record = await fromPage(page, 'GET', `/api/v1/staff-identities/${own.principal_id}`);
  expect(record.etag).not.toBeNull();
  const refused = await fromPage(page, 'POST', `/api/v1/ops/staff/${own.principal_id}/mfa/reset`, {
    body: { reason_code: reason },
    headers: { 'if-match': record.etag ?? '' },
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect((refused.body as { code?: string }).code).toBe('SELF_APPROVAL_FORBIDDEN');
  await clearBrowser(context);

  // The other administrator resets Sena's authenticator, with a reason from the catalogue.
  await signInAs(page, bola);
  await openProfile(page, sena.person.fullName);
  await page.getByRole('link', { name: 'Reset authenticator' }).click();
  await page.getByRole('button', { name: 'Reset authenticator' }).click();
  await giveReasonAndConfirm(page, 'Reset authenticator');
  await expect(page.getByRole('heading', { level: 2, name: 'Authenticator reset' })).toBeVisible();
  // The acting administrator is not shown the link.
  await expect(page.getByText(/#token=|\/setup\/mfa/)).toHaveCount(0);
  await clearBrowser(context);

  // Sena's session on the old browser ended with the reset.
  await page.goto('/sign-in');
  await context.addCookies(oldBrowser);
  const ended = await fromPage(page, 'GET', '/api/v1/auth/session');
  expect(ended.status).toBe(401);
  expect((ended.body as { code?: string }).code).toBe('SESSION_INVALID');
  await clearBrowser(context);

  // The link reaches Sena alone. She begins the set-up, gives a wrong code, and the authenticator stays unproven.
  const message = await world.inbox.next({ to: sena.person.workEmail });
  expect(new URL(message.link.reveal()).pathname).toBe('/setup/mfa');
  await openLink(page, message.link);
  await expectHeading(page, 'Set up your authenticator');
  await page.getByRole('button', { name: 'Begin set-up' }).click();
  const replacement = new Authenticator(await readSetupKey(page));
  await finishSetUp(page, replacement.wrong());
  await expect(page.getByText(/Your authenticator is not set up yet/)).toBeVisible();
  expect(
    (await observe(database, 'factors', sena.person.workEmail)).map((row) => row.status).at(-1),
  ).toBe('PENDING');

  // A proven code makes it the factor.
  await finishSetUp(page, await replacement.next());
  await expectAuthenticatorSetUp(page);
  expect(
    (await observe(database, 'factors', sena.person.workEmail)).map((row) => row.status),
  ).toEqual(['REVOKED', 'ACTIVE']);
  const previous = sena.authenticator;
  sena.authenticator = replacement;

  // Only the new authenticator signs her in: a code from the old one is not accepted.
  await goToSignIn(page);
  await submitPassword(page, sena.person.workEmail, sena.password);
  await expectCodeStep(page);
  await submitCode(page, (await previous?.next()) ?? '000000');
  await expect(page.getByText('That code was not accepted.')).toBeVisible();
  await signInAs(page, sena);
  await signOut(page);
}

/**
 * Row 12: a setup grant lapses unused; the approver re-issues it with a reason; the earlier grant is dead; two completions of one grant
 * have one winner; an identity that already holds a credential is refused and pointed at recovery; a bootstrap identity is refused.
 */
async function lapsedGrantIsReissued({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const ada = world.person('ada');
  const bola = world.person('bola');
  const esi = introduce(world, 'esi.lapsed', 'Esi Lapsed');
  const database = stack.database.name;

  await signInAs(page, ada);
  await createProfile(page, {
    fullName: esi.person.fullName,
    workEmail: esi.person.workEmail,
    role: 'Ops Staff',
  });
  await clearBrowser(context);

  await signInAs(page, bola);
  esi.id = await approveProfile(page, esi.person.fullName, esi.person.workEmail);
  const first = await world.inbox.next({ to: esi.person.workEmail });

  // The grant lapses unused. The employee, at another page, opens the link and is told it cannot be used.
  await arrange(database, 'expire-setup-grant', esi.person.workEmail, 'STAFF_CREDENTIAL_SETUP');
  const employee = await context.newPage();
  await openLink(employee, first.link);
  await employee.getByLabel('New password').fill(esi.password);
  await employee.getByRole('button', { name: 'Set password' }).click();
  await expectHeading(employee, 'This link cannot be used');

  // The approver re-issues it, with a reason.
  await openProfile(page, esi.person.fullName);
  await page.getByRole('button', { name: 'Send a new setup link' }).click();
  await giveReasonAndConfirm(page, 'Send new link');
  await expect(page.getByText(/A new setup link is on its way to/)).toBeVisible();
  const second = await world.inbox.next({ to: esi.person.workEmail });
  // Digests, not the grants: a failed assertion prints what it was given.
  expect(digestOf(grantOf(second.link))).not.toBe(digestOf(grantOf(first.link)));

  // The earlier grant is dead. (The page is taken away first: a link that differs from the address only by its fragment is no new page.)
  await employee.goto('/sign-in');
  await openLink(employee, first.link);
  await employee.getByLabel('New password').fill(esi.password);
  await employee.getByRole('button', { name: 'Set password' }).click();
  await expectHeading(employee, 'This link cannot be used');

  // Two completions of the new grant, together: one winner.
  await employee.goto('/sign-in');
  const passwords = [`${esi.password} first`, `${esi.password} second`];
  const raced = await employee.evaluate(
    async ({ token, passwords }) =>
      Promise.all(
        passwords.map(async (password) => {
          const response = await fetch('/api/v1/auth/staff/setup/credential', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ setup_token: token, password }),
          });
          return {
            status: response.status,
            body: (await response.json().catch(() => null)) as unknown,
          };
        }),
      ),
    { token: grantOf(second.link), passwords },
  );
  const winner = raced.findIndex((each) => each.status < 300);
  const losers = raced.filter((each) => each.status >= 400);
  expect(raced.filter((each) => each.status < 300)).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect((losers[0]?.body as { code?: string }).code).toBe('SETUP_GRANT_INVALID');
  esi.password = passwords[winner] ?? esi.password;
  await employee.close();

  // An identity that already holds a credential is refused when the approver asks again, and the refusal is explained.
  await openProfile(page, esi.person.fullName);
  await page.getByRole('button', { name: 'Send a new setup link' }).click();
  await giveReasonAndConfirm(page, 'Send new link');
  await expect(page.locator('dialog[open]').getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');

  // A bootstrap identity is refused too: the screen offers no new link for it, and the server refuses it.
  const adaId = await openProfile(page, ada.person.fullName);
  await expect(page.getByRole('button', { name: 'Send a new setup link' })).toHaveCount(0);
  const reason = await reasonCodeFor(page, 'reissueStaffCredentialSetup');
  const record = await fromPage(page, 'GET', `/api/v1/staff-identities/${adaId}`);
  const refused = await fromPage(
    page,
    'POST',
    `/api/v1/ops/staff/${adaId}/credential/setup/reissue`,
    {
      body: { reason_code: reason },
      headers: { 'if-match': record.etag ?? '' },
    },
  );
  expect(refused.status).toBe(409);
  expect((refused.body as { code?: string }).code).toBe('STATE_CONFLICT');
  await clearBrowser(context);

  // The winner signs in with their own password.
  await signInAs(page, esi);
  await signOut(page);
}

/** Row 13: five wrong passwords lock a credential and nobody is told; a lock reached at the second factor is announced to someone who proved the password. */
async function lockout({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const kofi = world.person('kofi.ops');
  const sena = world.person('sena.senior');
  const database = stack.database.name;
  const NOT_CORRECT = 'The email or password is not correct.';

  // Five wrong passwords: every one is the same sentence, and so is the sixth, with the right password: nobody is told of the lock.
  await goToSignIn(page);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await submitPassword(page, kofi.person.workEmail, `${kofi.password} wrong ${String(attempt)}`);
    await expect(page.getByText(NOT_CORRECT)).toBeVisible();
  }
  expect(await observe(database, 'lock', kofi.person.workEmail)).toEqual([
    { failures: 5, locked: true },
  ]);
  await submitPassword(page, kofi.person.workEmail, kofi.password);
  await expect(page.getByText(NOT_CORRECT)).toBeVisible();
  await expect(page.getByText(/locked/i)).toHaveCount(0);
  expect(await cookieValue(context, SESSION_COOKIE)).toBeUndefined();

  // The lock ends on its own, and a complete sign-in resets the count.
  await arrange(database, 'lapse-lock', kofi.person.workEmail);
  await signInAs(page, kofi);
  expect(await observe(database, 'lock', kofi.person.workEmail)).toEqual([
    { failures: 0, locked: false },
  ]);
  await signOut(page);

  // At the second factor the lock is announced, because the person has proved the password: four wrong passwords, then the right one, then
  // wrong codes. The fifth failure locks the credential; the next code attempt is told so.
  await goToSignIn(page);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await submitPassword(page, sena.person.workEmail, `${sena.password} wrong ${String(attempt)}`);
    await expect(page.getByText(NOT_CORRECT)).toBeVisible();
  }
  await submitPassword(page, sena.person.workEmail, sena.password);
  await expectCodeStep(page);
  const announced = page.getByText(/locked for fifteen minutes/i);
  for (let attempt = 1; attempt <= 3 && !(await announced.isVisible()); attempt += 1) {
    await submitCode(page, sena.authenticator?.wrong() ?? '000000');
    await expect(page.getByText('That code was not accepted.').or(announced)).toBeVisible();
  }
  await expect(announced).toBeVisible();
  expect(await observe(database, 'lock', sena.person.workEmail)).toEqual([
    { failures: 5, locked: true },
  ]);
  expect(await cookieValue(context, SESSION_COOKIE)).toBeUndefined();

  // The lock ends and Sena signs in again, with her own authenticator.
  await arrange(database, 'lapse-lock', sena.person.workEmail);
  await signInAs(page, sena);
  await signOut(page);
}

/**
 * Row 14, AC-SLICE-000-35 and AC-SLICE-000-127: signing out ends the session and expires the cookies; the next request and a second
 * sign-out on the same credential are `401`; a session that has been idle for too long is ended by the next request; an administrator
 * ends another person's session and the next request of the person is `401`.
 */
async function endOfSessions({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const bola = world.person('bola');
  const kofi = world.person('kofi.ops');
  const database = stack.database.name;
  const email = kofi.person.workEmail;
  const sessionsOf = async () =>
    observe<{ live: boolean; reason: string | null }>(database, 'sessions', email);

  // Sign out through the control every signed-in screen carries: the account menu of the top bar.
  await signInAs(page, kofi);
  const saved = await context.cookies();
  const ending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/auth/session' &&
      response.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  const answer = await ending;
  expect(answer.status()).toBe(204);
  await expect(page).toHaveURL(/\/sign-in$/);
  // The cookies are expired with a literal Max-Age=0, and the browser holds neither.
  const lines = await setCookieLines(answer);
  for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
    const line = lines.find((each) => each.startsWith(`${name}=`)) ?? '';
    expect(/;\s*max-age=0(;|$)/i.test(line), `${name} is expired with Max-Age=0`).toBe(true);
  }
  expect(await cookieValue(context, SESSION_COOKIE)).toBeUndefined();
  expect(await cookieValue(context, CSRF_COOKIE)).toBeUndefined();
  expect((await sessionsOf()).at(-1)).toEqual({ live: false, reason: 'SIGNED_OUT' });

  // The credential that was kept is dead: the next request is refused, and so is a second sign-out.
  await context.addCookies(saved);
  const next = await fromPage(page, 'GET', '/api/v1/auth/session');
  expect(next.status).toBe(401);
  expect((next.body as { code?: string }).code).toBe('SESSION_INVALID');
  const again = await fromPage(page, 'DELETE', '/api/v1/auth/session');
  expect(again.status).toBe(401);
  await clearBrowser(context);

  // An unsafe request without the synchronizer token is refused (AC-SLICE-000-84) while the session is live.
  await signInAs(page, kofi);
  const noToken = await fromPage(page, 'DELETE', '/api/v1/auth/session', {
    headers: { 'x-csrf-token': 'not-the-token' },
  });
  expect(noToken.status).toBe(403);
  expect((noToken.body as { code?: string }).code).toBe('CSRF_VALIDATION_FAILED');
  expect((await fromPage(page, 'GET', '/api/v1/auth/session')).status).toBe(200);

  // A session idle for longer than the standard thirty minutes is ended by the next request that finds it so (AC-SLICE-000-35).
  await arrange(database, 'idle-session', email, '31');
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
  // (The aged session now looks the oldest, so it is found among them and not at the end.)
  expect(await sessionsOf()).toContainEqual({ live: false, reason: 'EXPIRED' });
  await clearBrowser(context);

  // An administrator ends another person's session, and the person's next request is refused.
  await signInAs(page, kofi);
  const kofiBrowser = await context.cookies();
  await clearBrowser(context);
  await signInAs(page, bola);
  await page.goto(`/admin/sessions?principal_type=STAFF&principal_id=${kofi.id ?? ''}`);
  await expectHeading(page, 'Sessions');
  await page
    .getByRole('button', { name: /^End session started/ })
    .first()
    .click();
  await giveReasonAndConfirm(page, 'End session');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await clearBrowser(context);
  await page.goto('/sign-in');
  await context.addCookies(kofiBrowser);
  const revoked = await fromPage(page, 'GET', '/api/v1/auth/session');
  expect(revoked.status).toBe(401);
  expect((await sessionsOf()).at(-1)?.live).toBe(false);
  await clearBrowser(context);

  // The landing a signed-out person is taken to asks for nothing.
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in$/);
}

/**
 * The trusted browser (the Product Owner's instruction of 25 October 2026; staff-authentication.md section 5.8; AC-SLICE-000-133 to -139):
 * a Platform Admin remembers a browser at the second step and is let in by the password alone for seven days; the cookie is the one
 * persistent cookie of the sign-in and cannot be read by script; the password is still asked and a wrong one is the one refusal; the
 * person removes the browser from the screen and it asks for a code again; seven days over end it; and a Platform Admin removes the
 * browsers of another person with a reason. Three codes are presented in all, and each is a fresh step of the authenticator.
 */
async function rememberThisBrowser({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  // A Platform Admin who has not just been signed in a dozen times by the lockout journey: the staff sign-in is limited to ten a minute for an
  // address (AC-SLICE-000-81), which is the real limit and not one the journey may step around.
  const ada = world.person('ada');
  const bola = world.person('bola');
  const database = stack.database.name;
  const email = ada.person.workEmail;
  const browsers = () =>
    observe<{ valid: boolean; used: boolean; cause: string | null }>(
      database,
      'trusted-browsers',
      email,
    );
  const lineOf = (lines: readonly string[]) =>
    lines.find((line) => line.startsWith(`${TRUSTED_COOKIE}=`)) ?? '';
  await clearBrowser(context);

  // The choice is offered off, ticked, and the code that issues the session also issues the trusted browser.
  const remembered = await signInRemembering(page, ada);
  const trustedLine = lineOf(remembered.setCookies);
  expect(trustedLine, 'the answer set the trusted-browser cookie').not.toBe('');
  expect(/;\s*max-age=604800(;|$)/i.test(trustedLine), 'seven days, to the second').toBe(true);
  expect(/;\s*httponly/i.test(trustedLine)).toBe(true);
  expect(/;\s*secure/i.test(trustedLine)).toBe(true);
  expect(/;\s*samesite=lax/i.test(trustedLine)).toBe(true);
  expect(new RegExp(`;\\s*path=${TRUSTED_PATH}(;|$)`, 'i').test(trustedLine)).toBe(true);
  expect(/;\s*domain=/i.test(trustedLine), 'host-only').toBe(false);
  // The session cookies keep no lifetime of their own: the trusted one is the only persistent cookie of the sign-in.
  expectNoLifetimeInSetCookies(remembered.setCookies.filter((line) => line !== trustedLine));
  await expectBrowserSessionCookies(context);
  const stored = (await context.cookies()).find((cookie) => cookie.name === TRUSTED_COOKIE);
  expect(stored).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: TRUSTED_PATH,
  });
  const lasts = (stored?.expires ?? 0) - Date.now() / 1000;
  expect(lasts).toBeGreaterThan(6.9 * 24 * 3600);
  expect(lasts).toBeLessThan(7.1 * 24 * 3600);
  // Script cannot read it, and the page keeps nothing of it.
  expect(await page.evaluate((name) => document.cookie.includes(name), TRUSTED_COOKIE)).toBe(false);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(await browsers()).toEqual([{ valid: true, used: false, cause: null }]);
  const credential = digestOf(stored?.value ?? '');

  // Signing out does not remove it: that is the point of it.
  await signOut(page);
  expect(await cookieValue(context, TRUSTED_COOKIE)).toBeDefined();

  // The password alone now signs the person in, with the session a proven code issues, and nothing is renewed.
  const quick = await signInOnRememberedBrowser(page, ada);
  expect(quick.askedForCode, 'no second step was asked').toBe(false);
  expect(quick.sentCredential, 'the browser sent the credential to the sign-in').toBe(true);
  expect(lineOf(quick.setCookies), 'the cookie is not set again').toBe('');
  expectNoLifetimeInSetCookies(quick.setCookies);
  await expectBrowserSessionCookies(context);
  const session = (await fromPage(page, 'GET', '/api/v1/auth/session')).body as {
    issued_at: string;
    expires_at: string;
  };
  expect(Date.parse(session.expires_at) - Date.parse(session.issued_at)).toBe(480 * 60_000);
  expect(await browsers()).toEqual([{ valid: true, used: true, cause: null }]);
  const after = (await context.cookies()).find((cookie) => cookie.name === TRUSTED_COOKIE);
  expect(digestOf(after?.value ?? '')).toBe(credential);
  expect(after?.expires, 'using it does not move its end').toBe(stored?.expires);
  const codes = await observe<{ code: string }>(database, 'audit-codes', email);
  expect(codes.map((row) => row.code)).toContain('auth.trusted_browser.issued');

  // AC-SLICE-000-139: the cookie goes to the staff sign-in routes and never to a business operation (Path=/api/v1/auth/staff).
  const business = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/v1/auth/session',
  );
  await fromPage(page, 'GET', '/api/v1/auth/session');
  const sentToBusiness = (await (await business).allHeaders()).cookie ?? '';
  expect(sentToBusiness.includes(`${SESSION_COOKIE}=`), 'the session went with the request').toBe(
    true,
  );
  expect(
    sentToBusiness.includes(`${TRUSTED_COOKIE}=`),
    'the credential is not sent to a business operation',
  ).toBe(false);

  // The person sees it, marked as the browser in use, and nothing that could be used to sign in.
  await page.goto('/account/trusted-browsers');
  await expectHeading(page, 'Trusted browsers');
  const table = page.getByRole('table', { name: 'Your trusted browsers' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('This browser');
  // A boolean, not the page: a failed assertion prints what it was given, and the page would be the credential's whole text.
  expect(
    (await page.locator('body').innerText()).includes(stored?.value ?? 'unreachable'),
    'the page shows no credential',
  ).toBe(false);
  await signOut(page);

  // The password is still asked: a wrong one is the one refusal, whatever the cookie, and it signs nobody in.
  await submitPassword(page, email, 'not the password at all');
  await expect(page.getByText('The email or password is not correct.')).toBeVisible();
  expect(await cookieValue(context, SESSION_COOKIE)).toBeUndefined();

  // The person removes the browser from the screen, and the browser asks for a code again.
  await signInOnRememberedBrowser(page, ada);
  await page.goto('/account/trusted-browsers');
  await expectHeading(page, 'Trusted browsers');
  await page.getByRole('button', { name: /^Remove .*\(this browser\)$/ }).click();
  await giveConfirmation(page, 'Remove browser');
  await expect(
    page.getByText('The browser is removed. It will ask for a code at its next sign-in.'),
  ).toBeVisible();
  expect(await browsers()).toEqual([{ valid: false, used: true, cause: 'SELF' }]);
  // The answer cleared the cookie in the browser that asked.
  await expect.poll(() => cookieValue(context, TRUSTED_COOKIE)).toBeUndefined();
  await signOut(page);
  await submitPassword(page, email, ada.password);
  await expectCodeStep(page);

  // Seven days over end it: the browser is remembered again, a week and a day pass on the database's clock, and the code is asked.
  await clearBrowser(context);
  await signInRemembering(page, ada);
  await signOut(page);
  expect(await arrange(database, 'age-trusted-browsers', email, '8')).toBe(1);
  await submitPassword(page, email, ada.password);
  await expectCodeStep(page);
  // Back-dated, the remembered browser is now the oldest of the two, still unused and no longer valid; the one the person removed is the other.
  expect(await browsers()).toEqual([
    { valid: false, used: false, cause: null },
    { valid: false, used: true, cause: 'SELF' },
  ]);

  // A Platform Admin removes the browsers of another person, with a reason, and that person's browser asks for a code again.
  await clearBrowser(context);
  await signInRemembering(page, ada);
  await signOut(page);
  const adaBrowser = await context.cookies();
  expect(adaBrowser.map((cookie) => cookie.name)).toEqual([TRUSTED_COOKIE]);
  await clearBrowser(context);
  await signInAs(page, bola);
  await openProfile(page, ada.person.fullName);
  const section = page.getByRole('region', { name: 'Trusted browsers' });
  // A table where the main column of the record has room for one (40rem of its box), and cards, a list of the same name, under that (the profile has a side column): the browsers are listed in either.
  await expect(
    section.getByRole('table').or(section.getByRole('list', { name: /^Trusted browsers of / })),
  ).toBeVisible();
  expect(
    (await page.locator('body').innerText()).includes(adaBrowser[0]?.value ?? 'unreachable'),
    "the profile shows no credential of the person's",
  ).toBe(false);
  await section.getByRole('button', { name: 'Remove all trusted browsers' }).click();
  await giveReasonAndConfirm(page, 'Remove trusted browsers');
  await expect(page.getByText('1 trusted browser removed.')).toBeVisible();
  expect((await browsers()).at(-1)).toEqual({ valid: false, used: false, cause: 'ADMINISTRATOR' });
  const events = await observe<{ code: string; outcome: string }>(database, 'audit-codes', email);
  expect(events.map((row) => row.code)).toContain('auth.trusted_browser.admin_revoked');
  await clearBrowser(context);

  await page.goto('/sign-in');
  await context.addCookies(adaBrowser);
  await submitPassword(page, email, ada.password);
  await expectCodeStep(page);
  await clearBrowser(context);
}

export const STAFF_JOURNEYS: readonly Journey[] = [
  {
    title:
      'row 4 and 5: the first bootstrap administrator sets a password and an authenticator from the secret in their bundle, and has no session before the code is proven',
    run: firstAdministrator,
  },
  {
    title:
      'row 4a: a continuation that lapsed is recovered by the provisioning command, with no database edit, no password reset and no bypass',
    run: lapsedContinuation,
  },
  {
    title:
      'row 1 and AC-115: an Ops Staff profile is created by one administrator, approved by the other, set up from the link the worker captured, and signed in',
    run: opsStaffSetUpAndSignIn,
  },
  {
    title:
      'rows 2 and 3: a privileged profile signs in through two steps, and one that never proved a factor is stopped at the second step and counted toward no lock',
    run: privilegedSetUp,
  },
  {
    title:
      'row 6: another Platform Admin resets an authenticator, the sessions end, a wrong code leaves the new one unproven, and only the new one signs in',
    run: resetAuthenticator,
  },
  {
    title:
      'row 12: a lapsed grant is re-issued with a reason, the earlier one is dead, two completions have one winner, and a credentialed or bootstrap identity is refused',
    run: lapsedGrantIsReissued,
  },
  {
    title:
      'row 13: five wrong passwords lock a credential and nobody is told, and a lock reached at the second factor is announced to someone who proved the password',
    run: lockout,
  },
  {
    title:
      'row 14, AC-35 and AC-127: signing out, an idle session and an administrator ending a session each end it, and the cookies are expired',
    run: endOfSessions,
  },
  {
    title:
      'AC-133 to AC-139: a Platform Admin remembers a browser and signs in with the password alone, removes it, lets seven days end it, and an administrator removes it with a reason',
    run: rememberThisBrowser,
  },
  {
    title:
      'row 11 (staff) and AC-105: a Platform Admin starts a staff recovery with a reason and the version read, the person sets a new password, and every session ends',
    run: administratorStartsStaffRecovery,
  },
  {
    title:
      'AC-20, -21 and -36: the recovery page answers a real and an unknown address alike, and the new password still asks for the same authenticator',
    run: selfServiceStaffRecovery,
  },
  {
    title:
      'rows 10a and 11 (vendor), AC-15, -22 and -23: a vendor recovers its secret itself and from a Platform Admin, its browsers rotate, and its sessions end',
    run: vendorRecovery,
  },
  {
    title:
      'rows 8, 7, 9, 11 (rider) and 13 (rider): a rider’s handset is registered by a QR it reads, signs in, signs in again, is replaced in person, and five wrong PINs lock it',
    run: riderHandsets,
  },
  {
    title:
      'rows 10b, 15 and 13 (vendor): an unregistered browser is refused as a wrong secret, the vendor manages its browsers, a Platform Admin ends its session, and a lock is told',
    run: vendorBrowsersAndSessions,
  },
  {
    title:
      'S1.25: Ops builds a manifest from the pool, assigns a rider and dispatches, the rider starts the run, custody is handed to a rider and to the hub, and a stale act is refused',
    run: manifestsAndCustody,
  },
];
