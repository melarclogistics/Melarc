import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { arrange } from '../database.ts';
import { signInAs } from './actions.ts';
import { hubRunsOn, hubToday, msToWaitForADay } from './hub-calendar.ts';
import { clearBrowser, expectHeading } from './pages.ts';
import type { JourneyContext } from './staff-journeys.ts';
import { worldOf, type RiderState } from './world.ts';

/**
 * The order screens (S1.40, and Run G2's early orders) walked against the real API, a real database and the real delivery worker, as one story: a rider has finished collecting a run and hands it to the
 * hub; an officer makes orders from the door photos **before the parcels are checked in**, checks the vendor in, and the orders are confirmed; a parcel the officer is waiting on the vendor for is marked, passed over and
 * ordered later; an order is made in one step (the price beside the form, the save at that price); a recipient is corrected; the vendor is closed and its summary read. A second vendor, counted without photos, is counted and
 * ordered (each order's code, and where the vendor stands in its count), and a senior officer closes it with parcels still to order.
 *
 * **Where it stands in for the real path.** The rider's collection (the arrival, the parcels' photographs, the vendor's code, the count) is made by the arrangement `add-collected-run`
 * (`apps/api/src/tools/e2e/arrangements.ts`), because the Rider app does not exist and the photographs need a store a journey does not run; the rider's own act after it, **the handover to the hub, is the
 * product's** (`submitHubHandover`, through the handset client), and so is every act after that. The hub's prices are the seed's: the seven zones of the launch hub and their base fees; **no zone alias is seeded** (OB-S1-02), so
 * the address of every order is placed by the officer's choice of the zone, which is the real path of an address no zone matches (D-S7-5).
 *
 * **What this journey cannot arrange, and what stands in for it.** (1) *The checker's request for an address in another zone* is not built (Run G2 stopped before it: the plan's S1.39g), so there is nothing to walk; the
 * dialog's refusal of such an address is proved by the browser tests of the order screens against their stand-in. (2) *A reader whose pricing reaches fewer hubs than their pickup reading* needs a second hub and a
 * profile with two scopes, which the stack of the journeys does not hold (one hub, the launch hub); the rule is proved by the database tests (`hub-itemization.db.test.ts`, OB-S1-155) and by the component tests of the summary. (3) *A price
 * that changes between the check and the save* needs the hub's prices changed under a form that is open, which no screen does yet (settings are changed by the seed alone), so it is proved by the browser tests against the stand-in.
 *
 * **The day.** As the manifest journey's: the run is for today at the hub, and the hub works Monday to Saturday, so on a Sunday this journey is skipped with that reason and not passed.
 */
const A_DAY_FOR_THE_JOURNEY_MS = 5 * 60 * 1000;
const PHOTOGRAPHED = 4;
const COUNTED = 4;
/** The two vendors of the arranged run are named for what they are, by the dispatch summary of their stops. */
const PHOTO_VENDOR = 'Fixture Kente Crafts';
const BLIND_VENDOR = 'Fixture Adwoa Stalls';
const RUN_CODE = 'ACC-MF-HXJ2MN';
const ZONE = 'Madina/Adenta';
const GUARD_WAIT_MS = 750;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface HandedOver {
  readonly manifestId: string;
  readonly photo: { readonly id: string; readonly code: string };
  readonly blind: { readonly id: string; readonly code: string };
}

/**
 * The rider hands the run over through the real route, as the custody holder: one row for each collected request, each with the number counted. The rider challenge limit counts a rolling minute: the minute the
 * earlier journeys used has passed by now unless they ran very fast, and when its admissions have been cleaned away there is nothing to age; only that case is let go by.
 */
