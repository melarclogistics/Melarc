import { expect, test, type Page, type Route } from '@playwright/test';

import { tabReachesLinks, watchPage, wcagViolations } from './support/page';
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

    await page.getByRole('link', { name: 'ACC-PR-7KQ2MZ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeFocused();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a session without the key sees no entry, and the page names the key', async ({ page }) => {
    await open(page, '/pickup-requests', { permissions: ['staff.read'] });

    await expect(page.getByText('pickup.read')).toBeVisible();
    await expect(menuEntry(page, 'Requests')).toHaveCount(0);
  });
});

test.describe('the queue', () => {
  test('filters by state in the address, and tells a filter that hides everything from an empty queue', async ({
    page,
  }) => {
    const { api } = await open(page, '/pickup-requests');
    await page.getByRole('combobox', { name: 'State' }).selectOption('DECLINED');

    await expect(page).toHaveURL('/pickup-requests?state=DECLINED');
    await expect(page.getByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    expect(api.calls.some((call) => call.search === '?state=DECLINED')).toBe(true);

    await page.getByRole('button', { name: 'Show every request' }).click();
    await expect(page.getByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
  });

  test('says when there are no requests at all', async ({ page }) => {
    await open(page, '/pickup-requests', { requests: [] });

    await expect(page.getByRole('heading', { name: 'No pickup requests yet' })).toBeVisible();
  });
});

/**
 * The queue draws every request twice, as a row of a table and as a card, and the stylesheet shows the one that fits the room the results have
 * (queue-table.css): a table from 64rem, cards below. What is not shown is `display: none`, so a role query finds one drawing and never both.
 * The room is the results region and not the screen: at 1280 px the docked menu leaves 976 px, which is cards, and a collapsed menu leaves enough
 * for the table.
 */
const WIDE = { width: 1440, height: 900 } as const; // 1136 px of room beside the menu: a table
const NARROW = { width: 390, height: 844 } as const;
const PHONE = { width: 320, height: 640 } as const;
const CODE = 'ACC-PR-7KQ2MZ';

const queueTable = (page: Page) => page.getByRole('table', { name: 'Pickup requests' });
const queueCards = (page: Page) => page.getByRole('list', { name: 'Pickup requests' });

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

/** What is wider than its own box among what the queue shows: a word cut off, or a region that scrolls where its text should wrap. */
function overflowingInQueue(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '.ui-queue-table__results th, .ui-queue-table__results td, .ui-queue-table__card, .ui-table__scroller',
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

/** The terms of the cards that run onto a second line: "Packages / booking type" breaking where it has a whole line to itself. */
function wrappedTerms(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.ui-queue-table__card dt')]
      .filter((term) => term.getClientRects().length > 0)
      .filter((term) => {
        const range = document.createRange();
        range.selectNodeContents(term);
        return range.getClientRects().length > 1;
      })
      .map((term) => term.textContent),
  );
}

test.describe('the queue, drawn for the room it has', () => {
  // Break caught: a table squeezed into a room it cannot be read in, or both drawings exposed at once, which reads every request twice.
  test('draws a table of six columns where there is room, and keeps the cards out of the accessibility tree', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(page, '/pickup-requests');

    await expect(queueTable(page)).toBeVisible();
    await expect(queueTable(page).getByRole('columnheader')).toHaveText([
      'Request / sender',
      'State',
      'Service date',
      'Pickup address / hub',
      'Packages / booking type',
      'Needs',
    ]);
    await expect(queueCards(page)).toHaveCount(0);
    // Drawn and hidden, not left out: without this, a test that found no cards would prove nothing.
    await expect(
      page.getByRole('list', { name: 'Pickup requests', includeHidden: true }),
    ).toHaveCount(1);
    await expect(page.getByRole('link', { name: CODE })).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('link', { name: 'Book a pickup' })).toBeVisible();
    // The queue is asked for as it always was: no filter, no token, whatever the drawing.
    const asked = api.calls.filter((call) => call.path === '/api/v1/pickup-requests');
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked.map((call) => call.search))).toEqual(new Set(['']));
    expect(watch.problems).toEqual([]);
  });

  test('draws a list of cards where there is not, and keeps the table out of the accessibility tree', async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    const { watch } = await open(page, '/pickup-requests');

    const cards = queueCards(page);
    await expect(cards).toBeVisible();
    await expect(cards.getByRole('listitem')).toHaveCount(2);
    await expect(queueTable(page)).toHaveCount(0);
    await expect(
      page.getByRole('table', { name: 'Pickup requests', includeHidden: true }),
    ).toHaveCount(1);
    await expect(page.getByRole('link', { name: CODE })).toHaveCount(1);
    await expect(page.getByRole('main').getByRole('link', { name: 'Book a pickup' })).toBeVisible();
    const first = cards.getByRole('listitem').first();
    await expect(first.getByRole('heading', { level: 2 })).toHaveText(CODE);
    for (const fact of [
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
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a drawing hidden in a way that leaves it in the Tab order and the accessibility tree (`opacity: 0`, no height, off the
  // screen), so that a keyboard walks through every request twice, the second time unseen. A `display: none` element cannot take focus at all.
  for (const [shown, size, hidden] of [
    ['a table', WIDE, '.ui-queue-table__cards'],
    ['cards', NARROW, '.ui-queue-table__table'],
  ] as const) {
    test(`takes no focus in the drawing that is not shown, beside ${shown}`, async ({ page }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests');
      const link = page.getByRole('link', { name: CODE });
      await link.focus();
      await expect(link).toBeFocused();

      const out = page.locator(hidden);
      await expect(out).toBeHidden();
      const took = await out.locator('a, [tabindex="0"]').evaluateAll((elements) =>
        elements.map((element) => {
          (element as HTMLElement).focus();
          return document.activeElement === element;
        }),
      );
      expect(took.length).toBeGreaterThan(0);
      expect(took.filter(Boolean)).toEqual([]);
    });
  }

  for (const [shown, size] of [
    ['a table', WIDE],
    ['cards', NARROW],
  ] as const) {
    test(`reaches the code of each request by Tab, and opens it with Enter, beside ${shown}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests');
      // The page is ready before the engine is asked: a Tab pressed before the application has drawn reaches no link in any engine, and the
      // test would be skipped for a reason that is not the engine's.
      await expect(page.getByRole('link', { name: CODE })).toBeVisible();
      const reaches = await tabReachesLinks(page);
      test.skip(!reaches, 'This engine does not move focus to a link with Tab (support/page.ts).');
      const link = page.getByRole('link', { name: CODE });
      await expect(link).toBeVisible();

      await page.getByRole('combobox', { name: 'State' }).focus();
      for (let step = 0; step < 20; step += 1) {
        if (await link.evaluate((element) => element === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await expect(link).toBeFocused();
      // The next stop is the next request's code, and nothing of the other drawing comes between.
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'ACC-PR-9WXH4T' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Enter');

      await expect(page).toHaveURL(DETAIL);
      await expect(page.getByRole('heading', { level: 1, name: CODE })).toBeFocused();
    });

    // Break caught: a request opened by a script on the row (no new tab, no copy of the address), instead of by a link.
    test(`opens a request in a new tab with a modifier-click, and in place with a plain click, beside ${shown}`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize(size);
      // The stand-in answers for the whole context, so that the new tab has an API as well and stays on the request it was opened for: a tab
      // with none would be sent to sign in, in some engines before a test could look at it.
      await stubPickupApi(context, world());
      await page.goto('/pickup-requests');
      const link = page.getByRole('link', { name: CODE });
      await expect(link).toHaveAttribute('href', DETAIL);

      const [tab] = await Promise.all([
        context.waitForEvent('page'),
        link.click({ modifiers: ['ControlOrMeta'] }),
      ]);
      await expect(tab.getByRole('heading', { level: 1, name: CODE })).toBeVisible();
      await expect(tab).toHaveURL(DETAIL);
      await tab.close();
      await expect(page).toHaveURL('/pickup-requests');

      await link.click();
      await expect(page).toHaveURL(DETAIL);
    });
  }

  // Break caught: a query on the width of the screen, which would show the same drawing at 1280 px whether the menu was open or shut, and
  // squeeze the table into the room the menu leaves.
  test('follows the room the queue has, so that shutting the menu changes the drawing', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 }); // 976 px beside the open menu, 1104 px beside the rail
    await open(page, '/pickup-requests');

    await expect(queueCards(page)).toBeVisible();
    await expect(queueTable(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await expect(queueTable(page)).toBeVisible();
    await expect(queueCards(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Expand menu' }).click();
    await expect(queueCards(page)).toBeVisible();
    await expect(queueTable(page)).toHaveCount(0);
  });

  // Break caught: a long address or note cut off, hidden behind a tooltip, or pushed past the edge of the screen (the page scrolling sideways).
  for (const size of [WIDE, { width: 1280, height: 800 }, NARROW, PHONE]) {
    test(`keeps a long address, sender and note whole, wrapped, with no sideways scrolling at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests', longWorld());

      const address = page.getByText(LONG_ADDRESS).locator('visible=true');
      await expect(address).toHaveCount(2);
      await expect(page.getByText(LONG_SENDER).locator('visible=true')).toHaveCount(2);
      await expect(page.getByText('Late booking to decide').locator('visible=true')).toHaveCount(1);
      await expect(
        page.getByText('One-package exception waiting for approval').locator('visible=true'),
      ).toHaveCount(1);
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await overflowingInQueue(page)).toEqual([]);
      expect(await wrappedTerms(page)).toEqual([]);
      const box = await address.first().boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
      // Wrapped, not truncated: the text is on more than one line, and no element clips it.
      expect(box?.height ?? 0).toBeGreaterThan(30);
      expect(
        await address.first().evaluate((element) => getComputedStyle(element).textOverflow),
      ).toBe('clip');
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
      expect(await overflowingInQueue(page)).toEqual([]);
      expect(await wrappedTerms(page)).toEqual([]);
    });
  }

  // Break caught: a queue with a violation that only shows in one of its drawings, or in one state's colours (the four badges are four tones).
  test('has no WCAG 2.2 A or AA violation as a table, or as cards, with every state in it', async ({
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

    for (const size of [{ width: 1280, height: 800 }, { width: 768, height: 1024 }, PHONE]) {
      await page.setViewportSize(size);
      await expect(queueCards(page)).toBeVisible();
      expect(await wcagViolations(page), `${String(size.width)} px`).toEqual([]);
    }
  });

  // Break caught: a border that forced colours paints away, so that the cards run into one another, or a link whose focus ring disappears.
  test('under forced colours the cards keep their panel’s border and their dividers, and a code its focus ring', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize(NARROW);
    await open(page, '/pickup-requests');

    // The list draws no border of its own inside the panel (the panel's is drawn, and held beside the table by the panel's own test).
    const look = await queueCards(page).evaluate((list) => {
      const panel = list.closest('.ui-queue-panel');
      const card = list.querySelector('.ui-queue-table__card');
      return {
        panel: panel === null ? null : getComputedStyle(panel).borderTopStyle,
        divider: card === null ? null : getComputedStyle(card).borderBottomStyle,
      };
    });
    expect(look).toEqual({ panel: 'solid', divider: 'solid' });

    // By keyboard, so that the focus is a keyboard user's, which shows its ring.
    const link = page.getByRole('link', { name: CODE });
    await link.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    expect(await link.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  });

  test('with reduced motion nothing in the queue moves, in either drawing', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const size of [WIDE, NARROW]) {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests');
      await expect(page.getByRole('link', { name: CODE })).toBeVisible();

      const running = await page.evaluate(
        () =>
          document.getAnimations().filter((animation) => animation.playState === 'running').length,
      );
      expect(running).toBe(0);
    }
  });

  // Break caught: a pager whose button is gone while the next page loads and drops focus on the document, or a results region that no longer
  // takes focus now that it holds two drawings.
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
      await expect(page.getByRole('link', { name: CODE })).toBeVisible();

      await page.getByRole('button', { name: 'Next page' }).click();

      await expect(page.getByText('Showing 1 request on page 2.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'ACC-PR-9WXH4T' })).toBeVisible();
      await expect(page.getByRole('link', { name: CODE })).toHaveCount(0);
      await expect(page.locator('.ui-queue-table__results')).toBeFocused();
      expect(api.calls.some((call) => call.search === '?page_token=1')).toBe(true);

      await page.getByRole('button', { name: 'Previous page' }).click();
      await expect(page.getByRole('link', { name: CODE })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Previous page' })).toHaveCount(0);
    });
  }
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
 * The filters, the count, the rows and the pager of the queue are one white panel with hairlines between them (the reference of 1 November
 * 2026; COMPONENT_PATTERNS section 22f), and whatever stands in the place of the rows (loading, nothing, a failure, a refusal) stands inside it
 * and inset from its edges. The State and Service date controls share a line, with the date's help beneath its control.
 */
test.describe('the queue, set in one panel', () => {
  const stateSelect = (page: Page) => page.getByRole('combobox', { name: 'State' });
  const dateControl = (page: Page) => page.getByRole('group', { name: 'Service date' });

  // Break caught: the select aligned to the bottom of the date's help text, so that it hangs a line below the date control.
  for (const size of [WIDE, { width: 768, height: 1024 }]) {
    test(`puts the State and Service date controls on one line, with the date's help beneath its control, at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests');
      const help = page.getByText('Day, month and year.');
      await expect(help).toBeVisible();

      const [select, date, note] = await Promise.all([
        stateSelect(page).boundingBox(),
        dateControl(page).boundingBox(),
        help.boundingBox(),
      ]);

      expect(select).not.toBeNull();
      expect(date).not.toBeNull();
      expect(Math.abs((select?.y ?? 0) - (date?.y ?? 1000))).toBeLessThanOrEqual(1);
      expect(Math.abs((select?.height ?? 0) - (date?.height ?? 1000))).toBeLessThanOrEqual(1);
      expect(note?.y ?? 0).toBeGreaterThanOrEqual((date?.y ?? 1000) + (date?.height ?? 1000));
    });
  }

  // Break caught: the button aligned to the bottom of the help text, as the select was, instead of to the control it clears.
  test('puts the button that clears the date on the line of the date control', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests?date=2026-11-03');
    const clear = page.getByRole('button', { name: 'Every service date' });
    await expect(clear).toBeVisible();

    const [button, date] = await Promise.all([
      clear.boundingBox(),
      dateControl(page).boundingBox(),
    ]);

    expect(Math.abs((button?.y ?? 0) - (date?.y ?? 1000))).toBeLessThanOrEqual(1);
    expect(Math.abs((button?.height ?? 0) - (date?.height ?? 1000))).toBeLessThanOrEqual(1);
  });

  for (const [shown, size] of [
    ['a table', WIDE],
    ['cards', NARROW],
  ] as const) {
    // Break caught: the filters, the count and the rows on three surfaces of their own, or a border inside the panel drawn twice.
    test(`draws the filters, the count and the results in one white panel with hairlines between them, beside ${shown}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests');
      const panel = page.locator('.ui-queue-panel');

      await expect(panel).toHaveCount(1);
      await expect(panel.getByRole('group', { name: 'Filter the pickup requests' })).toBeVisible();
      await expect(panel.getByText(/^Showing 2 requests/)).toHaveText('Showing 2 requests.');
      await expect(panel.getByRole('link', { name: CODE })).toBeVisible();

      const look = await panel.evaluate((element) => {
        const style = getComputedStyle(element);
        const hairline = (selector: string) => {
          const part = element.querySelector(selector);
          return part === null ? null : getComputedStyle(part).borderBottomWidth;
        };
        const nested = [...element.querySelectorAll('.ui-table__scroller, .ui-queue-table__cards')]
          .filter((part) => part.getClientRects().length > 0)
          .map((part) => getComputedStyle(part).borderTopWidth);
        return {
          background: style.backgroundColor,
          border: `${style.borderTopStyle} ${style.borderTopWidth}`,
          radius: style.borderTopLeftRadius,
          // The band of the filters and of the refresh beside them carries the hairline, not the group of filters inside it.
          filtersHairline: hairline('.ui-queue-bar'),
          countHairline: hairline('.ui-queue-table__count'),
          nested,
        };
      });
      expect(look).toEqual({
        background: 'rgb(255, 255, 255)',
        border: 'solid 1px',
        // A panel: `radius.lg`, 12px since redesign step R2 (DESIGN_SYSTEM section 7), 8px before it.
        radius: '12px',
        filtersHairline: '1px',
        countHairline: '1px',
        nested: ['0px'],
      });
    });
  }

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
      shows: 'Loading the pickup requests…',
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
      name: 'a refusal that names the permission',
      reach: (page) => openAnswering(page, failing(403, 'PERMISSION_DENIED')),
      shows: /pickup\.read/,
    },
  ];

  for (const state of STATES) {
    // Break caught: a state drawn against the panel's edge, or outside the panel on the page behind it, so that the states of one screen
    // do not look like one another.
    test(`keeps the filters and ${state.name} in the one panel, inset from its edges`, async ({
      page,
    }) => {
      await page.setViewportSize(WIDE);
      await state.reach(page);
      const panel = page.locator('.ui-queue-panel');

      await expect(panel).toHaveCount(1);
      await expect(panel.getByRole('group', { name: 'Filter the pickup requests' })).toBeVisible();
      await expect(panel.getByText(state.shows).first()).toBeVisible();

      const insets = await panel.evaluate((element) => {
        const edge = element.getBoundingClientRect();
        return [...element.querySelectorAll('.ui-read-state > *')].map((child) => {
          const box = child.getBoundingClientRect();
          return { left: box.left - edge.left, right: edge.right - box.right };
        });
      });
      expect(insets.length).toBeGreaterThan(0);
      for (const inset of insets) {
        expect(inset.left).toBeGreaterThanOrEqual(16);
        expect(inset.right).toBeGreaterThanOrEqual(16);
      }
    });
  }

  test('sets the pager in the panel, under a hairline', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests', { pageSize: 1 });
    const pager = page.locator('.ui-queue-panel .ui-queue-table__pager');

    await expect(pager.getByRole('button', { name: 'Next page' })).toBeVisible();
    expect(await pager.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('1px');
  });

  // Break caught: a border that forced colours paints away, so that the panel and its parts run into the page.
  test('under forced colours the panel keeps its border and its hairlines', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests');
    const panel = page.locator('.ui-queue-panel');

    const look = await panel.evaluate((element) => {
      const style = getComputedStyle(element);
      const filters = element.querySelector('.ui-queue-bar');
      const count = element.querySelector('.ui-queue-table__count');
      return {
        border: `${style.borderTopStyle} ${style.borderTopWidth}`,
        filters: filters === null ? null : getComputedStyle(filters).borderBottomStyle,
        count: count === null ? null : getComputedStyle(count).borderBottomStyle,
      };
    });
    expect(look).toEqual({ border: 'solid 1px', filters: 'solid', count: 'solid' });
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

test.describe('the queue: Refresh page', () => {
  const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh page' });
  const checked = (page: Page) => page.getByText(/^Last checked /);

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
    await expect(page.getByText('Loading the pickup requests…')).toBeVisible();
    await expect(page.getByText('Checking this page…')).toBeVisible();
    await expect(page.getByRole('link', { name: codeOf(0) })).toHaveCount(0);
    await expect(queueTable(page).or(queueCards(page))).toHaveCount(0);
    release();

    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
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
    const time = ((await checked(page).textContent()) ?? '').replace('Last checked ', '');
    expect(time).toMatch(/^\d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2}$/);
    await page.route(LIST, failing(500, 'INTERNAL_ERROR'), { times: 1 });

    await refresh(page).click();

    await expect(page.getByText('The pickup requests could not be loaded.')).toBeVisible();
    await expect(page.getByRole('link', { name: codeOf(0) })).toHaveCount(0);
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

    await page.getByRole('combobox', { name: 'State' }).selectOption('CONFIRMED');
    await expect(page.getByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    const release = await holdReads(page);
    await page.getByRole('combobox', { name: 'State' }).selectOption('');
    await expect(page.getByText('Loading the pickup requests…')).toBeVisible();

    // While the newer read of the first filter is under way, and after it: nobody asked for it as a refresh.
    await expect(page.getByText('Page refreshed.')).toHaveCount(0);
    release();
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
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

  for (const [where, size] of [
    ['a wide room', WIDE],
    ['a narrow one', NARROW],
    ['a phone', PHONE],
  ] as const) {
    // Break caught: a control pushed past the edge of the panel or the screen, or set on a line of its own where there is room for it beside the filters.
    test(`sets the button inside the panel, with no sideways scrolling, in ${where}`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await open(page, '/pickup-requests?date=2026-11-03', FIVE_AT_A_TIME);
      await expect(checked(page)).toBeVisible();

      const panel = await page.locator('.ui-queue-panel').boundingBox();
      const button = await refresh(page).boundingBox();
      const select = await page.getByRole('combobox', { name: 'State' }).boundingBox();

      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(button).not.toBeNull();
      expect(button?.x ?? -1).toBeGreaterThanOrEqual(panel?.x ?? 0);
      expect((button?.x ?? 0) + (button?.width ?? 0)).toBeLessThanOrEqual(
        (panel?.x ?? 0) + (panel?.width ?? 0),
      );
      if (size === WIDE) {
        // Beside the filters: on the line of the controls, which is the line of the select, and at the end of the row, where the line of text
        // over the button ends at the panel's padding.
        expect(Math.abs((button?.y ?? 1000) - (select?.y ?? 0))).toBeLessThanOrEqual(1);
        const text = await page.locator('.pickup-freshness__text').boundingBox();
        expect(
          (panel?.x ?? 0) + (panel?.width ?? 0) - ((text?.x ?? 0) + (text?.width ?? 0)),
        ).toBeLessThanOrEqual(24);
      } else {
        // Under them, as nothing of the filters is wider than the room.
        expect(button?.y ?? 0).toBeGreaterThan((select?.y ?? 1000) + 20);
      }
    });
  }
});

