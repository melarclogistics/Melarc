import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

import { watchPage, wcagViolations } from './support/page';
import { menuEntry } from './support/shell';
import {
  IDS,
  PLANTED_PRICE_TEXT,
  pickup,
  stubPickupApi,
  world,
  type PickupApi,
  type World,
} from './support/pickup-api';

/**
 * The pickup screens (S1.19) in a real browser: the queue, the booking, one request, the exception and the approver's queue. What jsdom cannot show is here: the
 * layout at the verified widths with axe (WCAG 2.2 A and AA), no sideways scrolling at 320 px, text enlarged to 200%, forced colours, reduced
 * motion, the native modal dialog of an act (Tab kept inside it), and the exact headers a real browser sends with each act.
 *
 * The same file runs against the production build and against the development server (strict mode runs every effect twice). The API is a
 * small stateful stand-in with a price planted in answers that never carry one, so that a screen which could display a price would.
 */
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

/** A single-package request whose one-package exception was asked for by `requestedBy` and waits for a checker. */
const waiting = (requestedBy: string) =>
  pickup({
    declared_package_count: 1,
    exception: { requested_by: requestedBy, state: 'REQUESTED' },
  });

const DETAIL = `/pickup-requests/${IDS.pending}`;
const LATE = `/pickup-requests/${IDS.confirmed}`;

async function open(
  page: Page,
  path: string,
  setup: Partial<World> = {},
): Promise<{ api: PickupApi; watch: ReturnType<typeof watchPage> }> {
  const watch = watchPage(page);
  const api = await stubPickupApi(page, world(setup));
  await page.goto(path);
  return { api, watch };
}

const posts = (api: PickupApi) => api.calls.filter((call) => call.method === 'POST');

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** The controls whose content is wider than the control: a label cut off. */
function clippedControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.getAttribute('aria-label') ?? element.textContent),
  );
}

/** Chooses a vendor's own packages, the demo vendor, a Tuesday, three packages and the recipient as payer. */
async function fillBooking(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'A vendor’s own packages' }).check();
  await page.getByRole('searchbox', { name: /Search vendors/ }).fill('demo');
  await page.getByRole('searchbox', { name: /Search vendors/ }).press('Enter');
  await page.getByRole('button', { name: 'Choose: Demo Fabrics Ltd' }).click();
  const day = page.getByRole('group', { name: /Service date/ }).getByRole('textbox');
  await day.click();
  await page.keyboard.type('03112026');
  await page.getByRole('textbox', { name: /Number of packages/ }).fill('3');
  await page.getByRole('radio', { name: 'The recipient pays' }).check();
}

test.describe('moving through the screens', () => {
  // Break caught: a menu entry that goes nowhere, or a new page whose heading a screen reader never hears.
  test('the menu leads to the queue, and the queue to a request, each landing on the new heading', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/');
    await menuEntry(page, 'Requests').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Pickup requests' })).toBeFocused();

    await goToRequest(page, 'ACC-PR-7KQ2MZ');
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeFocused();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a session without the key sees no entry, and the page says what it cannot do', async ({
    page,
  }) => {
    await open(page, '/pickup-requests', { permissions: ['staff.read'] });

    await expect(
      page.getByText('Your account can’t see pickup requests. Ask an administrator for access.'),
    ).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('pickup.read');
    await expect(menuEntry(page, 'Requests')).toHaveCount(0);
  });
});

test.describe('the queue', () => {
  test('filters by state in the address, and tells a filter that hides everything from an empty queue', async ({
    page,
  }) => {
    const { api } = await open(page, '/pickup-requests');
    await page.getByRole('tab', { name: 'Declined' }).click();

    await expect(page).toHaveURL('/pickup-requests?state=DECLINED');
    await expect(page.getByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    expect(api.calls.some((call) => call.search === '?state=DECLINED')).toBe(true);

    await page.getByRole('button', { name: 'Show every request' }).click();
    await expect(opener(page, 'ACC-PR-7KQ2MZ')).toBeVisible();
  });

  test('says when there are no requests at all', async ({ page }) => {
    await open(page, '/pickup-requests', { requests: [] });

    await expect(page.getByRole('heading', { name: 'No pickup requests yet' })).toBeVisible();
  });
});

/**
 * The queue is drawn by the queue workspace template (redesign step R6): a table where the table's own box has room (40rem) and cards where it has not, the table and the cards
 * never both in the page, a request opened in a panel beside it. The room is the table's box and not the screen: at 1280 px the docked menu leaves 984 px, which is a table, and
 * with the panel open beside it the table has less. The kit's browser specs hold the template's look (WCAG 2.2 in both themes, 320 px, 200% text, forced colours); these hold
 * what the pickup queue adds to it.
 */
const WIDE = { width: 1440, height: 900 } as const; // 1144 px of room beside the menu: a table
const NARROW = { width: 390, height: 844 } as const;
const PHONE = { width: 320, height: 640 } as const;
const CODE = 'ACC-PR-7KQ2MZ';

const queueTable = (page: Page) => page.getByRole('table', { name: 'Pickup requests' });
const queueCards = (page: Page) => page.getByRole('list', { name: 'Pickup requests' });

/** The columns of the queue's table, in order, for a session that may confirm (the last is the row's own act). */
const QUEUE_COLUMNS = [
  'Request / sender',
  'State',
  'Service date',
  'Pickup address / hub',
  'Packages / booking type',
  'Needs',
  'Actions',
];

/** The button that opens a request, which the table draws in its row and the cards in each card. */
const opener = (page: Page, code: string) =>
  page.getByRole('button', { name: new RegExp(`^Open ${code}, `) });

/** The officer opens a request from its row, in the panel beside the queue, and goes to its own page by the panel's "Open full page". */
async function goToRequest(page: Page, code: string): Promise<void> {
  await opener(page, code).click();
  await page
    .getByRole('dialog', { name: code })
    .getByRole('link', { name: 'Open full page' })
    .click();
}

/** The heavier acts of a request are in the menu of its header: the menu is opened and the act chosen, and the act brings its own question or form. */
async function chooseAct(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /^More actions for / }).click();
  await page.getByRole('menuitem', { name }).click();
}

const LONG_ADDRESS =
  'Plot 14, Block C, off the Independence Avenue service road beside the old demo bakery, Ridge, Accra, Greater Accra Region';
const LONG_SENDER = 'Demo Fabrics and Household Linen Wholesale Trading Company Limited';

/** Two requests with long words where they are likely to be: an address, a sender, and the two notes a queue says in words. */
const longWorld = (): Partial<World> => ({
  requests: [
    // A late booking waiting for its decision is a confirmed request (task C1.1: a request cancelled since is not asked to be decided).
    pickup({
      state: 'CONFIRMED',
      declared_package_count: 1,
      sender: LONG_SENDER,
      address: LONG_ADDRESS,
      cutoff_exception_state: 'PENDING_OPS_REVIEW',
    }),
    {
      ...waiting(IDS.colleague),
      id: IDS.single,
      code: 'ACC-PR-2SY7Z5',
      sender: LONG_SENDER,
      address: LONG_ADDRESS,
    },
  ],
});

