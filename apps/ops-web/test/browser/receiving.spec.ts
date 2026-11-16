import { createHash } from 'node:crypto';

import type { Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import {
  COUNTED_SHORT,
  DECLARED,
  IDS,
  PLANTED,
  RUNS,
  SENIOR,
  stubReceivingApi,
  world,
  type ReceivingApi,
  type World,
} from './support/receiving-api';
import { watchPage, wcagViolations } from './support/page';
import { menuEntry } from './support/shell';
import { expectNoTableScrollsSideways } from './support/tables';
import { expectWholeInTheWindow } from './support/whole';

/**
 * The receiving screens (S1.35, reworked by Run D) in a real browser: the queue by run, a run's page, the count of a vendor with no photos, a vendor's record, the senior officer's decision and correction, the damage of a vendor with no photos and the list of missing parcels. What jsdom cannot show is here: **the blind count
 * proved from outside** (no answer the page received before the count, and nothing it drew, holds the rider's declaration or the number it would be: not the text, an attribute, the title, the accessible
 * tree, the console), the lock of another receiver, the second receiver of two who count, the evidence going through its three steps with the bytes sent to the store with no credentials and no referrer,
 * a photo that is really loaded only when it is opened, the layout at the verified widths with axe (WCAG 2.2 A and AA), no sideways scrolling at 320 px, text enlarged to 200% and forced colours.
 *
 * The API is a small stateful stand-in. **It carries the declaration only where the contract does** (an intake that has been counted), and `world.leak` turns it into the server the blind count is built
 * against, which carries it everywhere: the screens must refuse such an answer whole and the number must be nowhere on the page. The same file runs against the production build and the development server.
 */
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const QUEUE = '/receiving';
const runPath = (id: string) => `/receiving/${id}`;
const MISSING = '/missing-parcels';
const record = (id: string) => `/intakes/${id}`;
const count = (id: string) => `/intakes/${id}/count`;
const discrepancy = (id: string) => `/intakes/${id}/discrepancy`;
/** The declared number, as a standalone number in a text: it is no part of a date, a time or an identifier of the world. */
const THE_NUMBER = new RegExp(`\\b${String(DECLARED)}\\b`);

interface Opened {
  readonly api: ReceivingApi;
  readonly watch: ReturnType<typeof watchPage>;
  /** Every answer the browser received from the API, as text, in the order it came. */
  readonly received: { readonly url: string; readonly status: number; readonly text: string }[];
  /** Everything the page said to the console, whatever the kind. */
  readonly console: string[];
}

async function open(page: Page, path: string, setup: Partial<World> = {}): Promise<Opened> {
  const watch = watchPage(page);
  const received: Opened['received'] = [];
  const logged: string[] = [];
  page.on('response', (response) => {
    if (!response.url().includes('/api/v1/')) return;
    void response.text().then(
      (text) => received.push({ url: response.url(), status: response.status(), text }),
      () => undefined,
    );
  });
  page.on('console', (message) => logged.push(message.text()));
  const api = await stubReceivingApi(page, world(setup));
  await page.goto(path);
  return { api, watch, received, console: logged };
}

const acts = (api: ReceivingApi) => api.calls.filter((call) => call.method === 'POST');
const sent = (api: ReceivingApi, suffix: string) =>
  acts(api).filter((call) => call.path.endsWith(suffix));
const reads = (api: ReceivingApi, suffix: string) =>
  api.calls.filter((call) => call.method === 'GET' && call.path.endsWith(suffix));
const authorizations = (api: ReceivingApi) =>
  api.calls.filter((call) => call.path.endsWith('/retrieval-authorization'));
/** The problems of the page, leaving out the refusals a test brought about on purpose. */
const problemsBut = (watch: Opened['watch'], ...statuses: number[]): string[] =>
  watch.problems.filter(
    (problem) =>
      !statuses.some(
        (status) =>
          problem.startsWith(`HTTP ${String(status)}:`) ||
          problem.includes(`the server responded with a status of ${String(status)}`),
      ),
  );

const table = (page: Page, name: string) => page.getByRole('table', { name });
const overflowOf = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** The controls whose content is wider than the control: a label cut off. */
function clippedControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.getAttribute('aria-label') ?? element.textContent),
  );
}

/**
 * **The blind count, proved from outside:** nothing the page was sent, and nothing it drew, is the rider's declaration or the number it would be. The answers are read as text as the browser got them
 * (the key of the declaration and the number itself, as a standalone number); the page is read as it stands (every text and every attribute, the title, the accessible tree) and so is the console.
 */
async function expectBlind(page: Page, opened: Opened): Promise<void> {
  for (const answer of opened.received) {
    expect(answer.text, answer.url).not.toContain('rider_declared_count');
    expect(answer.text, answer.url).not.toMatch(THE_NUMBER);
  }
  expect(await page.content()).not.toMatch(THE_NUMBER);
  expect(await page.title()).not.toMatch(THE_NUMBER);
  expect(await page.locator('body').ariaSnapshot()).not.toMatch(THE_NUMBER);
  for (const line of opened.console) expect(line).not.toMatch(THE_NUMBER);
}

/** The chooser of a photo taken or chosen in a dialog: the gallery's input, which takes the file a test hands it (the camera's cannot be driven). */
const gallery = (scope: Page | ReturnType<Page['locator']>) =>
  scope.locator('input[type="file"][multiple]');

/** A press on a tile opens the photo in the viewer (D-D2); *Open this parcel* leads from it to the parcel's own dialog, where the acts are. */
async function openParcel(page: Page, tile: ReturnType<Page['locator']>, name: string) {
  await tile.click();
  await page.getByRole('button', { name: 'Open this parcel' }).click();
  await expect(page.getByRole('button', { name: 'Open this parcel' })).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function enterCount(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: /Parcels counted/ }).fill(text);
  await page.getByRole('button', { name: 'Review the count' }).click();
}

