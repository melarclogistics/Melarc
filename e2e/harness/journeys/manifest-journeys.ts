import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { arrange } from '../database.ts';
import { readMessages, readTexts } from '../messages.ts';
import { signInAs } from './actions.ts';
import { hubRunsOn, hubToday } from './hub-calendar.ts';
import { expectHeading, fromPage } from './pages.ts';
import { readEnrolmentCode, RiderHandset } from './rider-handset.ts';
import type { JourneyContext } from './staff-journeys.ts';
import { worldOf, type RiderState } from './world.ts';

/**
 * The manifest and custody screens (S1.25) walked against the real API, a real database and the real delivery worker, as one story: Ops builds a
 * run from the pool, gives it a rider, dispatches it; the rider starts it (a handset client, since the Rider app does not exist); Ops opens a
 * custody handover to a second rider, who accepts it; Ops skips the stop left and the system completes the run. A second run is handed to the
 * hub: a handover is failed, and another is accepted by Ops. A second tab acts on a read that is out of date.
 *
 * **Where it stands in for the real path.** The pool of confirmed requests is made by the `add-confirmed-pickups` arrangement
 * (`apps/api/src/tools/e2e/arrangements.ts`), as a day of real bookings would have left it, because a booking needs what the seed does not hold
 * (no zone alias, no saved pickup location: OB-S1-02) and depends on the hour (the booking cut-off); every act after the pool is an operation of
 * the product. The rider's half is the handset client of `rider-handset.ts`. Nothing is edited by hand, and the one pass of time (a rider's lock)
 * is the arrangement `lapse-rider-lock`.
 *
 * **The day.** A run is started on its `service_date` on the hub's clock and not before or after it, so the manifest's day is today at the hub
 * (`Africa/Accra`), whatever the browser's own clock says: the harness freezes that clock on 5 October 2026 and the API runs on the real one.
 * The hub works Monday to Saturday (`hub-calendar.ts`), so on a Sunday there is no day on which this story can be told: the API refuses a manifest
 * for it, and a run starts only on its own day. The journey is then **skipped, with that reason, and not passed**; it runs on every other day.
 */
const TWO = {
  name: 'Demonstration Rider Two (fixture)',
  phone: '+99900000002',
  pin: '730915',
} as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The code of the nth arranged request: the arrangement's own rule (`fixturePickupCode`), which a journey follows to name a request without reading it. */
const codeOf = (at: number): string => `ACC-PR-HX${'ABCDEFGH'.charAt(at)}${String(at + 2)}MN`;

/** The service date field takes the day first: `DDMMYYYY` typed into the day segment moves on by itself. */
async function typeServiceDate(page: Page, day: string): Promise<void> {
  const [year = '', month = '', date = ''] = day.split('-');
  const first = page
    .getByRole('group', { name: /Service date/ })
    .getByRole('spinbutton')
    .first();
  await first.click();
  await page.keyboard.type(`${date}${month}${year}`);
}

/** The rider's registration as the officer does it (row 8 of the rider journey): the QR the screen draws, read by the handset. */
async function registerRider(
  page: Page,
  api: string,
  rider: Omit<RiderState, 'handset' | 'id'>,
): Promise<RiderState> {
  await page.goto('/admin/riders');
  await expectHeading(page, 'Riders');
  await page.getByRole('link', { name: rider.name }).click();
  await expectHeading(page, rider.name);
  const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(id).toMatch(UUID);
  await page.getByRole('link', { name: 'Register the first device' }).click();
  await expectHeading(page, 'Register a first device');
  await page.getByRole('button', { name: 'Show the QR code' }).click();
  const code = await readEnrolmentCode(page);
  const handset = new RiderHandset(api);
  expect((await handset.enrol(code.token, rider.pin)).status).toBe(200);
  await page.getByRole('button', { name: 'The rider has scanned it' }).click();
  await expect(page.getByText('Ready to sign in.')).toBeVisible();
  return { ...rider, id, handset };
}