test.describe('the queue, drawn for the room it has', () => {
  // Break caught: a table squeezed into a room it cannot be read in, or both drawings exposed at once, which reads every request twice.
  test('draws a table of six columns where there is room, and no cards', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(page, '/pickup-requests');

    await expect(queueTable(page)).toBeVisible();
    await expect(queueTable(page).getByRole('columnheader')).toHaveText(QUEUE_COLUMNS);
    await expect(queueCards(page)).toHaveCount(0);
    await expect(opener(page, CODE)).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('link', { name: 'Book a pickup' })).toBeVisible();
    // The queue is asked for as it always was: no filter, no token, whatever the drawing.
    const asked = api.calls.filter((call) => call.path === '/api/v1/pickup-requests');
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked.map((call) => call.search))).toEqual(new Set(['']));
    expect(watch.problems).toEqual([]);
  });

  // Break caught (the review of 499399c): the queue drawn as cards at 1280 px with the menu open, a box of about 61rem, though its table has room for every column: a table that
  // keeps every column from 40rem up, its cells wrapping, and is cards only under that.
  test('keeps the table, with every column, at 1280 px with the menu open, and no cards', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    const { watch } = await open(page, '/pickup-requests');

    await expect(queueTable(page)).toBeVisible();
    await expect(queueTable(page).getByRole('columnheader')).toHaveText(QUEUE_COLUMNS);
    await expect(queueCards(page)).toHaveCount(0);
    await expect(opener(page, CODE)).toHaveCount(1);
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    expect(watch.problems).toEqual([]);
  });

  test('draws a list of cards where there is not, with every fact of a request and no table', async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    const { watch } = await open(page, '/pickup-requests');

    const cards = queueCards(page);
    await expect(cards).toBeVisible();
    await expect(cards.getByRole('listitem')).toHaveCount(2);
    await expect(queueTable(page)).toHaveCount(0);
    await expect(opener(page, CODE)).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('link', { name: 'Book a pickup' })).toBeVisible();
    const first = cards.getByRole('listitem').first();
    // Each card keeps a heading, its code, for heading navigation (it is outside the card's button, whose content is presentational).
    await expect(first.getByRole('heading', { level: 2 })).toHaveText(CODE);
    await expect(cards.getByRole('heading', { level: 2 })).toHaveCount(2);
    for (const fact of [
      CODE,
      'Waiting for confirmation',
      'Demo Fabrics Ltd',
      'Tue 3 Nov 2026',
      '14 Demo Lane, Osu',
      'Accra Central',
      '3 packages',
      'A vendor’s own packages',
    ]) {
      await expect(first).toContainText(fact);
    }
    // Break caught (the review of 499399c): the card's words about 5px from the edge of the glass. The card has its own inner padding (space-4, 16px) where it starts.
    const inset = await first.evaluate((card) => {
      const body = card.querySelector('.ui-data-table__card-body');
      if (body === null) throw new Error('the card has no body');
      return body.getBoundingClientRect().left - card.getBoundingClientRect().left;
    });
    expect(inset).toBeGreaterThanOrEqual(16);
    expect(watch.problems).toEqual([]);
  });

  // Break caught (the Product Owner, 9 November 2026): the views of the queue running off a narrow screen with nothing to say so, or the current view (the address names it) left
  // behind the edge: the end that is cut off fades, and the current view is whole inside the row.
  for (const width of [320, 390]) {
    test(`fades the cut-off end of the views, and brings the current view into view, at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const { watch } = await open(page, '/pickup-requests');
      const row = page.locator('.ui-view-tabs__scroll');
      await expect(row).toHaveAttribute('data-fade', 'end');

      await page.goto('/pickup-requests?state=CANCELLED');
      const current = page.getByRole('tab', { name: /^Cancelled/ });
      await expect(current).toHaveAttribute('aria-selected', 'true');
      await expect(row).toHaveAttribute('data-fade', 'start');
      const room = await row.boundingBox();
      const tab = await current.boundingBox();
      expect(room).not.toBeNull();
      expect(tab).not.toBeNull();
      expect(tab?.x ?? -1).toBeGreaterThanOrEqual((room?.x ?? 0) - 0.5);
      expect((tab?.x ?? 0) + (tab?.width ?? 0)).toBeLessThanOrEqual(
        (room?.x ?? 0) + (room?.width ?? 0) + 0.5,
      );
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(watch.problems).toEqual([]);
    });
  }

  for (const [shown, size] of [
    ['a table', WIDE],
    ['cards', NARROW],
  ] as const) {
    // Break caught: a request that cannot be reached and opened from the keyboard, or one that opens the page where it should open the panel.
    test(`reaches each request by the keyboard, and opens it in the panel with Enter, beside ${shown}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests');
      await expect(opener(page, CODE)).toBeVisible();

      await page.getByRole('button', { name: 'Filter', exact: true }).focus();
      for (let step = 0; step < 12; step += 1) {
        if (await opener(page, CODE).evaluate((element) => element === document.activeElement))
          break;
        await page.keyboard.press('Tab');
      }
      await expect(opener(page, CODE)).toBeFocused();
      // The arrows move between requests (the table has one stop in the Tab order), and Enter opens the one the officer is on.
      await page.keyboard.press('ArrowDown');
      await expect(opener(page, 'ACC-PR-9WXH4T')).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Enter');

      await expect(page.getByRole('dialog', { name: CODE })).toBeVisible();
      await expect(page).toHaveURL('/pickup-requests');
    });

    // Break caught: a request opened by a script on the row (no new tab, no copy of the address), instead of by a link.
    test(`opens a request's own page in a new tab with a modifier-click on the panel's link, and in place with a plain click, beside ${shown}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize(size);
      // The stand-in answers for the whole context, so that the new tab has an API as well and stays on the request it was opened for.
      await stubPickupApi(context, world());
      await page.goto('/pickup-requests');
      await opener(page, CODE).click();
      const link = page
        .getByRole('dialog', { name: CODE })
        .getByRole('link', { name: 'Open full page' });
      await expect(link).toHaveAttribute('href', DETAIL);

      const [tab] = await Promise.all([
        context.waitForEvent('page'),
        link.click({ modifiers: ['ControlOrMeta'] }),
      ]);
      // A fresh tab on the development server loads every module of the application one request at a time, which the default 5 s of an assertion (for a page that is open) does
      // not allow on a machine with two processors: the wait for the new tab's first paint is stated, for the development projects only (the production build loads at once). The wait
      // is as long as the test's own 30 s, which would end the test first and make the wait count for nothing: the development projects are slow tests (three times the time) and
      // the production build is not (the review of 499399c).
      const development = test.info().project.name.includes('-dev-');
      test.slow(
        development,
        'A fresh tab on the development server loads every module one request at a time.',
      );
      const loading = { timeout: development ? 30_000 : 5_000 };
      await tab.waitForLoadState('load', loading);
      await expect(tab.getByRole('heading', { level: 1, name: CODE })).toBeVisible(loading);
      await expect(tab).toHaveURL(DETAIL);
      await tab.close();
      await expect(page).toHaveURL('/pickup-requests');

      await link.click();
      await expect(page).toHaveURL(DETAIL);
    });
  }

  // Break caught: a long address or note cut off, hidden behind a tooltip, or pushed past the edge of the screen (the page scrolling sideways).
  for (const size of [WIDE, { width: 1280, height: 800 }, NARROW, PHONE]) {
    test(`keeps a long address, sender and note whole, with no sideways scrolling at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests', longWorld());

      // One drawing at a time (a row, or a card) of each of the two requests.
      await expect(page.getByText(LONG_ADDRESS).locator('visible=true')).toHaveCount(2);
      await expect(page.getByText(LONG_SENDER).locator('visible=true')).toHaveCount(2);
      await expect(page.getByText('Late booking to decide').locator('visible=true')).toHaveCount(1);
      await expect(
        page.getByText('One-package exception waiting for approval').locator('visible=true'),
      ).toHaveCount(1);
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await clippedControls(page)).toEqual([]);
    });
  }

  // Break caught (WCAG 1.4.4, 1.4.10): sizes in pixels, so that enlarged text does not grow the cards, or the columns not giving way to them.
  for (const size of [WIDE, { width: 640, height: 800 }]) {
    test(`at 200% text takes the cards, whole, with no sideways scrolling at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests', longWorld());
      // Where the table is drawn at the size text is made, enlarging it is what takes the table away.
      if (size.width === WIDE.width) await expect(queueTable(page)).toBeVisible();
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });

      await expect(queueCards(page)).toBeVisible();
      await expect(queueTable(page)).toHaveCount(0);
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await clippedControls(page)).toEqual([]);
    });
  }

  // Break caught: a queue with a violation that only shows in one of its drawings, or in one state's colours (the four badges are four tones), or with the panel open.
  test('has no WCAG 2.2 A or AA violation as a table, as cards, or with a request open beside it, with every state in it', async ({
    page,
  }) => {
    const states = [
      pickup({ id: IDS.pending, code: 'ACC-PR-7KQ2MZ', state: 'PENDING' }),
      pickup({ id: IDS.confirmed, code: 'ACC-PR-9WXH4T', state: 'CONFIRMED' }),
      pickup({ id: IDS.booked, code: 'ACC-PR-3TZ8A6', state: 'DECLINED' }),
      pickup({ id: IDS.single, code: 'ACC-PR-4VA9B7', state: 'CANCELLED' }),
    ];
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests', { requests: states });
    await expect(queueTable(page)).toBeVisible();
    expect(await wcagViolations(page)).toEqual([]);

    await opener(page, CODE).click();
    await expect(page.getByRole('dialog', { name: CODE })).toBeVisible();
    await expect(page.getByText('It waits for an Ops officer to confirm it.')).toBeVisible();
    expect(await wcagViolations(page), 'with the panel open').toEqual([]);
    await page.keyboard.press('Escape');

    for (const size of [NARROW, PHONE]) {
      await page.setViewportSize(size);
      await expect(queueCards(page)).toBeVisible();
      expect(await wcagViolations(page), `${String(size.width)} px`).toEqual([]);
    }
  });

  test('with reduced motion nothing in the queue moves, in either drawing', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const size of [WIDE, NARROW]) {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests');
      await expect(opener(page, CODE)).toBeVisible();

      const running = await page.evaluate(
        () =>
          document.getAnimations().filter((animation) => animation.playState === 'running').length,
      );
      expect(running).toBe(0);
    }
  });

  // Break caught: a pager whose button is gone while the next page loads and drops focus on the document, or a results region that no longer takes focus.
  for (const [shown, size] of [
    ['a table', WIDE],
    ['cards', NARROW],
  ] as const) {
    test(`pages with the server’s tokens and puts focus on the results, beside ${shown}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const { api } = await open(page, '/pickup-requests', { pageSize: 1 });
      await expect(
        page.getByText('Showing 1 request. More follow on the next page.'),
      ).toBeVisible();
      await expect(opener(page, CODE)).toBeVisible();

      await page.getByRole('button', { name: 'Next page' }).click();

      await expect(page.getByText('Showing 1 request on page 2.')).toBeVisible();
      await expect(opener(page, 'ACC-PR-9WXH4T')).toBeVisible();
      await expect(opener(page, CODE)).toHaveCount(0);
      await expect(page.locator('.ui-data-table__scroller')).toBeFocused();
      expect(api.calls.some((call) => call.search === '?page_token=1')).toBe(true);

      await page.getByRole('button', { name: 'Previous page' }).click();
      await expect(opener(page, CODE)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Previous page' })).toHaveCount(0);
    });
  }
});