test.describe('moving through the screens', () => {
  // Break caught: a menu entry that goes nowhere, or a page whose heading a screen reader never hears.
  test('the menu leads to the queue by run, which lands on its heading, and a row opens its run', async ({
    page,
  }) => {
    const opened = await open(page, '/');

    await menuEntry(page, 'Receiving').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Receiving' })).toBeFocused();
    await table(page, 'Runs').getByRole('link', { name: 'ACC-MF-7KQ2MZ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-MF-7KQ2MZ' })).toBeFocused();
    expect(new URL(page.url()).pathname).toBe(runPath(RUNS.waiting));
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: the address of the queue before Run D (`/intakes`) dead, so that a link made before it goes nowhere.
  test('the old address of the queue leads to the queue by run', async ({ page }) => {
    const opened = await open(page, '/intakes');

    await expect(page.getByRole('heading', { level: 1, name: 'Receiving' })).toBeVisible();
    await expect(table(page, 'Runs')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(QUEUE);
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the receiving queue, by run', () => {
  // Break caught: the queue drawing a declared count (a blind vendor's included), a request that is not the server's own filter, or a rider named by a number.
  test('lists the runs that wait, oldest first, naming the rider and the vendors, and nothing of any count: not in a response, not on the page', async ({
    page,
  }) => {
    const opened = await open(page, QUEUE);

    const rows = table(page, 'Runs').getByRole('row');
    await expect(rows.filter({ hasText: 'ACC-MF-4PX8RT' })).toHaveCount(0);
    const waiting = rows.filter({ hasText: 'ACC-MF-7KQ2MZ' });
    await expect(waiting).toContainText('Kofi Boateng');
    await expect(waiting).toContainText('Kente Crafts, Shea Naturals +1 more');
    await expect(waiting).toContainText('3 of 3 vendors still to check in');
    await expect(waiting).toContainText('No one');

    const [list] = reads(opened.api, '/receiving-runs');
    expect(list?.search).not.toContain('hub_id');
    await expectBlind(page, opened);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('has the views of the server’s filter, and a lookup the server answers', async ({
    page,
  }) => {
    const opened = await open(page, `${QUEUE}?view=needs_decision`);

    const rows = table(page, 'Runs').getByRole('row');
    await expect(rows.filter({ hasText: 'ACC-MF-4PX8RT' })).toContainText(
      '1 vendor needs a decision',
    );
    await expect(rows.filter({ hasText: 'ACC-MF-4PX8RT' })).toContainText(
      '1 parcel being searched for',
    );
    expect(reads(opened.api, '/receiving-runs').at(-1)?.search).toContain('view=needs_decision');

    await page.goto(`${QUEUE}?view=all&q=Shea`);
    await expect(rows.filter({ hasText: 'ACC-MF-7KQ2MZ' })).toBeVisible();
    await expect(rows.filter({ hasText: 'ACC-MF-4PX8RT' })).toHaveCount(0);
    expect(reads(opened.api, '/receiving-runs').at(-1)?.search).toContain('q=Shea');
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the run’s page: All N here', () => {
  // Break caught: a confirmation in other words than the owner's, a Cancel that is not a button, a number sent that is not the number shown, a key or a version missing, or a lock taken by opening the page.
  test('asks in the owner’s words, sends the number shown with a key and the vendor’s version, and takes the lock only on the act', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });
    await expect(kente.getByText('4 parcels photographed')).toBeVisible();
    expect(sent(opened.api, '/lock')).toHaveLength(0);

    await kente.getByRole('button', { name: 'All 4 here' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Confirm 4 parcels from Kente Crafts?' });
    await expect(
      dialog.getByText('I counted 4 parcels from this vendor on the table.'),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(sent(opened.api, '/check-in')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Yes, all 4 are here' }).click();

    await expect(kente.getByText('Kente Crafts is checked in.')).toBeVisible();
    await expect(kente.getByText('Next: Shea Naturals')).toBeVisible();
    await expect(kente.getByText('Checked in and cleared')).toBeVisible();
    const [finish] = sent(opened.api, '/check-in');
    expect(finish?.body).toEqual({ all_arrived: true, confirmed_count: 4 });
    expect(finish?.ifMatch).toBe('"r1"');
    expect(finish?.idempotencyKey).toMatch(KEY);
    expect(sent(opened.api, '/lock')).toHaveLength(1);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: the photos drawn before they are near, or a picture whose address is shown as text.
  test('draws each parcel’s photo from an address of its own and shows no address', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting));
    await expect(
      page.getByRole('region', { name: 'Kente Crafts' }).getByRole('button', { name: 'Parcel 1' }),
    ).toBeVisible();

    await expect.poll(() => opened.api.images.length).toBeGreaterThanOrEqual(6);
    expect(await page.locator('body').innerText()).not.toMatch(
      /test-evidence-store|token=|https?:\/\//,
    );
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the run’s page: the count is different', () => {
  // Break caught: a tap that sends a key or a version (it states a desired state), a tile that is a toggle before the officer chose, a finish that sends a number, a parcel not tapped that is not missing.
  test('taps each parcel that is here, finishes the vendor as tapped, and shows what is missing with its photo', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });
    await expect(kente.getByRole('button', { name: 'Parcel 1' })).not.toHaveAttribute(
      'aria-pressed',
    );
    await kente.getByRole('button', { name: 'The count is different' }).click();

    for (const n of [1, 2, 3]) {
      await kente.getByRole('button', { name: `Parcel ${String(n)}`, exact: true }).click();
      await expect(
        kente.getByRole('button', { name: `Parcel ${String(n)}, Checked in` }),
      ).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(kente.getByText('3 of 4 checked in')).toBeVisible();
    const taps = opened.api.calls.filter((call) => call.method === 'PUT');
    expect(taps.map((call) => call.body)).toEqual([
      { arrived: true },
      { arrived: true },
      { arrived: true },
    ]);
    for (const tap of taps) {
      expect(tap.ifMatch).toBeUndefined();
      expect(tap.idempotencyKey).toBeUndefined();
    }
    // The run is read once: a tap is taken into the page from the answer.
    expect(reads(opened.api, `/receiving-runs/${RUNS.waiting}`)).toHaveLength(1);

    await kente.getByRole('button', { name: 'Finish this vendor' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Finish Kente Crafts?' });
    await expect(
      dialog.getByText('1 parcel you did not tap will be marked missing.'),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Finish this vendor' }).click();

    await expect(kente.getByText('A senior officer will decide about this vendor.')).toBeVisible();
    await expect(kente.getByRole('button', { name: 'Parcel 4, Missing' })).toBeVisible();
    const [finish] = sent(opened.api, '/check-in');
    expect(finish?.body).toEqual({ all_arrived: false });
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: a count finished on a vendor read before another officer finished it: the finish is refused as stale, in words, and the page reads the vendor again.
  test('says in words that the vendor changed when it was finished by someone else, and offers to read it again', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });
    await kente.getByRole('button', { name: 'All 4 here' }).click();
    // Another officer finishes the vendor between the page's read and the confirmation.
    const vendor = opened.api.world.runs[0]?.vendors[0];
    if (vendor === undefined) throw new Error('no vendor');
    vendor.version += 1;
    await page.getByRole('button', { name: 'Yes, all 4 are here' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: /This vendor changed after you opened it/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Reload the record' }).click();
    await expect(
      page.getByRole('alertdialog', { name: 'Confirm 4 parcels from Kente Crafts?' }),
    ).toBeVisible();
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the run’s page: a finished run', () => {
  // Break caught: a finished run that leaves the officer to work out the next step, or that does not show the rider the picture of what is missing.
  test('leads with the rider’s bag, says what each vendor came to, and shows the missing parcel’s photo', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.decision));
    const summary = page.getByRole('region', { name: 'Before the rider leaves' });

    await expect(summary.getByText('Check the rider’s bag before they leave.')).toBeVisible();
    await expect(summary.getByText('Yaw Textiles: 1 checked in, 1 missing')).toBeVisible();
    await expect(
      summary.getByRole('list', { name: 'Photos of Yaw Textiles’s missing parcels' }),
    ).toBeVisible();
    await expect(
      summary.getByText('A senior officer will decide about Yaw Textiles.'),
    ).toBeVisible();
    await expect.poll(() => opened.api.images.length).toBeGreaterThanOrEqual(1);
    expect(opened.api.unexpected).toEqual([]);
  });

  // Break caught: a missing parcel that cannot be found again, or a found parcel that closes the case (a senior officer closes it).
  test('checks a missing parcel in when it is found, and the case stays open', async ({ page }) => {
    const opened = await open(page, runPath(RUNS.decision));
    const yaw = page.getByRole('region', { name: 'Yaw Textiles' });

    const dialog = await openParcel(
      page,
      yaw.getByRole('button', { name: 'Parcel 2, Missing' }),
      'Parcel 2',
    );
    await expect(dialog.getByText(/Missing since /)).toBeVisible();
    await dialog.getByRole('button', { name: 'Found it' }).click();

    await expect(yaw.getByText('Parcel 2 is found and checked in.')).toBeVisible();
    await expect(yaw.getByRole('button', { name: 'Parcel 2, Checked in' })).toBeVisible();
    await expect(yaw.getByText('A senior officer will decide about this vendor.')).toBeVisible();
    const found = opened.api.calls.filter((call) => call.method === 'PUT');
    expect(found.map((call) => call.body)).toEqual([{ arrived: true }]);
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the run’s page: a vendor counted without photos', () => {
  // Break caught (D-D3): the rider's number, or a photo, on the page of a vendor whose photos Ops excused: not in a response, not on the page, not in the title, the accessible tree or the console.
  test('says one line, offers the count, and shows nothing of the rider’s number', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting));
    const blind = page.getByRole('region', { name: 'Adwoa Stalls' });

    await expect(blind.getByText('No photos at the door: counted, not checked in')).toBeVisible();
    await expect(
      blind.getByText(/The rider’s number is shown only after you have typed yours\./),
    ).toBeVisible();
    await expect(blind.getByRole('link', { name: 'Count the parcels' })).toHaveAttribute(
      'href',
      count(IDS.waiting),
    );
    await expect(blind.locator('img')).toHaveCount(0);
    await expectBlind(page, opened);
    expect(opened.api.unexpected).toEqual([]);
  });

  // Break caught: a server that carries the rider's number in the run's page drawn, or half drawn: the answer is refused whole and the number is nowhere on the page.
  test('refuses an answer that carries the rider’s number, and the number is nowhere on the page', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting), { leak: true });

    await expect(
      page.getByRole('alert').filter({ hasText: 'This run could not be loaded.' }),
    ).toBeVisible();
    expect(opened.received.some((answer) => THE_NUMBER.test(answer.text))).toBe(true);
    expect(await page.content()).not.toMatch(THE_NUMBER);
    expect(await page.locator('body').ariaSnapshot()).not.toMatch(THE_NUMBER);
    for (const line of opened.console) expect(line).not.toMatch(THE_NUMBER);
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the run’s page: a photo taken at the hub', () => {
  const PHOTO = { name: 'parcel.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('photo') };

  // Break caught: a parcel added with no photo, a photo cited before it is stored, an upload that carries credentials or a referrer, or an extra sent with a version.
  test('adds a parcel that is not on the list: the photo is stored in its three steps, then cited once', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });

    await kente.getByRole('button', { name: 'Add a parcel not on the list' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Add a parcel that is not on the list' });
    await dialog.getByRole('button', { name: 'Add this parcel' }).click();
    await expect(dialog.getByText('Take a photo of the parcel.', { exact: true })).toBeVisible();
    expect(sent(opened.api, '/extra-parcels')).toHaveLength(0);

    await gallery(dialog).setInputFiles(PHOTO);
    await expect(dialog.getByText('Stored', { exact: true })).toBeVisible();
    await dialog.getByLabel(/Note/).fill('A box of soap');
    await dialog.getByRole('button', { name: 'Add this parcel' }).click();

    await expect(
      kente.getByText('The parcel was added. A senior officer will decide about it.'),
    ).toBeVisible();
    await expect(kente.getByRole('button', { name: 'Extra parcel 5, Checked in' })).toBeVisible();
    await expect(kente.getByRole('button', { name: /^All \d+ here$/ })).toHaveCount(0);
    const order = opened.api.calls
      .filter((call) => call.method !== 'GET' && !call.path.endsWith('/retrieval-authorization'))
      .map((call) => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/g, ':id')}`);
    // The photo is stored when it is chosen; confirming is the act that takes the vendor's lock, and then cites the photo.
    expect(order).toEqual([
      'POST /api/v1/evidence',
      'POST /api/v1/evidence/:id/complete',
      'POST /api/v1/hub-intakes/:id/lock',
      'POST /api/v1/hub-intakes/:id/extra-parcels',
    ]);
    expect(opened.api.uploads).toHaveLength(1);
    for (const name of Object.keys(opened.api.uploads[0]?.headers ?? {})) {
      expect(name, 'a header of the upload').not.toMatch(
        /csrf|idempotency|authorization|cookie|referer/i,
      );
    }
    const [extra] = sent(opened.api, '/extra-parcels');
    expect(extra?.ifMatch).toBeUndefined();
    expect(extra?.idempotencyKey).toMatch(KEY);
    expect(extra?.body).toMatchObject({ note: 'A box of soap' });
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: damage recorded with no photo, on no parcel, or on a version the officer did not read.
  test('records damage on a parcel: its own photo, a note, once, on the vendor’s version', async ({
    page,
  }) => {
    const opened = await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });
    await kente.getByRole('button', { name: 'All 4 here' }).click();
    await page.getByRole('button', { name: 'Yes, all 4 are here' }).click();
    await expect(kente.getByText('Kente Crafts is checked in.')).toBeVisible();

    const parcel = await openParcel(
      page,
      kente.getByRole('button', { name: 'Parcel 2, Checked in' }),
      'Parcel 2',
    );
    await parcel.getByRole('button', { name: 'Damaged' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Record damage on Parcel 2?' });
    await dialog.getByRole('button', { name: 'Record the damage' }).click();
    await expect(dialog.getByText('Take a photo of the damage.')).toBeVisible();
    await gallery(dialog).setInputFiles(PHOTO);
    await expect(dialog.getByText('Stored', { exact: true })).toBeVisible();
    await dialog.getByLabel(/What is damaged/).fill('A torn corner');
    await dialog.getByRole('button', { name: 'Record the damage' }).click();

    await expect(kente.getByText('The damage to Parcel 2 is recorded.')).toBeVisible();
    await expect(kente.getByRole('button', { name: 'Parcel 2, Damaged' })).toBeVisible();
    const [condition] = sent(opened.api, '/condition');
    expect(condition?.ifMatch).toBe('"r2"');
    expect(condition?.body).toMatchObject({ condition: 'DAMAGED', note: 'A torn corner' });
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });
});

test.describe('the run’s page: the hub floor', () => {
  // Break caught (DESIGN_SYSTEM sections 11 and 12): a control under the 56 px the hub floor asks of a thumb: a tile, a button of the bar, a button of the confirmation.
  test('every control the officer presses is at least 56 px high', async ({ page }) => {
    await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });
    await expect(kente.getByRole('button', { name: 'All 4 here' })).toBeVisible();

    const heights = async (selector: ReturnType<Page['locator']>): Promise<number[]> =>
      // The layout height (a dialog opens with a transform that scales it for a moment, which a bounding box would measure).
      selector.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).offsetHeight));
    for (const height of await heights(kente.locator('.receiving-actions button'))) {
      expect(height).toBeGreaterThanOrEqual(56);
    }
    for (const height of await heights(kente.locator('.ui-photo-tile'))) {
      expect(height).toBeGreaterThanOrEqual(56);
    }
    await kente.getByRole('button', { name: 'All 4 here' }).click();
    for (const height of await heights(page.getByRole('alertdialog').locator('button.ui-button'))) {
      expect(height).toBeGreaterThanOrEqual(56);
    }
  });

  // Break caught: an action bar that is behind the on-screen keyboard at 768 px (the visual viewport is shorter than the window), so that the officer closes the keyboard to reach the button.
  test('lifts the action bar above the on-screen keyboard at 768 px, by what the visual viewport says', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });
    await expect(kente.getByRole('button', { name: 'All 4 here' })).toBeVisible();
    const before = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset'),
    );
    expect(before.trim()).toBe('0px');

    // The officer is at the vendor's photos, so the page is scrolled to its card. A bar is kept within its own card, so it can be lifted above the keyboard only where its card is in view: with the
    // floor's 56 px links the page's header is taller, and the card of an unscrolled page began below the 400 px that the keyboard leaves.
    await kente.evaluate((node) => {
      node.scrollIntoView({ block: 'start' });
    });
    // The keyboard opens: the part of the page the person can see is 400 px high.
    await page.evaluate(() => {
      const viewport = window.visualViewport;
      if (viewport === null) throw new Error('this browser has no visual viewport');
      Object.defineProperty(viewport, 'height', { configurable: true, get: () => 400 });
      viewport.dispatchEvent(new Event('resize'));
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--keyboard-inset'),
        ),
      )
      .toBe('624px');
    const bar = kente.locator('.receiving-actions');
    const bottom = await bar.evaluate((node) => node.getBoundingClientRect().bottom);
    expect(bottom).toBeLessThanOrEqual(400);
  });

  // Break caught: a page that says nothing when the connection is lost, so that the officer goes on checking parcels in and none of it is saved.
  test('says what the officer does now is not saved when the browser goes offline, and says nothing when it is back', async ({
    context,
    page,
  }) => {
    await open(page, runPath(RUNS.waiting));
    await expect(page.getByRole('region', { name: 'Kente Crafts' })).toBeVisible();
    await expect(page.getByText('No connection. What you do now is not saved.')).toHaveCount(0);

    await context.setOffline(true);
    await expect(page.getByText('No connection. What you do now is not saved.')).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText('No connection. What you do now is not saved.')).toHaveCount(0);
  });
});

test.describe('the hub floor on the receiving screens, measured (the review of the pictures)', () => {
  const FLOOR = 56;
  /** The code of a row opens its page from the height of the row, less the 1px separator inside it. */
  const ROW_REACH = FLOOR - 1;
  const SIZES = [
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ] as const;
  /** The layout height of the first element it finds (a dialog opens with a transform that scales it for a moment, which a bounding box would measure). */
  const heightOf = (locator: ReturnType<Page['locator']>): Promise<number> =>
    locator.first().evaluate((node) => (node as HTMLElement).offsetHeight);
  /** Every view of the queue is in sight: a row of views that scrolls hides one behind its edge (a phone's second view that ended at it looked complete, and the third lay wholly out of sight). */
  const viewsAllInSight = (page: Page): Promise<boolean> =>
    page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>('.ui-view-tabs__scroll');
      if (strip === null) return false;
      const edge = strip.getBoundingClientRect().right;
      const tabs = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')];
      return (
        strip.scrollWidth <= strip.clientWidth &&
        tabs.length > 0 &&
        tabs.every((tab) => tab.getBoundingClientRect().right <= edge + 1)
      );
    });

  for (const size of SIZES) {
    // Break caught (defects 6 and 7): the views, the lookup, its button or the code of a run at the working height (44, 44, 36 and 17 to 22 px), or a row of views that scrolls under the page's edge.
    test(`the receiving queue: the views, the lookup, its button, Refresh and the code of a run are 56 px, and every view is in sight, at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, QUEUE);
      const main = page.getByRole('main');
      await expect(main.getByRole('link', { name: /^ACC-MF-/ }).first()).toBeVisible();

      for (const tab of await main.getByRole('tab').all()) {
        expect(await heightOf(tab)).toBeGreaterThanOrEqual(FLOOR);
      }
      expect(await heightOf(main.getByRole('searchbox'))).toBeGreaterThanOrEqual(FLOOR);
      expect(
        await heightOf(main.getByRole('button', { name: 'Search', exact: true })),
      ).toBeGreaterThanOrEqual(FLOOR);
      expect(await heightOf(main.getByRole('button', { name: /^Refresh/ }))).toBeGreaterThanOrEqual(
        FLOOR,
      );
      expect(await heightOf(main.getByRole('link', { name: /^ACC-MF-/ }))).toBeGreaterThanOrEqual(
        ROW_REACH,
      );
      expect(await viewsAllInSight(page)).toBe(true);
    });

    // Break caught (defects 6, 7 and 10): the views of the missing list at the working height or behind the edge ("Written off, vendor not to…"), and the control that opens a parcel under the floor.
    test(`the list of missing parcels: the views and the control that opens a parcel are 56 px, and every view is in sight, at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, MISSING, { permissions: SENIOR });
      const main = page.getByRole('main');
      const opener = main.getByRole('button', { name: /^Open the missing parcel from/ });
      await expect(opener.first()).toBeVisible();

      for (const tab of await main.getByRole('tab').all()) {
        expect(await heightOf(tab)).toBeGreaterThanOrEqual(FLOOR);
      }
      expect(await heightOf(opener)).toBeGreaterThanOrEqual(ROW_REACH);
      expect(await viewsAllInSight(page)).toBe(true);
    });
  }

  // Break caught (defects 3 and 7): the bar of a vendor whose card begins at the foot of the first screen drawn over its own card's name (every bar was kept at the foot of the screen), and the way up
  // the trail and Refresh at 20 and 24 px.
  test('the run: no bar is drawn over the name of a vendor on the first screen, and the trail and Refresh are 56 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await open(page, runPath(RUNS.waiting));
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 2, name: 'Shea Naturals' })).toBeVisible();

    // The name of each vendor that is on the screen is the topmost thing at its own middle: nothing is drawn over it.
    const covered = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('main h2')]
        .filter((heading) => {
          const box = heading.getBoundingClientRect();
          if (box.bottom <= 0 || box.top >= window.innerHeight) return false;
          const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return top === null || !heading.contains(top);
        })
        .map((heading) => heading.textContent),
    );
    expect(covered).toEqual([]);
    expect(await heightOf(main.getByRole('link', { name: 'Receiving' }))).toBeGreaterThanOrEqual(
      FLOOR,
    );
    expect(await heightOf(main.getByRole('button', { name: /^Refresh/ }))).toBeGreaterThanOrEqual(
      FLOOR,
    );
  });

  // Break caught (defect 7): the buttons of a photo that was taken (Retake, Leave out) at the working height among the 56 px buttons that took it, in a dialog of the floor.
  test('a photo taken in a dialog: Retake and Leave out are 56 px', async ({ page }) => {
    await open(page, runPath(RUNS.waiting));
    const kente = page.getByRole('region', { name: 'Kente Crafts' });
    await kente.getByRole('button', { name: 'Add a parcel not on the list' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Add a parcel that is not on the list' });
    await gallery(dialog).setInputFiles({
      name: 'parcel.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from('photo'),
    });
    await expect(dialog.getByText('Stored', { exact: true })).toBeVisible();

    expect(
      await heightOf(dialog.getByRole('button', { name: 'Retake photo 1' })),
    ).toBeGreaterThanOrEqual(FLOOR);
    expect(
      await heightOf(dialog.getByRole('button', { name: 'Leave out photo 1' })),
    ).toBeGreaterThanOrEqual(FLOOR);
  });

  for (const size of SIZES) {
    // Break caught (defects 2 and 7): the decision before the facts at a narrow width (the form's own summary slot follows its fields), or the outcomes at 46 px rows.
    test(`the decision: the facts come before the outcomes, and each outcome is a 56 px row, at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, discrepancy(RUNS.yaw), { permissions: SENIOR });
      const facts = page.getByRole('region', { name: 'What happened to this vendor' });
      const outcomes = page.getByRole('group', { name: /What do you decide\?/ });
      await expect(outcomes).toBeVisible();

      const factsBox = await facts.boundingBox();
      const outcomesBox = await outcomes.boundingBox();
      if (factsBox === null || outcomesBox === null) throw new Error('the page is not drawn');
      expect(factsBox.y + factsBox.height).toBeLessThanOrEqual(outcomesBox.y);
      for (const label of await outcomes.locator('label').all()) {
        expect(await heightOf(label)).toBeGreaterThanOrEqual(FLOOR);
      }
      // The vendor is said by its name, never by its code alone.
      await expect(page.getByText(/^Yaw Textiles\. Say what happens next/)).toBeVisible();
    });
  }

  // Break caught (defect 5): the page's heading said twice, and a field the width of the page and 44 px high for a few digits; the vendor said by its code alone.
  test('the count of a vendor with no photos: one heading, the vendor by its name, a field for a few digits at 56 px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await open(page, count(IDS.waiting));
    const field = page.getByRole('textbox', { name: /Parcels counted/ });
    await expect(field).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Count the parcels' })).toHaveCount(1);
    expect(await heightOf(field)).toBeGreaterThanOrEqual(FLOOR);
    const width = await field.evaluate((node) => (node as HTMLElement).offsetWidth);
    expect(width).toBeLessThanOrEqual(160);
    await expect(page.getByText(/^Adwoa Stalls\. Count what was handed over/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Adwoa Stalls' })).toBeVisible();
  });

  // Break caught (defect 8): the heading of the finished run's summary set smaller than the sentence under it.
  test('the finished run: the summary’s heading is not smaller than the sentence under it', async ({
    page,
  }) => {
    await open(page, runPath(RUNS.decision));
    const summary = page.getByRole('region', { name: 'Before the rider leaves' });
    await expect(summary).toBeVisible();

    const size = (locator: ReturnType<Page['locator']>): Promise<number> =>
      locator.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    const heading = await size(summary.getByRole('heading', { name: 'Before the rider leaves' }));
    const lead = await size(summary.getByText('Check the rider’s bag before they leave.'));
    expect(heading).toBeGreaterThanOrEqual(lead);
  });
});

test.describe('the blind count', () => {
  // Break caught: the declaration in any form on the count page, whatever it was sent: not greyed, not in a tooltip, not in a response the page discards; a lock taken by opening the page.
  test('asks for the number alone in one line, takes the lock on the first digit, with the declaration in no form, then reveals the comparison once the count commits', async ({
    page,
  }) => {
    const opened = await open(page, count(IDS.waiting));

    await expect(page.getByRole('heading', { level: 1, name: 'Count the parcels' })).toBeVisible();
    const field = page.getByRole('textbox', { name: /Parcels counted/ });
    await expect(field).toHaveValue('');
    await expect(
      page.getByText(
        'Count this vendor’s parcels on the table first. The rider’s number is shown only after you have typed yours.',
      ),
    ).toBeVisible();
    // The lock is taken on the first digit and never by opening the page.
    expect(sent(opened.api, '/lock')).toHaveLength(0);
    await field.hover();
    await expectBlind(page, opened);

    await field.pressSequentially('1');
    await expect.poll(() => sent(opened.api, '/lock').length).toBe(1);
    await field.fill('');
    await enterCount(page, String(COUNTED_SHORT));
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`Record a count of ${String(COUNTED_SHORT)} parcels?`);
    await expectBlind(page, opened);
    expect(sent(opened.api, '/count')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Record the count' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    await expect(
      page.getByText(
        'Your count is recorded. The rider’s number is shown below, with the comparison.',
      ),
    ).toBeVisible();
    const came = page.getByRole('region', { name: 'What came of this vendor' });
    await expect(came).toContainText(String(DECLARED));
    await expect(came).toContainText(String(COUNTED_SHORT));
    await expect(came).toContainText('7 parcels fewer');

    // The one act: the physical count and nothing else, under a fresh key and the version of the read; the lock never moved the version.
    const [act] = sent(opened.api, '/count');
    expect(act?.body).toEqual({ physical_count: COUNTED_SHORT });
    expect(act?.idempotencyKey).toMatch(KEY);
    expect(act?.ifMatch).toBe('"v1"');
    // The first answer that carries the declaration is the answer to the committed count, and the record read after it.
    const carrying = opened.received.filter((answer) =>
      answer.text.includes('rider_declared_count'),
    );
    expect(carrying.length).toBeGreaterThan(0);
    expect(carrying.every((answer) => !answer.url.endsWith('/lock'))).toBe(true);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: the declaration drawn from an answer that carried it by mistake: the screens refuse such an answer whole, so no page can be given the number by an API that sent it.
  test('refuses every answer that carries the declaration before the count, and the number is nowhere on the page', async ({
    page,
  }) => {
    // The run's page is what the old queue was here: the first screen of the receiving side that reads a vendor counted blind.
    const opened = await open(page, runPath(RUNS.waiting), { leak: true });
    await expect(page.getByText('This run could not be loaded.').first()).toBeVisible();
    // The test is sensitive: the leaking API did send it.
    expect(opened.received.some((answer) => THE_NUMBER.test(answer.text))).toBe(true);
    expect(await page.content()).not.toMatch(THE_NUMBER);
    expect(await page.locator('body').ariaSnapshot()).not.toMatch(THE_NUMBER);

    await page.goto(count(IDS.waiting));
    await expect(page.getByText('This vendor could not be loaded.').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Parcels counted/ })).toHaveCount(0);
    expect(await page.content()).not.toMatch(THE_NUMBER);
    expect(await page.title()).not.toMatch(THE_NUMBER);

    await page.goto(record(IDS.waiting));
    await expect(page.getByText('This vendor could not be loaded.').first()).toBeVisible();
    expect(await page.content()).not.toMatch(THE_NUMBER);
    for (const line of opened.console) expect(line).not.toMatch(THE_NUMBER);
    expect(opened.api.unexpected).toEqual([]);
  });

  test('refuses a count that is not a whole number from zero, and sends nothing', async ({
    page,
  }) => {
    const opened = await open(page, count(IDS.waiting));
    for (const typed of ['', '-1', '2.5', 'abc']) {
      await enterCount(page, typed);
      await expect(
        page.getByText('Enter the number of parcels you counted, as a whole number from 0.'),
      ).toBeVisible();
      await expect(page.getByRole('textbox', { name: /Parcels counted/ })).toBeFocused();
    }
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(sent(opened.api, '/count')).toHaveLength(0);
  });

  // Break caught (D-D3): a vendor photographed at the door counted by number, which would hide what the door photos are for.
  test('sends a vendor photographed at the door to its run’s page, tells why there, and takes no lock', async ({
    page,
  }) => {
    const opened = await open(page, count(RUNS.kente));

    await expect(
      page.getByText(
        'This vendor was photographed at the door, so it is checked in on its run’s page and is never counted.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-MF-7KQ2MZ' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Parcels counted/ })).toHaveCount(0);
    expect(sent(opened.api, '/lock')).toHaveLength(0);
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the lock tells who is working and stops nobody', () => {
  // Break caught (surfaces/ops-portal.md section 9): another officer's lock told as a gate, as a name, or in the words of the people who built it; a lock taken by opening the page.
  test('tells that someone else opened this, keeps the form, and takes the lock only on the first digit', async ({
    page,
  }) => {
    const opened = await open(page, count(IDS.held));

    await expect(
      page.getByText('Someone else opened this check-in at 08:20. It stops nobody.'),
    ).toBeVisible();
    const field = page.getByRole('textbox', { name: /Parcels counted/ });
    await expect(field).toBeEnabled();
    expect(await page.content()).not.toContain(IDS.other);
    expect(sent(opened.api, '/lock')).toHaveLength(0);

    await field.pressSequentially('1');
    await expect.poll(() => sent(opened.api, '/lock').length).toBe(1);
    // The lock changed nothing of the vendor: no count, no version.
    expect(sent(opened.api, '/count')).toHaveLength(0);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: the second officer given a bare failure: it says someone else counted first, that nothing was changed, and where to look; and the count is the first officer's.
  test('tells the second officer of two who count what happened, and reads the first’s count on reload', async ({
    page,
  }) => {
    const opened = await open(page, count(IDS.waiting), { raceOnCount: true });

    await enterCount(page, String(COUNTED_SHORT));
    await page.getByRole('alertdialog').getByRole('button', { name: 'Record the count' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(
      'Someone else counted this vendor first, so your count was not kept and nothing was changed.',
    );
    await expect(dialog).toContainText('Only the first count is kept');
    await expect(page.getByText('Diagnostic text that must never reach a screen.')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Reload the record' }).click();
    await expect(
      page.getByText(
        'Someone else counted this vendor first, so their count is the one that was recorded and nothing was changed by this page.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the vendor' })).toHaveAttribute(
      'href',
      record(IDS.waiting),
    );
    await expect(page.getByRole('textbox', { name: /Parcels counted/ })).toHaveCount(0);
    expect(sent(opened.api, '/count')).toHaveLength(1);
    expect(opened.api.world.intakes.find((intake) => intake.id === IDS.waiting)?.physical).toBe(
      DECLARED - 1,
    );
    expect(problemsBut(opened.watch, 409)).toEqual([]);
  });
});

test.describe('the record of a vendor counted without photos', () => {
  // Break caught: a comparison, a declaration or a photo on the record of a vendor that has not been counted, or a request for the photos before the count.
  test('before the count says it is waiting to be counted and offers the count, with no comparison and no request for a photo', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.waiting));

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Count the parcels' })).toHaveAttribute(
      'href',
      count(IDS.waiting),
    );
    await expect(
      page
        .getByText(/This vendor was not photographed at the door, so its parcels are counted/)
        .first(),
    ).toBeVisible();
    await expect(page.getByText('The rider said at handover')).toHaveCount(0);
    await expect(page.getByText('The door photos')).toHaveCount(0);
    expect(authorizations(opened.api)).toHaveLength(0);
    expect(opened.api.calls.some((call) => call.path.includes('/evidence'))).toBe(false);
    await expectBlind(page, opened);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: the declaration, the count or the comparison drawn wrongly, a difference worked out by the page, listing the orders offered, or an act offered to a session without its key.
  test('after the count shows the comparison as the API stated it, offers its acts by key, and never offers listing the orders', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short), { permissions: SENIOR });

    const came = page.getByRole('region', { name: 'What came of this vendor' });
    await expect(came).toContainText(String(DECLARED));
    await expect(came).toContainText(String(COUNTED_SHORT));
    await expect(came).toContainText('7 parcels fewer');
    await expect(page.getByRole('link', { name: 'Decide' })).toHaveAttribute(
      'href',
      discrepancy(IDS.short),
    );
    await expect(page.getByRole('button', { name: 'Record damage' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Correct the count' })).toBeVisible();
    await expect(page.getByRole('link', { name: /itemi|list the orders|close/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /itemi|list the orders|close/i })).toHaveCount(0);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('does not offer the decision or the correction to a session without the key, and says a senior officer will decide', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short));

    await expect(page.getByText('A senior officer will decide this.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Decide' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Correct the count' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Record damage' })).toBeVisible();
    await page.goto(discrepancy(IDS.short));
    await expect(
      page.getByText('A senior officer decides this. Ask one to open this page.'),
    ).toBeVisible();
    await expect(page.getByText(/administrator/i)).toHaveCount(0);
    await expect(page.getByRole('radio')).toHaveCount(0);
    expect(opened.api.unexpected).toEqual([]);
  });

  // Break caught: the door photos drawn with a picture before one is opened, an authorization asked for ahead of the officer, an address or a key shown, or one kept after it is closed.
  test('opens the door photos one at a time, each with an authorization of its own, loaded from the page’s origin, and drops it on close', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short));

    const photos = page.getByRole('list', { name: 'The door photos' });
    await expect(photos.getByRole('button')).toHaveCount(3);
    expect(authorizations(opened.api)).toHaveLength(0);
    expect(opened.api.images).toEqual([]);
    await expect(page.locator('img.stop-photo__image')).toHaveCount(0);

    await photos.getByRole('button', { name: 'Open Door photo 2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Door photo 2' });
    await expect(dialog.getByRole('img')).toBeVisible();
    await expect
      .poll(() =>
        dialog
          .getByRole('img')
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth),
      )
      .toBe(800);
    expect(authorizations(opened.api)).toHaveLength(1);
    expect(opened.api.images).toHaveLength(1);
    expect(opened.api.images[0]).toContain('/test-evidence-store/photo/');
    // The address is held by the image alone: it is in no text of the page and in no attribute but the image's own.
    expect(await page.locator('body').innerText()).not.toContain('test-evidence-store');
    expect(await page.locator('body').innerText()).not.toContain('token=issued');
    expect(await page.locator('[src*="test-evidence-store"]').count()).toBe(1);
    expect(
      await page
        .locator(
          '[href*="test-evidence-store"], [title*="test-evidence-store"], [alt*="test-evidence-store"]',
        )
        .count(),
    ).toBe(0);

    await dialog.getByRole('button', { name: 'Close the photo' }).click();
    await expect(page.locator('img.stop-photo__image')).toHaveCount(0);
    await photos.getByRole('button', { name: 'Open Door photo 2' }).click();
    await expect(page.getByRole('dialog', { name: 'Door photo 2' }).getByRole('img')).toBeVisible();
    expect(authorizations(opened.api)).toHaveLength(2);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });
});

test.describe('the damage of a vendor counted without photos', () => {
  const FILE = Buffer.from('a synthetic photo of two crushed cartons');

  // Break caught: evidence declared for another purpose or with a checksum that is not the file's, bytes sent with the session or a referrer, a record cited before it is stored, a storage key or an address on the screen, the version lost.
  test('uploads the photo in its three steps with no credentials and no referrer, cites it, and records the damage once', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short), { permissions: SENIOR });

    await page.getByRole('button', { name: 'Record damage' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Record damage for this vendor?' });
    await dialog.getByRole('button', { name: 'Record the damage' }).click();
    await expect(dialog.getByText('Take a photo of the damage.')).toBeVisible();
    expect(sent(opened.api, '/condition')).toHaveLength(0);

    await gallery(dialog).setInputFiles({
      name: 'crushed.jpg',
      mimeType: 'image/jpeg',
      buffer: FILE,
    });
    await expect(dialog.getByText('Stored', { exact: true })).toBeVisible();

    const [declaration] = sent(opened.api, '/evidence');
    expect(declaration?.body).toMatchObject({
      owner_type: 'PICKUP_INTAKE',
      owner_id: IDS.short,
      purpose: 'CONDITION',
      content_type: 'image/jpeg',
      byte_size: FILE.length,
      checksum_sha256: createHash('sha256').update(FILE).digest('hex'),
    });
    expect(declaration?.idempotencyKey).toMatch(KEY);
    const [upload] = opened.api.uploads;
    expect(opened.api.uploads).toHaveLength(1);
    // WebKit tells a test neither the bytes nor their length: where it does, they are the file's.
    if (upload?.size !== null) expect(upload?.size).toBe(FILE.length);
    expect(upload?.headers['content-type']).toBe('image/jpeg');
    // The bytes go to the store and not to the API: no cookie of the session, no token of the portal, no referrer.
    expect(upload?.headers.cookie).toBeUndefined();
    expect(upload?.headers.referer).toBeUndefined();
    expect(
      Object.keys(upload?.headers ?? {}).some((name) =>
        /csrf|idempotency|authorization/i.test(name),
      ),
    ).toBe(false);
    const [completion] = acts(opened.api).filter((call) => call.path.endsWith('/complete'));
    expect(completion?.ifMatch).toBe('"e1"');
    for (const planted of [PLANTED.objectKey, PLANTED.address, PLANTED.signature]) {
      expect(await page.content()).not.toContain(planted);
    }

    await dialog.getByLabel(/What is damaged/).fill('Two cartons crushed at one corner.');
    await dialog.getByRole('button', { name: 'Record the damage' }).click();

    await expect(page.getByText('The damage is recorded.')).toBeVisible();
    const [act] = sent(opened.api, '/condition');
    expect(act?.ifMatch).toBe('"v1"');
    expect(act?.idempotencyKey).toMatch(KEY);
    expect(act?.body).toMatchObject({
      condition: 'DAMAGED',
      note: 'Two cartons crushed at one corner.',
      evidence_ids: [expect.stringMatching(KEY)],
    });
    const finding = page
      .getByRole('list', { name: 'What was found, in the order it was made' })
      .getByRole('listitem')
      .first();
    await expect(finding).toContainText('The vendor: Damaged');
    // It is recorded once: the act is not offered again.
    await expect(page.getByRole('button', { name: 'Record damage' })).toHaveCount(0);

    // The photo of the finding is opened like any other: one at a time, with an authorization of its own.
    await finding.getByRole('button', { name: 'Open Photo 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Photo 1' }).getByRole('img')).toBeVisible();
    expect(authorizations(opened.api)).toHaveLength(1);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('asks for a photo of the damage at its field, and does not send without one', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short), { permissions: SENIOR });
    await page.getByRole('button', { name: 'Record damage' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Record damage for this vendor?' });
    await dialog.getByRole('button', { name: 'Record the damage' }).click();
    await expect(dialog.getByText('Take a photo of the damage.')).toBeVisible();
    expect(sent(opened.api, '/condition')).toHaveLength(0);
  });

  test('sends the old address of a vendor’s condition to its record', async ({ page }) => {
    await open(page, `${record(IDS.short)}/condition`, { permissions: SENIOR });
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-IN-3HT6NC' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${record(IDS.short)}$`));
  });
});