/** Builds a manifest from the pool by the row selection, for the day, and lands on it. */
async function build(
  page: Page,
  codes: readonly string[],
  day: string,
): Promise<{ id: string; code: string }> {
  await page.goto('/manifests/new');
  await expectHeading(page, 'Build a manifest');
  try {
    // The pool is drawn as a table where there is room and as cards where there is not (the browser here is 1280 px wide with the menu open,
    // which draws cards), and only the drawing that is shown is in the accessibility tree: the journey asks for the choice, not for a drawing.
    await expect(page.getByRole('checkbox', { name: `Choose ${codes[0] ?? ''}` })).toBeVisible();
  } catch (error) {
    // What the real API gave the pool, beside what the screen made of it: the point of walking the screens against the real API.
    const pool = await fromPage(
      page,
      'GET',
      '/api/v1/pickup-requests?state=CONFIRMED&manifested=false',
    );
    throw new Error(
      `The pool did not draw. The API answered ${String(pool.status)}: ${JSON.stringify(pool.body).slice(0, 1800)}`,
      { cause: error },
    );
  }
  for (const code of codes) await page.getByRole('checkbox', { name: `Choose ${code}` }).check();
  await typeServiceDate(page, day);
  await page.getByRole('button', { name: 'Create the manifest' }).click();
  await expect(page.getByText(/The manifest is made\./)).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(id).toMatch(UUID);
  const code = (await page.getByRole('heading', { level: 1 }).textContent()) ?? '';
  expect(code).toMatch(/^ACC-MF-[2-9A-HJKMNP-Z]{6}$/);
  return { id, code };
}

/** Gives the draft its rider through the picker, and dispatches it: two acts, each its own dialog. */
async function assignAndDispatch(page: Page, riderName: string): Promise<void> {
  await page.getByRole('button', { name: 'Assign a rider' }).click();
  const assign = page.getByRole('alertdialog', { name: 'Assign this rider?' });
  await assign.getByRole('button', { name: `Choose: ${riderName}` }).click();
  await assign.getByRole('button', { name: 'Assign the rider' }).click();
  await expect(page.getByText(/A rider is assigned\. The manifest is still a draft/)).toBeVisible();

  await page.getByRole('button', { name: 'Dispatch the manifest' }).first().click();
  const dispatch = page.getByRole('alertdialog', { name: 'Dispatch this manifest?' });
  await dispatch.getByRole('button', { name: 'Dispatch the manifest' }).click();
  await expect(page.getByText(/The manifest is dispatched/)).toBeVisible();
}

/** The rider starts the run from the handset: reads the run (its `ETag`), and sends it back. */
async function startRun(rider: RiderState, token: string, manifestId: string): Promise<void> {
  const read = await rider.handset.call('GET', `/api/v1/pickup-manifests/${manifestId}`, token);
  expect(read.status).toBe(200);
  expect(read.etag).toBeDefined();
  const started = await rider.handset.call(
    'POST',
    `/api/v1/pickup-manifests/${manifestId}/start`,
    token,
    {
      headers: { 'if-match': read.etag ?? '' },
    },
  );
  expect([started.status, started.body.state]).toEqual([200, 'IN_PROGRESS']);
}

