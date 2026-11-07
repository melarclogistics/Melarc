import { expect, test, type Page } from '@playwright/test';

import { stubApi } from './support/api';
import { watchPage, wcagViolations } from './support/page';
import { SUMMARY_PATH } from './support/queue-summary';
import { answerSessionWith, HUB_A, HUB_B, overflowOf, primaryNav } from './support/shell';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * My work, the signed-in landing (redesign step R4; surfaces/ops-portal.md section 7), in a real browser: the greeting, a card for each queue that
 * holds something with its figure and since when its oldest record has waited, the queues that are clear in one line, and the states of the read
 * of the summary: loading, nothing waiting, failed. What jsdom cannot show is here: the page frame and the title as they are painted, the cards
 * at a phone's width and with text enlarged, and every state with axe in both themes under the strict policy.
 *
 * **A sample figure is never a result and a missing figure is never zero**: while the summary is being read, and after a read that failed, no
 * figure is drawn at all. The counts are synthetic; the stand-in of the API answers the summary as each test says.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

const QUEUES = [
  { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 1234, oldest_at: '2026-11-03T08:00:00.000Z' },
  { queue: 'PICKUP_CUTOFF_REVIEW', count: 1, oldest_at: '2026-10-30T08:00:00.000Z' },
  { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 3, oldest_at: '2026-11-01T14:30:00.000Z' },
  { queue: 'PICKUP_UNMANIFESTED_POOL', count: 0 },
  { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 0 },
  { queue: 'STAFF_AWAITING_APPROVAL', count: 12, oldest_at: '2026-11-04T10:00:00.000Z' },
];

/** The keys that make the queues of `QUEUES` the session's to see. */
const KEYS = [
  'pickup.read',
  'pickup.exception.approve',
  'pickup.manifest.create',
  'staff.read',
  'staff.identity.approve',
];

type Summary = readonly Record<string, unknown>[] | 'fails' | 'held';

interface Opened {
  readonly release: () => void;
  readonly reads: () => number;
}

/**
 * My work for a session with these hubs and this name, the summary answered as given. `held` is held until `release`, and then answered with one queue
 * read and found empty: a complete summary with every count 0, which is what *Nothing is waiting* may be said of (a summary with no queue in it says
 * nothing of waiting at all).
 */
