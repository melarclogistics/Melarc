import { createHash } from 'node:crypto';

import type { Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import {
  COUNTED_SHORT,
  DECLARED,
  IDS,
  PLANTED,
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
 * The receiving screens (S1.35) in a real browser: the queue, the blind count, an intake's record, the condition with its photos and the adjudication. What jsdom cannot show is here: **the blind count
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

const QUEUE = '/intakes';
const record = (id: string) => `/intakes/${id}`;
const count = (id: string) => `/intakes/${id}/count`;
const condition = (id: string) => `/intakes/${id}/condition`;
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

async function enterCount(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: /Parcels counted/ }).fill(text);
  await page.getByRole('button', { name: 'Review the count' }).click();
}

test.describe('moving through the screens', () => {
  // Break caught: a menu entry that goes nowhere, or a page whose heading a screen reader never hears.
  test('the menu leads to the queue, which lands on its heading, and a row opens its intake', async ({
    page,
  }) => {
    const opened = await open(page, '/');

    await menuEntry(page, 'Receiving').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Receiving' })).toBeFocused();
    await table(page, 'Intakes').getByRole('link', { name: 'ACC-IN-7KQ2MZ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeFocused();
    expect(new URL(page.url()).pathname).toBe(record(IDS.waiting));
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });
});

test.describe('the receiving queue', () => {
  // Break caught: the queue drawing a declared count, a zero one included, or any part of the comparison; a request that is not the server's own filter; a hub the operation does not take.
  test('lists the intakes that wait, oldest handover first, and nothing of any count: not in a response, not on the page', async ({
    page,
  }) => {
    const opened = await open(page, QUEUE);

    const rows = table(page, 'Intakes').getByRole('row');
    await expect(rows.filter({ hasText: 'ACC-IN-3HT6NC' })).toHaveCount(0);
    await expect(rows.filter({ hasText: 'ACC-IN-7KQ2MZ' })).toContainText('Awaiting count');
    await expect(rows.filter({ hasText: 'ACC-IN-7KQ2MZ' })).toContainText('No one');
    await expect(rows.filter({ hasText: 'ACC-IN-9XM4TQ' })).toContainText(
      'Another receiver, last active',
    );
    await expect(page.getByText(/whichever hub is chosen at the top/)).toBeVisible();

    const [list] = reads(opened.api, '/hub-intakes');
    expect(list?.search).toContain('state=AWAITING_COUNT');
    expect(list?.search).not.toContain('hub_id');
    await expectBlind(page, opened);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('has the views of the server’s state filter, and a counted intake there carries no count', async ({
    page,
  }) => {
    const opened = await open(page, `${QUEUE}?view=decision`);

    const rows = table(page, 'Intakes').getByRole('row');
    await expect(rows.filter({ hasText: 'ACC-IN-3HT6NC' })).toContainText('Needs a decision');
    expect(reads(opened.api, '/hub-intakes').at(-1)?.search).toContain(
      'state=RECONCILIATION_REQUIRED',
    );

    await page.goto(`${QUEUE}?view=all`);
    await expect(rows.filter({ hasText: 'ACC-IN-5JK8PD' })).toContainText('Ready to itemise');
    expect(reads(opened.api, '/hub-intakes').at(-1)?.search).not.toContain('state=');
    // The list of counted intakes carries the declaration on the wire (the contract's counted shape); no screen draws it, a zero or a match included.
    expect(await table(page, 'Intakes').textContent()).not.toMatch(
      /\b(?:137|130|24|declared|counted)\b/i,
    );
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the blind count', () => {
  // Break caught: the declaration in any form on the count page, whatever it was sent: not greyed, not in a tooltip, not in a response the page discards.
  test('asks for the physical count alone, with the declaration in no form, then reveals the comparison once the count commits', async ({
    page,
  }) => {
    const opened = await open(page, count(IDS.waiting));

    await expect(page.getByRole('heading', { level: 1, name: 'Count the parcels' })).toBeVisible();
    const field = page.getByRole('textbox', { name: /Parcels counted/ });
    await expect(field).toHaveValue('');
    await expect(
      page.getByText(/The count is blind: the number the rider declared is not shown to you/),
    ).toBeVisible();
    await expect(page.getByText('Held by you')).toBeVisible();
    await field.hover();
    await expectBlind(page, opened);

    await enterCount(page, String(COUNTED_SHORT));
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(`Record a count of ${String(COUNTED_SHORT)} parcels?`);
    await expectBlind(page, opened);
    expect(sent(opened.api, '/count')).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Record the count' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    await expect(
      page.getByText(
        'Your count is recorded. The number the rider declared is shown below, with the comparison.',
      ),
    ).toBeVisible();
    const comparison = page.getByRole('region', { name: 'The count' });
    await expect(comparison).toContainText(`${String(DECLARED)} parcels`);
    await expect(comparison).toContainText(`${String(COUNTED_SHORT)} parcels`);
    await expect(comparison).toContainText('Short');
    await expect(comparison).toContainText(
      'The count is 7 parcels short of what the rider declared.',
    );

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

  // Break caught: the declaration drawn from an answer that carried it by mistake: the screens refuse such an answer whole, so no page can be given the number by a server that sent it.
  test('refuses every answer that carries the declaration before the count, and the number is nowhere on the page', async ({
    page,
  }) => {
    const opened = await open(page, QUEUE, { leak: true });
    await expect(page.getByText('The intakes could not be loaded.').first()).toBeVisible();
    // The test is sensitive: the leaking server did send it.
    expect(opened.received.some((answer) => THE_NUMBER.test(answer.text))).toBe(true);
    expect(await page.content()).not.toMatch(THE_NUMBER);
    expect(await page.locator('body').ariaSnapshot()).not.toMatch(THE_NUMBER);

    await page.goto(count(IDS.waiting));
    await expect(page.getByText('This intake could not be loaded.').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Parcels counted/ })).toHaveCount(0);
    expect(await page.content()).not.toMatch(THE_NUMBER);
    expect(await page.title()).not.toMatch(THE_NUMBER);

    await page.goto(record(IDS.waiting));
    await expect(page.getByText('This intake could not be loaded.').first()).toBeVisible();
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
});

test.describe('the lock is advisory', () => {
  // Break caught (surfaces/ops-portal.md section 9): another receiver's lock told as a gate, or as a name; "ask again" granted before the holder has been idle.
  test('tells that another receiver holds it, keeps the form, and takes the lock over only once the holder has been idle', async ({
    page,
  }) => {
    const opened = await open(page, count(IDS.held));

    await expect(page.getByText('Held by someone else')).toBeVisible();
    await expect(page.getByText('Another receiver holds the lock on this intake.')).toBeVisible();
    await expect(
      page.getByText(
        /It never stops a second count: if two receivers count, the first count is kept and the other is refused\./,
      ),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Parcels counted/ })).toBeEnabled();
    expect(await page.content()).not.toContain(IDS.other);

    await page.getByRole('button', { name: 'Ask again' }).click();
    await expect(page.getByText(/Asked again\. Another receiver still holds it/)).toBeVisible();
    expect(sent(opened.api, '/lock')).toHaveLength(2);

    opened.api.world.holderIdle = true;
    await page.getByRole('button', { name: 'Ask again' }).click();
    await expect(page.getByText('Held by you')).toBeVisible();
    // The lock changed nothing of the intake: no count, no version.
    expect(sent(opened.api, '/count')).toHaveLength(0);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: the second receiver given a bare failure: it says another receiver counted first, that nothing was changed, and where to look; and the count is the first receiver's.
  test('tells the second receiver of two who count what happened, and reads the first’s count on reload', async ({
    page,
  }) => {
    const opened = await open(page, count(IDS.waiting), { raceOnCount: true });

    await enterCount(page, String(COUNTED_SHORT));
    await page.getByRole('alertdialog').getByRole('button', { name: 'Record the count' }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(
      'Another receiver counted this intake first, so your count was not kept and nothing was changed.',
    );
    await expect(dialog).toContainText(
      'A lock only shows who is working; it never stops a second count, and the first one is kept.',
    );
    await expect(page.getByText('Diagnostic text that must never reach a screen.')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Reload the record' }).click();
    await expect(
      page.getByText(
        /This intake has been counted: another receiver’s count is the one that was recorded/,
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the intake' })).toHaveAttribute(
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

test.describe('the record of an intake', () => {
  // Break caught: a comparison, a declaration or a photo on the record of an intake that has not been counted, or a request for the photos before the count.
  test('before the count is the pre-count facts and a way to the count, with no comparison and no request for a photo', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.waiting));

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-IN-7KQ2MZ' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Count the parcels' })).toHaveAttribute(
      'href',
      count(IDS.waiting),
    );
    await expect(
      page.getByText(/This intake has not been counted\. The count is blind/),
    ).toBeVisible();
    await expect(page.getByText('Declared by the rider')).toHaveCount(0);
    await expect(page.getByText('Photos of the collection')).toHaveCount(0);
    expect(authorizations(opened.api)).toHaveLength(0);
    expect(opened.api.calls.some((call) => call.path.includes('/evidence'))).toBe(false);
    await expectBlind(page, opened);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  // Break caught: the declaration, the count or the comparison drawn wrongly, a difference worked out by the page, itemising offered, or an act offered to a session without its key.
  test('after the count shows the comparison as the server stated it, offers its acts by key, and never offers itemising', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short), { permissions: SENIOR });

    const comparison = page.getByRole('region', { name: 'The count' });
    await expect(comparison).toContainText(`${String(DECLARED)} parcels`);
    await expect(comparison).toContainText(`${String(COUNTED_SHORT)} parcels`);
    await expect(comparison).toContainText(
      'The count is 7 parcels short of what the rider declared.',
    );
    await expect(page.getByRole('region', { name: 'Condition' })).toContainText('Good condition');
    await expect(page.getByRole('link', { name: 'Adjudicate' })).toHaveAttribute(
      'href',
      discrepancy(IDS.short),
    );
    await expect(page.getByRole('link', { name: 'Record the condition' })).toHaveAttribute(
      'href',
      condition(IDS.short),
    );
    await expect(page.getByRole('link', { name: /itemi|close/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /itemi|close/i })).toHaveCount(0);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('does not offer the adjudication to a session without its key, and says a senior officer decides', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short));

    await expect(
      page.getByText(
        'A senior officer decides this. Your account can’t decide a discrepancy found at receiving. Ask an administrator for access.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Adjudicate' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Record the condition' })).toBeVisible();
    await page.goto(discrepancy(IDS.short));
    await expect(
      page.getByText(
        'Your account can’t decide a discrepancy found at receiving. Ask an administrator for access.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
    expect(opened.api.unexpected).toEqual([]);
  });

  // Break caught: the photos of the collection drawn with a picture before one is opened, an authorization asked for ahead of the officer, an address or a key shown, or one kept after it is closed.
  test('opens the photos of the collection one at a time, each with an authorization of its own, loaded from the page’s origin, and drops it on close', async ({
    page,
  }) => {
    const opened = await open(page, record(IDS.short));

    const photos = page.getByRole('list', { name: 'Photos of the collection' });
    await expect(photos.getByRole('button')).toHaveCount(3);
    expect(authorizations(opened.api)).toHaveLength(0);
    expect(opened.api.images).toEqual([]);
    await expect(page.locator('img.stop-photo__image')).toHaveCount(0);

    await photos.getByRole('button', { name: 'Open Photo of the collection 2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Photo of the collection 2' });
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
    await photos.getByRole('button', { name: 'Open Photo of the collection 2' }).click();
    await expect(
      page.getByRole('dialog', { name: 'Photo of the collection 2' }).getByRole('img'),
    ).toBeVisible();
    expect(authorizations(opened.api)).toHaveLength(2);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });
});

test.describe('the condition and its photos', () => {
  const FILE = Buffer.from('a synthetic photo of two crushed cartons');

  // Break caught: evidence declared for another purpose or with a checksum that is not the file's, bytes sent with the session or a referrer, a record cited before it is stored, a storage key or an address on the screen, the version lost.
  test('uploads the photo in its three steps with no credentials and no referrer, cites it, and records the condition once', async ({
    page,
  }) => {
    const opened = await open(page, condition(IDS.short));

    await page.getByRole('radio', { name: /Damaged/ }).check();
    await page.getByRole('textbox', { name: /Note/ }).fill('Two cartons crushed at one corner.');
    await page
      .getByLabel(/Photos of what you found/)
      .setInputFiles({ name: 'crushed.jpg', mimeType: 'image/jpeg', buffer: FILE });
    await expect(page.getByText('Stored', { exact: true })).toBeVisible();

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

    await page.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(
      'A condition is recorded once, and the intake goes to a senior officer’s review. No count changes.',
    );
    await dialog.getByRole('button', { name: 'Record the condition' }).click();

    await expect(page.getByText('The condition is recorded.')).toBeVisible();
    const [act] = sent(opened.api, '/condition');
    expect(act?.ifMatch).toBe('"v1"');
    expect(act?.idempotencyKey).toMatch(KEY);
    expect(act?.body).toMatchObject({
      condition: 'DAMAGED',
      note: 'Two cartons crushed at one corner.',
      evidence_ids: [expect.stringMatching(KEY)],
    });
    const finding = page
      .getByRole('list', { name: 'Findings, in the order they were made' })
      .getByRole('listitem')
      .first();
    await expect(finding).toContainText('Condition recorded at receiving');
    await expect(finding).toContainText('Damaged');

    // The photo of the finding is opened like any other: one at a time, with an authorization of its own.
    await finding.getByRole('button', { name: 'Open Photo 1' }).click();
    await expect(page.getByRole('dialog', { name: 'Photo 1' }).getByRole('img')).toBeVisible();
    expect(authorizations(opened.api)).toHaveLength(1);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('asks for a photo of damage at the photos, and does not send while one is on its way', async ({
    page,
  }) => {
    const opened = await open(page, condition(IDS.short));

    await page.getByRole('radio', { name: /Tampered with/ }).check();
    await page.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByText('Add at least one photo of what you found.')).toBeVisible();
    await expect(page.getByLabel(/Photos of what you found/)).toBeFocused();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(sent(opened.api, '/condition')).toHaveLength(0);
  });

  test('says an intake whose condition is recorded already is, and shows no form', async ({
    page,
  }) => {
    const opened = await open(page, condition(IDS.short));
    await page.getByRole('radio', { name: /Good condition/ }).check();
    await page.getByRole('button', { name: 'Review' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Record the condition' })
      .click();
    await expect(page.getByText('The condition is recorded.')).toBeVisible();

    await page.goto(condition(IDS.short));
    await expect(
      page.getByText(
        /A condition has already been recorded for this intake\. It is recorded once\./,
      ),
    ).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);
    expect(opened.api.unexpected).toEqual([]);
  });
});

test.describe('the adjudication', () => {
  // Break caught: the decision sent with a key (the operation declares none), without the version, or without the reason; or one that changes a count.
  test('records the decision on the version read, under no key, against a count it does not change', async ({
    page,
  }) => {
    const opened = await open(page, discrepancy(IDS.short), { permissions: SENIOR });

    const counted = page.getByRole('heading', { level: 3, name: 'What was counted' }).locator('..');
    await expect(counted).toContainText(`${String(DECLARED)} parcels`);
    await expect(counted).toContainText(`${String(COUNTED_SHORT)} parcels`);
    await page.getByRole('radio', { name: /Write off the difference/ }).check();
    await page
      .getByRole('textbox', { name: /Reason/ })
      .fill('Seven parcels lost between the door and the table.');
    await page.getByRole('button', { name: 'Review' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(
      'It changes no count. The intake is then cleared for itemising.',
    );
    await dialog.getByRole('button', { name: 'Record the decision' }).click();

    await expect(page.getByText('Your decision is recorded.')).toBeVisible();
    await expect(
      page.getByText(
        'Counted and cleared. Itemising and closing an intake are later work: nothing on this page starts them.',
      ),
    ).toBeVisible();
    const [act] = sent(opened.api, '/discrepancy');
    expect(act?.ifMatch).toBe('"v1"');
    expect(act?.idempotencyKey).toBeUndefined();
    expect(act?.body).toEqual({
      outcome: 'WRITTEN_OFF',
      note: 'Seven parcels lost between the door and the table.',
    });
    // The counts survive the adjudication, as the server stated them.
    const comparison = page.getByRole('region', { name: 'The count' });
    await expect(comparison).toContainText(`${String(DECLARED)} parcels`);
    await expect(comparison).toContainText(`${String(COUNTED_SHORT)} parcels`);
    await expect(page.getByRole('link', { name: 'Adjudicate' })).toHaveCount(0);
    expect(opened.api.unexpected).toEqual([]);
    expect(opened.watch.problems).toEqual([]);
  });

  test('is reachable on a count that matches, because damage is independent of the count', async ({
    page,
  }) => {
    const opened = await open(page, discrepancy(IDS.matched), {
      permissions: SENIOR,
      intakes: world().intakes.map((intake) =>
        intake.id === IDS.matched
          ? { ...intake, state: 'RECONCILIATION_REQUIRED' as const, condition: 'DAMAGED' as const }
          : intake,
      ),
    });

    await expect(page.getByRole('radio', { name: /Accept the count/ })).toBeVisible();
    await expect(page.getByText('Matches').first()).toBeVisible();
    expect(opened.api.unexpected).toEqual([]);
  });
});

interface Screen {
  readonly name: string;
  readonly heading: boolean;
  readonly reach: (page: Page) => Promise<void>;
}

const SCREENS: readonly Screen[] = [
  {
    name: 'the receiving queue',
    heading: true,
    reach: async (page) => {
      await open(page, QUEUE);
      await expect(page.getByText('ACC-IN-7KQ2MZ').first()).toBeVisible();
    },
  },
  {
    name: 'the blind count',
    heading: true,
    reach: async (page) => {
      await open(page, count(IDS.waiting));
      await expect(page.getByText('Held by you')).toBeVisible();
    },
  },
  {
    name: 'the blind count with another receiver’s lock',
    heading: true,
    reach: async (page) => {
      await open(page, count(IDS.held));
      await expect(page.getByText('Held by someone else')).toBeVisible();
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
      await expect(page.getByText(/This intake has not been counted/)).toBeVisible();
    },
  },
  {
    name: 'the record after the count',
    heading: true,
    reach: async (page) => {
      await open(page, record(IDS.short), { permissions: SENIOR });
      await expect(page.getByRole('region', { name: 'The count' })).toContainText('Short');
    },
  },
  {
    name: 'a photo opened',
    heading: false,
    reach: async (page) => {
      await open(page, record(IDS.short));
      await page.getByRole('button', { name: 'Open Photo of the collection 1' }).click();
      await expect(
        page.getByRole('dialog', { name: 'Photo of the collection 1' }).getByRole('img'),
      ).toBeVisible();
    },
  },
  {
    name: 'the condition form with a photo',
    heading: true,
    reach: async (page) => {
      await open(page, condition(IDS.short));
      await page.getByRole('radio', { name: /Damaged/ }).check();
      await page.getByLabel(/Photos of what you found/).setInputFiles({
        name: 'crushed.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from('photo'),
      });
      await expect(page.getByText('Stored', { exact: true })).toBeVisible();
    },
  },
  {
    name: 'the adjudication form',
    heading: true,
    reach: async (page) => {
      await open(page, discrepancy(IDS.short), { permissions: SENIOR });
      await expect(page.getByRole('radio', { name: /Accept the count/ })).toBeVisible();
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
      ['the blind count', count(IDS.held), 'Held by someone else'],
      ['the record after the count', record(IDS.short), 'The count'],
      ['the receiving queue', QUEUE, 'ACC-IN-7KQ2MZ'],
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

  // Break caught: a finding with no border once forced colours paint the fill away, so that two findings run together; a lock with no outline.
  test('under forced colours a finding keeps its border and the act of the record is whole in the window', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, record(IDS.short), {
      permissions: SENIOR,
      intakes: world().intakes.map((intake) =>
        intake.id === IDS.short
          ? {
              ...intake,
              condition: 'DAMAGED' as const,
              findings: [
                {
                  id: '60a2b153-8fa4-40c1-9243-000000000064',
                  kind: 'CONDITION' as const,
                  condition: 'DAMAGED' as const,
                  outcome: null,
                  note: 'Two cartons crushed.',
                  evidence_ids: [],
                  recorded_by: IDS.me,
                  recorded_at: '2026-11-03T08:45:00Z',
                },
              ],
            }
          : intake,
      ),
    });
    await expect(page.locator('.intake-finding').first()).toBeVisible();

    const border = await page
      .locator('.intake-finding')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.borderTopStyle, width: parseFloat(style.borderTopWidth) };
      });
    expect(border).toEqual({ style: 'solid', width: 1 });
    await page.getByRole('link', { name: 'Adjudicate' }).scrollIntoViewIfNeeded();
    await expectWholeInTheWindow(page, page.getByRole('link', { name: 'Adjudicate' }));
  });
});
