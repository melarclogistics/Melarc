import { expect, test, type Page } from '@playwright/test';

import {
  hold,
  IDS,
  PLANTED,
  stubMessagesApi,
  world,
  type Hold,
  type MessagesApi,
  type World,
} from './support/messages-api';
import { watchPage, wcagViolations } from './support/page';
import { menuEntry } from './support/shell';

/**
 * The message log (S1.12e) in a real browser: the list with its filters, the Ops feed, the narrowing to one request and the link to it from
 * that request's page. What jsdom cannot show is here: the layout at the verified widths with axe (WCAG 2.2 A and AA), no sideways scrolling at
 * 320 px, text enlarged to 200%, forced colours, reduced motion, and the filters by keyboard alone.
 *
 * **No number in clear, no message text and no code is ever drawn or sent.** The API is a small stand-in with all three planted in every entry
 * it answers, in fields the contract does not name, so that a screen which could draw one would, and a test looks for them in what was drawn
 * and in every request that was made.
 *
 * The same file runs against the production build and against the development server (strict mode runs every effect twice).
 */
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

const LOG = '/messages';
const ABOUT = `/messages?subject=${IDS.request}`;
/**
 * The address a request's page links to (`subjectLogPath`): the record and its kind, the kind being what the log words itself by and read from
 * the address alone. The log is asked of the server by the identifier only (`subject_id`: the contract has no kind parameter). A typed address
 * with no kind (`ABOUT`) is read as a pickup request, the one kind the log has.
 */
const ABOUT_FROM_REQUEST = `${ABOUT}&subject_type=PICKUP_REQUEST`;
const DIAGNOSTIC = 'Diagnostic text that must never reach a screen.';

async function open(
  page: Page,
  path: string,
  setup: Partial<World> = {},
): Promise<{ api: MessagesApi; watch: ReturnType<typeof watchPage> }> {
  const watch = watchPage(page);
  const api = await stubMessagesApi(page, world(setup));
  await page.goto(path);
  return { api, watch };
}

/** The row of the message raised at this time (its row header). */
const rowAt = (page: Page, time: string) =>
  page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: time }) });

const table = (page: Page) => page.getByRole('table', { name: 'Messages' });

/** The status, the audience and the channel are chosen in the popover of the filter row, which opens with the Filter button. */
const openFilters = (page: Page) =>
  page.getByRole('button', { name: 'Filter', exact: true }).click();

/** The requests the page made for the list. */
const lists = (api: MessagesApi) =>
  api.calls.filter((call) => call.path === '/api/v1/notifications');

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