async function handOver(rider: RiderState, database: string): Promise<HandedOver> {
  try {
    await arrange(database, 'lapse-rider-challenge-window');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('changed no row')) throw error;
  }
  const signedIn = await rider.handset.signIn(rider.phone, rider.pin);
  expect(signedIn.status).toBe(200);
  const token = signedIn.token ?? '';
  const list = await rider.handset.call('GET', '/api/v1/pickup-manifests?state=IN_PROGRESS', token);
  expect(list.status).toBe(200);
  const run = (list.body.items as { id: string; code: string }[]).find(
    (item) => item.code === RUN_CODE,
  );
  expect(run).toBeDefined();
  const manifestId = run?.id ?? '';
  const read = await rider.handset.call('GET', `/api/v1/pickup-manifests/${manifestId}`, token);
  expect(read.status).toBe(200);
  const stops = (read.body.stops as { sequence: number; pickup_request_id: string }[]).toSorted(
    (a, b) => a.sequence - b.sequence,
  );
  expect(stops).toHaveLength(2);
  const counts = [PHOTOGRAPHED, COUNTED];
  const handed = await rider.handset.call(
    'POST',
    `/api/v1/pickup-manifests/${manifestId}/hub-handover`,
    token,
    {
      body: {
        rows: stops.map((stop, at) => ({
          pickup_request_id: stop.pickup_request_id,
          declared_count: counts[at],
        })),
        captured_at: new Date(Date.now() - 60_000).toISOString(),
      },
      headers: { 'if-match': read.etag ?? '', 'idempotency-key': randomUUID() },
    },
  );
  expect(handed.status).toBe(201);
  const intakes = handed.body as unknown as { id: string; code: string }[];
  const [photo, blind] = intakes;
  if (photo === undefined || blind === undefined)
    throw new Error('the handover opened two intakes');
  expect(photo.id).toMatch(UUID);
  return { manifestId, photo, blind };
}

/** The save is pressed the way a person presses it: after the moment in which a press is ignored (a price that has just appeared) has passed. */
async function pressSave(page: Page, save: Locator): Promise<void> {
  await expect(save).toBeVisible();
  await page.waitForTimeout(GUARD_WAIT_MS);
  await save.click();
}

/** What the officer knows of the parcel in front of them, typed into the form. */
async function fillIn(page: Page, recipient: string): Promise<void> {
  await page.getByLabel('Recipient’s name').fill(recipient);
  await page.getByLabel('Recipient’s phone').fill('024 765 4321');
  await page.getByLabel('Delivery address').fill('7 Spintex Road, near the mall');
  await page.getByRole('radio', { name: 'Medium' }).check();
}

/**
 * An order made in one step on the real API: the form is filled in, **the address is placed by the officer's choice of a zone** (no alias is seeded, so no zone matches it: the hub's zones are offered with the reason the
 * contract takes), the price comes beside the form by itself, and the save says it. Returns the price the save said and the code the order was given.
 */
async function makeTheOrder(
  page: Page,
  recipient: string,
): Promise<{ price: string; code: string }> {
  await fillIn(page, recipient);
  const group = page.getByRole('group', { name: /Which zone is it\?/ });
  await expect(group).toBeVisible();
  await group.getByRole('radio', { name: ZONE }).check();
  await page.getByLabel(/Why this zone/).fill('The sender said it is in Adenta');
  const save = page.getByRole('button', { name: /^Save the order at / });
  await expect(save).toBeVisible();
  const price = /GH₵[\d,]+\.\d{2}/.exec((await save.textContent()) ?? '')?.[0] ?? '';
  expect(price).not.toBe('');
  await pressSave(page, save);
  const saved = page.getByText(/^Order ACC-OR-[A-Z0-9]+ is saved\.$/);
  await expect(saved).toBeVisible();
  const code = /ACC-OR-[A-Z0-9]+/.exec((await saved.textContent()) ?? '')?.[0] ?? '';
  return { price, code };
}