test.describe('the queue: Refresh page, when nothing has been read', () => {
  // Break caught: a button that moves up when the line over it has nothing to say, so that it no longer sits on the line of the controls.
  test('keeps the button on the line of the controls when the line over it has nothing to say', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await openAnswering(page, failing(500, 'INTERNAL_ERROR'));
    await expect(page.getByText('The pickup requests could not be loaded.')).toBeVisible();
    await expect(page.locator('.pickup-freshness__text')).toHaveText('');

    const button = await page.getByRole('button', { name: 'Refresh page' }).boundingBox();
    const select = await page.getByRole('combobox', { name: 'State' }).boundingBox();

    expect(Math.abs((button?.y ?? 1000) - (select?.y ?? 0))).toBeLessThanOrEqual(1);
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
    await page.getByRole('link', { name: opened }).click();
    await expect(page.getByRole('heading', { level: 1, name: opened })).toBeVisible();
    return view;
  }

  const backLink = (page: Page) => page.getByRole('link', { name: 'Back to pickup requests' });

  /** Where the officer should be: the page they left, read again, with focus on the request they opened. */
  async function expectTheOfficerBack(page: Page, api: PickupApi) {
    await expect(page).toHaveURL('/pickup-requests?state=PENDING');
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await expect(page.getByRole('link', { name: opened })).toBeFocused();
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

  // Break caught: a place that outlives the page, or one kept where a reload, the menu or an address could find it.
  test('starts at the first page after a reload, from the menu and from a typed address', async ({
    page,
  }) => {
    await toTheRequest(page);
    await backLink(page).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByRole('link', { name: opened }).click();
    await expect(page.getByRole('heading', { level: 1, name: opened })).toBeVisible();
    await menuEntry(page, 'Requests').click();
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByRole('link', { name: opened }).click();
    await expect(page.getByRole('heading', { level: 1, name: opened })).toBeVisible();
    await page.goto('/pickup-requests?state=PENDING');
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
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
      const far = page.getByRole('link', { name: codeOf(10) });
      await far.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      expect(before).toBeGreaterThan(200);
      await far.click();
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

    await page.getByRole('link', { name: opened }).click();
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

      await page.getByRole('link', { name: opened }).click();
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

    await expect(page.locator('.ui-queue-table__results')).toBeFocused();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await expect(page.getByRole('link', { name: opened })).toHaveCount(0);
  });

  // Break caught: focus pulled back to the request from the control the officer had already moved to while the page was being read.
  test('leaves focus where the officer put it while the page was being read', async ({ page }) => {
    await toTheRequest(page);
    const release = await holdReads(page);

    await backLink(page).click();
    await expect(page.getByText('Loading the pickup requests…')).toBeVisible();
    await page.getByRole('combobox', { name: 'State' }).focus();
    release();

    await expect(page.getByRole('link', { name: opened })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'State' })).toBeFocused();
  });

  test('shows the focus ring on the request when the officer came and went by keyboard', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/pickup-requests', FIVE_AT_A_TIME);
    const link = page.getByRole('link', { name: codeOf(2) });
    await link.focus();
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

    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
    await expect(page.locator('.ui-queue-table__results')).toBeFocused();
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

    await expect(page.getByText(/That page of the queue could not be opened/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page).toHaveURL('/pickup-requests?state=PENDING');
    await expect(page.getByRole('combobox', { name: 'State' })).toHaveValue('PENDING');
    await expect(page.locator('body')).not.toContainText('Diagnostic text');

    await page.getByRole('button', { name: 'Back to first page' }).click();
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
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
    await page.getByRole('button', { name: 'Cancel the request' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Cancel this pickup request?' });

    await expect(dialog).toContainText('No cancellation reason is configured yet');
    await expect(dialog).toContainText('settings.reason.manage');
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
    await page.getByRole('button', { name: 'Cancel the request' }).click();
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
      await expect(page.getByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
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
      await expect(page.getByText('The pickup requests could not be loaded.')).toBeVisible();
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
      await expect(page.getByRole('heading', { name: 'What you can do' })).toBeVisible();
    },
  },
  {
    name: 'one request with the cancellation open',
    reach: async (page) => {
      await open(page, DETAIL, {
        cancellationReasons: [{ code: 'DEMO_A', label: 'Demo reason A', attribution: 'CUSTOMER' }],
      });
      await page.getByRole('button', { name: 'Cancel the request' }).click();
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
    await expect(page.getByRole('heading', { name: 'No exceptions waiting' })).toBeVisible();
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
      'You requested this exception yourself, so another holder of pickup.exception.approve has to approve it.',
    );
    expect(posts(api)).toHaveLength(1);
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      page.getByRole('button', { name: 'Approve the exception of ACC-PR-7KQ2MZ' }),
    ).toBeVisible();
  });

  // Break caught: the queue or its entry offered to a session that may not decide, or a refusal that does not name the key.
  test('names the key to a session without it, and offers it no entry', async ({ page }) => {
    await open(page, '/approvals', { permissions: ['pickup.read'] });

    await expect(page.getByText('pickup.exception.approve')).toBeVisible();
    await expect(menuEntry(page, 'Decisions')).toHaveCount(0);
  });

  test('says when no exception waits', async ({ page }) => {
    await open(page, '/approvals', { requests: [] });

    await expect(page.getByRole('heading', { name: 'No exceptions waiting' })).toBeVisible();
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