/**
 * The parts that stay in view, the long text and the room the queue has (run 4, Stage 2; the review of 5edada2, M2, M5 and M6). Forty requests make the queue taller than the window.
 */
/** The characters an operational code is made of: none that can be confused when read aloud (no 0, 1, I, L or O). */
const CODE_CHARACTERS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const TALL = Array.from({ length: 40 }, (_, index) =>
  pickup({
    id: `5e0b0000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    code: `ACC-PR-${CODE_CHARACTERS.charAt(index % 31)}${CODE_CHARACTERS.charAt(Math.floor(index / 31))}22QX`,
    scheduled_service_date: '2026-11-03',
  }),
);

/** What in the queue is wider than its own box: a cell, a card or the box of the rows itself, cut off or scrolling where its words should wrap. */
function overflowingInQueue(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.ui-data-table__scroller, .ui-data-table__scroller th, .ui-data-table__scroller td, .ui-data-table__card',
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map(
        (element) =>
          `${element.tagName.toLowerCase()} ${element.textContent.trim().slice(0, 30)}: ${String(element.scrollWidth)} > ${String(element.clientWidth)}`,
      ),
  );
}

/**
 * What in the queue's rows is wider than its own cell or card, cut off where its words should wrap: the cells and the cards, and not the box of the rows, which may scroll sideways
 * while the table keeps every column in a room narrower than the columns need (a box of 41rem at 768px).
 */
function clippedCellsInQueue(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.ui-data-table__scroller th, .ui-data-table__scroller td, .ui-data-table__card',
      ),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map(
        (element) =>
          `${element.tagName.toLowerCase()} ${element.textContent.trim().slice(0, 30)}: ${String(element.scrollWidth)} > ${String(element.clientWidth)}`,
      ),
  );
}

/** What in the queue is cut off with an ellipsis: nothing that is a name, an address or a note may be. */
function ellipsisedInQueue(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ui-data-table__scroller *')]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => getComputedStyle(element).textOverflow === 'ellipsis')
      .map((element) => element.textContent.trim().slice(0, 30)),
  );
}

test.describe('the queue: the parts that stay in view, long text and the room it has', () => {
  // Break caught: a panel that sticks 16px from the top of the window, under the sticky top bar, so that its header (the code, "Open full page", the close button) is covered once the
  // queue has scrolled; and a panel taller than the room below the bar, whose last act cannot be reached.
  test('keeps the panel below the top bar and whole in the window while the queue scrolls, its last act in reach', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 640 });
    await open(page, '/pickup-requests', { requests: TALL });
    const code = TALL.at(0)?.code ?? '';
    await opener(page, code).click();
    const panel = page.getByRole('dialog', { name: code });
    await expect(panel).toBeVisible();

    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);

    const bar = await page.getByRole('banner').boundingBox();
    const box = await panel.boundingBox();
    const barBottom = (bar?.y ?? 0) + (bar?.height ?? 0);
    expect(barBottom).toBeGreaterThan(40);
    // Its top is not under the bar, and the whole of it is in the window.
    expect(box?.y ?? 0).toBeGreaterThanOrEqual(barBottom - 1);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(640 + 1);
    await expect(panel.getByRole('link', { name: 'Open full page' })).toBeInViewport({ ratio: 1 });
    await expect(panel.getByRole('button', { name: 'Close the panel' })).toBeInViewport({
      ratio: 1,
    });
    // The act of the panel is reached by scrolling the panel, never by scrolling the page out from under it.
    const confirm = panel.getByRole('button', { name: 'Confirm pickup' });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport({ ratio: 1 });
    const after = await confirm.boundingBox();
    expect(after?.y ?? 0).toBeGreaterThanOrEqual(barBottom - 1);
  });

  // Break caught (the review of 5edada2, M5): a cell that never wraps, so that a long address or a long name runs out of its box, is cut with an ellipsis or makes the box scroll sideways
  // (the old table's guards, which run 3 removed): the text is on the page whole, in the box it has, at every width and with the panel open.
  for (const size of [WIDE, { width: 1280, height: 800 }, { width: 768, height: 1024 }]) {
    test(`wraps a long address, name and note whole, and never cuts it off or scrolls the box sideways, at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests', longWorld());

      const address = page.getByText(LONG_ADDRESS).locator('visible=true');
      await expect(address).toHaveCount(2);
      await expect(page.getByText(LONG_SENDER).locator('visible=true')).toHaveCount(2);
      // A table in a box as wide as its columns needs scrolls nowhere. At 768px the box is 41rem and the table keeps every column (the review of 499399c: cards only under 40rem), which
      // needs more: its box scrolls sideways, and what must hold is that no cell cuts its words off and that the page itself never scrolls.
      expect(
        size.width > 768 ? await overflowingInQueue(page) : await clippedCellsInQueue(page),
      ).toEqual([]);
      expect(await ellipsisedInQueue(page)).toEqual([]);
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      // Wrapped, not truncated: the address takes more than one line and the box holds it.
      const box = await address.first().boundingBox();
      expect(box?.height ?? 0).toBeGreaterThan(30);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
    });
  }

  test('keeps a long name and address whole with a request open beside the queue', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests', longWorld());
    await opener(page, CODE).click();
    await expect(page.getByRole('dialog', { name: CODE })).toBeVisible();

    await expect(page.getByText(LONG_SENDER).locator('visible=true').first()).toBeVisible();
    expect(await overflowingInQueue(page)).toEqual([]);
    expect(await ellipsisedInQueue(page)).toEqual([]);
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);

    // Wrapped cells are not clamped (the Product Owner, 9 November 2026): with the panel open the sender takes as many lines as its words need, and its cell is as tall as those lines.
    const sender = queueTable(page).getByText(LONG_SENDER).first();
    const senderBox = await sender.boundingBox();
    const cellBox = await sender
      .locator('xpath=ancestor::*[self::th or self::td][1]')
      .boundingBox();
    expect(senderBox?.height ?? 0).toBeGreaterThan(30);
    expect((senderBox?.y ?? 0) + (senderBox?.height ?? 0)).toBeLessThanOrEqual(
      (cellBox?.y ?? 0) + (cellBox?.height ?? 0) + 1,
    );
    // Nothing is hidden by a line count or a height: neither the text's element nor its cell holds more than it shows.
    const hidden = await sender.evaluate((element) =>
      [element, element.closest('th, td')].map((box) =>
        box === null ? 0 : box.scrollHeight - box.clientHeight,
      ),
    );
    expect(hidden.every((height) => height <= 1)).toBe(true);
  });

  // Break caught (the review of 5edada2, M6, and the Product Owner's decision of 9 November 2026 that replaced its answer): a queue with nothing beside it that drops the columns it marked
  // lesser, so that at 768px it showed less than the cards it replaced. It does not: it keeps the table and every column from 40rem up (a box of 41rem at 768px, scrolling inside itself),
  // so every fact of a request is in its row; and it is cards under 40rem, with every fact (640px, a box of 38rem).
  test('keeps the table, with every column and every fact of a request, at 768px with no request open', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await open(page, '/pickup-requests');

    await expect(queueTable(page)).toBeVisible();
    await expect(queueCards(page)).toHaveCount(0);
    await expect(queueTable(page).getByRole('columnheader')).toHaveText(QUEUE_COLUMNS);
    const row = queueTable(page).getByRole('row').filter({ hasText: CODE });
    for (const fact of [
      CODE,
      'Demo Fabrics Ltd',
      'Tue 3 Nov 2026',
      '14 Demo Lane, Osu',
      'Accra Central',
      '3 packages',
      'A vendor’s own packages',
    ]) {
      await expect(row).toContainText(fact);
    }
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
  });

  test('draws cards with every fact under 40rem with no request open, at 640px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 640, height: 900 });
    await open(page, '/pickup-requests');

    const cards = queueCards(page);
    await expect(cards).toBeVisible();
    await expect(queueTable(page)).toHaveCount(0);
    const first = cards.getByRole('listitem').first();
    // Each card keeps a heading, its code, for heading navigation (it is outside the card's button, whose content is presentational).
    await expect(first.getByRole('heading', { level: 2 })).toHaveText(CODE);
    await expect(cards.getByRole('heading', { level: 2 })).toHaveCount(2);
    for (const fact of [
      CODE,
      'Demo Fabrics Ltd',
      'Tue 3 Nov 2026',
      '14 Demo Lane, Osu',
      'Accra Central',
      '3 packages',
      'A vendor’s own packages',
    ]) {
      await expect(first).toContainText(fact);
    }
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
  });

  test('keeps the table, without its lesser columns, with a request open beside it at 1440px', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests');
    await expect(queueTable(page)).toBeVisible();
    await expect(
      queueTable(page).getByRole('columnheader', { name: 'Service date' }),
    ).toBeVisible();

    await opener(page, CODE).click();
    await expect(page.getByRole('dialog', { name: CODE })).toBeVisible();

    // What the columns of lesser weight hold is in the panel, so the table gives them up and does not scroll sideways.
    await expect(queueTable(page)).toBeVisible();
    await expect(queueTable(page).getByRole('columnheader', { name: 'State' })).toBeVisible();
    await expect(queueTable(page).getByRole('columnheader', { name: 'Service date' })).toHaveCount(
      0,
    );
    expect(await overflowingInQueue(page)).toEqual([]);
  });
});

