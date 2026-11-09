import { expect, test, type Page } from '@playwright/test';

import { SIGNED_IN_SESSION, stubApi } from './support/api';
import { watchPage, wcagViolations } from './support/page';
import { SUMMARY_PATH } from './support/queue-summary';
import { menuEntry, openAccountMenu, primaryNav } from './support/shell';

/**
 * The queue summary in a browser (task C1; `AC-QSUM-07`, `AC-QSUM-08`, `AC-QSUM-09`; and `AC-QSUM-11`, task C1.1; drawn by the sidebar and My work of
 * redesign step R4): the sidebar draws a count beside the entry of each queue the server counted and that has an entry, My work has a card for each
 * queue that holds something, the one that has waited longest first, and one line for the queues that are clear, a failed read says so and
 * offers *Try again*, the page goes back to the server for the counts when the person goes to another page, and the late bookings open the
 * pickup list under their own filter. The production build, in a real engine; only the
 * network is stood in (the sessions and the summary are the stand-in's, the counts are synthetic).
 */
const OFFICER = {
  ...SIGNED_IN_SESSION,
  permissions: [
    'pickup.read',
    'pickup.exception.approve',
    'pickup.manifest.create',
    'staff.read',
    'staff.identity.approve',
  ],
};

const QUEUES = [
  { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 5, oldest_at: '2026-11-03T08:00:00.000Z' },
  { queue: 'PICKUP_CUTOFF_REVIEW', count: 1, oldest_at: '2026-10-30T08:00:00.000Z' },
  { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 3, oldest_at: '2026-11-01T14:30:00.000Z' },
  { queue: 'PICKUP_UNMANIFESTED_POOL', count: 4, oldest_at: '2026-10-31T09:05:00.000Z' },
  { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 0 },
  { queue: 'STAFF_AWAITING_APPROVAL', count: 12, oldest_at: '2026-11-04T10:00:00.000Z' },
];

/** The counts the rail test draws: one, four (grouped) and two digits, so that the widest pill on the rail is the one that has to fit. */
const RAIL_COUNTS = [
  { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 7, oldest_at: '2026-11-03T08:00:00.000Z' },
  { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 1234, oldest_at: '2026-11-01T14:30:00.000Z' },
  { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 12, oldest_at: '2026-11-05T07:00:00.000Z' },
  { queue: 'STAFF_AWAITING_APPROVAL', count: 3, oldest_at: '2026-11-04T10:00:00.000Z' },
];

interface Opened {
  readonly summaryReads: () => number;
}

/** The portal with this officer signed in and the summary answered as given (each read of it moves `next`, when it is a list of answers). */
async function open(
  page: Page,
  answers: readonly (readonly Record<string, unknown>[] | 'fails')[] = [QUEUES],
  path = '/',
): Promise<Opened> {
  await stubApi(page);
  // Routes registered later answer first: this one is the session of the officer, and the next the summary.
  await page.route('**/api/v1/auth/session', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      json: OFFICER,
    }),
  );
  await page.route('**/api/v1/auth/staff/trusted-browsers', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      json: { items: [] },
    }),
  );
  let reads = 0;
  await page.route(`**${SUMMARY_PATH}`, (route) => {
    const answer = answers[Math.min(reads, answers.length - 1)] ?? [];
    reads += 1;
    if (answer === 'fails') {
      return route.fulfill({
        status: 500,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        json: { code: 'INTERNAL_ERROR', message: 'Diagnostic text.', request_id: 'req-browser-9' },
      });
    }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      json: { queues: answer },
    });
  });
  await page.goto(path);
  return { summaryReads: () => reads };
}

const menu = (page: Page) => primaryNav(page);