/** Ops skips a stop with the first reason of the catalogue (and a note, where the reason wants one), and comes back to the run. */
async function skip(page: Page, code: string): Promise<void> {
  await page.getByRole('link', { name: new RegExp(`^Skip stop \\d+, ${code}$`) }).click();
  await expectHeading(page, 'Skip a stop');
  await page.getByRole('combobox', { name: /Reason/ }).selectOption({ index: 1 });
  const note = page.getByRole('textbox', { name: /Note/ });
  if (await note.count())
    await note.fill('Skipped by the manifest journey of the integrated harness.');
  await page.getByRole('button', { name: 'Skip this stop' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Skip the stop' }).click();
  await expect(page.getByText(/The stop is skipped and the vendor is told\./)).toBeVisible();
}

/**
 * The rider challenge limit counts a rolling minute: the minute the rider journey used has passed by now unless the journeys ran very fast, and
 * when its admissions have been cleaned away there is nothing to age. Only that case is let go by; any other failure is the journey's.
 */
async function letTheChallengeMinutePass(database: string): Promise<void> {
  try {
    await arrange(database, 'lapse-rider-challenge-window');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('changed no row')) throw error;
  }
}

/**
 * The journey, with what the page said when a step failed added to the failure: these screens hold no secret, and the journey runs with the
 * recorders off (it is a secret spec), so the words of the page are the only picture of where it stopped.
 */
export async function manifestsAndCustody(journey: JourneyContext): Promise<void> {
  const today = hubToday();
  test.skip(
    !hubRunsOn(today),
    `The hub does not run on ${today}, a Sunday: it works Monday to Saturday (MSC-DEC-149), a manifest cannot be made for a day it does not ` +
      `work and a run starts only on its own day, so this journey has nothing to walk today. It is not passed; it runs on every other day.`,
  );
  try {
    await walk(journey);
  } catch (error) {
    const said = await journey.page
      .locator('main')
      .innerText({ timeout: 2000 })
      .catch(() => '(the page could not be read)');
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}

The page said: ${said.slice(0, 700)}`,
      { cause: error },
    );
  }
}

async function walk({ page, context, stack }: JourneyContext): Promise<void> {
  const world = worldOf(stack);
  const ama = world.person('ama.accra');
  const vendor = world.vendor;
  const one = world.riders.get('one');
  if (vendor === undefined || one === undefined) {
    throw new Error('The vendor and rider journeys run before the manifest journey.');
  }
  const database = stack.database.name;
  const day = hubToday();

  // The pool: four confirmed requests of the demonstration vendor for the hub's day.
  expect(await arrange(database, 'add-confirmed-pickups', vendor.identifier, day, '4')).toBe(4);
  await signInAs(page, ama);
  const two = await registerRider(page, stack.apiOrigin, {
    name: TWO.name,
    phone: TWO.phone,
    pin: TWO.pin,
  });
  world.riders.set('two', two);

  // Step 1: Ops builds the run through the screens, the second request chosen first, so that the order is the one submitted.
  const run = await build(page, [codeOf(1), codeOf(0)], day);
  await expect(page.getByText('Draft', { exact: true }).first()).toBeVisible();
  // The stops name their requests once each has been read.
  await expect(page.getByText('Reading the pickup…')).toHaveCount(0);
  const text = await page.locator('main').innerText();
  expect(text.indexOf(codeOf(1))).toBeGreaterThan(-1);
  expect(text.indexOf(codeOf(1))).toBeLessThan(text.indexOf(codeOf(0)));
  const draft = await fromPage(page, 'GET', `/api/v1/pickup-manifests/${run.id}`);
  const body = draft.body as { state: string; service_date: string; stops: { sequence: number }[] };
  expect([draft.status, body.state, body.service_date]).toEqual([200, 'DRAFT', day]);
  expect(body.stops.map((stop) => stop.sequence)).toEqual([1, 2]);
  expect(draft.etag).toMatch(/^"[^"]+"$/);

  // Step 2: an ACTIVE rider by the picker, then the dispatch; the one text the dispatch sends is in the sink, and nothing else was delivered.
  const sink = stack.captureDirectory ?? '';
  const before = { links: readMessages(sink).length, texts: readTexts(sink).length };
  await assignAndDispatch(page, two.name);
  // The dispatch text is a text of the notification lane (the same folder, another shape: `readTexts`); it goes to the rider's number and to
  // nobody else, and no message with a link was sent by it.
  const dispatched = await world.inbox.nextText({ to: two.phone });
  expect(dispatched.destination).toBe(two.phone);
  expect(dispatched.text.reveal().length > 0).toBe(true);
  expect(readTexts(sink).length - before.texts).toBe(1);
  expect(readMessages(sink).length - before.links).toBe(0);

  const sent = await fromPage(page, 'GET', `/api/v1/pickup-manifests/${run.id}`);
  const sentBody = sent.body as { state: string; assigned_rider_id: string | null };
  expect([sent.status, sentBody.state, sentBody.assigned_rider_id]).toEqual([
    200,
    'DISPATCHED',
    two.id,
  ]);
  expect(sent.etag).not.toBe(draft.etag);

  // Step 3: the rider starts the run on its day.
  const signedInTwo = await two.handset.signIn(two.phone, two.pin);
  expect(signedInTwo.status).toBe(200);
  await startRun(two, signedInTwo.token ?? '', run.id);
  await page.goto(`/manifests/${run.id}`);
  await expect(page.getByText('In progress', { exact: true }).first()).toBeVisible();

  // Step 4 (a): a handover to the second rider, who accepts it with a count; the stop worked before stays the first rider's; the last stop is
  // skipped by Ops and the system completes the run.
  await skip(page, codeOf(1));
  await page.getByRole('button', { name: 'Open a custody handover' }).click();
  const opening = page.getByRole('alertdialog', { name: 'Open a custody handover?' });
  await opening.getByRole('radio', { name: 'To another rider' }).check();
  await opening.getByRole('button', { name: `Choose: ${one.name}` }).click();
  await opening
    .getByRole('textbox', { name: /Why custody/ })
    .fill('The first rider’s handset broke on the road.');
  await opening.getByRole('button', { name: 'Open the handover' }).click();
  await expect(page.getByText('Waiting for the receiver')).toBeVisible();
  await expect(
    page.getByText(
      new RegExp(
        `Custody is to go to ${escape(one.name)}\\. It is held now by ${escape(two.name)}`,
      ),
    ),
  ).toBeVisible();

  await arrange(database, 'lapse-rider-lock', one.phone);
  await letTheChallengeMinutePass(database);
  const signedInOne = await one.handset.signIn(one.phone, one.pin);
  expect(signedInOne.status).toBe(200);
  const tokenOne = signedInOne.token ?? '';
  const pending = await one.handset.call(
    'GET',
    `/api/v1/run-custody-handovers?manifest_id=${run.id}&state=PENDING`,
    tokenOne,
  );
  const handover = (pending.body.items as { id: string }[])[0];
  expect(handover).toBeDefined();
  const read = await one.handset.call(
    'GET',
    `/api/v1/run-custody-handovers/${handover?.id ?? ''}`,
    tokenOne,
  );
  const accepted = await one.handset.call(
    'POST',
    `/api/v1/pickup-manifests/${run.id}/custody-handover/accept`,
    tokenOne,
    {
      // Nothing was collected on this run (every stop is skipped), so the receiver took no parcels: a count of three here would be a custody record
      // that no stop explains, and a run the system then completes as empty (OB-S1-59). That case is pinned apart, in `pickup-run-completion.db.test.ts`.
      body: { parcel_count_taken: 0 },
      headers: { 'if-match': read.etag ?? '', 'idempotency-key': randomUUID() },
    },
  );
  expect([accepted.status, accepted.body.state]).toEqual([200, 'COMPLETED']);

  // Custody is the receiver's now, and the run is still the first rider's: the record of the handover says who took it, and the run keeps its
  // assignment. What the screen can say of it is that no handover waits and that the stop skipped before stays skipped.
  const taken = await fromPage(
    page,
    'GET',
    `/api/v1/run-custody-handovers?manifest_id=${run.id}&state=COMPLETED`,
  );
  const handovers = (
    taken.body as {
      items: { from_rider_id: string; to_rider_id: string; parcel_count_taken: number }[];
    }
  ).items;
  expect(handovers).toHaveLength(1);
  expect(handovers[0]?.from_rider_id).toBe(two.id);
  expect(handovers[0]?.to_rider_id).not.toBe(two.id);
  expect(handovers[0]?.parcel_count_taken).toBe(0);
  await page.reload();
  await expect(page.getByText('No handover is waiting')).toBeVisible();
  const during = await fromPage(page, 'GET', `/api/v1/pickup-manifests/${run.id}`);
  expect((during.body as { assigned_rider_id: string }).assigned_rider_id).toBe(two.id);
  await expect(page.getByText(/Skipped by Ops/)).toHaveCount(1);

  // The last stop is skipped by Ops, and the system completes the run (read again by the screen, which cannot know it in advance).
  await skip(page, codeOf(0));
  await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Skipped by Ops/)).toHaveCount(2);
  const finished = await fromPage(page, 'GET', `/api/v1/pickup-manifests/${run.id}`);
  const closed = finished.body as {
    state: string;
    completed_at: string | null;
    assigned_rider_id: string;
  };
  expect([closed.state, closed.assigned_rider_id]).toEqual(['COMPLETED', two.id]);
  expect(closed.completed_at).not.toBeNull();

  // Step 4 (b) and (c), and step 5, on a second run held by the first demonstration rider.
  const second = await build(page, [codeOf(2), codeOf(3)], day);
  await assignAndDispatch(page, one.name);
  await startRun(one, tokenOne, second.id);
  await page.goto(`/manifests/${second.id}`);

  const open = async (tab: Page) => {
    await tab.getByRole('button', { name: 'Open a custody handover' }).click();
    const dialog = tab.getByRole('alertdialog', { name: 'Open a custody handover?' });
    await dialog.getByRole('radio', { name: /To the hub/ }).check();
    await dialog.getByRole('textbox', { name: /Why custody/ }).fill('Unsafe roadside, to the hub.');
    await dialog.getByRole('button', { name: 'Open the handover' }).click();
    await expect(tab.getByText('Waiting for the receiver')).toBeVisible();
  };
  const markFailed = async (tab: Page) => {
    await tab.getByRole('button', { name: 'Mark the handover as failed' }).click();
    const dialog = tab.getByRole('alertdialog', { name: 'Mark this handover as failed?' });
    await dialog
      .getByRole('textbox', { name: /Why it did not happen/ })
      .fill('Nobody came to the hub door.');
    await dialog.getByRole('button', { name: 'Mark the handover as failed' }).click();
  };

  await open(page);
  // Step 5: a second tab reads the run while the handover waits; the first fails it; the second then acts on a read that is out of date.
  const beside = await context.newPage();
  await beside.goto(`/manifests/${second.id}`);
  await expect(beside.getByText('Waiting for the receiver')).toBeVisible();
  await markFailed(page);
  await expect(
    page.getByText('The handover is marked as failed. Custody is where it was.'),
  ).toBeVisible();
  await markFailed(beside);
  await expect(beside.getByText(/no longer waiting|No handover is waiting/).first()).toBeVisible();
  await beside.close();

  // (c): custody is where it was: a further handover names the same holder. (b): opened to the hub again, accepted by Ops with a count.
  await page.reload();
  await open(page);
  await expect(
    page.getByText(
      new RegExp(`Custody is to go to the hub: .*\\. It is held now by ${escape(one.name)}`),
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Accept the handover' }).click();
  const accept = page.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
  await accept.getByRole('textbox', { name: /Parcels taken/ }).fill('2');
  await accept.getByRole('button', { name: 'Accept the handover' }).click();
  await expect(
    page.getByText(/You recorded 2 parcels taken: a record of custody, not the hub’s count\./),
  ).toBeVisible();
  const both = await fromPage(
    page,
    'GET',
    `/api/v1/run-custody-handovers?manifest_id=${second.id}`,
  );
  const ledger = (
    both.body as { items: { state: string; from_rider_id: string; to_hub_id: string | null }[] }
  ).items;
  expect(ledger.map((entry) => entry.state)).toEqual(['COMPLETED', 'FAILED']);
  expect(new Set(ledger.map((entry) => entry.from_rider_id)).size).toBe(1);
  expect(ledger.every((entry) => entry.to_hub_id !== null)).toBe(true);
}

/** A name as text for a regular expression. */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