/** The journey, with what the page said when a step failed added to the failure (the same as the manifest journey: the recorders are off). */
export async function ordersAndClose(journey: JourneyContext): Promise<void> {
  const wait = msToWaitForADay(A_DAY_FOR_THE_JOURNEY_MS);
  if (wait > 0) {
    test.setTimeout(test.info().timeout + wait + 5000);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait);
    });
  }
  const today = hubToday();
  test.skip(
    !hubRunsOn(today),
    `The hub does not run on ${today}, a Sunday: it works Monday to Saturday (MSC-DEC-149), and a run is for a day the hub works, so this journey has nothing to walk today. It is not passed; it runs on every other day.`,
  );
  try {
    await walk(journey, today);
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

async function walk({ page, context, stack }: JourneyContext, day: string): Promise<void> {
  const world = worldOf(stack);
  const ama = world.person('ama.accra');
  const vendor = world.vendor;
  const rider = world.riders.get('one');
  if (vendor === undefined || rider === undefined) {
    throw new Error('The vendor and rider journeys run before the orders journey.');
  }
  const database = stack.database.name;
  // The lists and the pool of these screens are tables where there is room and cards where there is not (a window of 1280 pixels with the menu open draws cards): the journey asks for the table, the screen the officer of the hub floor reads.
  await page.setViewportSize({ width: 1600, height: 1000 });

  // The run the rider collected, handed over through the real route: two intakes at the start of their check-in.
  expect(
    await arrange(
      database,
      'add-collected-run',
      rider.phone,
      vendor.identifier,
      day,
      String(PHOTOGRAPHED),
      String(COUNTED),
    ),
  ).toBe(1);
  const run = await handOver(rider, database);

  // Session 1: the orders are begun from the photos while the check-in is open, and the vendor is checked in.
  await signInAs(page, ama);
  await page.goto(`/receiving/${run.manifestId}`);
  const section = page.getByRole('region', { name: PHOTO_VENDOR });
  await expect(section).toBeVisible();
  await section.getByRole('link', { name: 'Start orders from the photos' }).click();
  await expectHeading(page, `Orders for ${PHOTO_VENDOR}`);
  await expect(page.getByRole('tab', { name: /Not here yet/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('link', { name: 'Make the next order' }).first().click();
  const early: string[] = [];
  for (const parcel of [1, 2]) {
    await expectHeading(page, `Make an order for parcel ${String(parcel)}`);
    early.push((await makeTheOrder(page, `Early Recipient ${String(parcel)}`)).code);
    await expect(page.getByText(/The order waits for its parcel\./)).toBeVisible();
    if (parcel === 1) await page.getByRole('link', { name: 'Make the next order' }).click();
  }
  // An order made early is a quote: the vendor's page says the two wait for their parcels.
  await page.getByRole('link', { name: 'Back to the orders' }).click();
  await expect(
    page.getByRole('table', { name: 'Parcels and orders' }).getByText('Waiting for its parcel'),
  ).toHaveCount(2);

  // The vendor is checked in against its photos: all four parcels are here, which confirms the two orders and fixes their prices.
  await page.goto(`/receiving/${run.manifestId}`);
  await section.getByRole('button', { name: `All ${String(PHOTOGRAPHED)} here` }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: `Yes, all ${String(PHOTOGRAPHED)} are here` })
    .click();
  await expect(section.getByRole('link', { name: 'Make orders' })).toBeVisible();

  // Session 2: the two early orders are confirmed; a parcel is marked as waited on, passed over, and ordered later; an order is made in one step at the price shown; a recipient is corrected; the vendor is closed.
  await clearBrowser(context);
  await signInAs(page, ama);
  await page.goto(`/intakes/${run.photo.id}/orders`);
  await expectHeading(page, `Orders for ${PHOTO_VENDOR}`);
  await page.getByRole('tab', { name: /^Confirmed/ }).click();
  const rows = page.getByRole('table', { name: 'Parcels and orders' });
  await expect(rows.getByText('Confirmed — price fixed')).toHaveCount(2);
  await rows.getByRole('link', { name: 'Open order: Parcel 1' }).click();
  await expect(page.getByText('Confirmed: its price is fixed.')).toBeVisible();
  await expect(page.getByText('Fixed price')).toBeVisible();
  await expect(page.getByText(early[0] ?? '').first()).toBeVisible();

  // The next parcel that needs an order is the third: the officer is waiting on the vendor's details for it, marks it, and the next order is the fourth.
  await page.goto(`/intakes/${run.photo.id}/orders`);
  await page.getByRole('link', { name: 'Make the next order' }).first().click();
  await expectHeading(page, 'Make an order for parcel 3');
  await page.getByRole('button', { name: 'Waiting for the vendor’s details' }).click();
  const mark = page.getByRole('alertdialog');
  await mark.getByLabel(/What you asked, and how/).fill('Called the vendor, waiting on WhatsApp');
  await mark.getByRole('button', { name: 'Mark the parcel' }).click();
  await expectHeading(page, 'Make an order for parcel 4');
  const fourth = await makeTheOrder(page, 'Ama Mensah');

  // Nothing is left to order but the parcel that is waited on: the screen says so and leads to it.
  await page.getByRole('link', { name: 'Make the next order' }).click();
  await expect(
    page.getByText('Every parcel that is left is waiting for the vendor’s details.'),
  ).toBeVisible();
  await page.getByRole('link', { name: 'See the parcels that wait' }).click();
  await expect(rows.getByText('Called the vendor, waiting on WhatsApp')).toBeVisible();
  await rows.getByRole('link', { name: 'Make order: Parcel 3' }).click();
  await expectHeading(page, 'Make an order for parcel 3');
  await makeTheOrder(page, 'Kofi Boateng');

  // The order made in one step is at the price its save said, and fixed.
  await page.goto(`/intakes/${run.photo.id}/orders`);
  await page.getByRole('tab', { name: /^Confirmed/ }).click();
  await rows.getByRole('link', { name: 'Open order: Parcel 4' }).click();
  await expect(page.getByText(fourth.code).first()).toBeVisible();
  const price = page
    .getByRole('region', { name: 'The price' })
    .getByText('Fixed price')
    .locator('xpath=following-sibling::*[1]');
  await expect(price).toHaveText(fourth.price);

  // A recipient's name and phone are corrected with a reason, and the history says which parts, never what they were.
  await page.getByRole('button', { name: 'Correct the recipient' }).click();
  const correction = page.getByRole('alertdialog');
  await correction.getByLabel(/Recipient’s name/).fill('Ama Mensah-Owusu');
  await correction.getByLabel(/Recipient’s phone/).fill('020 123 4567');
  await correction
    .getByLabel(/Why are you correcting this\?/)
    .fill('The surname and the number had a mistake');
  await correction.getByRole('button', { name: 'Save the correction' }).click();
  await expect(
    page.getByText(`The recipient of order ${fourth.code} was corrected.`),
  ).toBeVisible();
  await expect(
    page.getByText('Corrected the recipient: the name and the phone number.'),
  ).toBeVisible();

  // Every parcel has an order: the vendor is closed, and its summary lists the four orders.
  await page.goto(`/intakes/${run.photo.id}/close`);
  await expect(
    page.getByText('Every parcel received has an order. You can close this vendor.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close this vendor' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, close it' }).click();
  await expect(page.getByText('The vendor is closed.')).toBeVisible();
  await page.getByRole('link', { name: 'See the summary' }).click();
  await expectHeading(page, `Summary for ${PHOTO_VENDOR}`);
  await expect(page.getByRole('table', { name: 'Order' }).getByRole('row')).toHaveCount(
    PHOTOGRAPHED + 1,
  );

  // Session 3: the vendor counted without photos is counted, ordered (the code of each order, and where the vendor stands in its count), and closed by a senior officer with parcels still to order.
  await clearBrowser(context);
  await signInAs(page, ama);
  await page.goto(`/receiving/${run.manifestId}`);
  const blind = page.getByRole('region', { name: BLIND_VENDOR });
  await expect(blind).toBeVisible();
  await blind.getByRole('link', { name: 'Count the parcels' }).click();
  await page.getByRole('textbox', { name: /Parcels counted/ }).fill(String(COUNTED));
  await page.getByRole('button', { name: 'Review the count' }).click();
  await page
    .getByRole('alertdialog', { name: `Record a count of ${String(COUNTED)} parcels?` })
    .getByRole('button', { name: 'Record the count' })
    .click();
  // The count is recorded once, and the officer is brought to the vendor's record: nothing is ordered before the page says so.
  await expectHeading(page, run.blind.code);
  await page.goto(`/intakes/${run.blind.id}/orders`);
  await expectHeading(page, `Orders for ${BLIND_VENDOR}`);
  await page.getByRole('link', { name: 'Make an order' }).first().click();
  for (const made of [1, 2]) {
    await makeTheOrder(page, `Counted Recipient ${String(made)}`);
    await expect(page.getByText('Write this code on the parcel.')).toBeVisible();
    await expect(
      page.getByText(`Order ${String(made)} of ${String(COUNTED)} for this vendor.`),
    ).toBeVisible();
    if (made === 1) await page.getByRole('link', { name: 'Make the next order' }).click();
  }
  await page.goto(`/intakes/${run.blind.id}/close`);
  await expect(page.getByText(/Some parcels received still have no order\./)).toBeVisible();
  await page
    .getByLabel(/Why are you closing with parcels still to order\?/)
    .fill('The vendor will bring the last two parcels’ details tomorrow.');
  await page.getByRole('button', { name: 'Close with a reason' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, close it' }).click();
  await expect(page.getByText('The vendor is closed, with parcels still to order.')).toBeVisible();
  await page.goto('/closed-vendors');
  await expectHeading(page, 'Closed with parcels left');
  await expect(page.getByText(BLIND_VENDOR).first()).toBeVisible();
}
