import { expect } from '@playwright/test';

import { VENDOR_ORIGIN } from '../api-environment.ts';
import { addVendorFixture, arrange, observe } from '../database.ts';
import {
  approveProfile,
  createProfile,
  enrolAuthenticator,
  giveReasonAndConfirm,
  openProfile,
  reasonCodeFor,
  signInAs,
} from './actions.ts';
import {
  clearBrowser,
  expectCodeStep,
  expectHeading,
  expectLanding,
  fromPage,
  goToSignIn,
  openLink,
  setPassword,
  signOut,
  submitCode,
  submitPassword,
} from './pages.ts';
import type { JourneyContext } from './staff-journeys.ts';
import { VendorBrowser } from './vendor-browser.ts';
import { introduce, worldOf } from './world.ts';

/**
 * The recovery journeys (S0.52; demonstration rows 10a and 11 of SLICE-000.md section 5.1, and AC-SLICE-000-15, -22, -23, -36, -105): the
 * staff halves through the real Ops screens, the vendor halves through a vendor's client of the real API (`vendor-browser.ts`: the Vendor PWA
 * does not exist), all against the real database and the real delivery worker, whose captured messages are the only way a link is had. They
 * stand on the people the staff journeys made (`kofi.ops`, `sena.senior` and the two administrators), so they run after them, in the same list.
 *
 * The rider third of row 11 (Senior Ops re-registers a rider's device) belongs to the rider tasks and is not here.
 */
const RECOVERY_REASON = 'CREDENTIAL_RECOVERY_ASSISTANCE';
const FIXTURE_EMAIL = 'vendor-recovery@melarc.invalid';
const FIXTURE_NAME = 'Melarc Demonstration Vendor (fixture)';
/** The hub of the reference seed that the vendor fixture's organisation answers to (`HUBS[0]`). */
const FIXTURE_HUB = 'Accra';

/** The token a captured link carries, from the fragment of its address. */
function tokenOf(link: { reveal(): string }): string {
  const token = new URLSearchParams(new URL(link.reveal()).hash.slice(1)).get('token');
  if (token === null || token === '') throw new Error('The captured link carries no token.');
  return token;
}

/** The recovery completion screen: sets the new password from the link that is open. */
async function setNewPassword(page: JourneyContext['page'], password: string): Promise<void> {
  await expectHeading(page, 'Set a new password');
  await page.getByLabel('New password').fill(password);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expectHeading(page, 'Your password is changed');
}

/**
 * Row 11 (staff) and AC-SLICE-000-105: a Platform Admin starts a staff member's recovery with a reason and the version the page read; the link
 * reaches the work email alone; the person sets the new password; every session they held ends; a Senior Ops session holds no such key.
 */
