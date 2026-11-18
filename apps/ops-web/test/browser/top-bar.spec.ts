import type { Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import { stubApi } from './support/api';
import { watchPage, wcagViolations } from './support/page';
import {
  accountButton,
  answerSessionWith,
  HUB_A,
  HUB_B,
  openAccountMenu,
  overflowOf,
  primaryNav,
  topBar,
} from './support/shell';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * The top bar of the signed-in shell in a real browser (redesign step R4): the hub switcher, the search, the theme control, the New menu and the
 * account menu. What jsdom cannot show is here: the menus opened and closed by pointer and keyboard in each engine with the focus that goes in and
 * comes back, the choice of theme kept across a reload and applied before the application runs (a pre-paint script of the page's own origin, under
 * the strict policy), the crimson square and the crimson button as they are painted, and every menu with axe in both themes.
 *
 * The API is the stand-in of `support/api.ts`: the session as each test says it (the hubs it lists, the keys it holds), and the summary of the queues
 * with no queue in it. Everything is synthetic.
 */
const THEME_KEY = 'melarc-theme';
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

/** The keys of a session that may create each of the three things the New menu offers. */
const CREATORS = ['pickup.request.create', 'pickup.manifest.create', 'staff.identity.create'];

interface Opened {
  readonly summaryReads: () => number;
  /** The `hub_id` of each read of the summary so far, in order: `null` where none was sent. */
  readonly summaryHubs: () => (string | null)[];
}

/** The portal at `path` as a person with these hubs and keys would have it, with the reads of the summary counted. */
async function open(
  page: Page,
  options: {
    readonly hubs?: readonly { id: string; display_name: string }[];
    readonly permissions?: readonly string[];
    readonly path?: string;
  } = {},
): Promise<Opened> {
  const { hubs = [HUB_A], permissions = ['staff.read'], path = '/' } = options;
  await stubApi(page);
  await answerSessionWith(page, { authorized_hubs: hubs, permissions });
  const hubsAsked: (string | null)[] = [];
  // With or without a query: the summary is asked for a hub with `?hub_id=` (task C3), and a glob without a query would not see that read.
  await page.route(/\/api\/v1\/ops\/queue-summary(\?.*)?$/, (route) => {
    hubsAsked.push(new URL(route.request().url()).searchParams.get('hub_id'));
    return route.fulfill({ status: 200, headers: JSON_HEADERS, json: { queues: [] } });
  });
  await page.route('**/api/v1/auth/staff/trusted-browsers', (route) =>
    route.fulfill({ status: 200, headers: JSON_HEADERS, json: { items: [] } }),
  );
  await page.goto(path);
  await expect(topBar(page)).toBeVisible();
  return { summaryReads: () => hubsAsked.length, summaryHubs: () => [...hubsAsked] };
}

const hubButton = (page: Page) => topBar(page).getByRole('button', { name: /^Hub: / });
const newButton = (page: Page) => topBar(page).getByRole('button', { name: 'New' });
const themeButton = (page: Page) => topBar(page).getByRole('button', { name: /^Theme: / });

/** What the browser keeps for this page, by place. */
const storedBy = (page: Page) =>
  page.evaluate(async () => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: sessionStorage.length,
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));

