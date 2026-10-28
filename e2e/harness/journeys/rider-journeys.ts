import { randomUUID } from 'node:crypto';

import { expect } from '@playwright/test';

import { addRiderFixture, arrange, observe } from '../database.ts';
import { giveReasonAndConfirm, reasonCodeFor, signInAs } from './actions.ts';
import { clearBrowser, expectHeading, fromPage, signOut } from './pages.ts';
import { readEnrolmentCode, RiderHandset } from './rider-handset.ts';
import type { JourneyContext } from './staff-journeys.ts';
import { VendorBrowser } from './vendor-browser.ts';
import { worldOf } from './world.ts';

/**
 * The Rider and the Vendor rows of the demonstration that the staff journeys do not walk (S0.62; SLICE-000 section 5): the Ops halves on
 * the Ops screens in a real browser, and the Rider's and the Vendor's halves at API level, since neither client is built (the Rider
 * Android and Vendor PWA slices build them). Every fact a person is not shown is read through the closed observations of
 * `apps/api/src/tools/e2e/arrangements.ts`, and nothing is written to the database but what the operations write.
 */

/** The first demonstration rider of the reference fixture (MIGRATION_AND_SEEDING.md section 4a), at the first seeded hub. */
const RIDER_NAME = 'Demonstration Rider One (fixture)';
const RIDER_PHONE = '+99900000001';
const PIN = '480297';
const NEW_PIN = '615038';
const WRONG_PIN = '000000';

/**
 * Rows 8, 7, 9, 11 (rider) and 13 (rider), AC-SLICE-000-60, -08, -40, -10, -71, -108, -105, -114 and -109: a Senior Ops of the rider's hub
 * registers its handset in person by a QR the handset reads; the rider sets its own PIN and signs in by signing a challenge; signing in
 * again replaces the earlier session, which the old token then finds plainly invalid; the officer replaces the handset with a reason and a
 * note through the same QR, and the old device and its session end; an Ops Staff, whose bundle holds no device key, is refused; and five
 * wrong PINs from the registered handset lock the rider, while attempts from a handset that is not registered count for nothing.
 */