export async function administratorStartsStaffRecovery({
  page,
  context,
  stack,
}: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const bola = world.person('bola');
  const kofi = world.person('kofi.ops');
  const sena = world.person('sena.senior');

  // Kofi is signed in on a browser of his own: its cookies are kept for later.
  await signInAs(page, kofi);
  const kofiBrowser = await context.cookies();
  await clearBrowser(context);

  // Senior Ops does not hold staff.credential.recover: the profile offers no recovery, and the server refuses it.
  await signInAs(page, sena);
  const kofiId = await openProfile(page, kofi.person.fullName);
  await expect(page.getByRole('button', { name: 'Start password recovery' })).toHaveCount(0);
  const read = await fromPage(page, 'GET', `/api/v1/staff-identities/${kofiId}`);
  const refused = await fromPage(page, 'POST', `/api/v1/ops/staff/${kofiId}/credential/recover`, {
    body: { reason_code: RECOVERY_REASON },
    headers: { 'if-match': read.etag ?? '' },
  });
  expect([refused.status, (refused.body as { code?: string }).code]).toEqual([
    403,
    'PERMISSION_DENIED',
  ]);
  await clearBrowser(context);

  // The Platform Admin starts it from the profile, with a reason.
  await signInAs(page, bola);
  await openProfile(page, kofi.person.fullName);
  await page.getByRole('button', { name: 'Start password recovery' }).click();
  await giveReasonAndConfirm(page, 'Send recovery link');
  await expect(page.getByText(/A recovery link is on its way to/)).toBeVisible();
  // The acting administrator is not shown the link.
  await expect(page.getByText(/#token=|\/recovery\/complete/)).toHaveCount(0);
  await clearBrowser(context);

  // The link reaches Kofi's work email alone, on the Ops Portal; he sets a new password.
  const message = await world.inbox.next({ to: kofi.person.workEmail });
  expect(new URL(message.link.reveal()).pathname).toBe('/recovery/complete');
  const newPassword = `${kofi.password} recovered`;
  await openLink(page, message.link);
  await setNewPassword(page, newPassword);

  // The session on his other browser ended with the change (AC-SLICE-000-22's staff half).
  await page.goto('/sign-in');
  await context.addCookies(kofiBrowser);
  const ended = await fromPage(page, 'GET', '/api/v1/auth/session');
  expect([ended.status, (ended.body as { code?: string }).code]).toEqual([401, 'SESSION_INVALID']);
  await clearBrowser(context);

  // The old password is refused like any other, and the new one signs him in.
  await goToSignIn(page);
  await submitPassword(page, kofi.person.workEmail, kofi.password);
  await expect(page.getByText('The email or password is not correct.')).toBeVisible();
  kofi.password = newPassword;
  await signInAs(page, kofi);
  await signOut(page);
}

/**
 * Self-service staff recovery and AC-SLICE-000-36: `/recovery` answers a real and an unknown address alike, the link reaches the real one alone,
 * and a privileged person's authenticator is untouched: the new password still asks for the code.
 */
export async function selfServiceStaffRecovery({
  page,
  context,
  stack,
}: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const sena = world.person('sena.senior');
  const database = stack.database.name;
  const factorsBefore = await observe(database, 'factors', sena.person.workEmail);

  await goToSignIn(page);
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expectHeading(page, 'Recover your password');
  await page.getByLabel('Work email').fill(sena.person.workEmail);
  await page.getByRole('button', { name: 'Send recovery link' }).click();
  await expectHeading(page, 'Check your email');
  const known = await page.getByRole('main').innerText();

  // An address that belongs to nobody gets the same page, word for word.
  await page.goto('/recovery');
  await page.getByLabel('Work email').fill('nobody.at.all@melarc.example');
  await page.getByRole('button', { name: 'Send recovery link' }).click();
  await expectHeading(page, 'Check your email');
  expect(await page.getByRole('main').innerText()).toBe(known);

  const message = await world.inbox.next({ to: sena.person.workEmail });
  const newPassword = `${sena.password} recovered`;
  await openLink(page, message.link);
  await setNewPassword(page, newPassword);
  await clearBrowser(context);

  // The authenticator is the same one, and the next sign-in still asks for its code.
  expect(await observe(database, 'factors', sena.person.workEmail)).toEqual(factorsBefore);
  sena.password = newPassword;
  await goToSignIn(page);
  await submitPassword(page, sena.person.workEmail, newPassword);
  await expectCodeStep(page);
  await submitCode(page, (await sena.authenticator?.next()) ?? '000000');
  await expectLanding(page, sena.person.fullName);
  await signOut(page);
}

/**
 * Rows 10a and 11 (vendor) and AC-SLICE-000-15, -17, -22, -23: the demonstration vendor is set up from the link a Senior Ops of its hub sends
 * from the Ops screens (a profile the two administrators make for the purpose, since the re-issue is a hub's act and neither of them has a
 * hub); the vendor recovers its secret itself, and then a Platform Admin starts its recovery from the account's page. Each completion
 * replaces the secret, ends every session and revokes every browser but the one completing it, which alone signs in with the new secret. The
 * account's browsers are the organisation's, never a person's; Senior Ops holds no key to recover a vendor.
 */
export async function vendorRecovery({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const ada = world.person('ada');
  const bola = world.person('bola');
  const api = stack.apiOrigin;
  await addVendorFixture(stack.database.name);

  // The re-issue is a hub's act (vendor.organization.approve, own hub, for a Platform Admin too: permissions.md), and neither bootstrap
  // administrator has a hub: a Senior Ops of the demonstration vendor's hub is made the way every profile is, and sends the link.
  const ama = introduce(world, 'ama.accra', 'Ama Accra');
  await signInAs(page, ada);
  await createProfile(page, { ...ama.person, role: 'Senior Ops', hub: FIXTURE_HUB });
  await clearBrowser(context);
  await signInAs(page, bola);
  ama.id = await approveProfile(page, ama.person.fullName, ama.person.workEmail);
  await clearBrowser(context);
  await openLink(page, (await world.inbox.next({ to: ama.person.workEmail })).link);
  expect(await setPassword(page, ama.password)).toBe('authenticator');
  await enrolAuthenticator(page, ama);
  await clearBrowser(context);

  // A Platform Admin with no hub is not the hub's officer: the server refuses the re-issue (the page cannot tell, as it lists keys only).
  await signInAs(page, bola);
  const fixture = (await fromPage(page, 'GET', '/api/v1/ops/vendors')).body as {
    items: { id: string }[];
  };
  const fixtureId = fixture.items[0]?.id ?? '';
  const read = await fromPage(page, 'GET', `/api/v1/ops/vendors/${fixtureId}`);
  const notTheHubs = await fromPage(
    page,
    'POST',
    `/api/v1/ops/vendors/${fixtureId}/credential/setup/reissue`,
    {
      body: { reason_code: await reasonCodeFor(page, 'reissueVendorCredentialSetup') },
      headers: { 'if-match': read.etag ?? '' },
    },
  );
  expect([notTheHubs.status, (notTheHubs.body as { code?: string }).code]).toEqual([
    403,
    'HUB_SCOPE_VIOLATION',
  ]);
  await clearBrowser(context);

  // The officer finds the account and sends its first setup link: it has no secret, so a re-issue is offered and a recovery is not.
  await signInAs(page, ama);
  await page.goto('/admin/vendors');
  await expectHeading(page, 'Vendors');
  const accountLink = page.getByRole('table', { name: 'Vendor accounts' }).getByRole('link');
  await expect(accountLink).toHaveCount(1);
  const identifier = (await accountLink.innerText()).trim();
  expect(identifier).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
  await accountLink.click();
  await expectHeading(page, identifier);
  const accountPath = new URL(page.url()).pathname;
  await expect(page.getByRole('button', { name: 'Start recovery' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send a new setup link' }).click();
  await giveReasonAndConfirm(page, 'Send new link');
  await expect(
    page.getByText(/A new setup link is on its way to its registered email/),
  ).toBeVisible();

  // Row 12 (the vendor): the first link lapses unused, the officer sends another with a reason, and the first is dead for good.
  const lapsed = await world.inbox.next({ to: FIXTURE_EMAIL });
  expect(lapsed.accountIdentifier).toBe(identifier);
  await arrange(stack.database.name, 'expire-vendor-setup-grant', identifier);
  const tooLate = await new VendorBrowser(api).send(
    'POST',
    '/api/v1/auth/vendor/setup/credential',
    {
      setup_token: tokenOf(lapsed.link),
      secret: 'a secret set too late for its link',
    },
  );
  expect([tooLate.status, (tooLate.body as { code?: string }).code]).toEqual([
    422,
    'SETUP_GRANT_INVALID',
  ]);
  await page.reload();
  await expectHeading(page, identifier);
  await page.getByRole('button', { name: 'Send a new setup link' }).click();
  await giveReasonAndConfirm(page, 'Send new link');
  await expect(
    page.getByText(/A new setup link is on its way to its registered email/),
  ).toBeVisible();

  // The vendor sets its secret from the message, which carries the identifier beside the link, and signs in.
  const setup = await world.inbox.next({ to: FIXTURE_EMAIL });
  expect(setup.accountIdentifier).toBe(identifier);
  expect(new URL(setup.link.reveal()).origin).toBe(VENDOR_ORIGIN);
  const secret = 'the demonstration vendor shared secret';
  const first = new VendorBrowser(api);
  const established = await first.send('POST', '/api/v1/auth/vendor/setup/credential', {
    setup_token: tokenOf(setup.link),
    secret,
  });
  expect([established.status, established.setCookies]).toEqual([200, ['melarc_vendor_device']]);
  expect((await first.signIn(identifier, secret)).status).toBe(200);
  // The lapsed link stays dead after the new one was used (row 12), and an account that holds a secret is not set up again: it is
  // recovered (AC-SLICE-000-120, the vendor): the page no longer offers a re-issue, and the server refuses one.
  const stillDead = await new VendorBrowser(api).send(
    'POST',
    '/api/v1/auth/vendor/setup/credential',
    {
      setup_token: tokenOf(lapsed.link),
      secret: 'a secret set too late for its link',
    },
  );
  expect((stillDead.body as { code?: string }).code).toBe('SETUP_GRANT_INVALID');
  await page.reload();
  await expectHeading(page, identifier);
  await expect(page.getByRole('button', { name: 'Send a new setup link' })).toHaveCount(0);
  const readAgain = await fromPage(page, 'GET', `/api/v1/ops/vendors/${fixtureId}`);
  const notAgain = await fromPage(
    page,
    'POST',
    `/api/v1/ops/vendors/${fixtureId}/credential/setup/reissue`,
    {
      body: { reason_code: await reasonCodeFor(page, 'reissueVendorCredentialSetup') },
      headers: { 'if-match': readAgain.etag ?? '' },
    },
  );
  expect([notAgain.status, (notAgain.body as { code?: string }).code]).toEqual([
    409,
    'STATE_CONFLICT',
  ]);

  // Row 10a: the vendor asks for recovery itself, and a browser of its own completes it.
  const asked = await new VendorBrowser(api).send('POST', '/api/v1/auth/recovery/request', {
    principal_type: 'VENDOR',
    identifier,
  });
  expect([asked.status, asked.body]).toEqual([202, undefined]);
  const recovery = await world.inbox.next({ to: FIXTURE_EMAIL });
  expect(new URL(recovery.link.reveal()).pathname).toBe('/recovery/complete');
  expect(recovery.accountIdentifier).toBe(identifier);
  const renewed = 'a renewed shared secret for the team';
  const second = new VendorBrowser(api);
  const completed = await second.send('POST', '/api/v1/auth/recovery/complete', {
    token: tokenOf(recovery.link),
    new_credential: renewed,
  });
  // A new browser credential and no session: the vendor signs in afterwards.
  expect([completed.status, completed.setCookies]).toEqual([204, ['melarc_vendor_device']]);
  expect((await first.session()).status).toBe(401);
  const revokedBrowser = await first.signIn(identifier, renewed);
  expect([revokedBrowser.status, (revokedBrowser.body as { code?: string }).code]).toEqual([
    422,
    'INVALID_CREDENTIALS',
  ]);
  expect((await second.signIn(identifier, renewed)).status).toBe(200);

  // Row 11 (vendor): the Platform Admin starts its recovery from the account's page, read again for its version; the vendor completes it.
  // vendor.credential.recover is the Platform Admin's at every hub, so a Platform Admin with no hub of their own acts.
  await clearBrowser(context);
  await signInAs(page, bola);
  await page.goto(accountPath);
  await expectHeading(page, identifier);
  await page.getByRole('button', { name: 'Start recovery' }).click();
  await giveReasonAndConfirm(page, 'Send recovery link');
  await expect(
    page.getByText(/A recovery link is on its way to its registered email/),
  ).toBeVisible();
  await expect(page.getByText(/#token=|\/recovery\/complete/)).toHaveCount(0);
  const started = await world.inbox.next({ to: FIXTURE_EMAIL });
  const third = new VendorBrowser(api);
  const again = 'the third shared secret of the team';
  expect(
    (
      await third.send('POST', '/api/v1/auth/recovery/complete', {
        token: tokenOf(started.link),
        new_credential: again,
      })
    ).status,
  ).toBe(204);
  expect((await second.session()).status).toBe(401);
  expect((await third.signIn(identifier, again)).status).toBe(200);

  // AC-SLICE-000-15: the browsers the shared account registered are the organisation's on the officer's screen, never a person's.
  await page.goto(accountPath);
  const browsers = page.getByRole('table', { name: 'Browsers of the account' });
  await expect(browsers.getByRole('row')).toHaveCount(4);
  await expect(browsers.getByText(FIXTURE_NAME)).toHaveCount(3);
  await clearBrowser(context);

  // Senior Ops holds no vendor.credential.recover, not even of the vendor's own hub: the page offers none, and the server refuses it.
  await signInAs(page, ama);
  await page.goto(accountPath);
  await expectHeading(page, identifier);
  await expect(page.getByRole('button', { name: 'Start recovery' })).toHaveCount(0);
  const current = await fromPage(page, 'GET', `/api/v1/ops/vendors/${fixtureId}`);
  const refused = await fromPage(
    page,
    'POST',
    `/api/v1/ops/vendors/${fixtureId}/credential/recover`,
    {
      body: { reason_code: RECOVERY_REASON },
      headers: { 'if-match': current.etag ?? '' },
    },
  );
  expect([refused.status, (refused.body as { code?: string }).code]).toEqual([
    403,
    'PERMISSION_DENIED',
  ]);
  await signOut(page);
  // The vendor's story goes on in the next journey (rows 10b, 13 and 15) from the browser it last signed in from.
  world.vendor = { identifier, accountId: fixtureId, secret: again, browser: third };
}
