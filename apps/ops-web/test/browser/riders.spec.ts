import { expect, test, type Page } from '@playwright/test';

import { decodePainted } from './support/painted';
import { reachableNames, watchPage, wcagViolations } from './support/page';
import { expectShellAround, signOutFromMenu } from './support/shell';
import {
  CODE_FORMS,
  CODES,
  IDS,
  PLANTED,
  rider,
  stubRiderApi,
  world,
  type RiderApi,
  type World,
} from './support/rider-api';

/**
 * The four rider screens (S0.60) in a real browser: the roster, one rider, the first binding of a device and the page that revokes and
 * replaces it. What jsdom cannot show is here: the enrolment code **as the browser painted it**, decoded by an independent decoder from a
 * screenshot, and every place the code could be left in a real page (the text, an attribute, a storage, the address, the title); a document that
 * is left and restored by the browser's history; the clock running past the code's end; the native modal dialog of the report of a loss (the page
 * behind it inert, Tab kept inside it, focus given back); the exact headers a real browser sends; times in Accra whatever the machine's zone;
 * and every screen with axe at the verified widths.
 *
 * The same file runs against the production build and against the development server (strict mode runs every effect twice). The API is a small
 * stateful stand-in with a PIN hash, a key and an attestation planted in answers that never carry them, so that a screen which could display one
 * would. The pages hold an enrolment code, so these tests turn tracing, screenshots and video off for their own contexts (playwright.config.ts).
 */
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

const QR_NAME = 'QR code for the rider’s handset';
const LONG_NAME = 'Kwabena Owusu-Ansah Boateng Mensah-Darko the Third of Kumasi and Accra Central';
const REGISTER = `/admin/riders/${IDS.esi}/device/register`;
const DEVICE = `/admin/riders/${IDS.kwame}/device`;

async function overflowOf(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

/** Opens a path as a person who holds the keys of the stand-in's world would, against a world the test shapes. */
async function open(
  page: Page,
  path: string,
  setup: Partial<World> = {},
): Promise<{ api: RiderApi; watch: ReturnType<typeof watchPage> }> {
  const watch = watchPage(page);
  const api = await stubRiderApi(page, world(setup));
  await page.goto(path);
  return { api, watch };
}

const acts = (api: RiderApi) => api.calls.filter((call) => call.method === 'POST');

const focusedIs = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 1, name })).toBeFocused();

/** What has focus, as a person would say it: in a dialog, `outside` it, or `document` for the body (where a browser's own interface lies). */
const focusPlace = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'document';
    return active.closest('dialog') === null ? 'outside' : 'dialog';
  });

const storedAnything = (page: Page): Promise<unknown> =>
  page.evaluate(async () => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));

/** Every place a form of the code could be on a page, by name: the text, the markup, the address, the title, a field, a storage. */
async function whereIsTheCode(page: Page): Promise<string[]> {
  const found = await page.evaluate(
    async (forms) => {
      const holds = (text: string | null | undefined): boolean =>
        forms.some((form) => (text ?? '').includes(form));
      const places: string[] = [];
      if (holds(document.documentElement.outerHTML)) places.push('markup');
      if (holds(document.body.innerText)) places.push('text');
      if (holds(location.href)) places.push('address');
      if (holds(document.title)) places.push('title');
      if (holds(JSON.stringify(history.state ?? null))) places.push('history state');
      if (holds(document.cookie)) places.push('cookie');
      if (holds(JSON.stringify(Object.entries(localStorage)))) places.push('localStorage');
      if (holds(JSON.stringify(Object.entries(sessionStorage)))) places.push('sessionStorage');
      if (
        [...document.querySelectorAll('input, textarea')].some((field) =>
          holds((field as HTMLInputElement).value),
        )
      ) {
        places.push('field');
      }
      if ((await indexedDB.databases()).length > 0) places.push('indexedDB');
      return places;
    },
    [...CODE_FORMS],
  );
  return found;
}

const qr = (page: Page) => page.getByRole('img', { name: QR_NAME });

/** Asks for the first code of the newcomer and waits for the picture. */
async function showFirstCode(page: Page, setup: Partial<World> = {}): Promise<RiderApi> {
  const { api } = await open(page, REGISTER, setup);
  await page.getByRole('button', { name: 'Show the QR code' }).click();
  await expect(qr(page)).toBeVisible();
  return api;
}