test.describe('moving through the screens', () => {
  // Break caught: a menu entry that goes nowhere, or a new page whose heading a screen reader never hears.
  test('the menu leads to the log, which lands on its heading', async ({ page }) => {
    const { api, watch } = await open(page, '/');
    await menuEntry(page, 'Message log').click();

    await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeFocused();
    await expect(table(page)).toBeVisible();
    await expect(page).toHaveURL(LOG);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a session without the key sees no entry, and the page says what it cannot do', async ({
    page,
  }) => {
    const { api } = await open(page, LOG, { permissions: ['pickup.read'] });

    await expect(
      page.getByText('Your account can’t see the message log. Ask an administrator for access.'),
    ).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('notification.read');
    await expect(menuEntry(page, 'Message log')).toHaveCount(0);
    expect(lists(api)).toEqual([]);
  });

  // Break caught: a link on the request's page that goes to the whole log, or no way back from the narrowed one.
  test('a request’s page links to its messages, and the log is narrowed to that request', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/pickup-requests/${IDS.request}`);
    await page.getByRole('link', { name: 'Messages about this request' }).click();

    await expect(page).toHaveURL(ABOUT_FROM_REQUEST);
    await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeFocused();
    await expect(page.getByText('Messages about one request')).toBeVisible();
    // Four of the eleven messages are about this request.
    await expect(page.getByRole('rowheader')).toHaveCount(4);
    expect(lists(api).some((call) => call.search === `?subject_id=${IDS.request}`)).toBe(true);

    await page.getByRole('button', { name: 'Show every message' }).click();
    await expect(page).toHaveURL(LOG);
    await expect(page.getByRole('rowheader')).toHaveCount(11);
    await expect(page.getByText('Messages about one request')).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a request’s page offers no link to the messages to a session without the key', async ({
    page,
  }) => {
    await open(page, `/pickup-requests/${IDS.request}`, { permissions: ['pickup.read'] });

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Messages about this request' })).toHaveCount(0);
  });
});

test.describe('the log', () => {
  test('tells each message in words: what it is, for whom, how it stands and what became of it', async ({
    page,
  }) => {
    const { api, watch } = await open(page, LOG);
    await expect(table(page)).toBeVisible();

    const delivered = rowAt(page, '29 Oct, 09:30');
    for (const words of [
      'Pickup request confirmed',
      'Wording version 1',
      'Ad-hoc sender',
      'Text message',
      'Delivered',
      'The provider accepted it',
      '+233******567',
    ]) {
      await expect(delivered).toContainText(words);
    }
    await expect(delivered.getByRole('link', { name: 'Pickup request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${IDS.request}`,
    );

    // A feed entry is written and not sent: in the feed, with no number.
    const feed = rowAt(page, '29 Oct, 09:20');
    for (const words of ['Vendor’s feed', 'In-app feed', 'In the feed', 'No number']) {
      await expect(feed).toContainText(words);
    }
    await expect(feed).not.toContainText('Delivered');

    await expect(rowAt(page, '29 Oct, 09:10')).toContainText('Sent, waiting for the network');
    await expect(rowAt(page, '29 Oct, 09:00')).toContainText('Will try again');
    await expect(rowAt(page, '29 Oct, 09:00')).toContainText('The provider gave no clear answer');
    await expect(rowAt(page, '29 Oct, 08:50')).toContainText('Failed');
    await expect(rowAt(page, '29 Oct, 08:50')).toContainText('The provider refused it');
    await expect(rowAt(page, '29 Oct, 08:50')).toContainText('Provider’s word: REQUEST_INVALID');
    await expect(rowAt(page, '29 Oct, 08:40')).toContainText('Held back');
    await expect(rowAt(page, '29 Oct, 08:40')).toContainText(
      'The daily limit for all messages was reached',
    );
    await expect(rowAt(page, '29 Oct, 08:30')).toContainText('Switched off');
    await expect(rowAt(page, '29 Oct, 08:20')).toContainText('Waiting to be sent');
    await expect(rowAt(page, '29 Oct, 08:10')).toContainText('Being sent');
    await expect(rowAt(page, '29 Oct, 08:00')).toContainText('Too late to send');
    // A kind the screen has no words for is shown in sentence case and never hidden.
    await expect(rowAt(page, '29 Oct, 07:50')).toContainText('Rider bonus paid');
    await expect(page.locator('body')).not.toContainText('RIDER_BONUS_PAID');
    // Not by colour alone: every status badge has words.
    const badges = await page.locator('.ui-status-badge').allTextContents();
    expect(badges).toHaveLength(11);
    expect(badges.every((text) => text.trim() !== '')).toBe(true);
    // The log is newest first, as the server sent it.
    const times = await page.getByRole('rowheader').allTextContents();
    expect(times).toEqual([...times].toSorted().toReversed());

    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught (AC: no number in clear and no code is ever shown or requested): a page that draws a field it should not have, or asks for one.
  test('never draws or sends a number in clear, a text or a code, whatever the answer carries', async ({
    page,
  }) => {
    const { api } = await open(page, LOG);
    await expect(table(page)).toBeVisible();

    // The stand-in really planted them, so that this test could fail.
    expect(api.planted).toBeGreaterThanOrEqual(11);
    const html = await page.content();
    const text = await page.locator('body').innerText();
    for (const planted of PLANTED) {
      expect(html, planted).not.toContain(planted);
      expect(text, planted).not.toContain(planted);
    }
    // The hint is the only number there is, and none is a whole number.
    expect(text).toContain('+233******567');
    expect(text).not.toMatch(/\d{7,}/);
    for (const call of api.calls) {
      for (const planted of PLANTED) {
        expect(decodeURIComponent(`${call.path}${call.search}`), planted).not.toContain(planted);
      }
    }
    // Nothing to copy, to dial or to send to, and no control that reveals a number.
    await expect(page.locator('a[href^="tel:"], a[href^="sms:"], a[href^="mailto:"]')).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('button', { name: /copy|reveal|show (the )?number|full number/i }),
    ).toHaveCount(0);
  });

  // Break caught: an identifier drawn where a person needs a name (a message, a request, a hub).
  test('names a message by what it is about, and never by an identifier', async ({ page }) => {
    await open(page, ABOUT);
    await expect(page.getByRole('rowheader')).toHaveCount(4);

    const text = await page.locator('body').innerText();
    for (const identifier of [IDS.request, IDS.otherRequest, IDS.hub, 'e0a8d4e2']) {
      expect(text, identifier).not.toContain(identifier);
    }
  });

  test('says when there are no messages at all', async ({ page }) => {
    await open(page, LOG, { entries: [] });

    await expect(page.getByRole('heading', { name: 'No messages yet' })).toBeVisible();
    await expect(
      page.getByText(
        'Messages appear here when the platform tells someone about an act, for example a confirmed pickup request.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('rowheader')).toHaveCount(0);
  });

  // Break caught: a made-up value in the address sent to the server as a made-up filter (the stand-in refuses it as the server does).
  test('takes a value in the address that is not a choice for no filter', async ({ page }) => {
    const { api } = await open(
      page,
      '/messages?state=everything&audience=ops&channel=email&subject=nonsense',
    );

    await expect(page.getByRole('rowheader')).toHaveCount(11);
    expect(lists(api).every((call) => call.search === '')).toBe(true);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe('the filters', () => {
  test('are reached in order by keyboard, chosen by typing, and put in the address', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'Safari’s engine opens a list on a key press instead of changing a closed select.',
    );
    const { api } = await open(page, LOG);
    await expect(table(page)).toBeVisible();

    // The three choices are in the popover of the filter row, and are reached in order.
    await openFilters(page);
    const status = page.getByRole('combobox', { name: 'Status' });
    const audience = page.getByRole('combobox', { name: 'For' });
    const channel = page.getByRole('combobox', { name: 'Channel' });

    await status.focus();
    await page.keyboard.type('Held');
    await expect(page).toHaveURL(/[?&]state=SUPPRESSED(&|$)/);
    // The choice is drawn (its chip) before the next is made: the address changes before the page is drawn again, and a choice made in that moment is made over the log as it was.
    await expect(
      page.getByRole('button', { name: 'Remove filter: Status: Held back' }),
    ).toBeVisible();
    // The two messages that were held back.
    await expect(page.getByRole('rowheader')).toHaveCount(2);
    await expect(status).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(audience).toBeFocused();
    await page.keyboard.type('Ad');
    await expect(page).toHaveURL(/audience=AD_HOC_SENDER/);
    await expect(
      page.getByRole('button', { name: 'Remove filter: For: Ad-hoc sender' }),
    ).toBeVisible();
    await expect(page.getByRole('rowheader')).toHaveCount(2);

    await page.keyboard.press('Tab');
    await expect(channel).toBeFocused();
    await page.keyboard.type('In');
    await expect(page).toHaveURL(/channel=FEED/);
    await expect(
      page.getByRole('button', { name: 'Remove filter: Channel: In-app feed' }),
    ).toBeVisible();
    // Nothing is held back in the feed: a filter that hides everything, and the way out of it is the empty state's action.
    await expect(page.getByRole('heading', { name: 'No messages match' })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show every message' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(LOG);
    await expect(page.getByRole('rowheader')).toHaveCount(11);

    const search = lists(api).map((call) => new URLSearchParams(call.search));
    expect(
      search.some(
        (each) =>
          each.get('state') === 'SUPPRESSED' &&
          each.get('audience') === 'AD_HOC_SENDER' &&
          each.get('channel') === 'FEED',
      ),
    ).toBe(true);
    expect(api.unexpected).toEqual([]);
  });

  test('narrow the log by status, audience and channel, and the address holds the view', async ({
    page,
  }) => {
    const { api } = await open(page, LOG);
    await expect(page.getByRole('rowheader')).toHaveCount(11);

    await openFilters(page);
    await page.getByRole('combobox', { name: 'Status' }).selectOption('FAILED');
    await expect(page).toHaveURL('/messages?state=FAILED');
    await expect(page.getByRole('rowheader')).toHaveCount(1);
    expect(lists(api).some((call) => call.search === '?state=FAILED')).toBe(true);

    // Linked, a view is the same view.
    await page.goto('/messages?state=SUPPRESSED&audience=AD_HOC_SENDER&channel=SMS');
    await expect(page.getByRole('rowheader')).toHaveCount(2);
    await openFilters(page);
    await expect(page.getByRole('combobox', { name: 'Status' })).toHaveValue('SUPPRESSED');
    await expect(page.getByRole('combobox', { name: 'For' })).toHaveValue('AD_HOC_SENDER');
    await expect(page.getByRole('combobox', { name: 'Channel' })).toHaveValue('SMS');
  });

  // Break caught (ops-portal.md section 7): "no messages" and "filtered to nothing" told as one, which sends Ops hunting for a bug.
  test('tell a filter that hides everything from an empty log, and one action takes every filter off', async ({
    page,
  }) => {
    await open(page, LOG);
    await expect(page.getByRole('rowheader')).toHaveCount(11);

    await openFilters(page);
    await page.getByRole('combobox', { name: 'Status' }).selectOption('FAILED');
    // The first filter is applied (it is in the address) before the second is chosen: two choices made before the page has taken the first are a race of the test's own, which
    // a loaded machine loses (the gate of 5 November 2026 lost it once, in one project of 1,058 tests, and it passed alone three times in three).
    await expect(page).toHaveURL('/messages?state=FAILED');
    // ...and drawn: its chip is the sign that the page has taken it (the address changes before the page is drawn again).
    await expect(page.getByRole('button', { name: 'Remove filter: Status: Failed' })).toBeVisible();
    await page.getByRole('combobox', { name: 'For' }).selectOption('RIDER');

    await expect(page.getByRole('heading', { name: 'No messages match' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No messages yet' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show every message' }).click();

    await expect(page).toHaveURL(LOG);
    await expect(page.getByRole('rowheader')).toHaveCount(11);
    // No choice is left: no chip of any, and the first view is the one chosen.
    await expect(page.getByRole('button', { name: /^Remove filter: / })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Every message' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // Break caught (the brief): the Ops feed offered as a different list, a status carried into it, or an entry invented to fill it.
  test('show the Ops feed as a view of its own, and say plainly that nothing is in it', async ({
    page,
  }) => {
    const { api } = await open(page, '/messages?state=FAILED');
    await expect(page.getByRole('rowheader')).toHaveCount(1);

    await page.getByRole('tab', { name: 'The Ops feed' }).click();

    await expect(page.getByRole('heading', { name: 'Nothing in the Ops feed yet' })).toBeVisible();
    const search = new URL(page.url()).searchParams;
    expect([search.get('channel'), search.get('audience'), search.has('state')]).toEqual([
      'FEED',
      'OPS_FEED',
      false,
    ]);
    expect(
      lists(api).some((call) => {
        const each = new URLSearchParams(call.search);
        return (
          each.get('channel') === 'FEED' &&
          each.get('audience') === 'OPS_FEED' &&
          !each.has('state')
        );
      }),
    ).toBe(true);
    await expect(page.getByRole('rowheader')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'The Ops feed' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await page.getByRole('button', { name: 'Show every message' }).click();
    await expect(page).toHaveURL(LOG);
    await expect(page.getByRole('rowheader')).toHaveCount(11);
  });

  test('page by the tokens the server gives, and keep the place in the view', async ({ page }) => {
    const { api } = await open(page, LOG, { pageSize: 4 });
    await expect(page.getByRole('rowheader')).toHaveCount(4);
    await expect(page.getByText('Showing 4 messages. More follow on the next page.')).toBeVisible();

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/Showing 4 messages on page 2/)).toBeVisible();
    await expect(page.getByRole('region', { name: 'Messages' })).toBeFocused();
    expect(lists(api).some((call) => call.search === '?page_token=p4')).toBe(true);

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/Showing 3 messages on page 3/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0);

    // A new choice starts again at the first page: the next page of one view is never asked for under another.
    await openFilters(page);
    await page.getByRole('combobox', { name: 'Channel' }).selectOption('SMS');
    await expect(page.getByText('Showing 4 messages. More follow on the next page.')).toBeVisible();
    expect(lists(api).at(-1)?.search).toBe('?channel=SMS');
  });
});

test.describe('when the messages cannot be had', () => {
  test('says so in approved words, never in the server’s, and tries again on request', async ({
    page,
  }) => {
    const { api } = await open(page, LOG, { listFails: { status: 500, code: 'INTERNAL_ERROR' } });

    await expect(page.getByRole('alert')).toContainText('The messages could not be loaded.');
    await expect(page.locator('body')).not.toContainText(DIAGNOSTIC);
    await expect(page.getByRole('rowheader')).toHaveCount(0);

    api.world.listFails = undefined;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('rowheader')).toHaveCount(11);
  });

  test('says what the account cannot do when the server refuses it, and names no key or role', async ({
    page,
  }) => {
    await open(page, LOG, { listFails: { status: 403, code: 'PERMISSION_DENIED' } });

    await expect(page.getByRole('alert')).toContainText(
      'Your account can’t see the message log. Ask an administrator for access.',
    );
    await expect(page.locator('body')).not.toContainText('notification.read');
    await expect(page.locator('body')).not.toContainText(
      /Ops Staff|Senior Ops|Platform Admin|Finance/,
    );
    await expect(page.locator('body')).not.toContainText(DIAGNOSTIC);
  });
});

interface Screen {
  readonly name: string;
  /** Opens the screen and waits until it is drawn. It may hand back what lets go of a read it holds. */
  readonly reach: (page: Page) => Promise<(() => void) | undefined>;
}

const SCREENS: readonly Screen[] = [
  {
    name: 'the log',
    reach: async (page) => {
      await open(page, LOG);
      // Rows or cards, by the room there is: the count the page states is the same.
      await expect(page.getByText('Showing 11 messages.')).toBeVisible();
      return undefined;
    },
  },
  {
    name: 'the log narrowed to one request',
    reach: async (page) => {
      await open(page, ABOUT);
      await expect(page.getByText('Messages about one request')).toBeVisible();
      await expect(page.getByText('Showing 4 messages.')).toBeVisible();
      return undefined;
    },
  },
  {
    name: 'a filter that hides everything',
    reach: async (page) => {
      await open(page, '/messages?state=FAILED&audience=RIDER');
      await expect(page.getByRole('heading', { name: 'No messages match' })).toBeVisible();
      return undefined;
    },
  },
  {
    name: 'the Ops feed with nothing in it',
    reach: async (page) => {
      await open(page, '/messages?channel=FEED&audience=OPS_FEED');
      await expect(
        page.getByRole('heading', { name: 'Nothing in the Ops feed yet' }),
      ).toBeVisible();
      return undefined;
    },
  },
  {
    name: 'a log with no message at all',
    reach: async (page) => {
      await open(page, LOG, { entries: [] });
      await expect(page.getByRole('heading', { name: 'No messages yet' })).toBeVisible();
      return undefined;
    },
  },
  {
    name: 'a log that cannot be read',
    reach: async (page) => {
      await open(page, LOG, { listFails: { status: 500, code: 'INTERNAL_ERROR' } });
      await expect(page.getByRole('alert')).toBeVisible();
      return undefined;
    },
  },
  {
    name: 'a log that is still loading',
    reach: async (page) => {
      const held: Hold = hold();
      await open(page, LOG, { hold: held });
      await expect(page.getByText('Loading messages')).toBeAttached();
      return held.release;
    },
  },
  {
    name: 'a session without the key',
    reach: async (page) => {
      await open(page, LOG, { permissions: ['pickup.read'] });
      await expect(
        page.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
      ).toBeVisible();
      return undefined;
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
        const release = await screen.reach(page);
        try {
          expect(await wcagViolations(page)).toEqual([]);
          expect(await overflowOf(page)).toBeLessThanOrEqual(0);
          await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        } finally {
          release?.();
        }
      });
    }
  }
});

test.describe('enlarged text, forced colours and reduced motion', () => {
  // Break caught (WCAG 1.4.4): sizes in pixels, so enlarged text does not grow the filters, or breaks them.
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 640, height: 800 },
  ]) {
    for (const path of [LOG, ABOUT]) {
      test(`${path === LOG ? 'the log' : 'the log narrowed to one request'} at 200% text keeps its layout at ${String(width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await open(page, path);
        await expect(page.getByText(/^Showing \d+ messages/)).toBeVisible();
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });

        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        expect(await clippedControls(page)).toEqual([]);
      });
    }
  }

  // Break caught: a status told by a fill that forced colours paint away, a chip with no border, or a focus ring that disappears with them.
  test('under forced colours a status keeps its border, the narrowed log its frame and a select its focus ring', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page, ABOUT);
    await expect(page.getByText('Messages about one request')).toBeVisible();

    const border = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { style: style.borderTopStyle, width: parseFloat(style.borderTopWidth) };
        });
    expect(await border('.ui-status-badge')).toEqual({ style: 'solid', width: 1 });
    expect(await border('.messages-subject')).toEqual({ style: 'solid', width: 1 });

    // By keyboard, so that the focus is a keyboard user's, which shows its ring.
    await openFilters(page);
    const status = page.getByRole('combobox', { name: 'Status' });
    await status.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(status).toBeFocused();
    expect(await status.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
      'solid',
    );
  });

  test('with reduced motion nothing moves while the log loads', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const held = hold();
    await open(page, LOG, { hold: held });
    await expect(page.getByText('Loading messages')).toBeAttached();

    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.playState === 'running').length,
    );
    held.release();

    expect(running).toBe(0);
    await expect(page.getByRole('rowheader')).toHaveCount(11);
  });

  // The control of the test above: the same page moves when motion is not reduced, so that test could fail.
  test('without that preference the same page does move while it loads', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const held = hold();
    await open(page, LOG, { hold: held });
    await expect(page.getByText('Loading messages')).toBeAttached();

    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.playState === 'running').length,
    );
    held.release();

    expect(running).toBeGreaterThan(0);
    await expect(page.getByRole('rowheader')).toHaveCount(11);
  });
});
