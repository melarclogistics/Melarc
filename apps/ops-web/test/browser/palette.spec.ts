import { expect, test, type Locator, type Page } from '@playwright/test';

import { stubApi } from './support/api';
import { watchPage, wcagViolations } from './support/page';
import {
  accountButton,
  answerSessionWith,
  HUB_A,
  overflowOf,
  remOf,
  topBar,
} from './support/shell';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * The command palette of the signed-in shell in a real browser (redesign step R4; task C2's `lookupRecords`): Ctrl or ⌘ K and the search button open
 * it, it lists the pages and the actions the session may use and finds records by a code, a name or a phone number, and it gives focus back to where
 * the person was. What jsdom cannot show is here: the keys in each engine, focus that goes in and comes back, the layout at a phone's width and with
 * text enlarged, and every state of the search with axe in both themes.
 *
 * The API is the stand-in of `support/api.ts` plus a stand-in of the search, which answers what each test says and **plants what no answer may be
 * drawn from** (a line of wording, a link, a number in clear), so that a screen that could draw it would. Every record, name and number is synthetic.
 */
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const LOOKUP = '**/api/v1/ops/lookup';

const IDS = {
  request: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  staff: '1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e',
  rider: '2c3d4e5f-6071-4c8d-8e9f-1a2b3c4d5e6f',
};

/** A session that may open the staff pages and create each of the three things the New menu offers. */
const KEYS = [
  'staff.read',
  'pickup.request.create',
  'pickup.manifest.create',
  'staff.identity.create',
];

/** A pickup request as the search answers it: the facts, a masked phone, and the wording and the link no answer should carry planted beside them. */
const REQUEST_RESULT = {
  kind: 'PICKUP_REQUEST',
  id: IDS.request,
  code: 'ACC-PR-7KQ2MZ',
  title: 'ACC-PR-7KQ2MZ',
  state: 'PENDING',
  hub: HUB_A,
  service_date: '2026-11-09',
  sender_name: 'Demo Fabrics Ltd',
  phone_hint: '+233******567',
  subtitle: 'SERVER-WORDING',
  link: 'https://elsewhere.invalid/record',
  phone: '0241234567',
};
const STAFF_RESULT = {
  kind: 'STAFF_IDENTITY',
  id: IDS.staff,
  title: 'Ama Owusu',
  state: 'ACTIVE',
  hub: HUB_A,
};
const RIDER_RESULT = {
  kind: 'RIDER',
  id: IDS.rider,
  title: 'Kwame Mensah',
  state: 'SOMETHING_NEW',
  hub: HUB_A,
};

interface Answer {
  readonly status: number;
  readonly json: unknown;
}
const items = (...found: readonly unknown[]): Answer => ({ status: 200, json: { items: found } });
const fault = (status: number, code: string): Answer => ({
  status,
  json: {
    code,
    message: 'Diagnostic text that must never reach a screen.',
    request_id: 'req-browser-lookup',
  },
});

interface Opened {
  /** The texts asked of the server, in order. */
  readonly asked: string[];
  /** The bodies the browser sent, as it sent them. */
  readonly bodies: unknown[];
}

/** The portal as a person holding `KEYS` would have it, with the search answered as given (an answer, or a function of the text and the attempt). */
async function open(
  page: Page,
  answer: Answer | ((text: string, attempt: number) => Promise<Answer> | Answer) = items(),
  path = '/',
): Promise<Opened> {
  await stubApi(page);
  await answerSessionWith(page, { permissions: KEYS });
  const opened: Opened = { asked: [], bodies: [] };
  await page.route(LOOKUP, async (route) => {
    const body = route.request().postDataJSON() as { q: string };
    opened.asked.push(body.q);
    opened.bodies.push(body);
    const given = typeof answer === 'function' ? await answer(body.q, opened.asked.length) : answer;
    await route.fulfill({ status: given.status, headers: JSON_HEADERS, json: given.json });
  });
  // The page a record opens, answered as "not there": what these tests look at is that the person arrives and where focus is.
  await page.route('**/api/v1/staff-identities/*', (route) =>
    route.fulfill({ status: 404, headers: JSON_HEADERS, json: fault(404, 'NOT_FOUND').json }),
  );
  await page.goto(path);
  await expect(topBar(page)).toBeVisible();
  return opened;
}

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search' });
const field = (page: Page) => palette(page).getByRole('combobox');
const searchButton = (page: Page) =>
  topBar(page).getByRole('button', { name: 'Search a code, name or phone' });
/** An option by its name: a text names it whole ("Staff" is not "Add a staff profile"), a pattern as it says. */
const option = (page: Page, name: string | RegExp) =>
  palette(page).getByRole('option', typeof name === 'string' ? { name, exact: true } : { name });

/** Opens the palette with its key and waits until its field has focus. */
async function openByKey(page: Page): Promise<void> {
  await page.keyboard.press('Control+K');
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
}

/** Types as a person does and waits for the search to be asked, which it is only when the text has stood still. */
async function typeText(page: Page, text: string): Promise<void> {
  await field(page).pressSequentially(text, { delay: 15 });
}

test.describe('opening and closing the palette', () => {
  // Break caught: a palette that no key opens, that opens by merely being focused, that does not take focus in, or that is not a dialog with a name.
  test('opens by Ctrl K and by Meta K, with focus in its field, and by the button, and Ctrl K closes it', async ({
    page,
  }) => {
    await open(page);

    await openByKey(page);
    await expect(field(page)).toHaveValue('');
    await page.keyboard.press('Control+K');
    await expect(palette(page)).toHaveCount(0);

    await page.keyboard.press('Meta+K');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);

    await searchButton(page).click();
    await expect(palette(page)).toBeVisible();
    await expect(field(page)).toBeFocused();
  });

  // Break caught (review of 7 November 2026): the focus ring of the field hugging the text it holds, because the field had no room at its sides.
  test('gives the field room at its sides, so that the ring around it does not hug the text', async ({
    page,
  }) => {
    await open(page);
    await openByKey(page);
    const rem = await remOf(page);

    await expect(field(page)).toHaveCSS('padding-left', `${String(0.5 * rem)}px`);
    await expect(field(page)).toHaveCSS('padding-right', `${String(0.5 * rem)}px`);
  });

  // Break caught: the palette that takes focus to the body when it closes, so that a keyboard user starts again from the top of the page.
  test('gives focus back to the button that opened it, and to what had focus when a key opened it', async ({
    page,
  }) => {
    await open(page);

    await searchButton(page).click();
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
    await expect(searchButton(page)).toBeFocused();

    await page.getByRole('button', { name: 'Collapse menu' }).focus();
    await openByKey(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeFocused();

    await accountButton(page).focus();
    await openByKey(page);
    await page.keyboard.press('Control+K');
    await expect(palette(page)).toHaveCount(0);
    await expect(accountButton(page)).toBeFocused();
  });

  // Break caught: a search made for a palette that is closed, or the text of an earlier opening still in the field.
  test('forgets what was typed when it closes and asks nothing while it is closed', async ({
    page,
  }) => {
    const opened = await open(page);

    await openByKey(page);
    await typeText(page, 'ama');
    await expect.poll(() => opened.asked).toEqual(['ama']);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    await openByKey(page);
    await expect(field(page)).toHaveValue('');
    await expect(
      palette(page).getByText('Type two letters or more to search records.'),
    ).toBeVisible();
    await page.waitForTimeout(400);
    expect(opened.asked).toEqual(['ama']);
  });
});

test.describe('the pages and the actions', () => {
  // Break caught: the pages the session may not open offered, the built pages not offered, or the groups in an order other than the specification's.
  test('lists Go to and Create, then Records, offering only what the session may use', async ({
    page,
  }) => {
    await open(page);

    await openByKey(page);

    await expect(palette(page).locator('[cmdk-group-heading]')).toHaveText(['Go to', 'Create']);
    await expect(
      palette(page).getByRole('group', { name: 'Go to' }).getByRole('option'),
    ).toHaveText(['My work', 'Staff', 'Sessions', 'Trusted browsers']);
    await expect(
      palette(page).getByRole('group', { name: 'Create' }).getByRole('option'),
    ).toHaveText(['Book a pickup', 'Build a pickup run', 'Add a staff profile']);
    // Records is the third group of the specification; before anything is typed it says what to do, and holds no option.
    await expect(palette(page).getByText('Records', { exact: true })).toBeVisible();
    await expect(
      palette(page).getByText('Type two letters or more to search records.'),
    ).toBeVisible();
    await expect(palette(page).getByRole('option')).toHaveCount(7);
  });

  // Break caught: pages found by their name only (the person who knows what they want, and not what it is called), or a filter that hides the pages
  // of the other group.
  test('finds a page by its name and by what it is for, and an action by its name', async ({
    page,
  }) => {
    await open(page);
    await openByKey(page);

    await typeText(page, 'waiting');
    await expect(
      palette(page).getByRole('group', { name: 'Go to' }).getByRole('option'),
    ).toHaveText(['Staff']);
    await expect(palette(page).getByRole('group', { name: 'Create' })).toHaveCount(0);

    await field(page).fill('book');
    await expect(
      palette(page).getByRole('group', { name: 'Create' }).getByRole('option'),
    ).toHaveText(['Book a pickup']);
    await expect(palette(page).getByRole('group', { name: 'Go to' })).toHaveCount(0);
  });

  // Break caught: a palette that moves by the pointer only, or whose Enter does not open what is marked, or that leaves focus on the page's body
  // after going somewhere: the person who went to a page must land on its heading.
  test('moves with the arrow keys, opens with Enter, and lands on the new page’s heading', async ({
    page,
  }) => {
    await open(page);
    await openByKey(page);
    await expect(option(page, 'My work')).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowDown');
    await expect(option(page, 'Staff')).toHaveAttribute('aria-selected', 'true');
    await expect(option(page, 'My work')).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/admin/staff');
    await expect(palette(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeFocused();
  });

  test('opens an action of Create by a click, and lands on its page', async ({ page }) => {
    await open(page);
    await openByKey(page);

    await option(page, 'Add a staff profile').click();

    await expect(page).toHaveURL('/admin/staff/new');
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator('main h1')).toBeFocused();
  });
});

test.describe('the search of records', () => {
  // Break caught: a request for a text too short to search, or a request for each letter typed.
  test('asks nothing under two characters, and once for a text that has stood still', async ({
    page,
  }) => {
    const opened = await open(page, items(REQUEST_RESULT));
    await openByKey(page);

    await typeText(page, 'a');
    await page.waitForTimeout(500);
    expect(opened.asked).toEqual([]);
    await expect(
      palette(page).getByText('Type two letters or more to search records.'),
    ).toBeVisible();

    await typeText(page, 'cde');

    await expect(option(page, /ACC-PR-7KQ2MZ/)).toBeVisible();
    // The text that stood still is the one asked last, and not one request for each letter, which would be three ('ac', 'acd', 'acde'). A machine
    // that stalls for longer than the wait between two keys may split the text in two requests, and never in three (review of 7 November 2026: the test
    // expected exactly one, which four keys 15 ms apart only give while the machine keeps up).
    expect(opened.asked.at(-1)).toBe('acde');
    expect(opened.asked.length).toBeLessThan(3);
    expect(opened.bodies.at(-1)).toEqual({ q: 'acde' });
  });

  // Break caught: the wait not told ("nothing found" shown while the answer is on its way), or the number of a loading state not announced.
  test('says it is searching while the answer is on its way, then draws the results', async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await open(page, async () => {
      await held;
      return items(REQUEST_RESULT);
    });
    await openByKey(page);

    await typeText(page, 'fabrics');

    await expect(palette(page).getByRole('status')).toHaveText(/Searching…/);
    await expect(palette(page).getByText(/No record matches/)).toHaveCount(0);
    release();
    await expect(option(page, /ACC-PR-7KQ2MZ/)).toBeVisible();
    await expect(palette(page).getByText('Searching…')).toHaveCount(0);
  });

  // Break caught: the line under a result written by the server (its planted wording drawn), the state shown as the raw value, a link taken from the
  // answer, or a number in clear on the screen: the portal writes the line from the facts and the link from the kind and the id.
  test('draws a line the portal wrote from the facts, with the phone only as it was masked, and never what the answer planted', async ({
    page,
  }) => {
    await open(page, items(REQUEST_RESULT, STAFF_RESULT, RIDER_RESULT));
    await openByKey(page);

    await typeText(page, '0241234567');

    const request = option(page, /ACC-PR-7KQ2MZ/);
    await expect(request).toBeVisible();
    await expect(request).toContainText(
      'Demo Fabrics Ltd · Waiting for confirmation · Synthetic Hub · Mon 9 Nov 2026 · +233******567',
    );
    // The records are the server's answer and are not filtered again by the text: none of them contains the number that was typed.
    await expect(
      palette(page).getByRole('group', { name: 'Records' }).getByRole('option'),
    ).toHaveCount(3);
    await expect(option(page, /Ama Owusu/)).toContainText('Active · Synthetic Hub');
    // A state this build has no words for is not drawn as it came.
    await expect(option(page, /Kwame Mensah/)).not.toContainText('SOMETHING_NEW');
    await expect(option(page, /Kwame Mensah/)).toContainText('Synthetic Hub');

    const drawn = await palette(page).getByRole('listbox').innerText();
    expect(drawn).not.toContain('SERVER-WORDING');
    expect(drawn).not.toContain('0241234567');
    expect(drawn).not.toContain('elsewhere.invalid');
    // The code of a request is drawn in the monospace face; a name is not.
    const faces = await page.evaluate(() => ({
      code: getComputedStyle(document.querySelector('.ui-palette__code') ?? document.body)
        .fontFamily,
      subtitle: getComputedStyle(document.querySelector('.ui-palette__subtitle') ?? document.body)
        .fontFamily,
    }));
    expect(faces.code).not.toBe(faces.subtitle);
  });

  // Break caught: a result that opens the page the answer named, and not the portal's own page for its kind and its id.
  test('opens a result by the portal’s own page for it, and lands on that page’s heading', async ({
    page,
  }) => {
    await open(page, items(REQUEST_RESULT, STAFF_RESULT));
    await openByKey(page);
    await typeText(page, 'ama');
    await expect(option(page, /Ama Owusu/)).toBeVisible();

    await option(page, /Ama Owusu/).click();

    await expect(page).toHaveURL(`/admin/staff/${IDS.staff}`);
    await expect(palette(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Profile not found' })).toBeFocused();
  });

  // Break caught: "nothing found" worded as a failure, or the text that was searched for not said back.
  test('says no record matches, with the text, when the answer is empty', async ({ page }) => {
    await open(page, items());
    await openByKey(page);

    await typeText(page, 'zzz');

    await expect(palette(page).getByRole('status')).toHaveText(/No record matches “zzz”\./);
    // The alert container is in the palette through every state (audit B3) and says nothing when nothing has failed.
    await expect(palette(page).getByRole('alert')).toBeEmpty();
  });

  // Break caught: a failed search drawn as an empty answer, shown with the server's text, tried again by itself, or with no way to try again.
  test('says the search could not be completed, in plain words, and tries again only when asked', async ({
    page,
  }) => {
    const opened = await open(page, (_text, attempt) =>
      attempt === 1 ? fault(500, 'INTERNAL_ERROR') : items(REQUEST_RESULT),
    );
    await openByKey(page);

    await typeText(page, 'ama');

    const alert = palette(page).getByRole('alert');
    await expect(alert).toContainText('The search could not be completed.');
    await expect(palette(page).getByText(/Diagnostic text|INTERNAL_ERROR/)).toHaveCount(0);
    await expect(palette(page).getByText(/No record matches/)).toHaveCount(0);
    await page.waitForTimeout(1200);
    expect(opened.asked).toEqual(['ama']);

    await alert.getByRole('button', { name: 'Try again' }).click();

    await expect(option(page, /ACC-PR-7KQ2MZ/)).toBeVisible();
    expect(opened.asked).toEqual(['ama', 'ama']);
  });

  // Break caught: the limit of the session's searches shown as an error alert or in other words, or asked again by itself (audit A2: the shared calm message, in the status line).
  test('says to wait when the session has asked too often, and does not ask again by itself', async ({
    page,
  }) => {
    const opened = await open(page, fault(429, 'RATE_LIMITED'));
    await openByKey(page);

    await typeText(page, 'ama');

    await expect(palette(page).getByRole('status')).toContainText(
      "You're going a little fast. Try again in a few seconds.",
    );
    await expect(palette(page).getByRole('alert')).toBeEmpty();
    await page.waitForTimeout(1200);
    expect(opened.asked).toEqual(['ama']);
  });

  // Break caught: a number in clear in an answer drawn on the screen: the answer is refused whole, and the search is said to have failed.
  test('refuses an answer that carries a phone number in clear, and draws no number', async ({
    page,
  }) => {
    await open(page, items({ ...REQUEST_RESULT, phone_hint: '0241234567' }));
    await openByKey(page);

    await typeText(page, '0241234567');

    await expect(palette(page).getByRole('alert')).toContainText(
      'The search could not be completed.',
    );
    await expect(palette(page)).not.toContainText('0241234567');
    await expect(option(page, /ACC-PR-7KQ2MZ/)).toHaveCount(0);
  });

  // Break caught: the answer to an earlier text drawn under a later one (a slow answer that arrives after the person has gone on typing).
  test('never draws the answer to an earlier text under a later one', async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opened = await open(page, async (text) => {
      if (text === 'ab') {
        await held;
        return items({ ...STAFF_RESULT, title: 'Answer for ab' });
      }
      return items({ ...STAFF_RESULT, title: 'Answer for abc' });
    });
    await openByKey(page);

    await typeText(page, 'ab');
    await expect.poll(() => opened.asked).toEqual(['ab']);
    await typeText(page, 'c');
    await expect(option(page, /Answer for abc/)).toBeVisible();

    release();
    await page.waitForTimeout(500);

    await expect(option(page, /Answer for abc/)).toBeVisible();
    await expect(palette(page).getByText('Answer for ab', { exact: true })).toHaveCount(0);
  });
});

test.describe('the palette, policy and accessibility', () => {
  for (const width of [1280, 390] as const) {
    // Break caught: the palette (a dialog, a list, its inline styles) refused by the strict policy in any state it has, or the policy relaxed to let it
    // work. Every state of the search is drawn under it, at a desktop's width and at a phone's (where the dialog is as wide as the window): the hint, a
    // single letter, the wait for an answer, the results, no match, a failed search and a text too long (review of 7 November 2026: the states before
    // were results and no match, at one width).
    test(`runs under the strict policy in each state of the search, at ${String(width)} px`, async ({
      page,
    }) => {
      const violations = await enforceStrictPolicy(page);
      await page.setViewportSize({ width, height: 800 });
      const seen = watchPage(page);
      let mode: 'results' | 'empty' | 'fault' | 'held' = 'results';
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await open(page, async () => {
        if (mode === 'held') await held;
        if (mode === 'fault') return fault(500, 'INTERNAL_ERROR');
        return mode === 'empty' ? items() : items(REQUEST_RESULT);
      });

      await openByKey(page);
      await expect(
        palette(page).getByText('Type two letters or more to search records.'),
      ).toBeVisible();
      await typeText(page, 'a');
      await expect(
        palette(page).getByText('Type two letters or more to search records.'),
      ).toBeVisible();
      mode = 'held';
      await typeText(page, 'b');
      await expect(palette(page).getByRole('status')).toHaveText(/Searching…/);
      release();
      await expect(option(page, /ACC-PR-7KQ2MZ/)).toBeVisible();
      mode = 'empty';
      await field(page).fill('zzz');
      await expect(palette(page).getByRole('status')).toHaveText(/No record matches/);
      mode = 'fault';
      await field(page).fill('yyy');
      await expect(palette(page).getByRole('alert')).toContainText(
        'The search could not be completed.',
      );
      await field(page).fill('x'.repeat(65));
      await expect(palette(page).getByRole('status')).toHaveText(
        /Use 64 characters or fewer to search records\./,
      );

      expect(violations).toEqual([]);
      // The one failure on the page is the 500 this test asked for, and the line the browser logs about it: nothing else went wrong.
      expect(seen.problems.filter((line) => !/\/ops\/lookup|status of 500/.test(line))).toEqual([]);
      expect(seen.problems.some((line) => line.startsWith('HTTP 500:'))).toBe(true);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390] as const) {
      // Break caught: a state of the palette that fails contrast, naming or target size in either theme, at a desktop's width or a phone's, or that
      // makes the page scroll sideways.
      test(`has no WCAG 2.2 A or AA violation at ${String(width)} px in the ${scheme} theme, in each state of the search`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        let mode: 'results' | 'empty' | 'fault' | 'held' = 'results';
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await open(page, async () => {
          if (mode === 'held') await held;
          if (mode === 'fault') return fault(500, 'INTERNAL_ERROR');
          return mode === 'empty' ? items() : items(REQUEST_RESULT, STAFF_RESULT);
        });
        await openByKey(page);
        expect(await wcagViolations(page), 'hint').toEqual([]);

        mode = 'held';
        await typeText(page, 'ab');
        await expect(palette(page).getByRole('status')).toHaveText(/Searching…/);
        expect(await wcagViolations(page), 'searching').toEqual([]);
        release();

        await expect(option(page, /ACC-PR-7KQ2MZ/)).toBeVisible();
        expect(await wcagViolations(page), 'results').toEqual([]);
        expect(await overflowOf(page), 'results').toBeLessThanOrEqual(0);

        mode = 'empty';
        await field(page).fill('zzz');
        await expect(palette(page).getByRole('status')).toHaveText(/No record matches/);
        expect(await wcagViolations(page), 'empty').toEqual([]);

        mode = 'fault';
        await field(page).fill('yyy');
        await expect(palette(page).getByRole('alert')).toBeVisible();
        expect(await wcagViolations(page), 'failed').toEqual([]);
      });
    }
  }

  // Break caught: the palette wider than the window of a phone, or its field pushed out of sight when text is enlarged (WCAG 1.4.4, 1.4.10).
  test('stays inside the window at 320 px with text enlarged to 200%', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, items(REQUEST_RESULT, STAFF_RESULT));
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await openByKey(page);
    await typeText(page, 'ab');
    await expect(option(page, /ACC-PR-7KQ2MZ/)).toBeVisible();

    const box = await palette(page).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    await expect(field(page)).toBeInViewport();
    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
  });

  for (const size of ['100%', '200%'] as const) {
    // Break caught (audit B4, 7 November 2026): the panel of the palette run off the bottom of a low window (it sits from 12vh down, and the dialog's own limit
    // was the window less 2rem), with the status of the search clipped by `overflow: hidden`, so that a hint, a count or a failure could not be reached; or a
    // panel that does not scroll inside itself. A part is reached when the element at its centre is the part itself: a part clipped away is not.
    test(`stays inside a low window, 640 by 360, with text at ${size}, and scrolls inside itself to the status of the search`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 640, height: 360 });
      await open(page, items(REQUEST_RESULT));
      await page.evaluate((fontSize) => {
        document.documentElement.style.fontSize = fontSize;
      }, size);
      await openByKey(page);
      const panel = palette(page);
      const hint = panel.getByText('Type two letters or more to search records.');

      const box = await panel.boundingBox();
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(360);
      expect(await panel.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto');

      const reached = (part: Locator): Promise<boolean> =>
        part.evaluate((element) => {
          const rectangle = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rectangle.x + rectangle.width / 2,
            rectangle.y + rectangle.height / 2,
          );
          return hit !== null && element.contains(hit);
        });
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(await reached(hint), 'the status, at the end of the panel').toBe(true);
      await panel.evaluate((element) => {
        element.scrollTop = 0;
      });
      expect(await reached(field(page)), 'the field, at the start of the panel').toBe(true);
      expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    });
  }
});