/**
 * Confirming from the queue (run 4, Stage 3.1 to 3.3; the review of 5edada2): the row's Confirm opens the request in the panel with focus on the panel's own Confirm, and the panel
 * confirms with the version of the read it shows. A request that changed since is told as changed, in the panel, with the way to read it again; after a confirmation the rows stay,
 * the row that changed is told, focus is on it and the panel shows the state from the answer.
 */
test.describe('the queue: confirming in the panel', () => {
  const rowButton = (page: Page) => opener(page, CODE);
  const READ = `/api/v1/pickup-requests/${IDS.pending}`;

  // Break caught: the queue's Confirm that read the request again just before it confirmed, so that a request changed in the meantime was confirmed at a version the officer never saw.
  test('opens the panel on the row’s Confirm, asks first, confirms on the version the panel read, and shows what happened', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(page, '/pickup-requests');
    await page.getByRole('button', { name: `Confirm ${CODE}` }).click();

    const panel = page.getByRole('dialog', { name: CODE });
    const confirm = panel.getByRole('button', { name: 'Confirm pickup' });
    await expect(confirm).toBeFocused();
    expect(posts(api)).toEqual([]);

    await confirm.click();
    const question = page.getByRole('alertdialog', { name: 'Confirm this pickup?' });
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await question.getByRole('button', { name: 'Confirm the pickup' }).click();

    // The request was read once, for the panel, and the act carries that read's version: it is not read again for the act.
    await expect.poll(() => posts(api).length).toBe(1);
    expect(posts(api)[0]?.ifMatch).toBe('"v1"');
    expect(api.calls.filter((call) => call.method === 'GET' && call.path === READ)).toHaveLength(1);
    // What the officer sees: the panel shows the state from the answer, the row that changed is told, and focus is on it.
    await expect(panel.getByText('Confirmed').first()).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Confirm pickup' })).toHaveCount(0);
    await expect(rowButton(page)).toBeFocused();
    await expect(rowButton(page)).toHaveAccessibleDescription('Updated');
    await expect(page.getByText(`${CODE} is confirmed.`)).toBeVisible();
    expect(watch.problems.filter((problem) => !problem.includes('HTTP 4'))).toEqual([]);
  });

  test('tells a request that changed since the panel read it as changed, in the panel, and confirms on the new version once it is read again', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/pickup-requests');
    await page.getByRole('button', { name: `Confirm ${CODE}` }).click();
    const panel = page.getByRole('dialog', { name: CODE });
    await panel.getByRole('button', { name: 'Confirm pickup' }).click();
    // Someone else changed the request after the panel read it: the version the panel holds is no longer the record's.
    const row = api.world.requests.find((each) => each.id === IDS.pending);
    if (row !== undefined) row.version += 1;
    const question = page.getByRole('alertdialog', { name: 'Confirm this pickup?' });
    await question.getByRole('button', { name: 'Confirm the pickup' }).click();
    await expect(question).toContainText('changed after you opened it');

    // Dismissing the question leaves the panel saying so, with the way to read the request again.
    await question.getByRole('button', { name: 'Cancel' }).click();
    const banner = panel.getByRole('alert');
    await expect(banner).toContainText('changed');
    expect(posts(api)).toHaveLength(1);
    await banner.getByRole('button', { name: 'Reload' }).click();
    await expect(banner).toHaveCount(0);

    await panel.getByRole('button', { name: 'Confirm pickup' }).click();
    await page
      .getByRole('alertdialog', { name: 'Confirm this pickup?' })
      .getByRole('button', { name: 'Confirm the pickup' })
      .click();
    await expect.poll(() => posts(api).length).toBe(2);
    expect(posts(api)[1]?.ifMatch).toBe('"v2"');
  });

  // Break caught: the queue header's booking link taking the one primary of the view from the panel's act.
  test('has one primary act in view: the panel’s Confirm, and the booking link as a secondary', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests');
    await page.getByRole('button', { name: `Confirm ${CODE}` }).click();
    const panel = page.getByRole('dialog', { name: CODE });
    await expect(panel.getByRole('button', { name: 'Confirm pickup' })).toBeVisible();

    const colourOf = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).backgroundColor);
    const book = page.getByRole('main').getByRole('link', { name: 'Book a pickup' });
    await expect(book).toBeVisible();
    expect(await colourOf(book)).not.toBe(
      await colourOf(panel.getByRole('button', { name: 'Confirm pickup' })),
    );
    await expect(book).toHaveClass(/ui-button--secondary/);
  });
});

/**
 * The request's own page and the booking, at the widths they are used at (run 4, Stage 3.4 and 3.5; the review of 5edada2).
 */
