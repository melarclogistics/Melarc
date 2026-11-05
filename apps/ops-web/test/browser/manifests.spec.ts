import { expect, test, type Page, type Route } from '@playwright/test';

import {
  IDS,
  manifest,
  PLANTED_HUB_COUNT,
  REQUESTS,
  stop,
  stubManifestApi,
  world,
  type ManifestApi,
  type World,
} from './support/manifest-api';
import { watchPage, wcagViolations } from './support/page';

/**
 * The manifest screens (S1.25) in a real browser: the list, the builder, one run and the Ops skip of a stop. What jsdom cannot show is here: the
 * layout at the verified widths with axe (WCAG 2.2 A and AA), no sideways scrolling at 320 px, text enlarged to 200%, forced colours, reduced
 * motion, the native modal dialog of each act (Tab kept inside it), the reordering control driven by the keyboard with focus that follows the
 * moved stop, and the exact headers a real browser sends with each act.
 *
 * The same file runs against the production build and against the development server (strict mode runs every effect twice). The API is a small
 * stateful stand-in. **The custody half is written from the contract (S1.24) and is answered by the stand-in**: it proves the screens against the
 * contract and proves nothing of the server (the custody operations of S1.24 are in the contract and the API; no run here reached them). A count of the hub's is planted in every custody
 * answer, so that a screen which could draw one would.
 */
const WIDE = { width: 1440, height: 900 } as const;
const NARROW = { width: 390, height: 844 } as const;
const PHONE = { width: 320, height: 640 } as const;
const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 768, height: 1024 }, PHONE] as const;
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DRAFT = `/manifests/${IDS.draft}`;
const RUN = `/manifests/${IDS.run}`;

/** A run in progress with two stops still to be worked, the rider who holds custody being the first. */
const runWorld = (extra: Partial<World> = {}): Partial<World> => ({
  manifests: [
    manifest({
      id: IDS.run,
      code: 'ACC-MF-K7M4PX',
      state: 'IN_PROGRESS',
      service_date: '2026-11-03',
      riderId: IDS.riderA,
      stops: [
        stop({
          id: 'b1000000-0000-4000-8000-000000000001',
          requestId: REQUESTS.one.id,
          sequence: 1,
        }),
        stop({
          id: 'b1000000-0000-4000-8000-000000000002',
          requestId: REQUESTS.two.id,
          sequence: 2,
        }),
      ],
    }),
  ],
  ...extra,
});

async function open(
  page: Page,
  path: string,
  setup: Partial<World> = {},
): Promise<{ api: ManifestApi; watch: ReturnType<typeof watchPage> }> {
  const watch = watchPage(page);
  const api = await stubManifestApi(page, world(setup));
  await page.goto(path);
  return { api, watch };
}

const acts = (api: ManifestApi, method = 'POST') =>
  api.calls.filter((call) => call.method === method);
const callTo = (api: ManifestApi, method: string, suffix: string) =>
  api.calls.filter((call) => call.method === method && call.path.endsWith(suffix));

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

const poolTable = (page: Page) =>
  page.getByRole('table', { name: 'Confirmed pickups waiting for a manifest' });
const poolCards = (page: Page) =>
  page.getByRole('list', { name: 'Confirmed pickups waiting for a manifest' });

async function typeDate(page: Page, digits: string): Promise<void> {
  const day = page
    .getByRole('group', { name: /Service date/ })
    .getByRole('spinbutton')
    .first();
  await day.click();
  await page.keyboard.type(digits);
}