test.describe('the record of a vendor checked in against its door photos', () => {
  test('says what came of it, shows what is missing as its photos, and offers the decision and the correction to a senior officer', async ({
    page,
  }) => {
    const opened = await open(page, record(RUNS.yaw), { permissions: SENIOR });

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-IN-6TF5MJ' })).toBeVisible();
    await expect(page.getByText('A senior officer will decide about this vendor.')).toBeVisible();
    const came = page.getByRole('region', { name: 'What came of this vendor' });
    await expect(came).toContainText('Photographed at the door');
    await expect(came).toContainText('Missing');
    await expect(came).toContainText('Compared with the photos');
    await expect(page.getByRole('link', { name: 'Decide' })).toHaveAttribute(
      'href',
      discrepancy(RUNS.yaw),
    );
    await expect(page.getByRole('button', { name: 'Correct the count' })).toBeVisible();

    // The parcel that is missing is the photo of it, opened whole in the viewer: nothing of its identifier or its address is on the page.
    const group = page.getByRole('list', { name: 'Missing parcels of Yaw Textiles' });
    await group.getByRole('button', { name: /Parcel 2/ }).click();
    const viewer = page.getByRole('dialog');
    await expect(viewer.getByRole('img')).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('test-evidence-store');
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });
});

test.describe('the decision', () => {
  // Break caught: the decision sent with a key (the operation declares none), without the version, or without the reason; "vendor told" offered before a write-off, or sending anything.
  test('writes off what is missing on the version read and under no key, then records that the vendor was told, once', async ({
    page,
  }) => {
    const opened = await open(page, discrepancy(RUNS.yaw), { permissions: SENIOR });

    await expect(page.getByRole('radio')).toHaveCount(3);
    await page.getByRole('radio', { name: /Write off what is missing/ }).check();
    await page
      .getByRole('textbox', { name: /Why you decided this/ })
      .fill('Searched the hub and the rider’s bag.');
    await page.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(
      'The search is closed as not found. What was checked in is not changed.',
    );
    await dialog.getByRole('button', { name: 'Record the decision' }).click();

    await expect(page.getByText('Your decision is recorded.')).toBeVisible();
    const [act] = sent(opened.api, '/discrepancy');
    expect(act?.ifMatch).toBe('"r2"');
    expect(act?.idempotencyKey).toBeUndefined();
    expect(act?.body).toEqual({
      outcome: 'WRITTEN_OFF',
      note: 'Searched the hub and the rider’s bag.',
    });
    // The record says what was decided, and offers the record that the vendor was told.
    await expect(page.getByText('Written off: not found')).toBeVisible();
    await page.getByRole('link', { name: 'Record that the vendor was told' }).click();

    await expect(page.getByRole('radio')).toHaveCount(1);
    await expect(
      page.getByText('Records that someone told the vendor. Nothing is sent from here.'),
    ).toBeVisible();
    await page.getByRole('radio').check();
    await page.getByRole('textbox', { name: /Why you decided this/ }).fill('Told by phone.');
    await page.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByRole('alertdialog')).toContainText(
      'This records that someone told the vendor. Nothing is sent from here.',
    );
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Record the decision' })
      .click();

    await expect(page.getByText('Your decision is recorded.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Record that the vendor was told' })).toHaveCount(
      0,
    );
    const decisions = sent(opened.api, '/discrepancy');
    expect(decisions).toHaveLength(2);
    expect(decisions[1]?.body).toEqual({ outcome: 'VENDOR_NOTIFIED', note: 'Told by phone.' });
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('asks for an outcome and a reason at their fields, and sends nothing', async ({ page }) => {
    const opened = await open(page, discrepancy(RUNS.yaw), { permissions: SENIOR });
    await page.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByText('Choose what you decide.')).toBeVisible();
    await expect(page.getByText('Write why you decided this.')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(sent(opened.api, '/discrepancy')).toHaveLength(0);
  });
});