test.describe('one request: the record page', () => {
  // Break caught: focus on the code heading drawn with a ring, as if the heading were a control.
  test('lands focus on the code heading with no ring', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(page, DETAIL);

    const heading = page.getByRole('heading', { level: 1, name: CODE });
    await expect(heading).toBeFocused();
    expect(await heading.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      'none',
    );
  });

  // Break caught (the review of 5edada2): one long column at 1280px, with who to reach and the history after the attempts, where a side column has the room.
  for (const [width, beside] of [
    [1440, true],
    [1280, true],
    [768, false],
  ] as const) {
    test(`puts who to reach, the history and what is related ${beside ? 'beside' : 'after'} the work at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, DETAIL);

      const work = await page.getByRole('heading', { level: 2, name: 'The request' }).boundingBox();
      const people = await page
        .getByRole('heading', { level: 2, name: 'Who to reach, and who pays' })
        .boundingBox();
      const history = await page.getByRole('heading', { level: 2, name: 'History' }).boundingBox();
      const attempts = await page
        .getByRole('heading', { level: 2, name: 'Attempts' })
        .boundingBox();
      expect(work).not.toBeNull();
      expect(people).not.toBeNull();
      if (beside) {
        // The side column is to the right of the work and starts at its height; the attempts stay in the work's column.
        expect(people?.x ?? 0).toBeGreaterThan((work?.x ?? 0) + 300);
        expect(Math.abs((people?.y ?? 0) - (work?.y ?? 0))).toBeLessThan(60);
        expect(history?.x ?? 0).toBeGreaterThan((work?.x ?? 0) + 300);
        expect(Math.abs((attempts?.x ?? 0) - (work?.x ?? 0))).toBeLessThan(8);
      } else {
        expect(Math.abs((people?.x ?? 0) - (work?.x ?? 0))).toBeLessThan(8);
        expect(people?.y ?? 0).toBeGreaterThan(work?.y ?? 0);
      }
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    });
  }

  // Break caught: a path the contract does not give, or an end drawn as a stage still to come.
  test('tells where the request is on the contract’s one forward path, and the history by its own dated facts', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, DETAIL);

    const tracker = page.getByRole('list', { name: 'Progress of the pickup request' });
    await expect(tracker.getByRole('listitem')).toHaveText([
      /Waiting for confirmation/,
      /Confirmed/,
    ]);
    await expect(tracker.locator('[aria-current="step"]')).toContainText(
      'Waiting for confirmation',
    );
    const history = page.getByRole('list', { name: 'History of this request, oldest first' });
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history).toContainText('Booked');
    await expect(history).toContainText('29 Oct, 08:15');
  });
});

test.describe('the booking, at the widths it is used at', () => {
  const gridColumns = (page: Page) =>
    page.evaluate(() => {
      const grids = [...document.querySelectorAll<HTMLElement>('.ui-task-form__grid')].filter(
        (element) => element.getClientRects().length > 0 && element.children.length >= 2,
      );
      return grids.map((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    });

  // Break caught: two columns of fields on the tablet, where the pattern says one at 768px and below.
  for (const [width, columns] of [
    [1440, 2],
    [1280, 2],
    [768, 1],
    [390, 1],
  ] as const) {
    test(`lays the fields out in ${String(columns)} column${columns === 1 ? '' : 's'} at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page, '/pickup-requests/new');
      await fillBooking(page);

      const counts = await gridColumns(page);
      expect(counts.length).toBeGreaterThan(0);
      for (const count of counts) expect(count).toBe(columns);
    });
  }

  // Break caught: what the booking comes to read after the button that sends it, on a narrow page.
  for (const size of [{ width: 768, height: 1024 }, NARROW]) {
    test(`puts "After you book" before the button that books it at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests/new');

      const summary = await page
        .getByRole('heading', { level: 2, name: 'After you book' })
        .boundingBox();
      const submit = await page.getByRole('button', { name: 'Book the pickup' }).boundingBox();
      expect(summary).not.toBeNull();
      expect(submit).not.toBeNull();
      expect(summary?.y ?? 0).toBeLessThan(submit?.y ?? 0);
    });
  }

  test('puts "After you book" beside the sections at 1440 px, and the button under them', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests/new');

    const summary = await page
      .getByRole('heading', { level: 2, name: 'After you book' })
      .boundingBox();
    // The rail stands beside the first thing the form asks (what is being booked), and the button that books is under the sections, in the column of the sections.
    const first = await page.getByRole('group', { name: /What is being booked/ }).boundingBox();
    const submit = await page.getByRole('button', { name: 'Book the pickup' }).boundingBox();
    expect(summary?.x ?? 0).toBeGreaterThan((first?.x ?? 0) + 400);
    expect(Math.abs((summary?.y ?? 0) - (first?.y ?? 0))).toBeLessThan(80);
    expect(submit?.x ?? 1000).toBeLessThan(summary?.x ?? 0);
  });

  // Break caught: a line of help under an option that says again what the option says.
  test('has no help under a payer that repeats its label', async ({ page }) => {
    await open(page, '/pickup-requests/new');
    await fillBooking(page);

    const group = page.getByRole('group', { name: /Who pays for delivery/ });
    await expect(group).toContainText('The recipient pays');
    await expect(group).not.toContainText('for delivery.');
    await expect(group).not.toContainText('and the recipient the rest.');
  });
});

const LIST = /\/api\/v1\/pickup-requests(\?.*)?$/;

/** Opens the queue with its read answered by `answer` instead of by the stand-in: a failure, a refusal, or an answer that never comes. */
async function openAnswering(page: Page, answer: (route: Route) => Promise<void> | void) {
  const watch = watchPage(page);
  const api = await stubPickupApi(page, world());
  await page.route(LIST, answer);
  await page.goto('/pickup-requests');
  return { api, watch };
}

const failing = (status: number, code: string) => (route: Route) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      code,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-queue',
    }),
  });

/**
 * The views, the filters, the count, the rows and the pager of the queue are one page card, and whatever stands in the place of the rows (loading, nothing, a failure, a
 * refusal) stands inside it: the states of one screen are drawn on the one surface.
 */
test.describe('the queue, set in one page card', () => {
  const STATES: readonly {
    readonly name: string;
    readonly reach: (page: Page) => Promise<unknown>;
    readonly shows: string | RegExp;
  }[] = [
    {
      name: 'the loading',
      reach: (page) =>
        openAnswering(page, () => {
          // Never answered: the read stays under way.
        }),
      shows: 'Loading pickup requests',
    },
    {
      name: 'the empty state of a queue with nothing in it',
      reach: (page) => open(page, '/pickup-requests', { requests: [] }),
      shows: 'No pickup requests yet',
    },
    {
      name: 'the empty state of a filter that hides everything',
      reach: (page) => open(page, '/pickup-requests?state=DECLINED'),
      shows: 'No pickup requests match',
    },
    {
      name: 'a failure and its retry',
      reach: (page) => openAnswering(page, failing(500, 'INTERNAL_ERROR')),
      shows: 'The pickup requests could not be loaded.',
    },
    {
      name: 'a refusal, in plain words',
      reach: (page) => openAnswering(page, failing(403, 'PERMISSION_DENIED')),
      shows: 'Your account can’t see pickup requests. Ask an administrator for access.',
    },
  ];

  for (const state of STATES) {
    test(`keeps the views, the filters and ${state.name} in the one card`, async ({ page }) => {
      await page.setViewportSize(WIDE);
      await state.reach(page);
      const card = page.locator('.ui-queue-workspace__main');

      await expect(card).toHaveCount(1);
      await expect(
        card.getByRole('tablist', { name: 'Views of the pickup requests' }),
      ).toBeVisible();
      await expect(card.getByRole('group', { name: 'Filter the pickup requests' })).toBeVisible();
      await expect(card.getByText(state.shows).first()).toBeAttached();
    });
  }

  test('sets the pager in the card, under a hairline', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests', { pageSize: 1 });
    const pager = page.locator('.ui-queue-workspace__main .ui-queue-pager');

    await expect(pager.getByRole('button', { name: 'Next page' })).toBeVisible();
    expect(await pager.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px');
  });
});

/**
 * Refreshing the queue's page, and coming back to it from a request (COMPONENT_PATTERNS section 22f; the reference of 1 November 2026, sections 3
 * and 4), in a real browser: what only layout, focus and a real history can show. Twelve requests with codes of their own, read five at a time by
 * the stand-in's offset tokens, so that a page after the first has requests of its own.
 */
const LETTERS = 'ABCDEFGHJKMN';
const codeOf = (index: number): string =>
  `ACC-PR-${LETTERS.charAt(index)}${LETTERS.charAt(index)}22QX`;
const MANY = Array.from({ length: 12 }, (_, index) =>
  pickup({
    id: `5e0a0000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    code: codeOf(index),
    scheduled_service_date: '2026-11-03',
  }),
);
const FIVE_AT_A_TIME = { requests: MANY, pageSize: 5 } as const;
const listReads = (api: PickupApi) =>
  api.calls.filter((call) => call.method === 'GET' && call.path === '/api/v1/pickup-requests');