test.describe('the hub switcher', () => {
  // Break caught: a switcher drawn for a session with one hub (nothing to choose, so a button that opens a menu of one), or one that leaves out the
  // crimson square the specification gives the active hub.
  test('names the one hub of a session that has one, with the crimson square and no menu', async ({
    page,
  }) => {
    await open(page);

    await expect(topBar(page).getByText('Synthetic Hub')).toBeVisible();
    await expect(hubButton(page)).toHaveCount(0);
    const square = topBar(page).locator('.ui-hub__square');
    const painted = await square.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--color-brand-default)';
      document.body.append(probe);
      const crimson = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        width: box.width,
        height: box.height,
        fill: getComputedStyle(element).backgroundColor,
        crimson,
        hidden: element.getAttribute('aria-hidden'),
      };
    });
    expect(painted).toMatchObject({ width: 6, height: 6, hidden: 'true' });
    expect(painted.fill).toBe(painted.crimson);
  });

  // Break caught: a menu that does not list every hub of the session and All hubs, or that starts anywhere but All hubs, or that keeps the choice
  // in the browser (a second person on the same computer would start in the first one's hub).
  test('lists All hubs and each hub of a session that has two, starts on All hubs, and keeps the choice in memory only', async ({
    page,
  }) => {
    await open(page, { hubs: [HUB_A, HUB_B] });

    await expect(hubButton(page)).toHaveAccessibleName('Hub: All hubs');
    await hubButton(page).click();
    const menu = page.getByRole('menu', { name: 'Hub: All hubs' });
    await expect(menu).toBeVisible();
    await expect(menu.getByText('Show work for')).toBeVisible();
    await expect(menu.getByRole('menuitemradio')).toHaveText([
      'All hubs',
      'Synthetic Hub',
      'Second Synthetic Hub',
    ]);
    await expect(menu.getByRole('menuitemradio', { name: 'All hubs' })).toBeChecked();

    await menu.getByRole('menuitemradio', { name: 'Second Synthetic Hub' }).click();

    await expect(menu).toHaveCount(0);
    await expect(hubButton(page)).toHaveAccessibleName('Hub: Second Synthetic Hub');
    // Focus is back on the button that opened the menu.
    await expect(hubButton(page)).toBeFocused();
    // The foot of the sidebar still says what the session reaches, which a view does not change.
    await expect(page.getByRole('group', { name: 'Your account' })).toContainText('2 hubs');
    expect(await storedBy(page)).toEqual({
      local: {},
      session: 0,
      cookie: '',
      databases: 0,
      caches: 0,
    });

    await page.reload();
    await expect(hubButton(page)).toHaveAccessibleName('Hub: All hubs');
  });

  // Break caught: a menu that cannot be used from the keyboard, or that leaves focus nowhere when it closes.
  test('opens by keyboard with focus inside, moves with the arrows, chooses with Enter, and Escape closes it and gives focus back', async ({
    page,
  }) => {
    await open(page, { hubs: [HUB_A, HUB_B] });

    await hubButton(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Hub: All hubs' });
    await expect(menu.getByRole('menuitemradio', { name: 'All hubs' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(
      menu.getByRole('menuitemradio', { name: 'Synthetic Hub', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(hubButton(page)).toHaveAccessibleName('Hub: Synthetic Hub');
    await expect(hubButton(page)).toBeFocused();

    await page.keyboard.press('Enter');
    // The menu is named by the button that opens it, and the button's name now says the hub that was chosen.
    const reopened = page.getByRole('menu', { name: 'Hub: Synthetic Hub' });
    await expect(
      reopened.getByRole('menuitemradio', { name: 'Synthetic Hub', exact: true }),
    ).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(hubButton(page)).toBeFocused();
    // Escape chose nothing.
    await expect(hubButton(page)).toHaveAccessibleName('Hub: Synthetic Hub');
  });

  // Break caught: a choice of hub that leaves the counts of the shell as they were (the person looks at one hub and is told the queues of all), or
  // that asks for them without the hub (task C3: the summary is asked for the hub chosen).
  test('reads the counts of the queues for the hub chosen, and again only when another hub is chosen', async ({
    page,
  }) => {
    const opened = await open(page, { hubs: [HUB_A, HUB_B] });
    await expect.poll(() => opened.summaryReads()).toBe(1);
    expect(opened.summaryHubs()).toEqual([null]);

    await hubButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Second Synthetic Hub' }).click();
    await expect.poll(() => opened.summaryReads()).toBe(2);
    expect(opened.summaryHubs()).toEqual([null, HUB_B.id]);

    await hubButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Second Synthetic Hub' }).click();
    await page.waitForTimeout(300);
    expect(opened.summaryReads()).toBe(2);
  });

  // Break caught: a switcher that changes the title of a screen and nothing it asks of the server: the screens that can ask for one hub send
  // `hub_id` for it and nothing for All hubs (the staff list, and since task C3 the lists of requests and runs, the messages and the counts).
  test('makes the staff list ask for the hub that was chosen, and for no hub at All hubs', async ({
    page,
  }) => {
    const asked: URL[] = [];
    await open(page, { hubs: [HUB_A, HUB_B], permissions: ['staff.read'], path: '/' });
    await page.route(/\/api\/v1\/staff-identities(\?.*)?$/, (route) => {
      asked.push(new URL(route.request().url()));
      return route.fulfill({
        status: 200,
        headers: JSON_HEADERS,
        json: { items: [], next_page_token: null },
      });
    });
    await primaryNav(page).getByRole('link', { name: 'Staff' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
    await expect.poll(() => asked.length).toBeGreaterThan(0);
    expect(asked.at(-1)?.searchParams.has('hub_id'), 'All hubs').toBe(false);

    await hubButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Second Synthetic Hub' }).click();
    await expect.poll(() => asked.at(-1)?.searchParams.get('hub_id')).toBe(HUB_B.id);

    await hubButton(page).click();
    await page.getByRole('menuitemradio', { name: 'All hubs' }).click();
    await expect.poll(() => asked.at(-1)?.searchParams.has('hub_id')).toBe(false);
  });
});

test.describe('the New menu', () => {
  // Break caught: the New menu offering what the session may not do, in an order other than the specification's, or drawn for a session that may
  // create nothing; or a button that is not the crimson of the specification.
  test('lists what the session may create, in the order of the specification, on the crimson button', async ({
    page,
  }) => {
    await open(page, { permissions: CREATORS });

    await expect(newButton(page)).toBeVisible();
    const fills = await newButton(page).evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--color-action-new)';
      document.body.append(probe);
      const crimson = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { fill: getComputedStyle(element).backgroundColor, crimson };
    });
    expect(fills.fill).toBe(fills.crimson);

    await newButton(page).click();
    const menu = page.getByRole('menu', { name: 'New' });
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Book a pickup',
      'Build a pickup run',
      'Add a staff profile',
    ]);

    await menu.getByRole('menuitem', { name: 'Add a staff profile' }).click();

    await expect(page).toHaveURL('/admin/staff/new');
    await expect(page.getByRole('menu')).toHaveCount(0);
    // The page the person went to has the focus, on its heading, and not the button that opened the menu.
    await expect(page.locator('main h1')).toBeFocused();
  });

  test('offers a session that may create nothing no button and no empty menu', async ({ page }) => {
    await open(page, { permissions: ['staff.read'] });

    await expect(newButton(page)).toHaveCount(0);
  });

  // Break caught: a menu that cannot be used from the keyboard, or that leaves focus nowhere when it is dismissed.
  test('opens by keyboard and Escape closes it and gives focus back to the button', async ({
    page,
  }) => {
    await open(page, { permissions: CREATORS });

    await newButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Book a pickup' })).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(newButton(page)).toBeFocused();
  });
});

test.describe('the menus of the bar hold focus while they are open', () => {
  // Break caught: a menu that lets Tab carry focus out to the page behind it, which is hidden from assistive technology while the menu is open (so a
  // keyboard user would be on a control that nothing says is there), and what axe's `aria-hidden-focus` is right about when it is not so.
  for (const which of [
    'the hub menu',
    'the New menu',
    'the account menu',
    'the theme menu',
  ] as const) {
    test(`keeps focus inside ${which}: Tab does not leave it, and Escape gives focus back to its button`, async ({
      page,
    }) => {
      await open(page, { hubs: [HUB_A, HUB_B], permissions: CREATORS });
      const button = {
        'the hub menu': hubButton(page),
        'the New menu': newButton(page),
        'the account menu': accountButton(page),
        'the theme menu': themeButton(page),
      }[which];

      await button.click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      for (const key of ['Tab', 'Tab', 'Shift+Tab', 'Tab']) {
        await page.keyboard.press(key);
        const inside = await page.evaluate(
          () => document.activeElement?.closest('[role="menu"]') !== null,
        );
        expect(inside, `after ${key}`).toBe(true);
      }

      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(button).toBeFocused();
    });
  }
});

test.describe('the account menu', () => {
  // Break caught: the menu not saying who is signed in and where they act, offering a page that does not exist, or lacking the way to leave.
  test('says who is signed in and where they act, and offers the trusted browsers, the theme and sign-out', async ({
    page,
  }) => {
    await open(page, { hubs: [HUB_A, HUB_B] });

    const menu = await openAccountMenu(page);

    await expect(menu.getByText('Synthetic Officer')).toBeVisible();
    await expect(menu.getByText('2 hubs')).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Trusted browsers', 'Sign out']);
    await expect(menu.getByRole('menuitemradio')).toHaveText(['System', 'Light', 'Dark']);
    await expect(menu.getByRole('menuitemradio', { name: 'System' })).toBeChecked();
    // No page of this name exists, so none is offered.
    await expect(menu.getByText(/Profile and hubs/)).toHaveCount(0);
  });

  // Break caught: a link of the menu that leaves focus on the button of a menu that has closed, instead of on the page the person went to.
  test('goes to the trusted browsers and lands on that page’s heading', async ({ page }) => {
    await open(page);

    const menu = await openAccountMenu(page);
    await menu.getByRole('menuitem', { name: 'Trusted browsers' }).click();

    await expect(page).toHaveURL('/account/trusted-browsers');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Trusted browsers' })).toBeFocused();
  });

  // Break caught: a menu that cannot be used from the keyboard, or that leaves focus nowhere when it is dismissed.
  test('opens by keyboard with focus inside and Escape closes it and gives focus back to the button', async ({
    page,
  }) => {
    await open(page);

    await accountButton(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu', { name: 'Account menu' });
    await expect(menu.getByRole('menuitem', { name: 'Trusted browsers' })).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(menu).toHaveCount(0);
    await expect(accountButton(page)).toBeFocused();
  });
});

test.describe('the search', () => {
  // Break caught: a search that is a field that opens a dialog as soon as it takes focus (a change of context on focus, WCAG 3.2.1), that does not
  // say what it finds, or that does not show the key that opens the palette.
  test('is a button that says what it finds and shows its key, and does not open the palette by being focused', async ({
    page,
  }) => {
    await open(page);

    const search = topBar(page).getByRole('button', { name: 'Search a code, name or phone' });
    await expect(search).toBeVisible();
    await expect(search).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K Meta+K');
    await expect(search.locator('kbd')).toHaveText(/^(Ctrl K|⌘K)$/);

    await search.focus();
    await page.waitForTimeout(250);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});

test.describe('the theme', () => {
  // The values the page resolves for a token in each theme, read from the stylesheet itself so that nothing here repeats a colour.
  const surfaceIn = (page: Page, theme: 'light' | 'dark') =>
    page.evaluate((chosen) => {
      const root = document.documentElement;
      const before = root.getAttribute('data-theme');
      root.setAttribute('data-theme', chosen);
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--color-surface-page)';
      document.body.append(probe);
      const value = getComputedStyle(probe).backgroundColor;
      probe.remove();
      if (before === null) root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', before);
      return value;
    }, theme);
  const pageBackground = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  // Break caught: a default that is not System: the portal that is dark for a person whose computer is light, or the other way round, before they
  // have chosen anything.
  test('follows the computer’s setting until the person chooses, and writes nothing', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page);

    await expect(themeButton(page)).toHaveAccessibleName('Theme: System');
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect(await pageBackground(page)).toBe(await surfaceIn(page, 'dark'));

    await page.emulateMedia({ colorScheme: 'light' });
    expect(await pageBackground(page)).toBe(await surfaceIn(page, 'light'));
    expect((await storedBy(page)).local).toEqual({});
  });

  // Break caught: a choice that is not applied, that is written under more than one key, that writes anything else to the browser, or that does
  // not survive a reload.
  test('Dark is applied at once, kept in one key, and still applied after a reload', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);

    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(themeButton(page)).toHaveAccessibleName('Theme: Dark');
    await expect(themeButton(page)).toBeFocused();
    expect(await pageBackground(page)).toBe(await surfaceIn(page, 'dark'));
    expect(await storedBy(page)).toEqual({
      local: { [THEME_KEY]: 'dark' },
      session: 0,
      cookie: '',
      databases: 0,
      caches: 0,
    });

    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(themeButton(page)).toHaveAccessibleName('Theme: Dark');
    expect(await pageBackground(page)).toBe(await surfaceIn(page, 'dark'));
  });

  test('Light is applied over a computer that is set to dark, and kept across a reload', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page);

    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await pageBackground(page)).toBe(await surfaceIn(page, 'light'));
    expect((await storedBy(page)).local).toEqual({ [THEME_KEY]: 'light' });

    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(themeButton(page)).toHaveAccessibleName('Theme: Light');
  });

  // Break caught: System kept as a stored value, so that a person who went back to it is still held to what the computer said when they chose; the
  // key must not be written for the choice that is the default.
  test('System removes the key and follows the computer again', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);
    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    expect((await storedBy(page)).local).toEqual({ [THEME_KEY]: 'dark' });

    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    expect((await storedBy(page)).local).toEqual({});
    expect(await pageBackground(page)).toBe(await surfaceIn(page, 'light'));
    await page.reload();
    await expect(themeButton(page)).toHaveAccessibleName('Theme: System');
  });

  // Break caught: the pre-paint script that does not do its work (the page is drawn in the wrong theme first and changes when the application
  // starts), or a theme that is applied by the application only. The application's own scripts are refused here: what applies the choice is the
  // classic script in the head, a file of the page's own origin.
  test('is applied before the application runs, by a script of the page’s own origin', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);
    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // The application's own script is refused (the bundle of the build, or the entry module of the development server), so that nothing of it can
    // have set the attribute.
    await page.route(/\/(assets\/[^/]+\.js|src\/main\.tsx)(\?.*)?$/, (route) =>
      route.abort('blockedbyclient'),
    );
    await page.reload();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await pageBackground(page)).toBe(await surfaceIn(page, 'dark'));
    await expect(page.locator('#root')).toBeEmpty();
  });

  // Break caught: a stored value that is not one of the choices applied as a theme, which a person or an extension may have written.
  test('ignores a stored value that is not Light or Dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);
    await page.evaluate((key) => {
      localStorage.setItem(key, 'purple');
    }, THEME_KEY);

    await page.reload();

    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
    await expect(themeButton(page)).toHaveAccessibleName('Theme: System');
  });

  // Break caught: the two controls of the theme (the bar's and the account menu's) disagreeing with one another, or with the page.
  test('is the same choice in the top bar and in the account menu', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);

    const menu = await openAccountMenu(page);
    await menu.getByRole('menuitemradio', { name: 'Dark' }).click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(themeButton(page)).toHaveAccessibleName('Theme: Dark');
    const again = await openAccountMenu(page);
    await expect(again.getByRole('menuitemradio', { name: 'Dark' })).toBeChecked();
    await expect(again.getByRole('menuitemradio', { name: 'System' })).not.toBeChecked();
  });

  // Break caught: a second tab left in the theme it was in when the person chose another in the first.
  test('reaches another tab of the same browser', async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page);
    const second = await context.newPage();
    await second.emulateMedia({ colorScheme: 'light' });
    await stubApi(second);
    await second.goto('/');
    await expect(second.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    await expect(second.locator('html')).not.toHaveAttribute('data-theme', /.+/);

    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();

    // The other tab, which was already open, follows without a reload.
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');

    // And back to System: it follows again.
    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    await expect(second.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  });

  // Break caught: the pre-paint script or the menus refused by the strict policy, or the policy relaxed to let them run.
  test('runs under the strict policy: the script of the head and every menu raise no violation', async ({
    page,
  }) => {
    const violations = await enforceStrictPolicy(page);
    await page.emulateMedia({ colorScheme: 'light' });
    const seen = watchPage(page);
    await open(page, { hubs: [HUB_A, HUB_B], permissions: CREATORS });

    await themeButton(page).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await hubButton(page).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await newButton(page).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    const account = await openAccountMenu(page);
    await expect(account).toBeVisible();
    await page.keyboard.press('Escape');

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });
});