test.describe('the counts of the queues in a browser', () => {
  // Break caught: counts that are not drawn in a real engine, or drawn beside the wrong entry.
  test('the menu draws the count of each queue beside its entry', async ({ page }) => {
    const seen = watchPage(page);
    await open(page);

    await expect(
      menu(page).getByRole('link', { name: 'Requests 5 waiting for confirmation' }),
    ).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Decisions 3 waiting for approval' }),
    ).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Staff 12 waiting for approval' }),
    ).toBeVisible();
    // A queue with nothing in it that was read draws no pill (task R5.2, M16: a row of zeros is noise beside the entries that hold something; My work's "Also clear" line
    // still names the queue), and its entry keeps its name; an entry with no queue draws none either.
    const runs = menu(page).getByRole('link', { name: 'Pickup runs', exact: true });
    await expect(runs).toBeVisible();
    await expect(runs.locator('.ui-count-badge')).toHaveCount(0);
    await expect(menu(page).getByRole('link', { name: 'My work' })).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'My work' }).locator('.ui-count-badge'),
    ).toHaveCount(0);
    // Break caught (review of 7 November 2026): the helper the specs use to look for an entry by its label (`menuEntry`) not finding an entry that has
    // a count after its label, so that the specs that assert an entry is ABSENT for a session without the key would pass for an entry that was there.
    for (const label of ['Requests', 'Decisions', 'Staff', 'Pickup runs']) {
      await expect(menuEntry(page, label), label).toHaveCount(1);
    }
    // ...and a label is a whole word of the entry's name: the first letters of "Pickup runs" are not an entry.
    await expect(menuEntry(page, 'Pickup run')).toHaveCount(0);
    // Four entries have a queue, and three of them hold something: the other two queues of the summary (the late bookings, the confirmed pickups not on a run) have no
    // entry, and are drawn on My work only.
    await expect(menu(page).locator('.ui-count-badge')).toHaveCount(3);
    expect(seen.problems).toEqual([]);
  });

  // Break caught: My work listing what the keys suggest and not what the server counted, in any order but the oldest first, a card for a queue
  // that is clear, or a clear queue left out of the line that says so.
  test('My work has a card for each queue that holds something, the oldest first, each with a link, and one line for the clear ones', async ({
    page,
  }) => {
    await open(page);

    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Waiting for you' });
    await expect(list.getByRole('listitem')).toHaveCount(5);
    await expect(list.getByRole('link')).toHaveText([
      'Late bookings waiting for a cut-off decision',
      'Confirmed pickups not yet on a run',
      'One-package exceptions waiting for approval',
      'Pickup requests waiting for confirmation',
      'Staff profiles waiting for approval',
    ]);
    // The queue the server counted and found empty is not a card: it is one quiet line.
    await expect(page.getByText('Also clear: Pickup runs in progress.')).toBeVisible();
    await expect(list.getByText('Pickup runs in progress')).toHaveCount(0);
    await expect(
      list.getByRole('link', { name: 'Pickup requests waiting for confirmation' }),
    ).toHaveAttribute('href', '/pickup-requests?state=PENDING');
    await expect(
      list.getByRole('link', { name: 'Staff profiles waiting for approval' }),
    ).toHaveAttribute('href', '/admin/staff?view=waiting');
    await expect(list.getByRole('listitem').first()).toContainText('Oldest since 30 Oct, 08:00');
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
  });

  // Task C1.1 (AC-QSUM-11). Break caught: the link of the late bookings opening the plain list of confirmed requests (the officer hunts for
  // the late ones among the rest), or the page applying a filter it does not say, or a filter it says and does not send.
  test('the late bookings open the pickup list with the cut-off filter, asked of the server and said in words', async ({
    page,
  }) => {
    await open(page);
    const asked: URL[] = [];
    await page.route('**/api/v1/pickup-requests?**', (route) => {
      asked.push(new URL(route.request().url()));
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        json: { items: [], next_page_token: null },
      });
    });

    await page
      .getByRole('list', { name: 'Waiting for you' })
      .getByRole('link', { name: 'Late bookings waiting for a cut-off decision' })
      .click();

    await expect(page).toHaveURL(/\/pickup-requests\?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW$/);
    // The late bookings are a chip of the filter row (R6.1): said in words, and taken off by their own remove button.
    await expect(page.getByText('Only late bookings waiting for a cut-off decision')).toBeVisible();
    // The list's read may not have reached the route when the chip shows: poll, as the last assertion of the test does.
    await expect.poll(() => asked.at(-1)?.searchParams.get('state')).toBe('CONFIRMED');
    await expect
      .poll(() => asked.at(-1)?.searchParams.get('cutoff_exception_state'))
      .toBe('PENDING_OPS_REVIEW');

    await page
      .getByRole('button', {
        name: 'Remove filter: Only late bookings waiting for a cut-off decision',
      })
      .click();

    await expect(page).toHaveURL(/\/pickup-requests\?state=CONFIRMED$/);
    // The chip that took the filter off is gone: focus is on what stays in the filter row (the Filter button), and not lost to the page.
    await expect(page.getByRole('button', { name: 'Filter', exact: true })).toBeFocused();
    await expect(page.getByText('Only late bookings waiting for a cut-off decision')).toHaveCount(
      0,
    );
    await expect.poll(() => asked.at(-1)?.searchParams.has('cutoff_exception_state')).toBe(false);
  });

  // Break caught: the defect this task fixes: "nothing is waiting" for a session the page never looked at.
  test('says nothing is waiting only when every count the server gave is 0', async ({ page }) => {
    await open(page, [
      [
        { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 },
        { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
      ],
    ]);

    await expect(page.getByText('Nothing is waiting.')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Waiting for you' })).toHaveCount(0);
  });

  // Break caught: a failed read drawn as "nothing is waiting", as a count, or as a broken menu.
  test('a failed read says so, offers Try again, and leaves the menu working', async ({ page }) => {
    await open(page, ['fails', QUEUES]);

    await expect(page.getByText('The summary of what is waiting could not be read.')).toBeVisible();
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
    await expect(menu(page).getByRole('link', { name: 'Requests' })).toBeVisible();
    await expect(menu(page).locator('.ui-count-badge')).toHaveCount(0);

    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(
      page.getByRole('link', { name: 'Pickup requests waiting for confirmation' }),
    ).toBeVisible();
    await expect(menu(page).locator('.ui-count-badge')).toHaveCount(3);
  });

  // Break caught: the counts of the moment the page opened shown beside every page the person goes to after it.
  test('reads the summary again when the person goes to another page', async ({ page }) => {
    const opened = await open(page, [
      QUEUES,
      [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 9, oldest_at: '2026-11-03T08:00:00.000Z' }],
    ]);
    await expect(
      menu(page).getByRole('link', { name: 'Requests 5 waiting for confirmation' }),
    ).toBeVisible();
    expect(opened.summaryReads()).toBe(1);

    const account = await openAccountMenu(page);
    await account.getByRole('menuitem', { name: 'Trusted browsers' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Trusted browsers' })).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Requests 9 waiting for confirmation' }),
    ).toBeVisible();
    expect(opened.summaryReads()).toBe(2);
  });

  // Break caught: the count lost on the rail, where the labels are not drawn, or the name and the count not told to a pointer or a keyboard.
  // Break caught (Product Owner, 7 November 2026): a count that leaves its entry (hung off the corner of the link, over the icon at four digits, or half on
  // the crimson and half on the Ink on the current entry), an entry that grows to hold it, a figure drawn smaller than it is beside a name, or a rail that grew.
  test('the rail keeps the count inside its entry, under the icon, and the name of the entry and what it counts in the tooltip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The entries of the rail with a count of one, two and four digits (the thousands are grouped: "1,234"), and the current entry among them.
    await open(page, [RAIL_COUNTS], '/approvals');
    await page.getByRole('button', { name: 'Collapse menu' }).click();

    const link = menu(page).getByRole('link', {
      name: 'Requests 7 waiting for confirmation',
    });
    await link.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Requests: 7 waiting for confirmation');

    const rail = await page.getByRole('complementary', { name: 'Main menu' }).boundingBox();
    expect(rail).not.toBeNull();
    expect(Math.round(rail?.width ?? 0)).toBe(64);
    for (const name of [
      'Requests 7 waiting for confirmation',
      'Pickup runs 12 in progress',
      'Decisions 1,234 waiting for approval',
    ]) {
      const entry = menu(page).getByRole('link', { name });
      const pill = entry.locator('.ui-count-badge');
      await expect(pill, name).toBeVisible();
      const [badge, row, icon, style] = await Promise.all([
        pill.boundingBox(),
        entry.boundingBox(),
        entry.locator('.ui-sidebar__icon').boundingBox(),
        pill.evaluate((element) => {
          const computed = getComputedStyle(element);
          return { fontSize: computed.fontSize, transform: computed.transform };
        }),
      ]);
      expect(badge, name).not.toBeNull();
      expect(row, name).not.toBeNull();
      expect(icon, name).not.toBeNull();
      if (badge === null || row === null || icon === null) continue;
      // Inside the entry on all four sides, so that it never leaves its link and, on the current entry, is wholly on the crimson.
      expect(badge.x, name).toBeGreaterThanOrEqual(row.x);
      expect(badge.y, name).toBeGreaterThanOrEqual(row.y);
      expect(badge.x + badge.width, name).toBeLessThanOrEqual(row.x + row.width);
      expect(badge.y + badge.height, name).toBeLessThanOrEqual(row.y + row.height);
      // Under the icon and never over it, in an entry that is 36px as it is without a count.
      expect(badge.y, name).toBeGreaterThanOrEqual(icon.y + icon.height);
      expect(row.height, name).toBeCloseTo(36, 0);
      // The figure is the CountBadge's own 12px, not scaled down.
      expect(style, name).toEqual({ fontSize: '12px', transform: 'none' });
    }
  });
});