async function open(
  page: Page,
  summary: Summary,
  session: Readonly<Record<string, unknown>> = {},
): Promise<Opened> {
  await stubApi(page);
  await answerSessionWith(page, { permissions: KEYS, ...session });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route(`**${SUMMARY_PATH}`, async (route) => {
    reads += 1;
    if (summary === 'held') await held;
    if (summary === 'fails') {
      await route.fulfill({
        status: 500,
        headers: JSON_HEADERS,
        json: { code: 'INTERNAL_ERROR', message: 'Diagnostic text.', request_id: 'req-browser-9' },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      json: {
        queues: summary === 'held' ? [{ queue: 'STAFF_AWAITING_APPROVAL', count: 0 }] : summary,
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
  return { release, reads: () => reads };
}

const cards = (page: Page) => page.getByRole('list', { name: 'Waiting for you' });

test.describe('the page frame and the greeting', () => {
  // Break caught: a page that is not in the frame of the specification: the title 24px on a 30px line, bold, drawn 0.02em tighter, with the 24px
  // padding of the page (16px on a phone), or a title that is not the page's one heading.
  for (const { width, padding } of [
    { width: 1280, padding: 24 },
    { width: 390, padding: 16 },
  ] as const) {
    test(`has the title and the padding of the page frame at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, QUEUES);

      const frame = await page.evaluate(() => {
        const heading = document.querySelector('main h1');
        const main = document.querySelector('main');
        const title = heading === null ? null : getComputedStyle(heading);
        const around = main === null ? null : getComputedStyle(main);
        return {
          size: title?.fontSize,
          line: title?.lineHeight,
          weight: title?.fontWeight,
          spacing: title?.letterSpacing,
          left: around?.paddingLeft,
          right: around?.paddingRight,
          headings: document.querySelectorAll('h1').length,
        };
      });
      expect(frame).toEqual({
        size: '24px',
        line: '30px',
        weight: '700',
        spacing: '-0.48px',
        left: `${String(padding)}px`,
        right: `${String(padding)}px`,
        headings: 1,
      });
      await expect(page).toHaveTitle('My work · Melarc Ops Portal');
    });
  }

  test('greets the person by name and says where they act', async ({ page }) => {
    await open(page, QUEUES);

    await expect(page.getByRole('main').getByText('Hello,')).toBeVisible();
    await expect(page.getByRole('main').locator('strong')).toHaveText('Synthetic Officer');
    await expect(page.getByRole('main')).toContainText('Synthetic Hub');
  });

  test('says how many hubs a session lists when it lists more than one, and nothing for none', async ({
    page,
  }) => {
    await open(page, QUEUES, { authorized_hubs: [HUB_A, HUB_B] });
    await expect(page.getByRole('main')).toContainText('2 hubs');
    await expect(page.getByRole('main')).not.toContainText('Second Synthetic Hub');
  });

  test('says that the person is signed in when the session has no name, and names no hub for a session with none', async ({
    page,
  }) => {
    await open(page, QUEUES, { principal_display_name: null, authorized_hubs: [] });

    await expect(page.getByRole('main').getByText('You are signed in.')).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('Synthetic Hub');
    await expect(page.getByRole('main')).not.toContainText('hubs');
  });
});

test.describe('what is waiting', () => {
  // Break caught: a card for a queue that is clear, an order other than the oldest first, a figure that is not grouped as the portal's others,
  // an age drawn as a number of days (no threshold is defined, so none is invented), or a link that does not go to the queue.
  test('has a card for each queue that holds something, the one waiting longest first, with its figure and since when', async ({
    page,
  }) => {
    await open(page, QUEUES);

    await expect(cards(page).getByRole('listitem')).toHaveCount(4);
    await expect(cards(page).getByRole('link')).toHaveText([
      'Late bookings waiting for a cut-off decision',
      'One-package exceptions waiting for approval',
      'Pickup requests waiting for confirmation',
      'Staff profiles waiting for approval',
    ]);
    const first = cards(page).getByRole('listitem').first();
    await expect(first).toContainText('Oldest since 30 Oct, 08:00');
    const request = cards(page).getByRole('listitem').filter({ hasText: 'Pickup requests' });
    // The figure is drawn grouped as the portal draws a figure, and read with what it counts, once.
    await expect(request.locator('.my-work-card__figure > span').first()).toHaveText('1,234');
    await expect(request.getByText('1,234 waiting for confirmation')).toBeAttached();
    await expect(page.getByRole('main')).not.toContainText(/\bdays?\b/);
    await expect(request.getByRole('link')).toHaveAttribute(
      'href',
      '/pickup-requests?state=PENDING',
    );
    // The queues the server counted and found empty are one quiet line, and no card.
    await expect(
      page.getByText('Also clear: Confirmed pickups not yet on a run, Pickup runs in progress.'),
    ).toBeVisible();
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
  });

  // Break caught: the figure of a card drawn as the specification does not say: 32px, bold, tabular, tightened; or a card that is not 16px round.
  test('draws the figure large, bold and tabular on a card of the radius of a page card', async ({
    page,
  }) => {
    await open(page, QUEUES);

    const drawn = await page.evaluate(() => {
      const figure = document.querySelector('.my-work-card__figure');
      const card = document.querySelector('.my-work-card');
      const style = figure === null ? null : getComputedStyle(figure);
      return {
        size: style?.fontSize,
        weight: style?.fontWeight,
        numeric: style?.fontVariantNumeric,
        spacing: style?.letterSpacing,
        radius: card === null ? undefined : getComputedStyle(card).borderTopLeftRadius,
      };
    });
    expect(drawn).toEqual({
      size: '32px',
      weight: '700',
      numeric: 'tabular-nums',
      spacing: '-0.64px',
      radius: '16px',
    });
  });

  // Break caught: the card's link or the phrase that is read with the figure missing from a screen reader's view, or the figure said twice.
  test('names a card by its link and reads its figure once, with what it counts', async ({
    page,
  }) => {
    await open(page, QUEUES);

    const card = cards(page).getByRole('listitem').filter({ hasText: 'Staff profiles' });
    // The drawn number is hidden from assistive technology; the phrase that holds it is read.
    await expect(card.locator('.my-work-card__figure > span[aria-hidden="true"]')).toHaveText('12');
    await expect(card.locator('.my-work-card__meaning')).toHaveText('12 waiting for approval');
    await expect(
      card.getByRole('link', { name: 'Staff profiles waiting for approval' }),
    ).toBeVisible();
  });

  // Break caught: "Nothing is waiting" said for a summary that was not read, that was cut short, or that has anything in it.
  test('says nothing is waiting only when the summary was read and every count of it is 0', async ({
    page,
  }) => {
    await open(page, [
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 0 },
    ]);

    await expect(page.getByText('Nothing is waiting.')).toBeVisible();
    await expect(cards(page)).toHaveCount(0);
    await expect(page.getByText(/^Also clear/)).toHaveCount(0);
  });

  // Break caught: a queue the page has no words for (a server newer than the page) dropped without a word, so that "nothing is waiting" or a short
  // list is taken for all that waits.
  test('says that some queues cannot be shown when the server counted one this page has no words for', async ({
    page,
  }) => {
    await open(page, [
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 },
      { queue: 'A_QUEUE_OF_A_NEWER_SERVER', count: 7, oldest_at: '2026-11-04T10:00:00.000Z' },
    ]);

    await expect(page.getByText('Some queues cannot be shown on this page.')).toBeVisible();
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
    await expect(page.getByText('A_QUEUE_OF_A_NEWER_SERVER')).toHaveCount(0);
  });

  // Break caught: a session the server gave no queue told anything about waiting: neither that nothing is, nor a heading over nothing.
  test('says nothing of waiting to a session the server gave no queue', async ({ page }) => {
    await open(page, []);

    await expect(page.getByRole('heading', { level: 2, name: 'Waiting for you' })).toHaveCount(0);
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
  });
});

test.describe('while the summary is read, and when it cannot be', () => {
  // Break caught: a figure drawn before the summary was read (a sample, or a zero), "nothing is waiting" before there is anything to say it of,
  // or loading that is not announced.
  test('shows the shapes of cards and the words that it is checking, and no figure', async ({
    page,
  }) => {
    const opened = await open(page, 'held');

    await expect(page.getByRole('heading', { level: 2, name: 'Waiting for you' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('Checking what is waiting…');
    await expect(page.locator('.my-work__cards--loading .my-work-card')).toHaveCount(3);
    await expect(page.locator('.my-work__cards--loading')).toHaveAttribute('aria-hidden', 'true');
    // Not one digit of a figure, and no claim.
    expect(await page.locator('.my-work-card').allInnerTexts()).toEqual(['', '', '']);
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
    await expect(primaryNav(page).locator('.ui-count-badge')).toHaveCount(0);

    opened.release();
    await expect(page.getByText('Nothing is waiting.')).toBeVisible();
  });

  // Break caught: a failed read drawn as nothing waiting, as a figure, or with the server's text; or with no way to ask again.
  test('says the summary could not be read, offers Try again, draws no figure, and is not taken for nothing waiting', async ({
    page,
  }) => {
    await open(page, 'fails');

    await expect(page.getByText('The summary of what is waiting could not be read.')).toBeVisible();
    await expect(page.getByText(/Diagnostic text|INTERNAL_ERROR/)).toHaveCount(0);
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
    await expect(page.locator('.my-work-card')).toHaveCount(0);
    await expect(primaryNav(page).locator('.ui-count-badge')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('My work, policy and accessibility', () => {
  // Break caught: the screen (its cards, its skeletons, its inline styles) refused by the strict policy, or the policy relaxed for it.
  for (const state of ['cards', 'loading', 'nothing waiting', 'failed'] as const) {
    test(`runs under the strict policy: ${state}`, async ({ page }) => {
      const violations = await enforceStrictPolicy(page);
      const seen = watchPage(page);
      const summary: Summary =
        state === 'cards'
          ? QUEUES
          : state === 'loading'
            ? 'held'
            : state === 'failed'
              ? 'fails'
              : [{ queue: 'STAFF_AWAITING_APPROVAL', count: 0 }];
      await open(page, summary);

      if (state === 'cards') await expect(cards(page)).toBeVisible();
      if (state === 'loading') {
        await expect(page.getByRole('status')).toContainText('Checking what is waiting…');
      }
      if (state === 'nothing waiting')
        await expect(page.getByText('Nothing is waiting.')).toBeVisible();
      if (state === 'failed')
        await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();

      expect(violations).toEqual([]);
      // A failed read is a request the page sees fail (the answer is a 500 on purpose, and the browser logs it): nothing else may be a problem.
      expect(seen.problems.filter((problem) => !problem.includes('500'))).toEqual([]);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    for (const { width, height } of [
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 320, height: 640 },
    ] as const) {
      // Break caught: a state of the page that fails contrast, naming or target size in either theme, that clips, or that makes the page scroll
      // sideways at a verified width.
      test(`has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px in the ${scheme} theme, in each state`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });

        const loading = await open(page, 'held');
        await expect(page.getByRole('status')).toContainText('Checking what is waiting…');
        expect(await wcagViolations(page), 'loading').toEqual([]);
        expect(await overflowOf(page), 'loading').toBeLessThanOrEqual(0);
        loading.release();
        await expect(page.getByText('Nothing is waiting.')).toBeVisible();
        expect(await wcagViolations(page), 'nothing waiting').toEqual([]);

        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await open(page, QUEUES);
        await expect(cards(page)).toBeVisible();
        expect(await wcagViolations(page), 'cards').toEqual([]);
        expect(await overflowOf(page), 'cards').toBeLessThanOrEqual(0);

        await page.unrouteAll({ behavior: 'ignoreErrors' });
        await open(page, 'fails');
        await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
        expect(await wcagViolations(page), 'failed').toEqual([]);
      });
    }
  }

  // Break caught: the figure or the name of a card clipped, or the page pushed sideways, at a phone's width with text enlarged to 200%
  // (WCAG 1.4.4, 1.4.10).
  test('keeps the cards whole at 320 px with text enlarged to 200%, one under another', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, QUEUES);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    const boxes = await page.locator('.my-work-card').evaluateAll((all) =>
      all.map((card) => {
        const box = card.getBoundingClientRect();
        return { x: box.x, right: box.right, top: box.top };
      }),
    );
    expect(boxes).toHaveLength(4);
    for (const box of boxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(320);
    }
    // One column: each card is under the one before it.
    for (const [index, box] of boxes.entries()) {
      if (index > 0) expect(box.top).toBeGreaterThan(boxes[index - 1]?.top ?? Number.MAX_VALUE);
    }
  });
});