test.describe('moving through the screens', () => {
  // Break caught: a menu entry that goes nowhere, or a new page whose heading a screen reader never hears.
  test('the menu leads to the list, and the list to a manifest, each landing on the new heading', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/');
    await page.getByRole('link', { name: 'Manifests' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Manifests' })).toBeFocused();

    await page.getByRole('link', { name: 'ACC-MF-Q92422' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-MF-Q92422' })).toBeFocused();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a session without the key sees no entry, and the page names the key', async ({ page }) => {
    await open(page, '/manifests', { permissions: ['staff.read'] });

    await expect(page.getByText('pickup.read')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manifests' })).toHaveCount(0);
  });

  test('the list tells that it is oldest first, and moves by the server’s token', async ({
    page,
  }) => {
    const { api } = await open(page, '/manifests', {
      manifests: [manifest(), manifest({ id: IDS.run, code: 'ACC-MF-K7M4PX', stops: [] })],
      pageSize: 1,
    });
    await expect(page.getByText(/Listed oldest first, as the server returns them/)).toBeVisible();
    // The one control that is a menu is the state filter, and it asks for no state until one is chosen.
    await expect(page.getByRole('combobox')).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: 'State' })).toHaveValue('');

    await page.getByRole('button', { name: /Next page/ }).click();
    await expect(page.getByRole('link', { name: 'ACC-MF-K7M4PX' }).first()).toBeVisible();
    expect(api.calls.filter((call) => call.search.includes('page_token=1'))).toHaveLength(1);
    expect(api.unexpected).toEqual([]);
  });
});

test.describe('building a manifest', () => {
  // Break caught: a pool whose rows are chosen twice (the table and the cards), or whose second drawing is exposed beside the first.
  test('exposes one drawing of the pool at a time, and the same choice in either', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/manifests/new');
    await expect(poolTable(page)).toBeVisible();
    await expect(poolCards(page)).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' })).toHaveCount(1);

    await page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' }).check();
    await page.setViewportSize(NARROW);
    await expect(poolCards(page)).toBeVisible();
    await expect(poolTable(page)).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' })).toHaveCount(1);
  });

  test('keeps the choice across the pages of the pool', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/manifests/new', { pageSize: 2 });
    await page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' }).check();
    await page.getByRole('button', { name: /Next page/ }).click();
    await page.getByRole('checkbox', { name: 'Choose ACC-PR-ZYU26H' }).check();
    await page.getByRole('button', { name: /Previous page/ }).click();

    await expect(page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' })).toBeChecked();
    await expect(page.getByText(/2 requests chosen/)).toBeVisible();
    const pool = api.calls.filter((call) => call.path === '/api/v1/pickup-requests');
    expect(
      pool.every(
        (call) =>
          call.search.includes('state=CONFIRMED') && call.search.includes('manifested=false'),
      ),
    ).toBe(true);
  });

  test('creates the manifest from the pool, with the reason of the overdue request, and lands on it', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(page, '/manifests/new');
    await page.getByRole('checkbox', { name: 'Choose ACC-PR-9WXH4T' }).check();
    await page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' }).check();
    await typeDate(page, '04112026');
    await expect(page.getByRole('heading', { level: 3, name: 'ACC-PR-9WXH4T' })).toBeVisible();
    await page
      .getByRole('combobox', { name: /Why it is carried over/ })
      .selectOption('RUN_WAS_FULL');

    await page.getByRole('button', { name: 'Create the manifest' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-MF-N7R4PX' })).toBeFocused();
    await expect(page.getByText(/The manifest is made\./)).toBeVisible();
    const create = callTo(api, 'POST', '/pickup-manifests')[0];
    expect(create?.idempotencyKey).toMatch(KEY);
    expect(create?.ifMatch).toBeUndefined();
    expect(create?.body).toEqual({
      pickup_request_ids: [REQUESTS.two.id, REQUESTS.one.id],
      service_date: '2026-11-04',
      carryover: [{ pickup_request_id: REQUESTS.two.id, reason_code: 'RUN_WAS_FULL' }],
    });
    expect(api.unexpected).toEqual([]);
    expect(watch.problems.filter((problem) => !problem.includes('HTTP 4'))).toEqual([]);
  });

  test('tells a request taken meanwhile at its place, with nothing made', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/manifests/new');
    await page.getByRole('checkbox', { name: 'Choose ACC-PR-7KQ2MZ' }).check();
    await page.getByRole('checkbox', { name: 'Choose ACC-PR-ZYU26H' }).check();
    await typeDate(page, '04112026');
    for (const row of api.world.pool) {
      if (row.code === 'ACC-PR-ZYU26H') row.manifested = true;
    }

    await page.getByRole('button', { name: 'Create the manifest' }).click();

    await expect(page.getByText('Already on a manifest.')).toBeVisible();
    await expect(page.getByText(/A request you chose is already on a manifest/)).toBeVisible();
    expect(api.world.manifests).toHaveLength(1);
  });
});

test.describe('ordering, assigning and dispatching a run', () => {
  // Break caught: a reordering control that works with a pointer alone, or whose focus is lost with every move.
  test('moves a stop by the keyboard alone, keeping focus on it, and saves the whole order', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, DRAFT);
    await page.getByRole('button', { name: 'Change the order' }).click();

    const down = page.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' });
    await down.focus();
    await page.keyboard.press('Enter');
    await expect(down).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ up' })).toBeFocused();
    await expect(
      page.getByRole('status').filter({ hasText: 'moved to place 3 of 3' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Save this order' }).click();
    await expect(page.getByText('The order of the stops is saved.')).toBeVisible();
    const put = callTo(api, 'PUT', '/stops')[0];
    expect(put?.ifMatch).toBe('"m1"');
    expect(put?.idempotencyKey).toMatch(KEY);
    expect(put?.body).toEqual({
      ordered_stop_ids: [
        'a1000000-0000-4000-8000-000000000002',
        'a1000000-0000-4000-8000-000000000003',
        'a1000000-0000-4000-8000-000000000001',
      ],
    });
    expect(api.unexpected).toEqual([]);
  });

  test('assigns a rider and dispatches as two acts, each with its own dialog and the headers its operation declares', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(page, DRAFT);

    await page.getByRole('button', { name: 'Assign a rider' }).click();
    const assign = page.getByRole('alertdialog', { name: 'Assign this rider?' });
    await assign.getByRole('button', { name: 'Choose: Kwame Mensah' }).click();
    await assign.getByRole('button', { name: 'Assign the rider' }).click();
    await expect(
      page.getByText(/A rider is assigned\. The manifest is still a draft/),
    ).toBeVisible();
    expect(callTo(api, 'POST', '/dispatch')).toHaveLength(0);

    await page.getByRole('button', { name: 'Dispatch the manifest' }).first().click();
    const dispatch = page.getByRole('alertdialog', { name: 'Dispatch this manifest?' });
    await dispatch.getByRole('button', { name: 'Dispatch the manifest' }).click();
    await expect(page.getByText(/The manifest is dispatched/)).toBeVisible();
    await expect(page.getByText('Dispatched', { exact: true }).first()).toBeVisible();

    const assigned = callTo(api, 'POST', '/assign-rider')[0];
    expect(assigned?.ifMatch).toBe('"m1"');
    expect(assigned?.idempotencyKey).toBeUndefined();
    expect(assigned?.body).toEqual({ rider_id: IDS.riderA });
    const dispatched = callTo(api, 'POST', '/dispatch')[0];
    expect(dispatched?.ifMatch).toBe('"m2"');
    expect(dispatched?.idempotencyKey).toBeUndefined();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('tells a dispatch refused for a day that has passed, in words, with the manifest still a draft', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, DRAFT, {
      manifests: [manifest({ service_date: '2026-11-02', riderId: IDS.riderA })],
    });
    await page.getByRole('button', { name: 'Dispatch the manifest' }).first().click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Dispatch the manifest' })
      .click();

    await expect(
      page.getByText(/day of this run has passed, so it is never sent out/),
    ).toBeVisible();
    expect(api.world.manifests[0]?.state).toBe('DRAFT');
  });

  test('cancels a draft with a note, under a key and the version, and says its requests return to the pool', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, DRAFT);
    await page.getByRole('button', { name: 'Cancel the manifest' }).first().click();
    const dialog = page.getByRole('alertdialog', { name: 'Cancel this manifest?' });
    await dialog.getByRole('button', { name: 'Cancel the manifest' }).click();
    await expect(dialog.getByText('Write a note saying why.')).toBeVisible();

    await dialog.getByRole('textbox', { name: /Why it is cancelled/ }).fill('Rider unwell');
    await dialog.getByRole('button', { name: 'Cancel the manifest' }).click();

    await expect(page.getByText(/The manifest is cancelled\./)).toBeVisible();
    const cancel = callTo(api, 'POST', '/cancel')[0];
    expect(cancel?.ifMatch).toBe('"m1"');
    expect(cancel?.idempotencyKey).toMatch(KEY);
    expect(cancel?.body).toEqual({ note: 'Rider unwell' });
    expect(api.world.pool.every((row) => !row.manifested)).toBe(true);
  });

  // Break caught: a dialog that lets Tab out to the page behind it.
  test('keeps Tab inside the dialog of an act, and Escape closes it', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(page, DRAFT);
    await page.getByRole('button', { name: 'Dispatch the manifest' }).first().click();
    const dialog = page.getByRole('alertdialog', { name: 'Dispatch this manifest?' });
    await expect(dialog).toBeVisible();

    // Past the dialog's last control a browser may hand Tab to its own interface (the document has focus then); what must never happen is focus
    // on the page behind the dialog.
    for (let presses = 0; presses < 6; presses += 1) {
      await page.keyboard.press('Tab');
      const place = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || active === document.body) return 'document';
        return active.closest('dialog') === null ? 'outside' : 'dialog';
      });
      expect(place).not.toBe('outside');
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('skipping a stop', () => {
  async function skipPage(page: Page, setup: Partial<World> = {}) {
    await page.setViewportSize(WIDE);
    const opened = await open(page, RUN, runWorld(setup));
    await page.getByRole('link', { name: 'Skip stop 1, ACC-PR-7KQ2MZ' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Skip a stop' })).toBeFocused();
    return opened;
  }

  test('skips a stop with a reason that wants a note, says the vendor is told, and comes back to the run', async ({
    page,
  }) => {
    const { api, watch } = await skipPage(page);
    await expect(page.getByText(/The vendor is always told/)).toBeVisible();
    await page.getByRole('combobox', { name: /Reason/ }).selectOption('LOCATION_INACCESSIBLE');
    await page.getByRole('button', { name: 'Skip this stop' }).click();
    await expect(page.getByText('This reason needs a note.')).toBeVisible();
    await page.getByRole('textbox', { name: /Note/ }).fill('Gate locked');
    await page.getByRole('button', { name: 'Skip this stop' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Skip stop 1, ACC-PR-7KQ2MZ?' });
    await expect(dialog.getByText(/The vendor is notified/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Skip the stop' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'ACC-MF-K7M4PX' })).toBeVisible();
    await expect(page.getByText(/The stop is skipped and the vendor is told\./)).toBeVisible();
    const skip = acts(api).find((call) => call.path.endsWith('/skip'));
    expect(skip?.ifMatch).toBe('"s1"');
    expect(skip?.idempotencyKey).toMatch(KEY);
    expect(skip?.body).toEqual({ reason_code: 'LOCATION_INACCESSIBLE', note: 'Gate locked' });
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('shows the run completed by the system once its last stop is skipped, read again from the server', async ({
    page,
  }) => {
    const { api } = await open(
      page,
      RUN,
      runWorld({
        manifests: [
          manifest({
            id: IDS.run,
            code: 'ACC-MF-K7M4PX',
            state: 'IN_PROGRESS',
            service_date: '2026-11-03',
            riderId: IDS.riderA,
            stops: [
              stop({
                id: 'b1000000-0000-4000-8000-000000000001',
                requestId: REQUESTS.one.id,
                sequence: 1,
              }),
            ],
          }),
        ],
      }),
    );
    await page.getByRole('link', { name: 'Skip stop 1, ACC-PR-7KQ2MZ' }).click();
    await page.getByRole('combobox', { name: /Reason/ }).selectOption('RUN_CUT_SHORT');
    await page.getByRole('button', { name: 'Skip this stop' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Skip the stop' }).click();

    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Skipped by Ops: Demo: the run was cut short.')).toBeVisible();
    expect(api.world.manifests[0]?.state).toBe('COMPLETED');
  });

  test('reads the stop and the run again from the reload after a conflict', async ({ page }) => {
    const { api } = await skipPage(page);
    await page.getByRole('combobox', { name: /Reason/ }).selectOption('RUN_CUT_SHORT');
    await page.getByRole('button', { name: 'Skip this stop' }).click();
    for (const each of api.world.manifests[0]?.stops ?? []) each.version = 5;
    await page.getByRole('alertdialog').getByRole('button', { name: 'Skip the stop' }).click();

    await expect(page.getByText(/can no longer be skipped/)).toBeVisible();
    await page.getByRole('button', { name: 'Reload the record' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(
      api.calls.filter((call) => call.method === 'GET' && call.path.includes('/pickup-stops/'))
        .length,
    ).toBeGreaterThanOrEqual(2);
  });
});

test.describe('the custody handover (written from the contract; answered by the stand-in)', () => {
  // Break caught: a count of the hub's drawn from an answer that should never carry one, or the number taken drawn as one.
  test('opens a handover to the hub, accepts it with what was taken, and never draws a count of the hub’s', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(page, RUN, runWorld());
    await page.getByRole('button', { name: 'Open a custody handover' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Open a custody handover?' });
    await dialog.getByRole('radio', { name: /To the hub/ }).check();
    await dialog.getByRole('textbox', { name: /Why custody/ }).fill('Unsafe roadside');
    await dialog.getByRole('button', { name: 'Open the handover' }).click();

    await expect(page.getByText('Waiting for the receiver')).toBeVisible();
    await expect(page.getByText('the hub: Accra Central')).toBeVisible();
    const opened = callTo(api, 'POST', '/custody-handover')[0];
    expect(opened?.ifMatch).toBe('"m1"');
    expect(opened?.idempotencyKey).toBeUndefined();
    expect(opened?.body).toEqual({ to_hub_id: IDS.hub, note: 'Unsafe roadside' });

    await page.getByRole('button', { name: 'Accept the handover' }).click();
    const accept = page.getByRole('alertdialog', { name: 'Accept this handover for the hub?' });
    await accept.getByRole('textbox', { name: /Parcels taken/ }).fill('7');
    await accept.getByRole('button', { name: 'Accept the handover' }).click();

    await expect(
      page.getByText(/You recorded 7 parcels taken: a record of custody, not the hub’s count\./),
    ).toBeVisible();
    const accepted = callTo(api, 'POST', '/custody-handover/accept')[0];
    expect(accepted?.ifMatch).toBe('"h1"');
    expect(accepted?.idempotencyKey).toMatch(KEY);
    expect(accepted?.body).toEqual({ parcel_count_taken: 7 });
    expect(await page.locator('body').innerText()).not.toContain(String(PLANTED_HUB_COUNT));
    expect(await page.content()).not.toContain(String(PLANTED_HUB_COUNT));
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('marks a handover failed with a note, and custody is where it was', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(
      page,
      RUN,
      runWorld({ handover: { to: { hub: true }, state: 'PENDING', parcels: null, version: 1 } }),
    );
    await page.getByRole('button', { name: 'Mark the handover as failed' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Mark this handover as failed?' });
    await dialog
      .getByRole('textbox', { name: /Why it did not happen/ })
      .fill('Receiver never came');
    await dialog.getByRole('button', { name: 'Mark the handover as failed' }).click();

    await expect(
      page.getByText(/The handover is marked as failed\. Custody is where it was\./),
    ).toBeVisible();
    const failed = callTo(api, 'POST', '/custody-handover/fail')[0];
    expect(failed?.ifMatch).toBe('"h1"');
    expect(failed?.body).toEqual({ note: 'Receiver never came' });
    await expect(page.getByRole('button', { name: 'Open a custody handover' })).toBeVisible();
  });

  test('offers Ops no acceptance of a handover to a rider', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(
      page,
      RUN,
      runWorld({
        handover: { to: { rider: IDS.riderB }, state: 'PENDING', parcels: null, version: 1 },
      }),
    );

    await expect(page.getByText('Esi Owusu')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept the handover' })).toHaveCount(0);
    await expect(page.getByText(/accepted by that rider, in the Rider app/)).toBeVisible();
  });
});

/** Four manifests of three states on three days, so that each filter, and both, tell the rows apart. Their stops are none, so that a run's page reads no request. */
const filterWorld = (extra: Partial<World> = {}): Partial<World> => ({
  manifests: [
    manifest({
      id: 'a1000000-0000-4000-8000-0000000000b1',
      code: 'ACC-MF-Q92422',
      state: 'DRAFT',
      service_date: '2026-11-04',
      stops: [],
    }),
    manifest({
      id: 'a1000000-0000-4000-8000-0000000000b2',
      code: 'ACC-MF-K7M4PX',
      state: 'IN_PROGRESS',
      service_date: '2026-11-03',
      riderId: IDS.riderA,
      stops: [],
    }),
    manifest({
      id: 'a1000000-0000-4000-8000-0000000000b3',
      code: 'ACC-MF-D3F5RT',
      state: 'DRAFT',
      service_date: '2026-11-05',
      stops: [],
    }),
    manifest({
      id: 'a1000000-0000-4000-8000-0000000000b4',
      code: 'ACC-MF-C4P6WQ',
      state: 'COMPLETED',
      service_date: '2026-11-03',
      riderId: IDS.riderA,
      stops: [],
    }),
  ],
  ...extra,
});

const ALL_CODES = ['ACC-MF-Q92422', 'ACC-MF-K7M4PX', 'ACC-MF-D3F5RT', 'ACC-MF-C4P6WQ'];

/** The codes of the manifests the list draws as a table, in the order it draws them. */
const listedCodes = async (page: Page): Promise<string[]> =>
  (
    await page
      .getByRole('table', { name: 'Manifests' })
      .getByRole('rowheader')
      .evaluateAll((cells) => cells.map((cell) => cell.querySelector('a')?.textContent ?? ''))
  ).filter((code) => code !== '');

/** Every request the browser made for the list, and the answer the stand-in (which keeps the contract's rules) gives each: none may be a refusal. */
const listRequests = (api: ManifestApi) =>
  api.calls.filter((call) => call.method === 'GET' && call.path === '/api/v1/pickup-manifests');

test.describe('filtering the list', () => {
  async function typeFilterDate(page: Page, digits: string): Promise<void> {
    const day = page.getByRole('group', { name: 'Service date' }).getByRole('spinbutton').first();
    await day.click();
    await page.keyboard.type(digits);
  }

  // Break caught: a filter that narrows in the browser (or not at all), a change that does not reach the address, a state of another case sent.
  test('narrows by state and by day on the server, keeps the filters in the address, and clears each', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(page, '/manifests', filterWorld());
    expect(await listedCodes(page)).toEqual(ALL_CODES);

    await page.getByRole('combobox', { name: 'State' }).selectOption('DRAFT');
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-Q92422', 'ACC-MF-D3F5RT']);
    expect(new URL(page.url()).search).toBe('?state=DRAFT');
    expect(listRequests(api).at(-1)?.search).toBe('?state=DRAFT');

    await typeFilterDate(page, '05112026');
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-D3F5RT']);
    expect(new URL(page.url()).search).toBe('?state=DRAFT&date=2026-11-05');
    expect(listRequests(api).at(-1)?.search).toBe('?state=DRAFT&service_date=2026-11-05');

    await page.getByRole('button', { name: 'Every service date' }).click();
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-Q92422', 'ACC-MF-D3F5RT']);
    expect(new URL(page.url()).search).toBe('?state=DRAFT');

    await page.getByRole('combobox', { name: 'State' }).selectOption('');
    await expect.poll(() => listedCodes(page)).toEqual(ALL_CODES);
    expect(new URL(page.url()).search).toBe('');
    expect(listRequests(api).at(-1)?.search).toBe('');

    // Not one request of all that was a refusal, and no parameter was sent that is empty or repeated.
    expect(watch.problems).toEqual([]);
    for (const call of listRequests(api)) {
      const query = new URLSearchParams(call.search);
      const names = [...query.keys()];
      expect(new Set(names).size).toBe(names.length);
      for (const [, value] of query) expect(value).not.toBe('');
    }
    expect(api.unexpected).toEqual([]);
  });

  test('takes an address with a made-up filter for no filter, and asks for none', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(
      page,
      '/manifests?state=draft&date=2026-02-30',
      filterWorld(),
    );

    expect(await listedCodes(page)).toEqual(ALL_CODES);
    await expect(page.getByRole('combobox', { name: 'State' })).toHaveValue('');
    expect(listRequests(api).map((call) => call.search)).toEqual(['']);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a page token sent under a filter it was not made with.
  test('starts again at the first page when a filter changes', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/manifests', filterWorld({ pageSize: 2 }));
    await page.getByRole('button', { name: /Next page/ }).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    expect(listRequests(api).at(-1)?.search).toBe('?page_token=2');

    await page.getByRole('combobox', { name: 'State' }).selectOption('DRAFT');

    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-Q92422', 'ACC-MF-D3F5RT']);
    await expect(page.getByText(/on page 2/)).toHaveCount(0);
    expect(listRequests(api).at(-1)?.search).toBe('?state=DRAFT');
  });

  // Break caught (ops-portal.md section 7): "no manifests" and "filtered to nothing" told as one.
  test('tells a filter that hides everything from a list with nothing in it, and clears from the keyboard', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/manifests?state=COMPLETED&date=2026-11-05', filterWorld());

    await expect(page.getByRole('heading', { name: 'No manifests match' })).toBeVisible();
    await expect(
      page.getByText(/Nothing fits the state Completed and the service date Thu 5 Nov 2026\./),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No manifests yet' })).toHaveCount(0);

    const clear = page.getByRole('button', { name: 'Show every manifest' });
    await clear.focus();
    await page.keyboard.press('Enter');

    await expect.poll(() => listedCodes(page)).toEqual(ALL_CODES);
    expect(new URL(page.url()).search).toBe('');
    expect(listRequests(api).at(-1)?.search).toBe('');
  });

  test('tells a list with nothing in it as that, and not as a filter', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/manifests', { manifests: [] });

    await expect(page.getByRole('heading', { name: 'No manifests yet' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No manifests match' })).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
  });

  // Break caught: a read that failed told as "nothing matches".
  test('keeps a failed read a failure, with the filters in place', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/manifests?state=DRAFT', filterWorld());
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-Q92422', 'ACC-MF-D3F5RT']);
    // The server then fails the next read (a route added later is asked first).
    await page.route(/\/api\/v1\/pickup-manifests(\?.*)?$/, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        json: {
          code: 'INTERNAL_ERROR',
          message: 'Diagnostic text that must never reach a screen.',
          request_id: 'req-x',
        },
      }),
    );
    await page.getByRole('button', { name: 'Refresh page' }).click();

    await expect(page.getByText('The manifests could not be loaded.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No manifests match' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'State' })).toHaveValue('DRAFT');
  });

  // Break caught: a reload that loses the filters, or a way back from a manifest that opens the plain list.
  test('keeps the filters on a reload, on the way back from a manifest, and on the browser’s Back', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api, watch } = await open(
      page,
      '/manifests?state=DRAFT&date=2026-11-05',
      filterWorld(),
    );
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-D3F5RT']);

    await page.reload();
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-D3F5RT']);
    await expect(page.getByRole('combobox', { name: 'State' })).toHaveValue('DRAFT');

    await page.getByRole('link', { name: 'ACC-MF-D3F5RT' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-MF-D3F5RT' })).toBeFocused();
    await page.getByRole('link', { name: 'Back to manifests' }).click();
    await expect(page.getByRole('link', { name: 'ACC-MF-D3F5RT' })).toBeFocused();
    expect(new URL(page.url()).search).toBe('?state=DRAFT&date=2026-11-05');
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-D3F5RT']);
    expect(listRequests(api).at(-1)?.search).toBe('?state=DRAFT&service_date=2026-11-05');

    await page.getByRole('link', { name: 'ACC-MF-D3F5RT' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'ACC-MF-D3F5RT' })).toBeVisible();
    await page.goBack();
    expect(new URL(page.url()).search).toBe('?state=DRAFT&date=2026-11-05');
    await expect.poll(() => listedCodes(page)).toEqual(['ACC-MF-D3F5RT']);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a manifest reached by a typed address given a filter nobody chose.
  test('gives the plain list to a manifest opened by its address', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await open(page, '/manifests/a1000000-0000-4000-8000-0000000000b1', filterWorld());

    await expect(page.getByRole('link', { name: 'Back to manifests' })).toHaveAttribute(
      'href',
      '/manifests',
    );
  });
});

/**
 * Coming back to the manifest list from a manifest (COMPONENT_PATTERNS section 22f, the pickup queue's pattern), in a real browser: what only
 * layout, focus and a real history can show. Twelve draft manifests with codes of their own, read five at a time by the stand-in's offset tokens,
 * so that a page after the first has manifests of its own.
 */
const LETTERS = 'ABCDEFGHJKMN';
const codeOf = (index: number): string =>
  `ACC-MF-${LETTERS.charAt(index)}${LETTERS.charAt(index)}22QX`;
const MANY = Array.from({ length: 12 }, (_, index) =>
  manifest({
    id: `a2000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    code: codeOf(index),
    state: 'DRAFT',
    service_date: '2026-11-04',
    stops: [],
  }),
);
const FIVE_AT_A_TIME = { manifests: MANY, pageSize: 5 } as const;
const LIST = /\/api\/v1\/pickup-manifests(\?.*)?$/;

const failing = (status: number, code: string) => (route: Route) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      code,
      message: 'Diagnostic text that must never reach a screen.',
      request_id: 'req-browser-manifests',
    }),
  });

/** Holds every read of the list from now on until the returned function is called; the stand-in answers it then. */
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

test.describe('the manifests: coming back from a manifest', () => {
  const opened = codeOf(7); // on the second page of five

  /** The officer pages to the second page, and opens a manifest on it. */
  async function toTheManifest(page: Page, size: { width: number; height: number } = WIDE) {
    await page.setViewportSize(size);
    const view = await open(page, '/manifests?state=DRAFT', FIVE_AT_A_TIME);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await page.getByRole('link', { name: opened }).click();
    await expect(page.getByRole('heading', { level: 1, name: opened })).toBeVisible();
    return view;
  }

  const backLink = (page: Page) => page.getByRole('link', { name: 'Back to manifests' });

  /** Where the officer should be: the page they left, read again, with focus on the manifest they opened. */
  async function expectTheOfficerBack(page: Page, api: ManifestApi) {
    await expect(page).toHaveURL('/manifests?state=DRAFT');
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await expect(page.getByRole('link', { name: opened })).toBeFocused();
    expect(listRequests(api).at(-1)?.search).toBe('?state=DRAFT&page_token=5');
    // The cursor is in no storage, and in no address.
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(page.url()).not.toContain('page_token');
  }

  for (const [shown, size] of [
    ['a table', WIDE],
    ['cards', NARROW],
  ] as const) {
    // Break caught: a place not left, not given back, or given back without a fresh read of the page.
    test(`the link back returns to the page the officer left, read again, with focus on the manifest they opened, beside ${shown}`, async ({
      page,
    }) => {
      const { api } = await toTheManifest(page, size);
      const reads = listRequests(api).length;

      await backLink(page).click();

      await expectTheOfficerBack(page, api);
      expect(listRequests(api)).toHaveLength(reads + 1);
    });

    test(`the browser’s Back returns to the same page, beside ${shown}`, async ({ page }) => {
      const { api } = await toTheManifest(page, size);

      await page.goBack();

      await expectTheOfficerBack(page, api);
    });
  }

  // Break caught: a place that outlives the page, or one kept where a reload, the menu or an address could find it.
  test('starts at the first page after a reload, from the menu and from a typed address', async ({
    page,
  }) => {
    await toTheManifest(page);
    await backLink(page).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();

    await page.reload();
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByRole('link', { name: opened }).click();
    await expect(page.getByRole('heading', { level: 1, name: opened })).toBeVisible();
    await page.getByRole('link', { name: 'Manifests' }).first().click();
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.getByRole('link', { name: opened }).click();
    await expect(page.getByRole('heading', { level: 1, name: opened })).toBeVisible();
    await page.goto('/manifests?state=DRAFT');
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
    await expect(page.getByText(/on page 2/)).toHaveCount(0);
  });

  // Break caught: the position taken from the browser's own restoration, which does not run for a link, so that the link back would open at the top.
  for (const [how, back] of [
    ['the link back', (page: Page) => backLink(page).click()],
    ['the browser’s Back', (page: Page) => page.goBack()],
  ] as const) {
    test(`gives the position on the page back, with the manifest in view, by ${how}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 500 });
      await open(page, '/manifests', { manifests: MANY, pageSize: 12 });
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

  // Break caught: the not-found page given no memory of the manifest it was opened for, so that its link back lost the page and the filters.
  test('keeps the way back to the page the officer left through a manifest that is not there', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/manifests?state=DRAFT', FIVE_AT_A_TIME);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    // The list still holds the manifest; by the time it is opened the server says it is not there.
    await page.route(`**/api/v1/pickup-manifests/${MANY[7]?.id ?? ''}`, failing(404, 'NOT_FOUND'));

    await page.getByRole('link', { name: opened }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Manifest not found' })).toBeVisible();
    await expect(backLink(page)).toHaveAttribute('href', '/manifests?state=DRAFT');
    const reads = listRequests(api).length;
    await backLink(page).click();

    await expectTheOfficerBack(page, api);
    expect(listRequests(api)).toHaveLength(reads + 1);
  });

  test('gives the plain list behind the link back of a manifest that is not there when it was reached directly', async ({
    page,
  }) => {
    // An identifier that is a manifest's in form, and that the stand-in does not hold.
    await open(page, '/manifests/a2000000-0000-4000-8000-0000000000ff', FIVE_AT_A_TIME);

    await expect(page.getByRole('heading', { level: 1, name: 'Manifest not found' })).toBeVisible();
    await expect(backLink(page)).toHaveAttribute('href', '/manifests');
  });

  // Break caught: a refusal page with no way back, or one that forgot where the officer came from and gave the plain list.
  test('keeps the way back to the page the officer left through a manifest outside the officer’s hubs', async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    const { api } = await open(page, '/manifests?state=DRAFT', FIVE_AT_A_TIME);
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await page.route(
      `**/api/v1/pickup-manifests/${MANY[7]?.id ?? ''}`,
      failing(403, 'HUB_SCOPE_VIOLATION'),
    );

    await page.getByRole('link', { name: opened }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'This is outside your hubs' }),
    ).toBeVisible();
    await expect(backLink(page)).toHaveAttribute('href', '/manifests?state=DRAFT');
    const reads = listRequests(api).length;
    await backLink(page).click();

    await expectTheOfficerBack(page, api);
    expect(listRequests(api)).toHaveLength(reads + 1);
  });

  test('gives focus to the results when the manifest is no longer on the page', async ({
    page,
  }) => {
    const { api } = await toTheManifest(page);
    api.world.manifests = api.world.manifests.filter((row) => row.code !== opened);

    await backLink(page).click();

    await expect(page.locator('.ui-queue-table__results')).toBeFocused();
    await expect(page.getByText(/on page 2/)).toBeVisible();
    await expect(page.getByRole('link', { name: opened })).toHaveCount(0);
  });

  // Break caught: focus pulled back to the manifest from the control the officer had already moved to while the page was being read.
  test('leaves focus where the officer put it while the page was being read', async ({ page }) => {
    await toTheManifest(page);
    const release = await holdReads(page);

    await backLink(page).click();
    await expect(page.getByText('Loading the manifests…')).toBeVisible();
    await page.getByRole('combobox', { name: 'State' }).focus();
    release();

    await expect(page.getByRole('link', { name: opened })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'State' })).toBeFocused();
  });

  test('says there are no manifests on a later page that has emptied, and goes to the first only when asked', async ({
    page,
  }) => {
    const { api } = await toTheManifest(page);
    api.world.manifests = api.world.manifests.slice(0, 5);
    const reads = listRequests(api).length;

    await backLink(page).click();

    await expect(page.getByRole('heading', { name: 'No manifests on this page' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No manifests yet' })).toHaveCount(0);
    expect(listRequests(api)).toHaveLength(reads + 1);

    await page.getByRole('button', { name: 'Back to first page' }).click();

    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
    await expect(page.locator('.ui-queue-table__results')).toBeFocused();
    expect(listRequests(api).at(-1)?.search).toBe('?state=DRAFT');
  });

  test('says a page the server will not open could not be opened, with the first page as the way out', async ({
    page,
  }) => {
    await toTheManifest(page);
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

    await backLink(page).click();

    await expect(page.getByText(/That page of the manifests could not be opened/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page).toHaveURL('/manifests?state=DRAFT');
    await expect(page.getByRole('combobox', { name: 'State' })).toHaveValue('DRAFT');
    await expect(page.locator('body')).not.toContainText('Diagnostic text');

    await page.getByRole('button', { name: 'Back to first page' }).click();
    await expect(page.getByRole('link', { name: codeOf(0) })).toBeVisible();
  });
});

const SCREENS: { name: string; reach: (page: Page) => Promise<void> }[] = [
  {
    name: 'the list under a filter',
    reach: async (page) => {
      await open(page, '/manifests?state=DRAFT&date=2026-11-05', filterWorld());
      await expect(page.getByRole('link', { name: 'ACC-MF-D3F5RT' }).first()).toBeVisible();
    },
  },
  {
    name: 'the list that a filter empties',
    reach: async (page) => {
      await open(page, '/manifests?state=COMPLETED&date=2026-11-05', filterWorld());
      await expect(page.getByRole('heading', { name: 'No manifests match' })).toBeVisible();
    },
  },
  {
    name: 'the list',
    reach: async (page) => {
      await open(page, '/manifests', {
        manifests: [
          manifest(),
          manifest({
            id: IDS.run,
            code: 'ACC-MF-K7M4PX',
            state: 'IN_PROGRESS',
            riderId: IDS.riderA,
            stops: [],
          }),
        ],
      });
      await expect(page.getByRole('link', { name: 'ACC-MF-Q92422' }).first()).toBeVisible();
    },
  },
  {
    name: 'the builder',
    reach: async (page) => {
      await open(page, '/manifests/new');
      await page.getByRole('checkbox', { name: 'Choose ACC-PR-9WXH4T' }).first().check();
      await typeDate(page, '04112026');
      await expect(page.getByRole('heading', { level: 3, name: 'ACC-PR-9WXH4T' })).toBeVisible();
    },
  },
  {
    name: 'a draft manifest',
    reach: async (page) => {
      await open(page, DRAFT);
      await expect(page.getByRole('table', { name: 'Stops' })).toBeVisible();
      await expect(page.getByText('Demo Fabrics Ltd')).toBeVisible();
    },
  },
  {
    name: 'a draft manifest being ordered',
    reach: async (page) => {
      await open(page, DRAFT);
      await page.getByRole('button', { name: 'Change the order' }).click();
      await expect(page.getByRole('list', { name: 'Stops, in order' })).toBeVisible();
    },
  },
  {
    name: 'a run in progress with a handover waiting',
    reach: async (page) => {
      await open(
        page,
        RUN,
        runWorld({ handover: { to: { hub: true }, state: 'PENDING', parcels: null, version: 1 } }),
      );
      await expect(page.getByText('Waiting for the receiver')).toBeVisible();
    },
  },
  {
    name: 'the skip page',
    reach: async (page) => {
      await open(page, RUN, runWorld());
      await page.getByRole('link', { name: 'Skip stop 1, ACC-PR-7KQ2MZ' }).click();
      await expect(page.getByRole('combobox', { name: /Reason/ })).toBeVisible();
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
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      });
    }
  }

  // Break caught: a dialog with a violation of its own (a name, a contrast, a target) that the page behind it hides.
  for (const { width, height } of VIEWPORTS) {
    test(`the dialogs of the acts have no WCAG 2.2 A or AA violation at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await open(page, DRAFT);
      await page.getByRole('button', { name: 'Assign a rider' }).click();
      const dialog = page.getByRole('alertdialog', { name: 'Assign this rider?' });
      await expect(dialog.getByText('Kwame Mensah')).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Cancel the manifest' }).first().click();
      await expect(page.getByRole('alertdialog', { name: 'Cancel this manifest?' })).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('enlarged text, forced colours and reduced motion', () => {
  // Break caught (WCAG 1.4.4): sizes in pixels, so enlarged text does not grow the screens, or breaks them.
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 640, height: 800 },
  ]) {
    for (const screen of SCREENS.filter((candidate) => candidate.name !== 'the list')) {
      test(`${screen.name} at 200% text keeps its layout at ${String(width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await screen.reach(page);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });

        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        expect(await clippedControls(page)).toEqual([]);
      });
    }
  }

  // Break caught: a focus ring that disappears under forced colours, on the control that has to be found by the keyboard.
  test('under forced colours the move buttons and the choices keep their focus ring', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'webkit', 'Playwright cannot emulate forced colours in WebKit.');
    await page.emulateMedia({ forcedColors: 'active' });
    await page.setViewportSize(WIDE);
    await open(page, DRAFT);
    await page.getByRole('button', { name: 'Change the order' }).click();
    const down = page.getByRole('button', { name: 'Move ACC-PR-7KQ2MZ down' });
    await down.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(down).toBeFocused();

    expect(await down.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid');
  });

  test('with reduced motion nothing moves when a dialog of an act opens', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, DRAFT);
    await page.getByRole('button', { name: 'Dispatch the manifest' }).first().click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    const running = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.playState === 'running').length,
    );
    expect(running).toBe(0);
  });
});
