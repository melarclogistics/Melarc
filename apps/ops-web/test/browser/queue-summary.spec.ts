import { expect, test, type Page } from '@playwright/test';

import { SIGNED_IN_SESSION, stubApi } from './support/api';
import { watchPage, wcagViolations } from './support/page';
import { SUMMARY_PATH } from './support/queue-summary';

/**
 * The queue summary in a browser (task C1; `AC-QSUM-07`, `AC-QSUM-08`, `AC-QSUM-09`; and `AC-QSUM-11`, task C1.1): the menu draws a count beside
 * the entry of each queue the server counted, the landing lists those queues, oldest first, with a link to each, a failed read says so and
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

const menu = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

test.describe('the counts of the queues in a browser', () => {
  // Break caught: counts that are not drawn in a real engine, or drawn beside the wrong entry.
  test('the menu draws the count of each queue beside its entry', async ({ page }) => {
    const seen = watchPage(page);
    await open(page);

    await expect(
      menu(page).getByRole('link', { name: 'Pickup requests 5 waiting for confirmation' }),
    ).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Exceptions to approve 3 waiting for approval' }),
    ).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Build a manifest 4 confirmed and not yet on a run' }),
    ).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Staff 12 waiting for approval' }),
    ).toBeVisible();
    // A queue with nothing in it that was read is drawn, quietly; an entry with no queue draws none.
    await expect(menu(page).getByRole('link', { name: 'Manifests 0 in progress' })).toBeVisible();
    await expect(menu(page).getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Overview' }).locator('.ui-count-badge'),
    ).toHaveCount(0);
    expect(seen.problems).toEqual([]);
  });

  // Break caught: the landing listing what the keys suggest and not what the server counted, in any order but the oldest first.
  test('the landing lists the queues the server counted, the oldest first, each with a link', async ({
    page,
  }) => {
    await open(page);

    const list = page.getByRole('list', { name: 'Waiting for you' });
    await expect(list.getByRole('listitem')).toHaveCount(6);
    await expect(list.getByRole('link')).toHaveText([
      'Late bookings waiting for a cut-off decision',
      'Confirmed pickups not yet on a run',
      'One-package exceptions waiting for approval',
      'Pickup requests waiting for confirmation',
      'Staff profiles waiting for approval',
      'Pickup runs in progress',
    ]);
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
    await expect(
      page.getByText('Only late bookings waiting for a cut-off decision.'),
    ).toBeVisible();
    // The list's read may not have reached the route when the banner shows: poll, as the last assertion of the test does.
    await expect.poll(() => asked.at(-1)?.searchParams.get('state')).toBe('CONFIRMED');
    await expect
      .poll(() => asked.at(-1)?.searchParams.get('cutoff_exception_state'))
      .toBe('PENDING_OPS_REVIEW');

    await page.getByRole('button', { name: 'Every cut-off decision' }).click();

    await expect(page).toHaveURL(/\/pickup-requests\?state=CONFIRMED$/);
    // The button that took the filter off is gone: focus is on the State filter, and not lost to the page.
    await expect(page.getByRole('combobox', { name: 'State' })).toBeFocused();
    await expect(page.getByText('Only late bookings waiting for a cut-off decision.')).toHaveCount(
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
    await expect(menu(page).getByRole('link', { name: 'Pickup requests' })).toBeVisible();
    await expect(menu(page).locator('.ui-count-badge')).toHaveCount(0);

    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(
      page.getByRole('link', { name: 'Pickup requests waiting for confirmation' }),
    ).toBeVisible();
    await expect(menu(page).locator('.ui-count-badge')).toHaveCount(5);
  });

  // Break caught: the counts of the moment the page opened shown beside every page the person goes to after it.
  test('reads the summary again when the person goes to another page', async ({ page }) => {
    const opened = await open(page, [
      QUEUES,
      [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 9, oldest_at: '2026-11-03T08:00:00.000Z' }],
    ]);
    await expect(
      menu(page).getByRole('link', { name: 'Pickup requests 5 waiting for confirmation' }),
    ).toBeVisible();
    expect(opened.summaryReads()).toBe(1);

    await menu(page).getByRole('link', { name: 'Trusted browsers' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Trusted browsers' })).toBeVisible();
    await expect(
      menu(page).getByRole('link', { name: 'Pickup requests 9 waiting for confirmation' }),
    ).toBeVisible();
    expect(opened.summaryReads()).toBe(2);
  });

  // Break caught: the count lost on the rail, where the labels are not drawn.
  test('the rail keeps the count beside the icon, and the name of the entry in the tooltip', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    await page.getByRole('button', { name: 'Collapse menu' }).click();

    const link = menu(page).getByRole('link', {
      name: 'Pickup requests 5 waiting for confirmation',
    });
    await expect(link).toHaveAttribute('title', 'Pickup requests: 5 waiting for confirmation');
    await expect(link.locator('.ui-count-badge')).toBeVisible();
    const [badge, row] = await Promise.all([
      link.locator('.ui-count-badge').boundingBox(),
      link.boundingBox(),
    ]);
    // At the corner of the icon: inside the row, which did not grow to take it.
    expect(badge).not.toBeNull();
    expect(row).not.toBeNull();
    if (badge !== null && row !== null) {
      expect(badge.x).toBeGreaterThanOrEqual(row.x);
      expect(badge.x + badge.width).toBeLessThanOrEqual(row.x + row.width + 1);
      expect(row.width).toBeLessThan(120);
    }
  });
});

test.describe('accessibility of the counts', () => {
  for (const scheme of ['light', 'dark'] as const) {
    // Break caught: a badge or a list line that fails contrast or naming in either theme.
    test(`the landing and the menu have no violations in the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await open(page);
      await expect(page.getByRole('list', { name: 'Waiting for you' })).toBeVisible();
      await expect(menu(page).locator('.ui-count-badge')).toHaveCount(5);

      expect(await wcagViolations(page), `${scheme}: the landing`).toEqual([]);
    });
  }
});