test.describe('the correction of a count', () => {
  // Break caught: a correction sent without a reason or a change, with the parcels that did not change, or on a version the officer did not read.
  test('ticks the parcel that is here, asks for a reason, sends only the parcel changed on the version read under a key, and says the number before and after', async ({
    page,
  }) => {
    const opened = await open(page, record(RUNS.yaw), { permissions: SENIOR });
    const parcel = opened.api.world.runs[1]?.vendors[0]?.parcels[1];

    await page.getByRole('button', { name: 'Correct the count' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Correct the count for Yaw Textiles?' });
    await dialog.getByRole('button', { name: 'Record the correction' }).click();
    await expect(
      dialog.getByText('Change at least one parcel before you record a correction.'),
    ).toBeVisible();
    expect(sent(opened.api, '/correction')).toHaveLength(0);

    await dialog.getByRole('checkbox', { name: 'Parcel 2 is here' }).check();
    await dialog
      .getByRole('textbox', { name: /Why you are correcting this/ })
      .fill('It was on the table.');
    await dialog.getByRole('button', { name: 'Record the correction' }).click();

    await expect(
      page.getByText('The correction is recorded. It was 1; it is now 2.'),
    ).toBeVisible();
    const [act] = sent(opened.api, '/correction');
    expect(act?.ifMatch).toBe('"r2"');
    expect(act?.idempotencyKey).toMatch(KEY);
    expect(act?.body).toEqual({
      reason: 'It was on the table.',
      parcel_changes: [{ parcel_id: parcel?.id, state: 'ARRIVED' }],
    });
    // Nothing is missing now, so nothing waits for a decision.
    await expect(page.getByRole('link', { name: 'Decide' })).toHaveCount(0);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('corrects the number of a vendor counted without photos, with a reason', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short), { permissions: SENIOR });
    await page.getByRole('button', { name: 'Correct the count' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Correct the count?' });
    await dialog.getByRole('textbox', { name: /The number of parcels on the table/ }).fill('131');
    await dialog.getByRole('textbox', { name: /Why you are correcting this/ }).fill('Miscounted.');
    await dialog.getByRole('button', { name: 'Record the correction' }).click();

    await expect(
      page.getByText('The correction is recorded. It was 130; it is now 131.'),
    ).toBeVisible();
    const [act] = sent(opened.api, '/correction');
    expect(act?.body).toEqual({ reason: 'Miscounted.', physical_count: 131 });
    expect(act?.ifMatch).toBe('"v1"');
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the list of missing parcels', () => {
  // Break caught: a parcel found and checked in with no tap (a request that is not the run's), the list not read again, or the parcel's photo drawn from an address the page shows.
  test('shows the parcel being searched for with its photo, opens it, and checks it in when it is found', async ({
    page,
  }) => {
    const opened = await open(page, MISSING, { permissions: SENIOR });

    await expect(
      page.getByRole('heading', { level: 1, name: 'Missing — being searched for' }),
    ).toBeVisible();
    const list = table(page, 'Missing parcels');
    await expect(list).toContainText('Yaw Textiles');
    await expect(list).toContainText('ACC-MF-4PX8RT');
    await page.getByRole('button', { name: 'Open the missing parcel from Yaw Textiles' }).click();
    await expect(
      page.getByRole('img', { name: 'Photo of a parcel from Yaw Textiles' }),
    ).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain('test-evidence-store');

    await page.getByRole('button', { name: 'Found: check it in' }).click();
    await expect(page.getByText('A parcel from Yaw Textiles is checked in.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No missing parcels yet' })).toBeVisible();
    const taps = opened.api.calls.filter(
      (call) => call.method === 'PUT' && call.path.endsWith('/arrival'),
    );
    expect(taps).toHaveLength(1);
    expect(taps[0]?.body).toEqual({ arrived: true });
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('is an entry of the Hub group of the menu, and lists the written-off parcels in their own view', async ({
    page,
  }) => {
    const opened = await open(page, QUEUE);
    await menuEntry(page, 'Missing parcels').click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Missing — being searched for' }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Written off, vendor not told yet' }).click();
    await expect(page.getByRole('heading', { name: 'No missing parcels yet' })).toBeVisible();
    expect(
      reads(opened.api, '/missing-parcels').some((call) => call.search.includes('vendor_to_tell')),
    ).toBe(true);
  });
});

interface Screen {
  readonly name: string;
  readonly heading: boolean;
  readonly reach: (page: Page) => Promise<void>;
}

const SCREENS: readonly Screen[] = [
  {
    name: 'the receiving queue, by run',
    heading: true,
    reach: async (page) => {
      await open(page, QUEUE);
      await expect(page.getByText('ACC-MF-7KQ2MZ').first()).toBeVisible();
    },
  },
  {
    name: 'the run’s page',
    heading: true,
    reach: async (page) => {
      await open(page, runPath(RUNS.waiting));
      await expect(
        page
          .getByRole('region', { name: 'Kente Crafts' })
          .getByRole('button', { name: 'All 4 here' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the run’s page while the officer taps',
    heading: true,
    reach: async (page) => {
      await open(page, runPath(RUNS.waiting));
      const kente = page.getByRole('region', { name: 'Kente Crafts' });
      await kente.getByRole('button', { name: 'The count is different' }).click();
      await kente.getByRole('button', { name: 'Parcel 1', exact: true }).click();
      await expect(kente.getByText('1 of 4 checked in')).toBeVisible();
    },
  },
  {
    name: 'a finished run, with the rider’s bag first',
    heading: true,
    reach: async (page) => {
      await open(page, runPath(RUNS.decision));
      await expect(page.getByRole('region', { name: 'Before the rider leaves' })).toBeVisible();
    },
  },
  {
    name: 'the confirmation of All N here',
    heading: false,
    reach: async (page) => {
      await open(page, runPath(RUNS.waiting));
      await page
        .getByRole('region', { name: 'Kente Crafts' })
        .getByRole('button', { name: 'All 4 here' })
        .click();
      await expect(
        page.getByRole('alertdialog', { name: 'Confirm 4 parcels from Kente Crafts?' }),
      ).toBeVisible();
    },
  },
  {
    name: 'a parcel opened',
    heading: false,
    reach: async (page) => {
      await open(page, runPath(RUNS.decision));
      await openParcel(
        page,
        page
          .getByRole('region', { name: 'Yaw Textiles' })
          .getByRole('button', { name: 'Parcel 2, Missing' }),
        'Parcel 2',
      );
    },
  },
  {
    name: 'a vendor’s photo in the viewer',
    heading: false,
    reach: async (page) => {
      await open(page, runPath(RUNS.decision));
      await page
        .getByRole('region', { name: 'Yaw Textiles' })
        .getByRole('button', { name: 'Parcel 2, Missing' })
        .click();
      await expect(page.getByRole('button', { name: 'Open this parcel' })).toBeVisible();
    },
  },
  {
    name: 'the form of a parcel that is not on the list',
    heading: false,
    reach: async (page) => {
      await open(page, runPath(RUNS.waiting));
      await page
        .getByRole('region', { name: 'Kente Crafts' })
        .getByRole('button', { name: 'Add a parcel not on the list' })
        .click();
      await expect(
        page.getByRole('alertdialog', { name: 'Add a parcel that is not on the list' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the blind count',
    heading: true,
    reach: async (page) => {
      await open(page, count(IDS.waiting));
      await expect(page.getByRole('textbox', { name: /Parcels counted/ })).toBeVisible();
    },
  },
  {
    name: 'the blind count with another officer’s lock',
    heading: true,
    reach: async (page) => {
      await open(page, count(IDS.held));
      await expect(
        page.getByText('Someone else opened this check-in at 08:20. It stops nobody.'),
      ).toBeVisible();
    },
  },
  {
    name: 'the count under review',
    heading: true,
    reach: async (page) => {
      await open(page, count(IDS.waiting));
      await enterCount(page, '130');
      await expect(page.getByRole('alertdialog')).toBeVisible();
    },
  },
  {
    name: 'the record before the count',
    heading: true,
    reach: async (page) => {
      await open(page, record(IDS.waiting));
      await expect(
        page.getByText(/This vendor was not photographed at the door/).first(),
      ).toBeVisible();
    },
  },
  {
    name: 'the record after the count',
    heading: true,
    reach: async (page) => {
      await open(page, record(IDS.short), { permissions: SENIOR });
      await expect(page.getByRole('region', { name: 'What came of this vendor' })).toContainText(
        'fewer',
      );
    },
  },
  {
    name: 'the record of a vendor checked in against its photos',
    heading: true,
    reach: async (page) => {
      await open(page, record(RUNS.yaw), { permissions: SENIOR });
      await expect(
        page.getByRole('list', { name: 'Missing parcels of Yaw Textiles' }),
      ).toBeVisible();
    },
  },
  {
    name: 'a photo opened',
    heading: false,
    reach: async (page) => {
      await open(page, record(IDS.short));
      await page.getByRole('button', { name: 'Open Door photo 1' }).click();
      await expect(
        page.getByRole('dialog', { name: 'Door photo 1' }).getByRole('img'),
      ).toBeVisible();
    },
  },
  {
    name: 'the damage of a vendor counted without photos, with a photo',
    heading: true,
    reach: async (page) => {
      await open(page, record(IDS.short), { permissions: SENIOR });
      await page.getByRole('button', { name: 'Record damage' }).click();
      await gallery(page.getByRole('alertdialog')).setInputFiles({
        name: 'crushed.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from('photo'),
      });
      await expect(page.getByText('Stored', { exact: true })).toBeVisible();
    },
  },
  {
    name: 'the correction of a count',
    heading: true,
    reach: async (page) => {
      await open(page, record(RUNS.yaw), { permissions: SENIOR });
      await page.getByRole('button', { name: 'Correct the count' }).click();
      await expect(
        page.getByRole('alertdialog', { name: 'Correct the count for Yaw Textiles?' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the decision',
    heading: true,
    reach: async (page) => {
      await open(page, discrepancy(RUNS.yaw), { permissions: SENIOR });
      await expect(page.getByRole('radio', { name: /Write off what is missing/ })).toBeVisible();
    },
  },
  {
    name: 'the list of missing parcels',
    heading: true,
    reach: async (page) => {
      await open(page, MISSING);
      // A table at the wide widths and cards at the narrow ones: the vendor's name is on both.
      await expect(page.getByText('Yaw Textiles').first()).toBeVisible();
    },
  },
];

test.describe('every screen, at the verified widths', () => {
  for (const { width, height } of VIEWPORTS) {
    for (const screen of SCREENS) {
      // Break caught: a screen that clips, scrolls sideways, fails contrast with layout, has an unlabelled control, or loses its heading.
      test(`${screen.name} has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await screen.reach(page);

        expect(await wcagViolations(page)).toEqual([]);
        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        await expectNoTableScrollsSideways(page);
        if (screen.heading) await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      });
    }
  }
});

test.describe('the same screens in the dark theme', () => {
  for (const screen of SCREENS) {
    // Break caught: a lock, a finding or an upload whose colours were written for the light theme and fail contrast in the dark one.
    test(`${screen.name} has no WCAG 2.2 A or AA violation in the dark theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.setViewportSize({ width: 1280, height: 800 });
      await screen.reach(page);

      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});

test.describe('enlarged text and forced colours', () => {
  // Break caught (WCAG 1.4.4): sizes in pixels, so enlarged text does not grow a form, a lock or a finding, or breaks them.
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 640, height: 800 },
  ]) {
    for (const [name, path, ready] of [
      ['the blind count', count(IDS.held), 'Someone else opened this check-in'],
      ['the record after the count', record(IDS.short), 'What came of this vendor'],
      ['the list of missing parcels', MISSING, 'Yaw Textiles'],
      ['the receiving queue', QUEUE, 'ACC-MF-7KQ2MZ'],
      ['the run’s page', runPath(RUNS.waiting), 'Kente Crafts'],
    ] as const) {
      test(`${name} at 200% text keeps its layout at ${String(width)} px`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await open(page, path);
        await expect(page.getByText(ready).first()).toBeVisible();
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });

        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        expect(await clippedControls(page)).toEqual([]);
      });
    }
  }

  // Break caught: a finding with no line between it and the next once forced colours paint the fill away, so that two findings run together.
  test('under forced colours the findings keep their line and the act of the record is whole in the window', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    const runs = world().runs;
    const vendor = runs[1]?.vendors[0];
    const first = vendor?.parcels[0];
    if (vendor === undefined || first === undefined) throw new Error('the world holds no vendor');
    first.condition = {
      condition: 'DAMAGED',
      note: 'Two cartons crushed.',
      evidence_ids: [],
      recorded_by_name: 'Synthetic Officer',
      recorded_at: '2026-11-03T08:45:00Z',
    };
    vendor.decisions = [
      {
        id: 'd0000000-0000-4000-8000-000000000001',
        outcome: 'ESCALATED',
        note: 'Still looking.',
        at: '2026-11-03T09:00:00Z',
      },
    ];
    await open(page, record(RUNS.yaw), { permissions: SENIOR, runs });
    await expect(page.locator('.receiving-finding')).toHaveCount(2);

    const line = await page
      .locator('.receiving-finding')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.borderBlockEndStyle, width: parseFloat(style.borderBlockEndWidth) };
      });
    expect(line).toEqual({ style: 'solid', width: 1 });
    await page.getByRole('link', { name: 'Decide' }).scrollIntoViewIfNeeded();
    await expectWholeInTheWindow(page, page.getByRole('link', { name: 'Decide' }));
  });
});