test.describe('accessibility of the counts', () => {
  for (const scheme of ['light', 'dark'] as const) {
    // Break caught: a badge or a list line that fails contrast or naming in either theme.
    test(`My work and the sidebar have no violations in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await expect(page.getByRole('list', { name: 'Waiting for you' })).toBeVisible();
      await expect(menu(page).locator('.ui-count-badge')).toHaveCount(3);

      expect(await wcagViolations(page), `${scheme}: My work`).toEqual([]);
    });

    // Break caught (Product Owner, 7 November 2026): the figure on the pill of the current entry, white at 18% over the crimson, below 4.5:1 in a real engine, on
    // the rail or beside the name; or the pill moved off the crimson where the contrast was measured.
    test(`the sidebar has no violations with a count on its current entry, docked and on the rail, in the ${scheme} theme`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1280, height: 800 });
      await open(page, [RAIL_COUNTS], '/approvals');
      const current = menu(page).getByRole('link', {
        name: 'Decisions 1,234 waiting for approval',
      });
      await expect(current).toHaveAttribute('aria-current', 'page');

      expect(await wcagViolations(page, { include: '.ui-sidebar' }), `${scheme}: docked`).toEqual(
        [],
      );

      await page.getByRole('button', { name: 'Collapse menu' }).click();
      await expect(current.locator('.ui-count-badge')).toBeVisible();
      expect(await wcagViolations(page, { include: '.ui-sidebar' }), `${scheme}: rail`).toEqual([]);
    });
  }
});