export async function riderHandsets({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const api = stack.apiOrigin;
  const ama = world.person('ama.accra');
  await addRiderFixture(stack.database.name);

  // Row 8: the officer opens the rider and shows the code; the officer is never told it as text, and never learns the PIN.
  await signInAs(page, ama);
  await page.goto('/admin/riders');
  await expectHeading(page, 'Riders');
  await page.getByRole('link', { name: RIDER_NAME }).click();
  await expectHeading(page, RIDER_NAME);
  const riderPath = new URL(page.url()).pathname;
  const riderId = riderPath.split('/').at(-1) ?? '';
  await page.getByRole('link', { name: 'Register the first device' }).click();
  await expectHeading(page, 'Register a first device');
  await page.getByRole('button', { name: 'Show the QR code' }).click();
  const first = await readEnrolmentCode(page);
  await expect(page.getByText(first.token)).toHaveCount(0);

  const handset = new RiderHandset(api);
  const enrolled = await handset.enrol(first.token, PIN);
  expect(enrolled.status).toBe(200);
  await page.getByRole('button', { name: 'The rider has scanned it' }).click();
  await expect(page.getByText('Ready to sign in.')).toBeVisible();
  await expect(page.getByText(PIN)).toHaveCount(0);

  const signedIn = await handset.signIn(RIDER_PHONE, PIN);
  expect(signedIn.status).toBe(200);
  const firstToken = signedIn.token ?? '';
  expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect((await handset.session(firstToken)).status).toBe(200);

  // Row 7: a second sign-in replaces the first session; the old token is plainly invalid, never told it was superseded.
  const again = await handset.signIn(RIDER_PHONE, PIN);
  expect(again.status).toBe(200);
  expect(again.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const old = await handset.session(firstToken);
  expect([old.status, old.code]).toEqual([401, 'SESSION_INVALID']);
  expect(await observe(stack.database.name, 'rider-sessions', RIDER_PHONE)).toEqual([
    { live: false, reason: 'REPLACED_BY_NEW_SESSION' },
    { live: true, reason: null },
  ]);
  await clearBrowser(context);

  // Row 11 (rider): a bundle without the device key is refused, whatever it may read.
  await signInAs(page, world.person('kofi.ops'));
  const refused = await fromPage(page, 'POST', `/api/v1/ops/riders/${riderId}/device/reregister`, {
    body: { reason_code: 'RIDER_HANDSET_CHANGED', note: 'Seen in person with the rider’s card.' },
    headers: { 'if-match': '"stale"' },
  });
  expect([refused.status, (refused.body as { code?: string }).code]).toEqual([
    403,
    'PERMISSION_DENIED',
  ]);
  await clearBrowser(context);

  // Rows 9 and 11 (rider): the Senior Ops of the hub replaces the handset in person, with a reason and how the rider was verified,
  // through the same QR; the new handset completes the same enrolment, and the old device and its session end.
  await signInAs(page, ama);
  await page.goto(riderPath);
  await page.getByRole('link', { name: 'Revoke or replace the device' }).click();
  await expectHeading(page, 'Revoke or replace a device');
  await page
    .getByRole('combobox', { name: 'Reason (required)' })
    .selectOption('RIDER_HANDSET_CHANGED');
  await page
    .getByRole('textbox', { name: 'How you verified the rider in person (required)' })
    .fill('Seen in person with the rider’s Ghana card.');
  await page.getByRole('button', { name: 'Show the QR code' }).click();
  const second = await readEnrolmentCode(page);
  expect(second.token).not.toBe(first.token);
  const replacement = new RiderHandset(api);
  expect((await replacement.enrol(second.token, NEW_PIN)).status).toBe(200);
  await page.getByRole('button', { name: 'The rider has scanned it' }).click();
  await expect(page.getByText('Ready to sign in.')).toBeVisible();

  expect((await handset.session(again.token ?? '')).status).toBe(401);
  const sessions = await observe(stack.database.name, 'rider-sessions', RIDER_PHONE);
  expect(sessions.at(-1)).toEqual({ live: false, reason: 'DEVICE_REPLACED' });
  await page.goto(riderPath);
  const devices = page.getByRole('table', { name: 'Devices of the rider' });
  await expect(devices.getByText('Replaced')).toHaveCount(1);
  // The replaced handset signs a challenge with a key the rider no longer has registered: its proof does not verify, whatever the PIN.
  const replaced = await handset.signIn(RIDER_PHONE, PIN);
  expect([replaced.status, replaced.code]).toEqual([422, 'DEVICE_PROOF_INVALID']);
  expect((await replacement.signIn(RIDER_PHONE, NEW_PIN)).status).toBe(200);

  // Row 13 (rider): a handset that is not registered cannot start the count; five wrong PINs from the registered one lock the rider.
  // The rider's challenge and sign-in share a limit of 20 requests a minute for one phone number (`rate_limit_rider_challenge`, a rolling
  // window on the database's clock), and the steps above have used most of it: the limit is part of the product and is not gone around, so
  // the minute is let to pass in the data, as every wait of the journeys is (plan section 3, "Time"), and the first answer below is pinned
  // to be the answer of the sign-in and not of a limit.
  expect(await arrange(stack.database.name, 'lapse-rider-challenge-window')).toBeGreaterThan(0);
  const stranger = new RiderHandset(api);
  const unregistered = await stranger.signIn(RIDER_PHONE, WRONG_PIN);
  expect([unregistered.status, unregistered.code]).toEqual([422, 'DEVICE_PROOF_INVALID']);
  expect(await observe(stack.database.name, 'rider-lock', RIDER_PHONE)).toEqual([
    { failures: 0, locked: false },
  ]);
  const answers: [number, string | undefined][] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const wrong = await replacement.signIn(RIDER_PHONE, WRONG_PIN);
    answers.push([wrong.status, wrong.code]);
  }
  // Each is the answer for a wrong PIN from the registered handset, and each counts (a different answer would not).
  expect(answers).toEqual(Array.from({ length: 5 }, () => [422, 'INVALID_CREDENTIALS']));
  expect(await observe(stack.database.name, 'rider-lock', RIDER_PHONE)).toEqual([
    { failures: 5, locked: true },
  ]);
  // Locked: the right PIN from the registered handset is refused as the lock, and nothing says how many wrong ones there were.
  const locked = await replacement.signIn(RIDER_PHONE, NEW_PIN);
  expect([locked.status, locked.code]).toEqual([422, 'CREDENTIAL_LOCKED']);
  await signOut(page);
}

/**
 * Rows 10b, 15 and 13 (vendor), AC-SLICE-000-96, -41, -99, -100 and -95: the demonstration vendor, set up by the journey before, is refused
 * from a browser it never registered exactly as for a wrong secret, and no number of such attempts locks it; it adds a browser from the
 * link its account is sent, lists its browsers and removes the other one but not the one it is using; a Senior Ops is refused the end of
 * its session at the tier the session's principal needs, and a Platform Admin finds the live session and ends it with a reason; five
 * wrong secrets from its registered browser lock the team, and the lock is told to the browser that proved itself.
 */
export async function vendorBrowsersAndSessions({
  page,
  context,
  stack,
}: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const vendor = world.vendor;
  if (vendor === undefined)
    throw new Error('The vendor journey of rows 10a and 11 runs before this one.');
  const api = stack.apiOrigin;
  const email = 'vendor-recovery@melarc.invalid';

  // Row 10b: the right identifier and the right secret from a browser that was never registered are refused as a wrong secret is,
  // and no number of them counts toward a lock.
  const unregistered = new VendorBrowser(api);
  const right = await unregistered.signIn(vendor.identifier, vendor.secret);
  const wrong = await unregistered.signIn(vendor.identifier, 'not the secret of the team at all');
  expect([right.status, (right.body as { code?: string }).code]).toEqual([
    422,
    'INVALID_CREDENTIALS',
  ]);
  // The same answer in everything but the request id each response carries as its own.
  const withoutRequestId = (answer: { status: number; body: unknown }) => [
    answer.status,
    { ...(answer.body as Record<string, unknown>), request_id: undefined },
  ];
  expect(withoutRequestId(wrong)).toEqual(withoutRequestId(right));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    // Each is the same refusal in everything but its request id, and none of them counts.
    expect(withoutRequestId(await unregistered.signIn(vendor.identifier, vendor.secret))).toEqual(
      withoutRequestId(right),
    );
  }
  expect(await observe(stack.database.name, 'vendor-lock', vendor.identifier)).toEqual([
    { failures: 0, locked: false },
  ]);

  // Row 15, the vendor's half: it adds a browser from the link its account is sent, lists its browsers, removes the other and not this.
  const browser = vendor.browser;
  expect((await browser.session()).status).toBe(200);
  const granted = await browser.send('POST', '/api/v1/auth/vendor/device/grant', undefined, {
    'idempotency-key': randomUUID(),
  });
  expect(granted.status).toBe(202);
  const link = await world.inbox.next({ to: email });
  const token = new URLSearchParams(new URL(link.link.reveal()).hash.slice(1)).get('token') ?? '';
  const added = new VendorBrowser(api);
  const enrolled = await added.send('POST', '/api/v1/auth/vendor/device/enrol', {
    setup_token: token,
  });
  expect([enrolled.status, enrolled.setCookies]).toEqual([200, ['melarc_vendor_device']]);
  const addedId = (enrolled.body as { id?: string }).id ?? '';
  const listed = await browser.send('GET', '/api/v1/auth/vendor/devices');
  const active = (listed.body as { id: string; status: string }[]).filter(
    (device) => device.status === 'ACTIVE',
  );
  expect(active.map((device) => device.id)).toContain(addedId);
  const removed = await browser.send(
    'POST',
    `/api/v1/auth/vendor/devices/${addedId}/revoke`,
    undefined,
    {
      'if-match': listed.etag ?? '',
    },
  );
  expect(removed.status).toBe(200);
  const own = active.find((device) => device.id !== addedId);
  const relisted = await browser.send('GET', '/api/v1/auth/vendor/devices');
  const notThisOne = await browser.send(
    'POST',
    `/api/v1/auth/vendor/devices/${own?.id ?? ''}/revoke`,
    undefined,
    {
      'if-match': relisted.etag ?? '',
    },
  );
  expect([notThisOne.status, (notThisOne.body as { code?: string }).code]).toEqual([
    409,
    'STATE_CONFLICT',
  ]);

  // Row 15, the Ops half: a Platform Admin finds the live session (the id is read once, as the screen reads it); Senior Ops of the
  // hub, who is refused the list of a vendor's sessions and the end of one at the tier it takes, is shown the id and refused again.
  await signInAs(page, world.person('bola'));
  const found = await fromPage(
    page,
    'GET',
    `/api/v1/auth/sessions?principal_type=VENDOR&principal_id=${vendor.accountId}`,
  );
  const liveId = ((found.body as { items?: { id: string }[] }).items ?? [])[0]?.id ?? '';
  expect(liveId).not.toBe('');
  await clearBrowser(context);
  await signInAs(page, world.person('ama.accra'));
  const notListed = await fromPage(
    page,
    'GET',
    `/api/v1/auth/sessions?principal_type=VENDOR&principal_id=${vendor.accountId}`,
  );
  expect([notListed.status, (notListed.body as { code?: string }).code]).toEqual([
    403,
    'INSUFFICIENT_AUTHORITY',
  ]);
  const tooLow = await fromPage(page, 'POST', `/api/v1/auth/sessions/${liveId}/revoke`, {
    body: { reason_code: await reasonCodeFor(page, 'revokeSession') },
  });
  expect([tooLow.status, (tooLow.body as { code?: string }).code]).toEqual([
    403,
    'INSUFFICIENT_AUTHORITY',
  ]);
  await clearBrowser(context);
  await signInAs(page, world.person('bola'));
  await page.goto(`/admin/sessions?principal_type=VENDOR&principal_id=${vendor.accountId}`);
  await expectHeading(page, 'Sessions');
  const open = page.getByRole('table', { name: 'Open sessions' });
  await expect(open.getByRole('row')).toHaveCount(2);
  await open.getByRole('button', { name: /^End session started/ }).click();
  await giveReasonAndConfirm(page, 'End session');
  await expect(open.getByRole('row')).toHaveCount(0);
  expect((await browser.session()).status).toBe(401);
  expect((await observe(stack.database.name, 'vendor-sessions', vendor.identifier)).at(-1)).toEqual(
    {
      live: false,
      reason: 'ADMIN_REVOKED',
    },
  );
  await signOut(page);

  // Row 13 (vendor): five wrong secrets from the registered browser lock the team, and that browser, which proved itself, is told so.
  expect((await browser.signIn(vendor.identifier, vendor.secret)).status).toBe(200);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Each is the answer for a wrong secret from the registered browser, and each counts.
    const refused = await browser.signIn(
      vendor.identifier,
      'a wrong secret from the right browser',
    );
    expect([refused.status, (refused.body as { code?: string }).code]).toEqual([
      422,
      'INVALID_CREDENTIALS',
    ]);
  }
  expect(await observe(stack.database.name, 'vendor-lock', vendor.identifier)).toEqual([
    { failures: 5, locked: true },
  ]);
  const locked = await browser.signIn(vendor.identifier, vendor.secret);
  expect((locked.body as { code?: string }).code).toBe('CREDENTIAL_LOCKED');
}