test.describe('moving through the screens', () => {
  // Break caught: a navigation that leaves focus where the link was, so that a screen reader says nothing about the new page.
  test('the menu leads to the roster, the rider and the device page, and each step lands on the new page’s heading', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/');

    const menu = page.getByRole('navigation', { name: 'Primary' });
    await expect(menu.getByRole('link')).toHaveText(['My work', 'Riders']);
    await menu.getByRole('link', { name: 'Riders' }).click();
    await expect(page).toHaveURL('/admin/riders');
    await focusedIs(page, 'Riders');
    await expect(menu.getByRole('link', { name: 'Riders' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await page.getByRole('link', { name: 'Kwame Mensah' }).click();
    await expect(page).toHaveURL(`/admin/riders/${IDS.kwame}`);
    await focusedIs(page, 'Kwame Mensah');
    await page.getByRole('link', { name: 'Revoke or replace the device' }).click();
    await expect(page).toHaveURL(DEVICE);
    await focusedIs(page, 'Revoke or replace a device');
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('the first binding is reached from a rider who has held no device', async ({ page }) => {
    const { api, watch } = await open(page, `/admin/riders/${IDS.esi}`);

    await page.getByRole('link', { name: 'Register the first device' }).click();

    await expect(page).toHaveURL(REGISTER);
    await focusedIs(page, 'Register a first device');
    await expect(page.getByText('For Esi Owusu.')).toBeVisible();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a person who cannot read the roster sees no entry for it, and is told what the account cannot do', async ({
    page,
  }) => {
    await open(page, '/admin/riders', { permissions: ['staff.read'] });

    await expect(
      page.getByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    await expect(
      page.getByText('Your account can’t see riders. Ask an administrator for access.'),
    ).toBeVisible();
    await expect(page.getByRole('main')).not.toContainText('dispatch.read');
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Riders' }),
    ).toHaveCount(0);
  });

  // Break caught: the roster naming something other than identity and readiness, or showing what the answer should never have carried.
  test('the roster shows identity and readiness in words, filters by status and by search, and keeps both in the address', async ({
    page,
  }) => {
    const { api } = await open(page, '/admin/riders');

    const table = page.getByRole('table', { name: 'Riders' });
    await expect(table.getByRole('row')).toHaveCount(4);
    const kwame = table.getByRole('row', { name: /Kwame Mensah/ });
    await expect(kwame).toContainText('+233201234567');
    await expect(kwame).toContainText('Set');
    await expect(kwame).toContainText('One active device');
    await expect(kwame).toContainText('Accra Central');
    await expect(table.getByRole('row', { name: /Esi Owusu/ })).toContainText('No active device');

    // The status is a view of the roster (a tab), and the search a field in the filter row's popover.
    await page.getByRole('tab', { name: 'Suspended' }).click();
    await expect(page).toHaveURL('/admin/riders?status=SUSPENDED');
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table.getByRole('row', { name: /Ama Boateng/ })).toBeVisible();

    await page.getByRole('tab', { name: 'All' }).click();
    // The status is taken off, and the page has drawn the list without it, before the search is typed, as the step above waits for its own: the page
    // builds the new address from what it last drew, so a search made before that (the development server is slow enough for it) keeps the old status.
    await expect(page).toHaveURL('/admin/riders');
    await expect(table.getByRole('row')).toHaveCount(4);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search by name or phone' }).fill('  esi  ');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL('/admin/riders?q=esi');
    await expect(page.getByRole('button', { name: 'Remove filter: Search: esi' })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(2);
    const last = api.calls.filter((call) => call.path === '/api/v1/ops/riders').at(-1);
    expect(new URL(`http://x${last?.search ?? ''}`).searchParams.get('q')).toBe('esi');

    // Nothing of what a server should never send reaches the page.
    expect(await page.content()).not.toContain(PLANTED);
  });

  // The roster is drawn by the queue workspace template: a table with every column where the table's own box has room for them (40rem: at 1280 px with the menu open, and at 768 px),
  // and cards under that, each with every fact of the rider, never both in the page. Nothing a server should never send reaches either.
  for (const size of [
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
  ]) {
    // Break caught: a table squeezed into a room it cannot be read in, a column dropped where nothing else shows it, or a page wider than its window.
    test(`the roster is a table of every column at ${String(size.width)} px, and no cards`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const { api, watch } = await open(page, '/admin/riders');

      const table = page.getByRole('table', { name: 'Riders' });
      await expect(table).toBeVisible();
      await expect(table.getByRole('columnheader')).toHaveText([
        'Rider / phone',
        'Status',
        'PIN',
        'Device',
        'Hub',
      ]);
      await expect(page.getByRole('list', { name: 'Riders' })).toHaveCount(0);
      await expect(table.getByRole('link', { name: 'Kwame Mensah' })).toHaveAttribute(
        'href',
        `/admin/riders/${IDS.kwame}`,
      );
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await page.content()).not.toContain(PLANTED);
      expect(api.unexpected).toEqual([]);
      expect(watch.problems).toEqual([]);
    });
  }

  for (const size of [
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    // Break caught: a fact the table shows and the card forgets, a card with no heading, or a table drawn where the room has none.
    test(`the roster is a card for each rider at ${String(size.width)} px, with every fact, a heading and the link, and no table`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const { api, watch } = await open(page, '/admin/riders');

      const cards = page.getByRole('list', { name: 'Riders' });
      await expect(cards).toBeVisible();
      await expect(page.getByRole('table', { name: 'Riders' })).toHaveCount(0);
      await expect(cards.getByRole('listitem')).toHaveCount(3);
      const card = cards.getByRole('listitem').filter({ hasText: 'Kwame Mensah' });
      await expect(card.getByRole('heading', { level: 2 })).toHaveText('Kwame Mensah');
      await expect(card.getByRole('link', { name: 'Kwame Mensah' })).toHaveAttribute(
        'href',
        `/admin/riders/${IDS.kwame}`,
      );
      for (const fact of ['Active', '+233201234567', 'Set', 'One active device', 'Accra Central']) {
        await expect(card).toContainText(fact);
      }
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await page.content()).not.toContain(PLANTED);
      expect(api.unexpected).toEqual([]);
      expect(watch.problems).toEqual([]);
    });
  }

  test('the roster is paged with the token the server gave, and goes back', async ({ page }) => {
    const { api } = await open(page, '/admin/riders', { pageSize: 2 });
    await expect(page.getByText('Showing 2 riders. More follow on the next page.')).toBeVisible();

    await page.getByRole('button', { name: 'Next page' }).click();

    await expect(page.getByText(/Showing 1 rider on page 2\./)).toBeVisible();
    const tokens = api.calls
      .filter((call) => call.path === '/api/v1/ops/riders')
      .map((call) => new URL(`http://x${call.search}`).searchParams.get('page_token'));
    expect(tokens).toEqual([null, '2']);
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.getByText('Showing 2 riders. More follow on the next page.')).toBeVisible();
  });

  // The rider is drawn by the record template: the name is the heading (in the heading face, wrapping: a long name never pushes the page sideways), the status is the header's and the
  // readiness is facts apart from it, and the devices are a table where the table's own box has room (40rem) and cards under that, never both.
  for (const [shown, size] of [
    ['a table', { width: 1280, height: 800 }],
    ['a table or cards, one of them', { width: 768, height: 1024 }],
    ['cards', { width: 390, height: 844 }],
    ['cards', { width: 320, height: 640 }],
  ] as const) {
    // Break caught: a name drawn as a code (monospaced, never broken), a fact the record forgets, devices drawn twice or not at all, or a page wider than a phone.
    test(`the rider is a record with a long name wrapped in its heading and its devices as ${shown}, at ${String(size.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      const { api, watch } = await open(page, `/admin/riders/${IDS.kwame}`, {
        riders: [rider({ full_name: LONG_NAME })],
      });

      const heading = page.getByRole('heading', { level: 1, name: LONG_NAME });
      await expect(heading).toBeVisible();
      await expect(heading.locator('.ui-code')).toHaveCount(0);
      await expect(page.getByText('This rider is active.')).toBeVisible();
      for (const [term, value] of [
        ['Phone', '+233201234567'],
        ['Hub', 'Accra Central'],
        ['PIN', 'Set'],
        ['Device', 'One active device'],
        ['Readiness', 'Ready to sign in.'],
      ] as const) {
        await expect(page.locator(`dt:text-is("${term}") + dd`)).toHaveText(value);
      }
      const table = page.getByRole('table', { name: 'Devices of the rider' });
      const cards = page.getByRole('list', { name: 'Devices of the rider' });
      if (shown === 'a table') {
        await expect(table).toBeVisible();
        await expect(cards).toHaveCount(0);
      } else if (shown === 'cards') {
        await expect(cards).toBeVisible();
        await expect(table).toHaveCount(0);
      } else {
        expect((await table.count()) + (await cards.count())).toBe(1);
      }
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      expect(await wcagViolations(page)).toEqual([]);
      expect(await page.content()).not.toContain(PLANTED);
      expect(api.unexpected).toEqual([]);
      expect(watch.problems).toEqual([]);
    });
  }

  test('a rider of another hub and a rider that does not exist are pages of their own', async ({
    page,
  }) => {
    await open(page, `/admin/riders/${IDS.farAway}`, {
      riders: [rider({ id: IDS.farAway, full_name: 'Far Away', primary_hub_id: IDS.otherHub })],
    });
    await expect(page.getByText(/hub your session does not act in/)).toBeVisible();
    await page.goto('/admin/riders/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { level: 1, name: 'Rider not found' })).toBeVisible();
  });
});

test.describe('times', () => {
  // Break caught: a time shown in the machine's zone: the same instant would read differently on every laptop that opens the page.
  test.describe('whatever the machine’s zone', () => {
    test.use({ timezoneId: 'Pacific/Auckland' });

    test('are shown in Accra, 24-hour, with no zone label', async ({ page }) => {
      await open(page, `/admin/riders/${IDS.kwame}`);

      const table = page.getByRole('table', { name: 'Devices of the rider' });
      await expect(table.getByText('20 Oct, 09:00')).toBeVisible();
      expect(await table.innerText()).not.toMatch(/GMT|UTC|AM|PM|NZ/);
    });
  });
});

test.describe('the enrolment code in a real browser', () => {
  // Break caught: a picture that is not the code that scans to the credential: what a camera sees is what the browser painted, not what the
  // component meant to draw.
  test('the painted picture decodes to the whole code', async ({ page }) => {
    await showFirstCode(page);

    expect(await decodePainted(page, qr(page))).toBe(CODES.first);
  });

  // Break caught (ops-portal.md section 7): the credential anywhere but the picture: the text, the markup, an attribute, the address, the
  // title, a field, a storage or a log. The code is bearer material that must be present to be drawn, and is on the page as modules alone.
  test('is in the picture and nowhere else: not in the text, the markup, the address, the title or any storage', async ({
    page,
  }) => {
    const { api, watch } = await open(page, REGISTER);
    await page.getByRole('button', { name: 'Show the QR code' }).click();
    await expect(qr(page)).toBeVisible();

    expect(await whereIsTheCode(page)).toEqual([]);
    expect(await storedAnything(page)).toEqual({
      local: 0,
      session: 0,
      cookie: '',
      databases: 0,
      caches: 0,
    });
    const region = page.getByRole('region', { name: 'Scan this code with the rider’s handset' });
    // The button that asked for the code has gone, so focus is on the region, where a screen reader reads from its heading.
    await expect(region).toBeFocused();
    await expect(region.locator('input, textarea, a, title, desc')).toHaveCount(0);
    await expect(region.getByRole('button')).toHaveText([
      'The rider has scanned it',
      'Make a new code',
    ]);
    // Not in a request after it was made either: the page asks for nothing with it.
    expect(api.calls.map((call) => `${call.path}${call.search}`).join('\n')).not.toMatch(
      /melarc-rider|Enrolment/,
    );
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a registration sent with a version or without a key, or with a body, which the contract does not take.
  test('is asked for once, under an Idempotency-Key, with no version and no body', async ({
    page,
  }) => {
    const api = await showFirstCode(page);

    const [call] = acts(api);
    expect(call?.path).toBe(`/api/v1/ops/riders/${IDS.esi}/device/register`);
    expect(call?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.ifMatch).toBeUndefined();
    expect(call?.body).toBeUndefined();
    expect(acts(api)).toHaveLength(1);
  });

  // Break caught: a lost answer that is told as a refusal, or a retry that makes a second code instead of repeating the first.
  test('a lost connection leaves the outcome unknown, and trying again repeats the same attempt under the same key', async ({
    page,
  }) => {
    const { api } = await open(page, REGISTER, { dropNext: true });
    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(page.getByText(/We could not confirm whether the code was made/)).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    // The button that asked has gone, and the way out has the focus: not the top of the document, where a screen reader says nothing.
    await expect(page.getByRole('button', { name: 'Check the rider' })).toBeFocused();
    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(qr(page)).toBeVisible();
    // And the code has it when it arrives, the button of the retry having gone in turn.
    await expect(
      page.getByRole('region', { name: 'Scan this code with the rider’s handset' }),
    ).toBeFocused();
    const keys = acts(api).map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(await decodePainted(page, qr(page))).toBe(CODES.first);
  });

  // Break caught: the earlier code left on the screen, with no news and no way out, when the answer to a new code is lost (the new code may have
  // been made and the earlier one ended). The engine judges what jsdom cannot: where the focus goes when the buttons of the code leave, and the key.
  test('a lost answer to a new code takes the earlier one off the screen, and trying again repeats the attempt under its key', async ({
    page,
  }) => {
    const api = await showFirstCode(page);
    api.world.dropNext = true;

    await page.getByRole('button', { name: 'Make a new code' }).click();

    await expect(page.getByText(/We could not confirm whether the code was made/)).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    await expect(page.getByText(/The earlier code is no longer shown/)).toBeVisible();
    expect(await whereIsTheCode(page)).toEqual([]);
    // The button that was clicked has gone: focus is on the page, not at the top of the document.
    expect(await focusPlace(page)).toBe('outside');
    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(qr(page)).toBeVisible();
    await expect(qr(page)).toHaveCount(1);
    const keys = acts(api).map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[0]);
    expect(await decodePainted(page, qr(page))).toBe(CODES.second);
    expect(await whereIsTheCode(page)).toEqual([]);
  });

  // Break caught: the focus left at the top of the document when the control that had it goes with a request: the notice of the earlier code
  // keeps it for a new code asked for from the code, and the control for what comes next takes it when the new code is asked for from the lapsed
  // screen, whatever the answer is (found by an independent review: lost and refused answers left it on the document).
  for (const [how, answer, news, next] of [
    [
      'lost',
      { dropNext: true },
      /We could not confirm whether the code was made/,
      'Check the rider',
    ],
    [
      'refused',
      { refuseNext: { status: 400, code: 'VALIDATION_FAILED' } },
      /The code could not be made/,
      'Show the QR code',
    ],
    [
      'in conflict',
      { refuseNext: { status: 409, code: 'STATE_CONFLICT' } },
      /A first device cannot be registered for this rider/,
      'Reload the rider',
    ],
  ] as const) {
    test(`the focus stays on the notice of the earlier code when the answer to a new code is ${how}`, async ({
      page,
    }) => {
      const api = await showFirstCode(page);
      Object.assign(api.world, answer);

      await page.getByRole('button', { name: 'Make a new code' }).click();

      await expect(page.getByText(news)).toBeVisible();
      await expect(
        page.locator('.rider-notice', { hasText: 'The earlier code is no longer shown' }),
      ).toBeFocused();
    });

    test(`after the earlier code lapsed, the focus goes to ${next} when the answer to a new code is ${how}`, async ({
      page,
    }) => {
      await page.clock.install();
      const api = await showFirstCode(page);
      await page.clock.runFor(5 * 60 * 1000 + 2000);
      await expect(page.getByText(/The QR code is no longer displayed\./)).toBeVisible();
      Object.assign(api.world, answer);

      await page.getByRole('button', { name: 'Make a new code' }).click();

      await expect(page.getByText(news)).toBeVisible();
      await expect(page.getByRole('button', { name: next })).toBeFocused();
      await expect(qr(page)).toHaveCount(0);
    });
  }

  // Break caught: the picture staying on the screen once the rider has scanned it.
  test('is gone when the rider has scanned it, and the officer is back at the rider', async ({
    page,
  }) => {
    const api = await showFirstCode(page);
    api.finishEnrolment(IDS.esi);

    await page.getByRole('button', { name: 'The rider has scanned it' }).click();

    await expect(page).toHaveURL(`/admin/riders/${IDS.esi}`);
    await expect(page.getByText('Ready to sign in.')).toBeVisible();
    expect(await whereIsTheCode(page)).toEqual([]);
    await expect(qr(page)).toHaveCount(0);
  });

  // Break caught: a code outliving the lifetime the server gave it, or a lapsed code left on the screen.
  test('is gone when its time is up, and the officer is told, and can make a new one', async ({
    page,
  }) => {
    await page.clock.install();
    const api = await showFirstCode(page);

    await page.clock.runFor(5 * 60 * 1000 + 2000);

    await expect(page.getByText(/The QR code is no longer displayed\./)).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    expect(await whereIsTheCode(page)).toEqual([]);
    await page.getByRole('button', { name: 'Make a new code' }).click();
    await expect(qr(page)).toBeVisible();
    expect(acts(api)).toHaveLength(2);
    expect(await decodePainted(page, qr(page))).toBe(CODES.second);
  });

  // Break caught: the code still there when the officer has gone to another page and comes back with the back button.
  test('is gone on navigation, and does not return with the back button', async ({ page }) => {
    await showFirstCode(page);

    // The way back to the rider is the trail of the page's parents (the roster, then the rider by name).
    await page
      .getByRole('navigation', { name: 'Breadcrumb' })
      .getByRole('link', { name: 'Esi Owusu' })
      .click();
    await expect(page).toHaveURL(`/admin/riders/${IDS.esi}`);
    expect(await whereIsTheCode(page)).toEqual([]);
    await page.goBack();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Register a first device' }),
    ).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show the QR code' })).toBeVisible();
  });

  // Break caught: the page, with the code on it, kept by the browser's back-forward cache and shown again.
  test('is gone when the document is left and restored by the browser’s history', async ({
    page,
  }) => {
    await showFirstCode(page);

    await page.goto('about:blank');
    await page.goBack();

    await expect(
      page.getByRole('heading', { level: 1, name: 'Register a first device' }),
    ).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    expect(await whereIsTheCode(page)).toEqual([]);
  });

  // Break caught: the code of a person whose session has ended being left on a page that is still open.
  test('is gone when the person signs out', async ({ page }) => {
    await showFirstCode(page);

    await signOutFromMenu(page);

    await expect(page).toHaveURL(/\/sign-in/);
    await expect(qr(page)).toHaveCount(0);
    expect(await whereIsTheCode(page)).toEqual([]);
  });

  // Break caught: a second code drawn beside the first, or the first left on the screen.
  test('is replaced, and not joined, by a new code', async ({ page }) => {
    const api = await showFirstCode(page);

    await page.getByRole('button', { name: 'Make a new code' }).click();

    await expect(async () => {
      expect(await decodePainted(page, qr(page))).toBe(CODES.second);
    }).toPass();
    await expect(qr(page)).toHaveCount(1);
    const keys = acts(api).map((call) => call.idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
    expect(await whereIsTheCode(page)).toEqual([]);
  });

  // Break caught (ops-portal.md section 7): "A rider who already has an ACTIVE device is STATE_CONFLICT, explained and pointed at re-registration".
  test('is not offered to a rider who already has a device, and the replacement is pointed at', async ({
    page,
  }) => {
    const { api } = await open(page, `/admin/riders/${IDS.kwame}/device/register`);

    await expect(
      page.getByText(/This rider already has a device, or has had one revoked/),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show the QR code' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Replace the device instead.' })).toHaveAttribute(
      'href',
      DEVICE,
    );
    expect(acts(api)).toHaveLength(0);
  });

  test('a refusal of the registration is explained and shows no code', async ({ page }) => {
    const { api } = await open(page, REGISTER, {
      refuseNext: { status: 409, code: 'STATE_CONFLICT' },
    });

    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(
      page.getByText(/A first device cannot be registered for this rider/),
    ).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reload the rider' })).toBeFocused();
    expect(acts(api)).toHaveLength(1);
  });
});

test.describe('reporting a lost or stolen device', () => {
  // Break caught: a modal that leaves the page behind it reachable, that lets Tab out, or that loses the person's place when it closes.
  test('the dialog keeps Tab inside it and gives focus back to the button that opened it', async ({
    page,
  }) => {
    await open(page, DEVICE);
    const revoke = page.getByRole('button', { name: 'Revoke the device' });
    // Opened with the keyboard, as a keyboard user does: Safari's engine does not focus a button that is clicked, so a click leaves nothing to give back.
    await revoke.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('alertdialog', { name: 'Revoke this device?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press('Tab');
      expect(await focusPlace(page), `Tab ${String(step + 1)}`).not.toBe('outside');
    }
    // The report of a loss asks for a reason and nothing else: no note field.
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(revoke).toBeFocused();
  });

  // Break caught: the report of a loss made slower by a version, a verification or a key it does not take.
  test('sends the reason alone, with no version and no key, and says the device is revoked', async ({
    page,
  }) => {
    const { api, watch } = await open(page, DEVICE);
    await page.getByRole('button', { name: 'Revoke the device' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Revoke this device?' });
    await dialog.getByRole('combobox', { name: 'Reason (required)' }).selectOption('DEVICE_LOST');
    await dialog.getByRole('button', { name: 'Revoke the device' }).click();

    await expect(
      page.getByText('The device is revoked and the rider’s session has ended.'),
    ).toBeVisible();
    await expect(page.getByText('This rider has no active device to revoke.')).toBeVisible();
    const [call] = acts(api);
    expect(call?.path).toBe(`/api/v1/ops/riders/${IDS.kwame}/device/revoke`);
    expect(call?.ifMatch).toBeUndefined();
    expect(call?.idempotencyKey).toBeUndefined();
    expect(call?.body).toEqual({ reason_code: 'DEVICE_LOST' });
    expect(
      api.calls.some(
        (each) =>
          each.path === '/api/v1/reason-definitions' &&
          each.search.includes('operation=revokeRiderDevice'),
      ),
    ).toBe(true);
    expect(api.unexpected).toEqual([]);
    // Chromium reports a stubbed 204 as an aborted request although the page received it (checked with a bare route and a fetch): that one
    // line is the stand-in's, and every other problem still fails the test.
    expect(
      watch.problems.filter((problem) => !problem.endsWith('/device/revoke (net::ERR_ABORTED)')),
    ).toEqual([]);
  });

  test('a lost answer keeps the dialog, says the outcome is not known, and trying again repeats the revoke', async ({
    page,
  }) => {
    const { api } = await open(page, DEVICE, { dropNext: true });
    await page.getByRole('button', { name: 'Revoke the device' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Revoke this device?' });
    await dialog.getByRole('combobox', { name: 'Reason (required)' }).selectOption('DEVICE_LOST');
    await dialog.getByRole('button', { name: 'Revoke the device' }).click();

    await expect(dialog.getByText(/could not confirm whether this was done/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Check the record' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Try again' }).click();

    await expect(
      page.getByText('The device is revoked and the rider’s session has ended.'),
    ).toBeVisible();
    expect(acts(api)).toHaveLength(2);
  });
});

test.describe('replacing the handset', () => {
  async function fillReplacement(page: Page, note: string): Promise<void> {
    await page
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('HANDSET_REPLACED');
    await page
      .getByRole('textbox', { name: 'How you verified the rider in person (required)' })
      .fill(note);
  }

  // Break caught: a replacement sent without the version read, with a key it does not take, with the note untrimmed, or a code that is not the one made.
  test('sends the reason and the trimmed note with the version read, no key, and draws the code made', async ({
    page,
  }) => {
    const { api, watch } = await open(page, DEVICE);
    await fillReplacement(page, '  Checked the rider’s Ghana card in person.  ');

    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(qr(page)).toBeVisible();
    expect(await decodePainted(page, qr(page))).toBe(CODES.replacement);
    const [call] = acts(api);
    expect(call?.path).toBe(`/api/v1/ops/riders/${IDS.kwame}/device/reregister`);
    expect(call?.ifMatch).toBe('"v1"');
    expect(call?.idempotencyKey).toBeUndefined();
    expect(call?.body).toEqual({
      reason_code: 'HANDSET_REPLACED',
      verification_note: 'Checked the rider’s Ghana card in person.',
    });
    expect(await whereIsTheCode(page)).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a verification left out, or one that is not on one line, sent to the server to be refused.
  test('asks for both, refuses a note of more than one line, and sends nothing until it is right', async ({
    page,
  }) => {
    const { api } = await open(page, DEVICE);
    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(page.getByText('Choose a reason.')).toBeVisible();
    await expect(
      page.getByText('Say how you verified the rider’s identity in person.'),
    ).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Reason (required)' })).toBeFocused();
    expect(acts(api)).toHaveLength(0);

    const note = page.getByRole('textbox', {
      name: 'How you verified the rider in person (required)',
    });
    await page
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('HANDSET_REPLACED');
    await note.focus();
    await page.keyboard.type('Checked the card.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('And the face.');
    await expect(note).toHaveValue('Checked the card.\nAnd the face.');
    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(
      page.getByText('The note must be one line. Remove the line breaks.'),
    ).toBeVisible();
    await expect(note).toBeFocused();
    expect(acts(api)).toHaveLength(0);
  });

  // Break caught: a record that moved under the officer's hand being overwritten, or the way on being anything but reading it again.
  test('a rider who changed is a conflict that is explained, and the next code is asked for with the new version', async ({
    page,
  }) => {
    const { api } = await open(page, DEVICE);
    await fillReplacement(page, 'Checked the rider’s Ghana card in person.');
    const row = api.world.riders.find((candidate) => candidate.id === IDS.kwame);
    if (row === undefined) throw new Error('The stand-in has no Kwame');
    row.version += 1;

    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(
      page.getByText(/A replacement cannot be registered for this rider as it stands/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Reload the rider' }).click();

    // Break caught (found by this test in Chromium; jsdom does not run the browser's action for a click): React gave the next branch the very
    // button the click was on, and changed its type to "submit" before the browser acted on the click, so that reading the rider again asked
    // for a code nobody had asked for. The click reads the rider and does nothing else.
    const asking = page.getByRole('button', { name: 'Show the QR code' });
    await expect(asking).toBeVisible();
    await expect
      .poll(
        () =>
          api.calls.filter((call) => call.method === 'GET' && call.path.endsWith(IDS.kwame)).length,
      )
      .toBe(2);
    expect(acts(api)).toHaveLength(1);

    await asking.click();

    await expect(qr(page)).toBeVisible();
    expect(acts(api).map((call) => call.ifMatch)).toEqual(['"v1"', '"v2"']);
  });

  test('a lost answer offers only a look at the rider, and says a new code ends the old', async ({
    page,
  }) => {
    const { api } = await open(page, DEVICE, { dropNext: true });
    await fillReplacement(page, 'Checked the rider’s Ghana card in person.');

    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(page.getByText(/a new code ends any earlier one/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Check the rider' }).click();
    await page.getByRole('button', { name: 'Show the QR code' }).click();
    await expect(qr(page)).toBeVisible();
    expect(acts(api)).toHaveLength(2);
  });

  // Break caught: the earlier code left on the screen, with no news and no way out, when the answer to a new replacement code is lost; and a retry
  // offered for an act that takes no key.
  test('a lost answer to a new replacement code takes the earlier one off the screen and offers only a look at the rider', async ({
    page,
  }) => {
    const { api } = await open(page, DEVICE);
    await fillReplacement(page, 'Checked the rider’s Ghana card in person.');
    await page.getByRole('button', { name: 'Show the QR code' }).click();
    await expect(qr(page)).toBeVisible();
    api.world.dropNext = true;

    await page.getByRole('button', { name: 'Make a new code' }).click();

    await expect(page.getByText(/a new code ends any earlier one/)).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check the rider' })).toBeFocused();
    expect(await whereIsTheCode(page)).toEqual([]);
    expect(acts(api)).toHaveLength(2);

    await page.getByRole('button', { name: 'Check the rider' }).click();
    await page.getByRole('button', { name: 'Show the QR code' }).click();

    await expect(qr(page)).toBeVisible();
    expect(acts(api)).toHaveLength(3);
    expect(await whereIsTheCode(page)).toEqual([]);
  });

  test('the replacement is not offered to a session without its key, which is told in words', async ({
    page,
  }) => {
    await open(page, DEVICE, {
      permissions: ['dispatch.read', 'staff.device.revoke', 'settings.reason.read'],
    });

    // What the account cannot do, in plain words (PRODUCT_DESIGN_DIRECTION section 6.5): never the permission key.
    await expect(
      page.getByText(
        'Your account can’t register a replacement handset. Ask an administrator for access.',
      ),
    ).toBeVisible();
    await expect(page.locator('body')).not.toContainText('staff.device.reregister');
    await expect(page.getByRole('textbox', { name: /How you verified/ })).toHaveCount(0);
  });

  // Break caught (Stage 4.9): the verification note an officer has typed lost to a stray click on a menu entry, without a word. The page asks first and the safe answer, to stay, has the
  // focus; what was typed is still there after it, and the other answer goes where the click was going.
  test('a typed verification note survives a stray click on a menu entry: staying keeps it, and leaving goes', async ({
    page,
  }) => {
    const { api } = await open(page, DEVICE);
    await fillReplacement(page, 'Checked the rider’s Ghana card in person.');
    const note = page.getByRole('textbox', {
      name: 'How you verified the rider in person (required)',
    });
    const entry = page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'Riders' });

    await entry.click();

    const question = page.getByRole('alertdialog', { name: 'Leave this page?' });
    await expect(question).toBeVisible();
    await expect(question.getByRole('button', { name: 'Stay here' })).toBeFocused();
    await question.getByRole('button', { name: 'Stay here' }).click();
    await expect(question).toHaveCount(0);
    await expect(page).toHaveURL(DEVICE);
    await expect(note).toHaveValue('Checked the rider’s Ghana card in person.');
    await expect(page.getByRole('combobox', { name: 'Reason (required)' })).toHaveValue(
      'HANDSET_REPLACED',
    );
    expect(acts(api)).toHaveLength(0);

    await entry.click();
    await page
      .getByRole('alertdialog', { name: 'Leave this page?' })
      .getByRole('button', { name: 'Leave the page' })
      .click();
    await expect(page).toHaveURL('/admin/riders');
  });
});

test.describe('a credential has nowhere to go', () => {
  // Break caught (ops-portal.md section 7): a PIN hash, a key or an attestation a server should never send, drawn on any rider screen.
  test('no screen shows what the answers carry that they should not', async ({ page }) => {
    const { api } = await open(page, '/admin/riders');
    for (const path of [
      '/admin/riders',
      `/admin/riders/${IDS.kwame}`,
      DEVICE,
      REGISTER,
      `/admin/riders/${IDS.esi}`,
    ]) {
      await page.goto(path);
      await page.getByRole('heading', { level: 1 }).waitFor();
      expect(await page.content(), path).not.toContain(PLANTED);
      expect(await page.evaluate(() => document.body.innerText), path).not.toContain(PLANTED);
    }
    expect(api.unexpected).toEqual([]);
  });
});

/** Every screen and state the rider screens have, reached the way a person reaches them. */
const STATES: { name: string; reach: (page: Page) => Promise<void>; setup?: Partial<World> }[] = [
  {
    name: 'the roster',
    reach: async (page) => {
      await open(page, '/admin/riders');
      // A rider is a row of a table where the table has room and a card where it has not: the rider's link is in both.
      await expect(page.getByRole('link', { name: 'Kwame Mensah' })).toBeVisible();
    },
  },
  {
    name: 'a roster that a filter empties',
    reach: async (page) => {
      await open(page, '/admin/riders?status=OFFBOARDED');
      await expect(page.getByRole('heading', { name: 'No riders match' })).toBeVisible();
    },
  },
  {
    name: 'an empty roster',
    reach: async (page) => {
      await open(page, '/admin/riders', { riders: [] });
      await expect(page.getByRole('heading', { name: 'No riders yet' })).toBeVisible();
    },
  },
  {
    name: 'a rider who is ready',
    reach: async (page) => {
      await open(page, `/admin/riders/${IDS.kwame}`);
      await expect(page.getByText('Ready to sign in.')).toBeVisible();
    },
  },
  {
    name: 'a rider who has no device',
    reach: async (page) => {
      await open(page, `/admin/riders/${IDS.esi}`);
      await expect(page.getByRole('link', { name: 'Register the first device' })).toBeVisible();
    },
  },
  {
    name: 'a rider whose access ended',
    reach: async (page) => {
      await open(page, `/admin/riders/${IDS.ama}`);
      await expect(page.getByText('This rider is suspended and cannot sign in.')).toBeVisible();
    },
  },
  {
    name: 'a rider that is not there',
    reach: async (page) => {
      await open(page, '/admin/riders/00000000-0000-4000-8000-000000000000');
      await expect(page.getByRole('heading', { level: 1, name: 'Rider not found' })).toBeVisible();
    },
  },
  {
    name: 'the first binding before a code is asked for',
    reach: async (page) => {
      await open(page, REGISTER);
      await expect(page.getByRole('button', { name: 'Show the QR code' })).toBeVisible();
    },
  },
  {
    name: 'the first binding with the code showing',
    reach: async (page) => {
      await showFirstCode(page);
    },
  },
  {
    name: 'the first binding refused',
    reach: async (page) => {
      await open(page, REGISTER, { refuseNext: { status: 409, code: 'STATE_CONFLICT' } });
      await page.getByRole('button', { name: 'Show the QR code' }).click();
      await expect(page.getByRole('button', { name: 'Reload the rider' })).toBeVisible();
    },
  },
  {
    name: 'the first binding after the answer to a new code was lost',
    reach: async (page) => {
      const api = await showFirstCode(page);
      api.world.dropNext = true;
      await page.getByRole('button', { name: 'Make a new code' }).click();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(page.getByText(/The earlier code is no longer shown/)).toBeVisible();
    },
  },
  {
    name: 'the device page',
    reach: async (page) => {
      await open(page, DEVICE);
      await expect(page.getByRole('button', { name: 'Revoke the device' })).toBeVisible();
    },
  },
  {
    name: 'the replacement form with problems',
    reach: async (page) => {
      await open(page, DEVICE);
      await page.getByRole('button', { name: 'Show the QR code' }).click();
      await expect(page.getByText('Choose a reason.')).toBeVisible();
    },
  },
  {
    name: 'the replacement with the code showing',
    reach: async (page) => {
      await open(page, DEVICE);
      await page
        .getByRole('combobox', { name: 'Reason (required)' })
        .selectOption('HANDSET_REPLACED');
      await page
        .getByRole('textbox', { name: 'How you verified the rider in person (required)' })
        .fill('Checked the rider’s Ghana card in person.');
      await page.getByRole('button', { name: 'Show the QR code' }).click();
      await expect(qr(page)).toBeVisible();
    },
  },
  {
    name: 'the replacement after the answer to a new code was lost',
    reach: async (page) => {
      const { api } = await open(page, DEVICE);
      await page
        .getByRole('combobox', { name: 'Reason (required)' })
        .selectOption('HANDSET_REPLACED');
      await page
        .getByRole('textbox', { name: 'How you verified the rider in person (required)' })
        .fill('Checked the rider’s Ghana card in person.');
      await page.getByRole('button', { name: 'Show the QR code' }).click();
      await expect(qr(page)).toBeVisible();
      api.world.dropNext = true;
      await page.getByRole('button', { name: 'Make a new code' }).click();
      await expect(page.getByRole('button', { name: 'Check the rider' })).toBeVisible();
      await expect(page.getByText(/The earlier code is no longer shown/)).toBeVisible();
    },
  },
  {
    name: 'the report of a loss with its dialog open',
    reach: async (page) => {
      await open(page, DEVICE);
      await page.getByRole('button', { name: 'Revoke the device' }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('combobox', { name: 'Reason (required)' })).toBeVisible();
    },
  },
];

test.describe('every screen and state, at the verified widths', () => {
  for (const { width, height } of VIEWPORTS) {
    for (const state of STATES) {
      // Break caught: a state that clips, scrolls sideways, fails contrast with layout, has an unlabelled control, or loses the shell.
      test(`${state.name} has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await state.reach(page);

        expect(await wcagViolations(page)).toEqual([]);
        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expectShellAround(page, width);
      });
    }
  }
});

test.describe('the keyboard', () => {
  // Break caught: a control a keyboard cannot reach, or a page whose Tab order the officer cannot predict.
  test('reaches every control of the device page by Tab, in the order of the page', async ({
    page,
  }) => {
    await open(page, DEVICE);
    await page.getByRole('heading', { level: 1, name: 'Revoke or replace a device' }).waitFor();
    await page.getByRole('textbox', { name: /How you verified/ }).waitFor();

    const names = await reachableNames(page, false);

    expect(names).toEqual(
      expect.arrayContaining([
        'Revoke the device',
        'Reason (required)',
        'How you verified the rider in person (required)',
        'Show the QR code',
      ]),
    );
    expect(names.indexOf('Revoke the device')).toBeLessThan(names.indexOf('Show the QR code'));
  });
});