/** Holds every read of the queue from now on until the returned function is called; the stand-in answers it then. */
async function holdReads(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(LIST, async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

test.describe('the queue: Refresh', () => {
  const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh' });
  const checked = (page: Page) => page.getByText(/^Updated /);

  test('reads the page again with its filters and its cursor, and leaves the officer on that page', async ({
    page,
  }) => {
    const { api } = await open(page, '/pickup-requests?state=PENDING', FIVE_AT_A_TIME);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    const before = listReads(api).length;

    await refresh(page).click();

    await expect(page.getByText('Page refreshed.')).toHaveText('Page refreshed.');
    await expect(page.getByText(/Showing 5 requests on page 2/)).toBeVisible();
    expect(listReads(api)).toHaveLength(before + 1);
    expect(listReads(api).at(-1)?.search).toBe('?state=PENDING&page_token=5');
    await expect(page).toHaveURL('/pickup-requests?state=PENDING');
  });

  // Break caught: the old rows left on the screen while the new read is under way, or focus lost with the button's busy state.
  test('takes the rows off while it reads, keeps focus on the button, and says once that it is done', async ({
    page,
  }) => {
    await open(page, '/pickup-requests', FIVE_AT_A_TIME);
    await expect(checked(page)).toBeVisible();
    const release = await holdReads(page);

    // By keyboard: WebKit does not give a button focus when it is clicked, so a click would leave nothing for the page to keep.
    await refresh(page).focus();
    await page.keyboard.press('Enter');

    await expect(refresh(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('Loading pickup requests')).toBeAttached();
    await expect(page.getByText('Checking…')).toBeVisible();
    await expect(opener(page, codeOf(0))).toHaveCount(0);
    release();

    await expect(opener(page, codeOf(0))).toBeVisible();
    await expect(checked(page)).toBeVisible();
    await expect(refresh(page)).toBeFocused();
    await expect(refresh(page)).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('Page refreshed.')).toHaveCount(1);
  });

  // Break caught: rows of the earlier read beside the failure of this one, which would pass for the queue as it is.
  test('shows the failure and no rows when the refresh fails, and says when the last check that worked was', async ({
    page,
  }) => {
    await open(page, '/pickup-requests', FIVE_AT_A_TIME);
    const time = ((await checked(page).textContent()) ?? '').replace('Updated ', '');
    expect(time).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
    await page.route(LIST, failing(500, 'INTERNAL_ERROR'), { times: 1 });

    await refresh(page).click();

    await expect(page.getByRole('alert')).toContainText('The pickup requests could not be loaded.');
    await expect(opener(page, codeOf(0))).toHaveCount(0);
    await expect(page.getByText(`Refresh failed. Last successful check: ${time}`)).toBeVisible();
    await expect(checked(page)).toHaveCount(0);
    await expect(refresh(page)).not.toHaveAttribute('aria-busy', 'true');
  });

  // Break caught: the word tied to the filter and not to the visit, so that going to another filter and back said "done" again over a read that
  // was not a refresh.
  test('does not say the refresh was done again when the officer goes to another filter and comes back', async ({
    page,
  }) => {
    await open(page, '/pickup-requests', FIVE_AT_A_TIME);
    await expect(checked(page)).toBeVisible();
    // By keyboard, as above: WebKit does not give a clicked button focus, and the page has nothing to keep for a click.
    await refresh(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Page refreshed.')).toHaveCount(1);

    await page.getByRole('tab', { name: 'Confirmed' }).click();
    await expect(page.getByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    const release = await holdReads(page);
    await page.getByRole('tab', { name: 'All' }).click();
    await expect(page.getByText('Loading pickup requests')).toBeAttached();

    // While the newer read of the first filter is under way, and after it: nobody asked for it as a refresh.
    await expect(page.getByText('Page refreshed.')).toHaveCount(0);
    release();
    await expect(opener(page, codeOf(0))).toBeVisible();
    await expect(page.getByText('Page refreshed.')).toHaveCount(0);
  });

  // Break caught: a page that reads again by itself (on focus, on reconnection), which every accepted request being activity for the
  // session's idle limit the reference leaves out on purpose.
  test('reads nothing on its own: not when the page is focused again, not when the connection returns', async ({
    page,
    context,
  }) => {
    const { api } = await open(page, '/pickup-requests', FIVE_AT_A_TIME);
    await expect(checked(page)).toBeVisible();
    const reads = listReads(api).length;

    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await context.setOffline(true);
    await context.setOffline(false);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
    });
    await page.waitForTimeout(700);

    expect(listReads(api)).toHaveLength(reads);
  });
});

test.describe('the queue: coming back from a request', () => {
  const opened = codeOf(7); // on the second page of five

  /** The officer pages to the second page, and opens a request on it. */
  async function toTheRequest(page: Page, size: { width: number; height: number } = WIDE) {
    await page.setViewportSize(size);
    const view = await open(page, '/pickup-requests?state=PENDING', FIVE_AT_A_TIME);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await goToRequest(page, opened);
    await expect(page.getByRole('heading', { level: 1, name: opened })).toBeVisible();
    return view;
  }

  const backLink = (page: Page) => page.getByRole('link', { name: 'Back to pickup requests' });

  /** Where the officer should be: the page they left, read again, with focus on the request they opened. */
  async function expectTheOfficerBack(page: Page, api: PickupApi) {
    await expect(page).toHaveURL('/pickup-requests?state=PENDING');
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await expect(opener(page, opened)).toBeFocused();
    expect(listReads(api).at(-1)?.search).toBe('?state=PENDING&page_token=5');
    // The cursor is in no storage, and in no address.
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(page.url()).not.toContain('page_token');
  }

  for (const [shown, size] of [
    ['a table', WIDE],
    ['cards', NARROW],
  ] as const) {
    test(`the link back returns to the page the officer left, read again, with focus on the request they opened, beside ${shown}`, async ({
      page,
    }) => {
      const { api } = await toTheRequest(page, size);
      const reads = listReads(api).length;

      await backLink(page).click();

      await expectTheOfficerBack(page, api);
      expect(listReads(api)).toHaveLength(reads + 1);
    });

    test(`the browser’s Back returns to the same page, beside ${shown}`, async ({ page }) => {
      const { api } = await toTheRequest(page, size);

      await page.goBack();

      await expectTheOfficerBack(page, api);
    });
  }

  // Break caught: a place that outlives the page, or one kept where a reload, the menu or an address could find it. One test for each of the three ways in (they were one
  // test that walked all three, which took 27 of its 30 seconds on the development server in the review of f6cf02b): each goes to the request on the second page, as the
  // officer does, and then leaves it that way.
  test('starts at the first page after a reload', async ({ page }) => {
    await toTheRequest(page);
    await backLink(page).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();

    await page.reload();
    await expect(opener(page, codeOf(0))).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);
  });

  test('starts at the first page from the menu', async ({ page }) => {
    await toTheRequest(page);

    await menuEntry(page, 'Requests').click();
    await expect(opener(page, codeOf(0))).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);
  });

  test('starts at the first page from a typed address', async ({ page }) => {
    await toTheRequest(page);

    await page.goto('/pickup-requests?state=PENDING');
    await expect(opener(page, codeOf(0))).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);
  });

  // Break caught: the position taken from the browser's own restoration, which does not run for a link, so that the link back would open at the top.
  for (const [how, back] of [
    ['the link back', (page: Page) => backLink(page).click()],
    ['the browser’s Back', (page: Page) => page.goBack()],
  ] as const) {
    test(`gives the position on the page back, with the request in view, by ${how}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 500 });
      await open(page, '/pickup-requests', { requests: MANY, pageSize: 12 });
      const far = opener(page, codeOf(10));
      await far.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
      // The place that is left is the one the officer leaves from: the page as it stands when they press the panel's link (the panel is in view where it is, and the page is not
      // moved to it), which is where Playwright would otherwise scroll to before its click.
      await far.click();
      const link = page
        .getByRole('dialog', { name: codeOf(10) })
        .getByRole('link', { name: 'Open full page' });
      await link.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      await link.click();
      await expect(page.getByRole('heading', { level: 1, name: codeOf(10) })).toBeVisible();

      await back(page);

      await expect(far).toBeFocused();
      const after = await page.evaluate(() => window.scrollY);
      expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
      const box = await far.boundingBox();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(500);
    });
  }

  // Break caught: the not-found page given no memory of the request it was opened for, so that its link back lost the page and the filters.
  test('keeps the way back to the page the officer left through a request that is not there', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/pickup-requests?state=PENDING', FIVE_AT_A_TIME);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    // The queue still lists the request; by the time it is opened the server says it is not there.
    await page.route(`**/api/v1/pickup-requests/${MANY[7]?.id ?? ''}`, failing(404, 'NOT_FOUND'));

    await goToRequest(page, opened);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Pickup request not found' }),
    ).toBeVisible();
    await expect(backLink(page)).toHaveAttribute('href', '/pickup-requests?state=PENDING');
    const reads = listReads(api).length;
    await backLink(page).click();

    await expectTheOfficerBack(page, api);
    expect(listReads(api)).toHaveLength(reads + 1);
  });

  test('gives the plain queue behind the link back of a request that is not there when it was reached directly', async ({
    page,
  }) => {
    // An identifier that is a request's in form, and that the stand-in does not hold.
    await open(page, '/pickup-requests/5e0a0000-0000-4000-8000-0000000000ff', FIVE_AT_A_TIME);

    await expect(
      page.getByRole('heading', { level: 1, name: 'Pickup request not found' }),
    ).toBeVisible();
    await expect(backLink(page)).toHaveAttribute('href', '/pickup-requests');
  });

  // Break caught: a refusal page with no way back, or one that forgot where the officer came from and gave the plain queue.
  for (const [why, code, heading] of [
    ['a request outside the officer’s hubs', 'HUB_SCOPE_VIOLATION', 'This is outside your hubs'],
    [
      'a request the officer may not read',
      'PERMISSION_DENIED',
      'You do not have access to this page',
    ],
  ] as const) {
    test(`keeps the way back to the page the officer left through ${why}`, async ({ page }) => {
      await page.setViewportSize(WIDE);
      const { api } = await open(page, '/pickup-requests?state=PENDING', FIVE_AT_A_TIME);
      await page.getByRole('button', { name: 'Next page' }).click();
      await expect(page.getByText(/on page 2/)).toBeVisible();
      // The queue lists the request; by the time it is opened the server refuses the officer it.
      await page.route(`**/api/v1/pickup-requests/${MANY[7]?.id ?? ''}`, failing(403, code));

      await goToRequest(page, opened);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(backLink(page)).toHaveAttribute('href', '/pickup-requests?state=PENDING');
      const reads = listReads(api).length;
      await backLink(page).click();

      await expectTheOfficerBack(page, api);
      expect(listReads(api)).toHaveLength(reads + 1);
    });

    test(`gives the plain queue behind the link back of ${why}, reached directly`, async ({
      page,
    }) => {
      await stubPickupApi(page, world(FIVE_AT_A_TIME));
      await page.route(`**/api/v1/pickup-requests/${MANY[7]?.id ?? ''}`, failing(403, code));
      await page.goto(`/pickup-requests/${MANY[7]?.id ?? ''}`);

      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(backLink(page)).toHaveAttribute('href', '/pickup-requests');
    });
  }

  // Break caught: a link to a queue the session cannot read, which leads from one refusal to another and leaves nowhere to go.
  test('gives a session that cannot read the queue the refusal with no link to another one', async ({
    page,
  }) => {
    const api = await stubPickupApi(
      page,
      world({ ...FIVE_AT_A_TIME, permissions: ['pickup.exception.request'] }),
    );
    await page.route(
      `**/api/v1/pickup-requests/${MANY[7]?.id ?? ''}`,
      failing(403, 'PERMISSION_DENIED'),
    );
    await page.goto(`/pickup-requests/${MANY[7]?.id ?? ''}/exception`);

    await expect(
      page.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    await expect(backLink(page)).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Main menu' })).toBeVisible();
    expect(listReads(api)).toHaveLength(0);
  });

  test('gives focus to the results when the request is no longer on the page', async ({ page }) => {
    const { api } = await toTheRequest(page);
    api.world.requests = api.world.requests.filter((row) => row.code !== opened);

    await backLink(page).click();

    await expect(page.locator('.ui-data-table__scroller')).toBeFocused();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await expect(opener(page, opened)).toHaveCount(0);
  });

  // Break caught: focus pulled back to the request from the control the officer had already moved to while the page was being read.
  test('leaves focus where the officer put it while the page was being read', async ({ page }) => {
    await toTheRequest(page);
    const release = await holdReads(page);

    await backLink(page).click();
    await expect(page.getByText('Loading pickup requests')).toBeAttached();
    await page.getByRole('button', { name: 'Filter', exact: true }).focus();
    release();

    await expect(opener(page, opened)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeFocused();
  });

  test('shows the focus ring on the request when the officer came and went by keyboard', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests', FIVE_AT_A_TIME);
    const link = opener(page, codeOf(2));
    await link.focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('dialog', { name: codeOf(2) })
      .getByRole('link', { name: 'Open full page' })
      .focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 1, name: codeOf(2) })).toBeVisible();
    await backLink(page).focus();
    await page.keyboard.press('Enter');

    await expect(link).toBeFocused();
    const ring = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(ring.style).not.toBe('none');
    expect(ring.width).toBeGreaterThan(0);
  });

  test('says there are no requests on a later page that has emptied, and goes to the first only when asked', async ({
    page,
  }) => {
    const { api } = await toTheRequest(page);
    api.world.requests = api.world.requests.slice(0, 5);
    const reads = listReads(api).length;

    await backLink(page).click();

    await expect(page.getByRole('heading', { name: 'No requests on this page' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No pickup requests yet' })).toHaveCount(0);
    expect(listReads(api)).toHaveLength(reads + 1);

    await page.getByRole('button', { name: 'Back to first page' }).click();

    await expect(opener(page, codeOf(0))).toBeVisible();
    await expect(page.locator('.ui-data-table__scroller')).toBeFocused();
    expect(listReads(api).at(-1)?.search).toBe('?state=PENDING');
  });

  test('says a page the server will not open could not be opened, with the first page as the way out', async ({
    page,
  }) => {
    await open(page, '/pickup-requests?state=PENDING', FIVE_AT_A_TIME);
    await page.route(LIST, (route) =>
      route.request().url().includes('page_token')
        ? route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({
              code: 'VALIDATION_FAILED',
              message: 'Diagnostic text that must never reach a screen.',
              request_id: 'req-browser-cursor',
              details: { violations: [{ in: 'query', pointer: '/page_token', rule: 'format' }] },
            }),
          })
        : route.fallback(),
    );

    await page.getByRole('button', { name: 'Next page' }).click();

    await expect(page.getByRole('alert')).toContainText(
      'That page of the queue could not be opened',
    );
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page).toHaveURL('/pickup-requests?state=PENDING');
    await expect(page.getByRole('tab', { name: 'Waiting for confirmation' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('body')).not.toContainText('Diagnostic text');

    await page.getByRole('button', { name: 'Back to first page' }).click();
    await expect(opener(page, codeOf(0))).toBeVisible();
  });
});

test.describe('the booking', () => {
  // Break caught: a booking sent without a key, with a version it does not take, or with a price; an estimate shown as a price.
  test('books under a fresh key with no version and no price, and shows the estimate as an estimate', async ({
    page,
  }) => {
    const { api } = await open(page, '/pickup-requests/new');
    await fillBooking(page);
    await page.getByRole('button', { name: 'Book the pickup' }).click();

    await expect(page.getByRole('heading', { name: 'Pickup booked' })).toBeVisible();
    const [create] = posts(api);
    expect(create?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(create?.ifMatch).toBeUndefined();
    expect(JSON.stringify(create?.body)).not.toMatch(/price|total|amount|zone/i);
    const estimate = page.getByRole('region', { name: 'Indicative estimate (provisional)' });
    await expect(estimate).toContainText('About GH₵45.00');
    await expect(estimate).toContainText('It is not a quote');
    await expect(page.locator('body')).not.toContainText(PLANTED_PRICE_TEXT);
  });

  // Break caught: a radio group a keyboard cannot enter, or one the arrows do not move through.
  test('chooses what is booked by keyboard, and nothing is chosen first', async ({ page }) => {
    await open(page, '/pickup-requests/new');
    const first = page.getByRole('radio', { name: 'A vendor’s own packages' });
    await expect(first).not.toBeChecked();

    await first.focus();
    await page.keyboard.press('ArrowDown');

    await expect(page.getByRole('radio', { name: 'A collection for a vendor' })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'A collection for a vendor' })).toBeFocused();
  });

  test('puts focus on the first field that is wrong, and sends nothing', async ({ page }) => {
    const { api } = await open(page, '/pickup-requests/new');
    await page.getByRole('radio', { name: 'A walk-in sender' }).check();
    await page.getByRole('button', { name: 'Book the pickup' }).click();

    await expect(page.getByRole('radio', { name: 'Yes: find them by phone' })).toBeFocused();
    expect(posts(api)).toEqual([]);
  });
});

test.describe('one request', () => {
  // AC-SLICE-001-10: the act takes the version read and no key.
  test('confirms on the version read with no key, and keeps Tab inside the dialog', async ({
    page,
  }) => {
    const { api } = await open(page, DETAIL);
    await page.getByRole('button', { name: 'Confirm the pickup' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Confirm this pickup?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // Past the dialog's last control a browser may hand Tab to its own interface (the document has focus then), as the rider spec's
    // `focusPlace` says; what must never happen is focus on the page behind the dialog.
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      const place = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'document';
        return active.closest('dialog') === null ? 'outside' : 'dialog';
      });
      expect(place).not.toBe('outside');
    }

    await dialog.getByRole('button', { name: 'Confirm the pickup' }).click();

    await expect(
      page.getByText('The request is confirmed. It waits in the pool for a pickup run.'),
    ).toBeVisible();
    const [confirm] = posts(api);
    expect(confirm?.ifMatch).toBe('"v1"');
    expect(confirm?.idempotencyKey).toBeUndefined();
  });

  test('a request changed by someone else is explained, and read again', async ({ page }) => {
    const { api } = await open(page, DETAIL);
    await page.getByRole('button', { name: 'Confirm the pickup' }).click();
    // Someone else confirmed it meanwhile: the version the page read is no longer the record's.
    const row = api.world.requests.find((each) => each.id === IDS.pending);
    if (row !== undefined) row.version += 1;
    await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm the pickup' }).click();

    await expect(page.getByRole('alertdialog')).toContainText('changed after you opened it');
    await page.getByRole('button', { name: 'Reload the record' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  // The catalogue's codes are not seeded: the act cannot be done here, and the page says so and who adds them, and sends nothing.
  test('says no cancellation reason is configured, and cannot cancel', async ({ page }) => {
    const { api } = await open(page, DETAIL);
    await chooseAct(page, 'Cancel the request');
    const dialog = page.getByRole('alertdialog', { name: 'Cancel this pickup request?' });

    await expect(dialog).toContainText('No cancellation reason is configured yet');
    await expect(dialog).toContainText('An administrator adds the reasons to the reason catalogue');
    await expect(dialog).not.toContainText('settings.reason.manage');
    await expect(dialog.getByRole('button', { name: 'Cancel the request' })).toBeDisabled();
    expect(posts(api)).toEqual([]);
  });

  test('cancels with a reason of the catalogue, the version read and a fresh key', async ({
    page,
  }) => {
    const { api } = await open(page, DETAIL, {
      cancellationReasons: [
        {
          code: 'DEMO_CUSTOMER_CHANGED_MIND',
          label: 'Demo: customer changed their mind',
          attribution: 'CUSTOMER',
        },
      ],
    });
    await chooseAct(page, 'Cancel the request');
    const dialog = page.getByRole('alertdialog', { name: 'Cancel this pickup request?' });
    await dialog
      .getByRole('combobox', { name: /^Reason/ })
      .selectOption('DEMO_CUSTOMER_CHANGED_MIND');
    await dialog.getByRole('button', { name: 'Cancel the request' }).click();

    await expect(page.getByText('The request is cancelled.')).toBeVisible();
    const [cancel] = posts(api);
    expect(cancel?.ifMatch).toBe('"v1"');
    expect(cancel?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(cancel?.body).toEqual({
      reason_code: 'DEMO_CUSTOMER_CHANGED_MIND',
      create_replacement: false,
    });
  });

  test('records the decision on a late booking with a note, the version read and a fresh key', async ({
    page,
  }) => {
    const { api } = await open(page, LATE);
    await page.getByRole('button', { name: 'Decide the late booking' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Decide this late booking?' });
    await dialog.getByRole('radio', { name: 'Approve it for the same day' }).check();
    await dialog.getByRole('textbox', { name: /Why/ }).fill('Vendor called before ten');
    await dialog.getByRole('button', { name: 'Record the decision' }).click();

    await expect(page.getByText('The late booking is approved for the same day.')).toBeVisible();
    const [decision] = posts(api);
    expect(decision?.ifMatch).toBe('"v1"');
    expect(decision?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(decision?.body).toEqual({
      decision: 'APPROVE_SAME_DAY',
      note: 'Vendor called before ten',
    });
  });

  test('never shows a price the answers should not carry', async ({ page }) => {
    await open(page, DETAIL);
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeVisible();

    await expect(page.locator('body')).not.toContainText(PLANTED_PRICE_TEXT);
    await expect(page.locator('body')).not.toContainText(/\btotal\b/i);
  });
});

interface Screen {
  readonly name: string;
  readonly reach: (page: Page) => Promise<void>;
}

const SCREENS: readonly Screen[] = [
  {
    name: 'the queue',
    reach: async (page) => {
      await open(page, '/pickup-requests');
      await expect(opener(page, 'ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  {
    name: 'the queue with nothing to show',
    reach: async (page) => {
      await open(page, '/pickup-requests', { requests: [] });
      await expect(page.getByRole('heading', { name: 'No pickup requests yet' })).toBeVisible();
    },
  },
  {
    name: 'the queue that could not be read',
    reach: async (page) => {
      await openAnswering(page, failing(500, 'INTERNAL_ERROR'));
      await expect(page.getByRole('alert')).toContainText(
        'The pickup requests could not be loaded.',
      );
    },
  },
  {
    name: 'the booking, filled',
    reach: async (page) => {
      await open(page, '/pickup-requests/new');
      await fillBooking(page);
    },
  },
  {
    name: 'the booking with its errors',
    reach: async (page) => {
      await open(page, '/pickup-requests/new');
      await page.getByRole('radio', { name: 'A collection for a vendor' }).check();
      await page.getByRole('button', { name: 'Book the pickup' }).click();
      await expect(page.getByText('Choose the vendor.')).toBeVisible();
    },
  },
  {
    name: 'one request',
    reach: async (page) => {
      await open(page, LATE);
      await expect(page.getByRole('heading', { level: 1, name: 'ACC-PR-9WXH4T' })).toBeVisible();
    },
  },
  {
    name: 'one request with the cancellation open',
    reach: async (page) => {
      await open(page, DETAIL, {
        cancellationReasons: [{ code: 'DEMO_A', label: 'Demo reason A', attribution: 'CUSTOMER' }],
      });
      await chooseAct(page, 'Cancel the request');
      await expect(
        page.getByRole('alertdialog').getByRole('combobox', { name: /^Reason/ }),
      ).toBeVisible();
    },
  },
  {
    name: 'the approver’s queue',
    reach: async (page) => {
      await open(page, '/approvals', { requests: [waiting(IDS.colleague)] });
      await expect(
        page.getByRole('button', { name: 'Approve the exception of ACC-PR-7KQ2MZ' }),
      ).toBeVisible();
    },
  },
  {
    name: 'the approver’s queue with the approval open',
    reach: async (page) => {
      await open(page, '/approvals', { requests: [waiting(IDS.me)] });
      await page.getByRole('button', { name: 'Approve the exception of ACC-PR-7KQ2MZ' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
    },
  },
  {
    name: 'the exception',
    reach: async (page) => {
      await open(page, `/pickup-requests/${IDS.pending}/exception`, {
        requests: [pickup({ declared_package_count: 1 })],
      });
      await expect(page.getByRole('button', { name: 'Request the exception' })).toBeVisible();
    },
  },
];

test.describe('the approver’s queue', () => {
  // Break caught: an approval sent with a body, a version or a key the operation does not take (the server refuses it), a queue that keeps a
  // request after its exception is approved, or a result that is not told in words.
  test('approves with the request’s id alone, says it, and the request leaves the queue', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/approvals', { requests: [waiting(IDS.colleague)] });
    await page.getByRole('button', { name: 'Approve the exception of ACC-PR-7KQ2MZ' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('the single-package pickup fee');
    await dialog.getByRole('button', { name: 'Approve the exception' }).click();

    await expect(
      page.getByText('The one-package exception of ACC-PR-7KQ2MZ is approved by you.'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'No exceptions waiting for approval yet' }),
    ).toBeVisible();
    const [approval] = posts(api);
    expect(approval?.path).toBe(
      `/api/v1/pickup-requests/${IDS.pending}/one-package-exception/approve`,
    );
    expect([approval?.ifMatch, approval?.idempotencyKey, approval?.body]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: the maker-checker rule judged in the page (the request would never be sent) or its refusal told as a failure of the page: the
  // server decides, the page sends the approval and tells the refusal as the rule, naming the permission and no role.
  test('sends the approval of the person who asked, and tells the server’s refusal as the rule', async ({
    page,
  }) => {
    const { api } = await open(page, '/approvals', { requests: [waiting(IDS.me)] });
    await page.getByRole('button', { name: 'Approve the exception of ACC-PR-7KQ2MZ' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('You asked for this exception yourself');
    await dialog.getByRole('button', { name: 'Approve the exception' }).click();

    await expect(dialog).toContainText(
      'You requested this exception yourself, so a different approver has to decide it.',
    );
    expect(posts(api)).toHaveLength(1);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      page.getByRole('button', { name: 'Approve the exception of ACC-PR-7KQ2MZ' }),
    ).toBeVisible();
  });

  // Break caught: the queue or its entry offered to a session that may not decide, or a refusal that names the key instead of what the account cannot do.
  test('says what a session without the key cannot do, and offers it no entry', async ({
    page,
  }) => {
    await open(page, '/approvals', { permissions: ['pickup.read'] });

    await expect(
      page.getByText(
        'Your account can’t decide a one-package exception. Ask an administrator for access.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('pickup.exception.approve');
    await expect(menuEntry(page, 'Decisions')).toHaveCount(0);
  });

  test('says when no exception waits', async ({ page }) => {
    await open(page, '/approvals', { requests: [] });

    await expect(
      page.getByRole('heading', { name: 'No exceptions waiting for approval yet' }),
    ).toBeVisible();
  });

  // Break caught (the review of 499399c): the approver's queue drawn as cards at 1280 px with the menu open, though its table has room for every column.
  test('keeps the table, with every column, at 1280 px with the menu open, and no cards', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '/approvals', { requests: [waiting(IDS.colleague)] });

    const table = page.getByRole('table', { name: 'One-package exceptions waiting for approval' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader')).toHaveText([
      'Request / sender',
      'Packages',
      'Recipient',
      'Why',
      'Asked',
      'Hub',
      'Request state',
      'Actions',
    ]);
    await expect(
      page.getByRole('list', { name: 'One-package exceptions waiting for approval' }),
    ).toHaveCount(0);
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
  });

  // Break caught (the Product Owner's review of 499399c, Stage 3 item 7, found again in the pictures of run 5): an empty band above the table of a queue that has no views, no filters and no
  // notice. The page card has no header, so it took 24px of its own above its content, and the body 16px more, above a header row that has nothing above it.
  test('starts its table at the top of the page card, with no empty band above it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, '/approvals', { requests: [waiting(IDS.colleague)] });

    const table = page.getByRole('table', { name: 'One-package exceptions waiting for approval' });
    await expect(table).toBeVisible();
    const head = await table.getByRole('row').first().boundingBox();
    const card = await table
      .locator(
        'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ui-panel ")][1]',
      )
      .boundingBox();
    expect(head).not.toBeNull();
    expect(card).not.toBeNull();
    // The card's own border is 1px, and nothing else is above the header row.
    expect((head?.y ?? 0) - (card?.y ?? 0)).toBeLessThanOrEqual(2);
  });
});

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
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      });
    }
  }
});

test.describe('enlarged text, forced colours and reduced motion', () => {
  // Break caught (WCAG 1.4.4): sizes in pixels, so enlarged text does not grow the form, or breaks it.
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 640, height: 800 },
  ]) {
    test(`the booking at 200% text keeps its layout at ${String(width)} px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await open(page, '/pickup-requests/new');
      await fillBooking(page);
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });

      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await clippedControls(page)).toEqual([]);
    });
  }

  // Break caught: an error told by a coloured rule that forced colours paints away, or a focus ring that disappears with them.
  test('under forced colours a radio keeps its focus ring and an invalid group its rule', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, '/pickup-requests/new');
    // By keyboard, so that the focus the form moves to the first invalid field is a keyboard user's focus, which shows its ring.
    await page.getByRole('button', { name: 'Book the pickup' }).focus();
    await page.keyboard.press('Enter');
    const radio = page.getByRole('radio', { name: 'A vendor’s own packages' });
    await expect(radio).toBeFocused();

    const ring = await radio.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(ring).toBe('solid');
    const rule = await page
      .locator('.ui-radio-group--invalid')
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          style: style.borderInlineStartStyle,
          width: parseFloat(style.borderInlineStartWidth),
        };
      });
    expect(rule.style).toBe('solid');
    expect(rule.width).toBeGreaterThanOrEqual(2);
  });

  test('with reduced motion nothing moves when a dialog of an act opens', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, DETAIL);
    await page.getByRole('button', { name: 'Confirm the pickup' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.playState === 'running').length,
    );
    expect(running).toBe(0);
  });
});