test.describe('the top bar and its menus, accessibility', () => {
  // One scan to a test, by state (the Product Owner's review of ba9a18c, item 6): the four tests that scanned the bar closed and with each of its menus open did up to five scans each, which is over the
  // 30 seconds of a test in WebKit as soon as the machine has anything else to do (the hosted run of 12 November 2026: 29.5s at 390px, and the same test at 1280px in the run before it, ending in "Target
  // page, context or browser has been closed" inside the wait for the page to stop moving). A scan that fails now names its state in the title of its test.
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390] as const) {
      const menus = [
        ['the hub menu', hubButton],
        ['the New menu', newButton],
        ['the account menu', accountButton],
        // The theme control is in the bar from 768px up; under it the sidebar's sheet holds it.
        ...(width >= 768 ? ([['the theme menu', themeButton]] as const) : []),
      ] as const;

      // Break caught: a bar that fails contrast, naming or target size in either theme, at the width of a desktop or of a phone, or that makes the page scroll sideways.
      test(`has no WCAG 2.2 A or AA violation at ${String(width)} px in the ${scheme} theme, closed`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height: 800 });
        await open(page, { hubs: [HUB_A, HUB_B], permissions: CREATORS });

        expect(await wcagViolations(page)).toEqual([]);
        expect(await overflowOf(page)).toBeLessThanOrEqual(0);
      });

      for (const [name, button] of menus) {
        // Break caught: a menu opened from the bar that fails contrast, naming or target size in either theme, at the width of a desktop or of a phone.
        test(`has no WCAG 2.2 A or AA violation at ${String(width)} px in the ${scheme} theme, with ${name} open`, async ({
          page,
        }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height: 800 });
          await open(page, { hubs: [HUB_A, HUB_B], permissions: CREATORS });

          await button(page).click();
          await expect(page.getByRole('menu')).toBeVisible();
          // axe does not take a Radix menu for the modal it is (it holds no `dialog` or `aria-modal`), so it reports the page behind it as hidden but
          // focusable; the page cannot be reached while the menu is open, which the tests above ("hold focus while they are open") prove for each menu.
          expect(await wcagViolations(page, { disable: ['aria-hidden-focus'] })).toEqual([]);
        });
      }
    }
  }

  // Break caught: a bar that is not the 56px of the specification at the sizes it draws (a fixed height lost, or a wrap that wraps when everything
  // fits), with the longest of the hubs' names and every control the bar can hold.
  for (const width of [1440, 768, 390] as const) {
    test(`is one row of exactly 56px at ${String(width)} px, with every control it can hold`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await open(page, { hubs: [HUB_A, HUB_B], permissions: CREATORS });
      await hubButton(page).waitFor();
      const rem = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      );

      const box = await topBar(page).boundingBox();
      expect(box?.height).toBe(3.5 * rem);
      const tops = await Promise.all(
        [
          hubButton(page),
          topBar(page).getByRole('button', { name: 'Search a code, name or phone' }),
          newButton(page),
          accountButton(page),
        ].map(async (control) => (await control.boundingBox())?.y ?? -1),
      );
      // Every control is on the same line: their tops differ by no more than the difference of their heights.
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(4);
    });
  }

  // Break caught: the bar's controls pushed out of the window at 320 px with text at 200%, or the page made to scroll sideways by it.
  test('keeps the controls of the bar inside the window at 320 px with text enlarged to 200%', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page, { hubs: [HUB_A, HUB_B], permissions: CREATORS });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    expect(await overflowOf(page)).toBeLessThanOrEqual(0);
    for (const control of [
      page.getByRole('button', { name: 'Open menu' }),
      hubButton(page),
      topBar(page).getByRole('button', { name: 'Search a code, name or phone' }),
      newButton(page),
      accountButton(page),
    ]) {
      const box = await control.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    }
  });
});
