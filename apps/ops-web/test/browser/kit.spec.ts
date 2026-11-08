import { expect, test, type Locator, type Page } from '@playwright/test';

import { settled, watchPage, wcagViolations } from './support/page';

/**
 * The Melarc component kit in the development-only showcase (`/__showcase/kit/<group>`; redesign step R5; COMPONENT_PATTERNS section 37), in a real browser: the
 * checks that jsdom cannot make. An automated WCAG 2.2 scan of every page in both themes and of the states that open; the sizes, positions and looks that only
 * the stylesheet gives (the rows at 36, 52 and 56px, the panel at 360 to 420px, the code at 26/32, the label column at 110px, the radii); the keyboard and
 * pointer behaviour of each component; and what moves, and that it does not under reduced motion. They do not replace the recorded keyboard-only and
 * screen-reader passes. The same pages built for production under the strict policy are `kit-policy.spec.ts`.
 */
const KIT = '/__showcase/kit';

type Scheme = 'light' | 'dark';

interface OpenOptions {
  readonly scheme?: Scheme;
  readonly reducedMotion?: boolean;
  readonly forcedColors?: boolean;
  readonly width?: number;
  readonly height?: number;
}

async function openKit(page: Page, group: string, options: OpenOptions = {}) {
  const seen = watchPage(page);
  if (options.width !== undefined || options.height !== undefined)
    await page.setViewportSize({ width: options.width ?? 1280, height: options.height ?? 900 });
  if (options.scheme !== undefined) await page.emulateMedia({ colorScheme: options.scheme });
  if (options.reducedMotion === true) await page.emulateMedia({ reducedMotion: 'reduce' });
  if (options.forcedColors === true) await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(`${KIT}/${group}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Kit showcase' })).toBeVisible();
  return seen;
}

/** A specimen of the page by the start of its caption. */
const specimen = (page: Page, caption: string): Locator =>
  page.getByRole('figure', {
    name: new RegExp(`^${caption.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });

/** One number of the computed style of an element, in pixels. */
const px = (locator: Locator, property: string): Promise<number> =>
  locator.evaluate(
    (element, name) => parseFloat(getComputedStyle(element).getPropertyValue(name)),
    property,
  );

/** The box of an element, which a test cannot do without. */
async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('The element has no box on the page.');
  return found;
}

/** The colour a design token resolves to in this page, as the browser writes it. */
function resolvedColour(
  page: Page,
  token: string,
  property: 'color' | 'backgroundColor',
): Promise<string> {
  return page.evaluate(
    ([name, wanted]) => {
      const probe = document.createElement('span');
      probe.style.color = `var(${name})`;
      probe.style.backgroundColor = `var(${name})`;
      document.body.append(probe);
      const colour = getComputedStyle(probe)[wanted === 'color' ? 'color' : 'backgroundColor'];
      probe.remove();
      return colour;
    },
    [token, property] as const,
  );
}

/** Whether keyboard focus is inside an element that matches the selector. */
const focusIn = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((within) => document.activeElement?.closest(within) != null, selector);

/** How far the document is wider than the window; zero or less means no sideways scrolling. */
const overflow = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** The shadow a design token resolves to in this page, as the browser writes it. */
function resolvedShadow(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span');
    probe.style.boxShadow = `var(${name})`;
    document.body.append(probe);
    const shadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    return shadow;
  }, token);
}

/** The computed colour of an element: its text (`color`) or its fill (`backgroundColor`). */
const colourOf = (locator: Locator, property: 'color' | 'backgroundColor'): Promise<string> =>
  locator.evaluate((element, name) => getComputedStyle(element)[name], property);

const GROUPS = [
  'header',
  'data',
  'panels',
  'menus',
  'forms',
  'lists',
  'badges',
  'states',
  'overlays',
  'example-queue',
  'example-record',
  'example-count',
] as const;

test.describe('the kit pages: WCAG 2.2 in both themes', () => {
  // Break caught: a component whose colours, sizes, names or roles fail a rule that contrast figures and jsdom cannot see, in either theme: a scan on a page whose
  // theme was never applied, which is why the page's own ground is compared.
  for (const scheme of ['light', 'dark'] as const) {
    for (const group of GROUPS) {
      test(`the ${group} page has no violation in the ${scheme} theme`, async ({ page }) => {
        const seen = await openKit(page, group, { scheme });
        const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        expect(ground).toBe(await resolvedColour(page, '--color-surface-page', 'backgroundColor'));

        expect(await wcagViolations(page)).toEqual([]);
        expect(seen.problems).toEqual([]);
      });
    }
  }

  // Break caught: the theme forced by the attribute a person's choice writes (step R4) differing from the one the system sets.
  test('follows the root data-theme before the system, and has no violation either way', async ({
    page,
  }) => {
    await openKit(page, 'data', { scheme: 'light' });
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
      light,
    );
    expect(await wcagViolations(page)).toEqual([]);
  });
});

test.describe('the states that open something: WCAG 2.2 in both themes', () => {
  // Break caught: an overlay, a panel or a bar that fails a rule only while it is showing (the surface of a popover, the ring on a close button, the colours of
  // a bar over the rows), in either theme, which a scan of the page with everything closed never sees.
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no violation with the filter popover open, in the ${scheme} theme`, async ({
      page,
    }) => {
      await openKit(page, 'header', { scheme });
      await specimen(page, 'Three filters, with Clear all')
        .getByRole('button', { name: 'Filter', exact: true })
        .click();
      await expect(page.getByRole('dialog', { name: 'Filter' })).toBeVisible();

      expect(await wcagViolations(page)).toEqual([]);
    });

    // Break caught: the docked panel's surface, its close button or its heading failing a rule only while it is open beside the list (found with the others of this
    // block: the dialog role without a modal, the shadow over the list).
    test(`has no violation with the side panel open beside the list, in the ${scheme} theme`, async ({
      page,
    }) => {
      await openKit(page, 'panels', { scheme, width: 1440 });
      await specimen(page, 'Beside a list of sample requests')
        .getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })
        .click();
      await expect(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeVisible();

      expect(await wcagViolations(page)).toEqual([]);
    });

    // Break caught: the sheet (a modal dialog on the sheet primitive, with the page behind it hidden from assistive technology) failing a rule at the width of a phone.
    test(`has no violation with the side panel open as a full-screen sheet at 390px, in the ${scheme} theme`, async ({
      page,
    }) => {
      await openKit(page, 'panels', { scheme, width: 390 });
      const row = specimen(page, 'Beside a list of sample requests').getByRole('button', {
        name: 'Open ACC-PR-7KQ2MZ',
      });
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await expect(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeVisible();

      expect(await wcagViolations(page)).toEqual([]);
    });

    // Break caught: text on the tint of a chosen row below 4.5 to 1 (the muted name under a code was 4.2 to 1 on it in the light theme: this scan found it), or the bar of
    // acts over the rows failing a rule.
    test(`has no violation with rows chosen and the bar of acts showing, in the ${scheme} theme`, async ({
      page,
    }) => {
      await openKit(page, 'data', { scheme });
      const two = specimen(page, 'Two lines (a code over a name)');
      await two.getByRole('checkbox', { name: 'Select ACC-PR-4HT9WD' }).check();
      await two.getByRole('checkbox', { name: 'Select ACC-PR-3NP6VB' }).check();
      await expect(two.getByRole('group', { name: 'Actions for the chosen rows' })).toBeVisible();

      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});

test.describe('PageHeader, ViewTabs and FilterBar in a browser', () => {
  // Break caught: a title that is not the size, weight and tightness of the redesign, or a count that reads as part of it.
  test('draws the title at 24/30 in weight 700 and the count apart from it', async ({ page }) => {
    await openKit(page, 'header');
    const header = specimen(page, 'With a description, a count and an action');
    const title = header.getByRole('heading', { level: 1, name: 'Pickup requests' });

    expect(await px(title, 'font-size')).toBe(24);
    expect(await px(title, 'line-height')).toBe(30);
    expect(await title.evaluate((element) => getComputedStyle(element).fontWeight)).toBe('700');
    expect(await px(title, 'letter-spacing')).toBeCloseTo(-0.48, 1);
    expect(await header.locator('.ui-page-head__count').textContent()).toContain('128');
  });

  // Break caught: the freshness line that lies: not busy while a read is under way, or failing to tell of a failure and to offer the retry.
  test('tells the freshness: updated, checking, failed and updated again, with Refresh in each', async ({
    page,
  }) => {
    await openKit(page, 'header');
    const line = specimen(page, 'Freshness: updated (press Refresh');

    await expect(line.getByRole('status')).toHaveText('Updated 09:42');
    await line.getByRole('button', { name: 'Refresh' }).click();
    await expect(line.getByRole('status')).toHaveText('Checking…');
    await expect(line.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(line.getByRole('status')).toContainText(
      'Refresh failed. Last successful check: 09:42',
    );
    await expect(line.getByRole('status')).toHaveText('Updated 09:42');
  });

  // Break caught: actions that are cut off or push the page sideways on a phone.
  test('wraps its actions under the title and pushes the page nowhere at 390px', async ({
    page,
  }) => {
    await openKit(page, 'header', { width: 390 });

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const narrow = specimen(page, 'In a narrow room: the actions wrap');
    const button = narrow.getByRole('button', { name: 'Book a pickup' });
    const right = (await box(button)).x + (await box(button)).width;
    expect(right).toBeLessThanOrEqual(390);
  });

  // Break caught: an underline that appears at once, one that takes another time than the token's, or one that moves under reduced motion.
  for (const reduced of [false, true]) {
    test(`grows the underline of the current view over the motion token's time${reduced ? ' (none under reduced motion)' : ''}`, async ({
      page,
    }) => {
      await openKit(page, 'header', { reducedMotion: reduced });
      const tab = specimen(page, 'Four views with counts').getByRole('tab', {
        name: /^Needs decision/,
      });

      const underline = await tab.evaluate((element) => {
        const style = getComputedStyle(element, '::after');
        return { duration: style.transitionDuration, height: style.height, scale: style.transform };
      });

      expect(underline.height).toBe('2px');
      expect(underline.scale).toBe('matrix(1, 0, 0, 1, 0, 0)');
      expect(underline.duration).toBe(reduced ? '0s' : '0.2s');
    });
  }

  // Break caught: the Ink pill on the wrong tab, or the keys of a tab list not working in a real browser.
  test('fills the count of the current view in Ink, and the arrows, Home and End move and choose', async ({
    page,
  }) => {
    await openKit(page, 'header');
    const views = specimen(page, 'Four views with counts');
    const pill = (name: RegExp) => views.getByRole('tab', { name }).locator('.ui-view-tabs__count');
    const ink = await resolvedColour(page, '--color-action-primary', 'backgroundColor');

    expect(
      await pill(/^Needs decision/).evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).toBe(ink);
    expect(
      await pill(/^Confirmed/).evaluate((element) => getComputedStyle(element).backgroundColor),
    ).not.toBe(ink);
    await views.getByRole('tab', { name: /^Needs decision/ }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(views.getByRole('tab', { name: /^Confirmed/ })).toBeFocused();
    // The arrows only move (task R5.2, M12: manual activation): the view changes, and the page reads the server, on Enter or Space.
    await expect(views.getByRole('tab', { name: /^Confirmed/ })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await page.keyboard.press('Enter');
    await expect(views.getByRole('tab', { name: /^Confirmed/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      await pill(/^Confirmed/).evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(ink);
    await page.keyboard.press('End');
    await expect(views.getByRole('tab', { name: /^All/ })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(views.getByRole('tab', { name: /^Needs decision/ })).toBeFocused();
  });

  // Break caught: a chip that cannot be removed with the keyboard, or one that loses the person's place.
  test('removes a chip from the keyboard and focus stays in the bar; the popover opens, takes focus and gives it back', async ({
    page,
  }) => {
    await openKit(page, 'header');
    const bar = specimen(page, 'Three filters, with Clear all').getByRole('group', {
      name: 'Filters',
    });

    await bar.getByRole('button', { name: 'Remove filter: Service date: this week' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      bar.getByRole('button', { name: 'Remove filter: State: Confirmed' }),
    ).toBeFocused();
    await expect(bar.getByText('Service date: this week')).toHaveCount(0);

    const add = bar.getByRole('button', { name: 'Filter', exact: true });
    await add.focus();
    await page.keyboard.press('Enter');
    const popover = page.getByRole('dialog', { name: 'Filter' });
    await expect(popover).toBeVisible();
    expect(await focusIn(page, '[data-slot="popover-content"]')).toBe(true);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(add).toBeFocused();
  });

  // Break caught: the bar's dashed button drawn as an ordinary one, the chips and the button not sharing a line, or the bar wider than a phone.
  test('draws the Filter button dashed, on the line of the chips, and wraps without sideways scrolling at 390px', async ({
    page,
  }) => {
    await openKit(page, 'header', { width: 390 });
    const bar = specimen(page, 'Three filters, with Clear all').getByRole('group', {
      name: 'Filters',
    });
    const add = bar.getByRole('button', { name: 'Filter', exact: true });

    expect(await add.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe(
      'dashed',
    );
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect((await box(add)).height).toBeGreaterThanOrEqual(32);
  });
});

test.describe('DataTable in a browser', () => {
  // Break caught: a row taller or shorter than the density says: 36px for a line, 52px for a code over a name, 56px for a tablet.
  for (const [caption, label, height] of [
    ['Single line, 36px rows', 'Pickup requests, single line', 36],
    ['Two lines (a code over a name)', 'Pickup requests, two lines', 52],
    ['Touch rows, 56px', 'Pickup requests, touch rows', 56],
  ] as const) {
    test(`draws its rows ${String(height)}px tall`, async ({ page }) => {
      await openKit(page, 'data');
      const rows = specimen(page, caption).getByRole('table', { name: label }).locator('tbody tr');

      expect((await box(rows.first())).height).toBeCloseTo(height, 0);
      expect((await box(rows.nth(1))).height).toBeCloseTo(height, 0);
    });
  }

  // Break caught: the code in the body face, or too light.
  test('sets the codes in the monospaced face at weight 600', async ({ page }) => {
    await openKit(page, 'data');
    const code = specimen(page, 'Single line, 36px rows').locator('tbody .ui-code').first();

    const look = await code.evaluate((element) => {
      const style = getComputedStyle(element);
      return { family: style.fontFamily, weight: style.fontWeight };
    });
    expect(look.family).toContain('JetBrains Mono');
    expect(look.weight).toBe('600');
  });

  // Break caught: the open act as a handler on a smaller target: a click anywhere on the row, on a cell that holds no control, must open the record.
  test('opens the record on a press anywhere on the row, through the one button in the code cell', async ({
    page,
  }) => {
    await openKit(page, 'data');
    const specimenBox = specimen(page, 'Single line, 36px rows');
    const row = specimenBox.getByRole('table').locator('tbody tr').nth(2);
    // The last cell that is drawn: the packages column goes first when the table's box is narrow (task R5.2, M12: priority 3), so it is not always there.
    const target = await box(row.locator('td:visible').last());
    const button = row.getByRole('button', { name: /^Open ACC-PR-2MX8RC/ });

    // The button is stretched: its pseudo-element covers the row, so a press at the far end of the row is a press on it.
    expect((await box(button)).width).toBeLessThan(target.x);
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);

    await expect(specimenBox.getByText('Opened ACC-PR-2MX8RC.')).toBeVisible();
  });

  // Break caught: Space opening the record, Enter doing nothing, or the arrows leaving the row they are on.
  test('moves between rows with the arrows, opens with Enter and chooses with Space', async ({
    page,
  }) => {
    await openKit(page, 'data');
    const two = specimen(page, 'Two lines (a code over a name)');
    const open = (code: string) => two.getByRole('button', { name: new RegExp(`^Open ${code}`) });

    await open('ACC-PR-7KQ2MZ').focus();
    await page.keyboard.press('ArrowDown');
    await expect(open('ACC-PR-4HT9WD')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await expect(open('ACC-PR-7KQ2MZ')).toBeFocused();
    await page.keyboard.press('End');
    // The last of the eight sample rows.
    await expect(open('ACC-PR-5RB7ZK')).toBeFocused();
    await page.keyboard.press('Home');

    await page.keyboard.press('Space');
    await expect(two.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).toBeChecked();
    await expect(two.locator('.showcase-kit-opened')).toHaveText('No record is open.');
    await page.keyboard.press('Enter');
    await expect(
      two.getByText('Opened ACC-PR-7KQ2MZ. The page decides what that shows.'),
    ).toBeVisible();
  });

  // Break caught: a bar that is not announced, whose act does not reach the rows it can act on, that counts a row it cannot act on, or that moves the rows more than once. The
  // bar is above the rows and sticks (task R5.2, M12: it used to float over the last rows and push none), so the rows move down by its height once, when it comes.
  test('brings the bar of acts in above the rows, counts the rows it can act on, and confirms them', async ({
    page,
  }) => {
    await openKit(page, 'data');
    const two = specimen(page, 'Two lines (a code over a name)');
    const first = two.getByRole('table').locator('tbody tr').first();
    // Where the first row is in the document: the page scrolls to the boxes that are checked, so a position in the window would change.
    const fromTop = async (): Promise<number> =>
      (await box(first)).y + (await page.evaluate(() => window.scrollY));
    const before = await fromTop();

    // Two that are waiting, and one that is confirmed already: the bar counts three chosen, and the act is for the two it can be taken on.
    await two.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }).check();
    await two.getByRole('checkbox', { name: 'Select ACC-PR-9WXH4T' }).check();
    await two.getByRole('checkbox', { name: 'Select ACC-PR-4HT9WD' }).check();
    const bar = two.getByRole('group', { name: 'Actions for the chosen rows' });
    await expect(bar).toBeVisible();
    await expect(bar.getByText('3 selected')).toBeVisible();
    await expect(bar.getByText('1 is already confirmed or cancelled')).toBeVisible();
    await expect(two.getByRole('status').filter({ hasText: '3 selected' })).toHaveCount(1);
    const height = (await box(bar)).height;
    await expect
      .poll(async () => Math.round((await fromTop()) - before))
      .toBeGreaterThanOrEqual(Math.round(height) - 1);
    expect((await fromTop()) - before).toBeLessThanOrEqual(height + 24);

    await bar.getByRole('button', { name: 'Confirm 2' }).click();
    await expect(bar).toBeHidden();
    await expect(first.locator('xpath=..').locator('tr[data-changed="true"]')).toHaveCount(2);
  });

  // Break caught: a bar that appears with no slide and no fade, or that slides for a person who asked the system for less motion. The bar is read the moment
  // it is drawn (before any frame has moved it), so the check does not depend on how fast the machine is.
  for (const reduced of [false, true]) {
    test(`brings the bar of acts in 12px high and faded${reduced ? ' (it does not under reduced motion)' : ''}`, async ({
      page,
    }) => {
      await openKit(page, 'data', { reducedMotion: reduced });

      // React draws the bar in a microtask after the press (a script's click has not returned yet): the page waits for microtasks only, never for a frame, so that
      // the bar is read as it is drawn, before anything has moved it.
      const first = await page.evaluate(async () => {
        const box = document.querySelector<HTMLElement>('[aria-label="Select ACC-PR-4HT9WD"]');
        box?.click();
        for (let turn = 0; turn < 8; turn += 1) {
          if (document.querySelector('.ui-data-table__bulk') !== null) break;
          await Promise.resolve();
        }
        const bar = document.querySelector('.ui-data-table__bulk');
        if (bar === null) return null;
        const style = getComputedStyle(bar);
        return { opacity: Number(style.opacity), y: new DOMMatrix(style.transform).m42 };
      });

      expect(first).not.toBeNull();
      if (reduced) {
        expect(first?.opacity).toBe(1);
        expect(first?.y).toBe(0);
      } else {
        // Not yet at its place: the 12px it comes in from (above, since the bar is above the rows), less what the first moment of the move has covered.
        expect(first?.opacity).toBeLessThan(1);
        expect(first?.y).toBeLessThan(-6);
        expect(first?.y).toBeGreaterThanOrEqual(-12);
      }
    });
  }

  // Break caught: a highlight that never plays, one that plays under reduced motion, or one of another time than the token's 900ms.
  for (const reduced of [false, true]) {
    test(`highlights a changed row over the 900ms token${reduced ? ' (not under reduced motion)' : ''}`, async ({
      page,
    }) => {
      await openKit(page, 'data', { reducedMotion: reduced });
      const two = specimen(page, 'Two lines (a code over a name)');
      await two.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }).check();
      await two.getByRole('button', { name: 'Confirm 1' }).click();

      const changed = two.locator('tr[data-changed="true"]').first();
      await expect(changed).toBeVisible();
      const animation = await changed.evaluate((element) => {
        const style = getComputedStyle(element);
        return { name: style.animationName, duration: style.animationDuration };
      });
      expect(animation.name).toBe('ui-data-table-changed');
      expect(animation.duration).toBe(reduced ? '0s' : '0.9s');
    });
  }

  // Break caught: a row action visible on every row at once (noise), or hidden from a keyboard that reaches it.
  test('shows the inline act on hover, on focus and when the row is chosen, and not otherwise', async ({
    page,
  }) => {
    await openKit(page, 'data');
    const two = specimen(page, 'Two lines (a code over a name)');
    const rows = two.getByRole('table').locator('tbody tr');
    const action = (row: Locator) => row.getByRole('button', { name: /^Confirm ACC-PR/ });
    const opacity = (locator: Locator) =>
      locator.evaluate((element) => getComputedStyle(element).opacity);

    // The first row is waiting for confirmation; the second is confirmed already, so it has no act.
    const waiting = rows.first();
    await expect(action(rows.nth(1))).toHaveCount(0);
    await page.mouse.move(0, 0);
    expect(await opacity(action(waiting))).toBe('0');
    await waiting.hover();
    await expect.poll(() => opacity(action(waiting))).toBe('1');
    await page.mouse.move(0, 0);
    await waiting.getByRole('button', { name: /^Open/ }).focus();
    await expect.poll(() => opacity(action(waiting))).toBe('1');
  });

  // Break caught: a header that scrolls away with the rows, or one that sticks to the page and not to its own box.
  test('keeps the header at the top of its own box while the rows scroll, and scrolls sideways inside it', async ({
    page,
  }) => {
    await openKit(page, 'data', { width: 560 });
    const box20 = specimen(page, 'A box of its own');
    const region = box20.getByRole('region', { name: 'Pickup requests, in a box' });

    await region.evaluate((element) => {
      element.scrollTop = 120;
    });
    const head = region.locator('thead th').first();
    expect(Math.abs((await box(head)).y - (await box(region)).y)).toBeLessThanOrEqual(1);
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  // Break caught: a table that makes a phone's page scroll sideways.
  test('scrolls inside its box and not the page at 390px', async ({ page }) => {
    await openKit(page, 'data', { width: 390 });

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const region = specimen(page, 'Single line, 36px rows').getByRole('region', {
      name: 'Pickup requests, single line',
    });
    expect(await region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
  });

  // Break caught: the failure, the empty and the loading shapes missing in a real page, or a loading table that shows rows.
  test('draws loading, empty, filtered, failed and stale states', async ({ page }) => {
    await openKit(page, 'data');

    const loading = specimen(page, 'Loading: rows of its own shape');
    await expect(loading.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    await expect(loading.getByText('ACC-PR-')).toHaveCount(0);
    await expect(loading.getByRole('status')).toHaveText('Loading pickup requests');
    await expect(specimen(page, 'Nothing there').getByText('Nothing is waiting')).toBeVisible();
    await expect(
      specimen(page, 'Nothing fits the filters').getByRole('button', { name: 'Clear the filters' }),
    ).toBeVisible();
    const failed = specimen(page, 'A failure');
    await failed.getByRole('button', { name: 'Retry' }).click();
    await expect(failed.getByRole('alert')).toContainText('Still no answer after 1 try');
    await expect(specimen(page, 'Stale').getByText(/The list may be out of date/)).toBeVisible();
    await expect(specimen(page, 'Stale').getByRole('rowheader')).toHaveCount(6);
  });

  // Break caught: a total the table was not given.
  test('draws no count of its own anywhere on the page', async ({ page }) => {
    await openKit(page, 'data');

    for (const table of await page.getByRole('table').all()) {
      const text = (await table.textContent()) ?? '';
      expect(text).not.toMatch(/\bof \d+\b|\btotal\b|\bshowing\b/i);
    }
  });
});

test.describe('SidePanel, RecordHeader, DescriptionList, Panel and StatTile in a browser', () => {
  const sample = (page: Page) => specimen(page, 'Beside a list of sample requests');

  // Break caught: a panel narrower or wider than the 360 to 420px of the spec, without the 12px corners and the floating shadow.
  test('is 360 to 420px wide, with 12px corners and the one floating shadow, beside the list', async ({
    page,
  }) => {
    await openKit(page, 'panels', { width: 1440 });
    await sample(page).getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' }).click();
    const panel = page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
    await expect(panel).toBeVisible();

    const width = (await box(panel)).width;
    expect(width).toBeGreaterThanOrEqual(360);
    expect(width).toBeLessThanOrEqual(420);
    expect(await px(panel, 'border-top-left-radius')).toBe(12);
    expect(await panel.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  });

  // Break caught: focus left behind the panel when it opens, or lost to the page when it closes: it goes in, and back to the row.
  test('moves focus in when it opens and back to the row when it closes, and Escape closes it', async ({
    page,
  }) => {
    await openKit(page, 'panels', { width: 1440 });
    const row = sample(page).getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' });

    await row.focus();
    await page.keyboard.press('Enter');
    // The panel's own heading: the record headers of the page below carry the same code.
    await expect(
      page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' }).getByRole('heading', { level: 2 }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Open full page' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeHidden();
    await expect(row).toBeFocused();
  });

  // Break caught: a panel that appears without the 18px slide and the fade, or that moves under reduced motion.
  for (const reduced of [false, true]) {
    test(`comes in 18px and faded${reduced ? ' (it does not under reduced motion)' : ''}`, async ({
      page,
    }) => {
      await openKit(page, 'panels', { width: 1440, reducedMotion: reduced });

      // The panel is read the moment it is drawn: React draws it in a microtask after the press (a script's click has not returned yet), so the page waits for
      // microtasks only and never for a frame, and the check does not depend on how fast the machine is.
      const first = await page.evaluate(async () => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => candidate.textContent === 'Open ACC-PR-7KQ2MZ',
        );
        button?.click();
        for (let turn = 0; turn < 8; turn += 1) {
          if (document.querySelector('aside.ui-side-panel') !== null) break;
          await Promise.resolve();
        }
        const aside = document.querySelector('aside.ui-side-panel');
        if (aside === null) return null;
        const style = getComputedStyle(aside);
        return { opacity: Number(style.opacity), x: new DOMMatrix(style.transform).m41 };
      });

      expect(first).not.toBeNull();
      if (reduced) {
        expect(first?.opacity).toBe(1);
        expect(first?.x).toBe(0);
      } else {
        // Not yet at its place: the 18px it comes in from, less what the first moment of the move has covered.
        expect(first?.opacity).toBeLessThan(1);
        expect(first?.x).toBeGreaterThan(9);
        expect(first?.x).toBeLessThanOrEqual(18);
      }
    });
  }

  // Break caught: a sheet that is not the whole screen at 768px and below, or that lets the page behind it be reached; focus not going back to the row.
  for (const width of [768, 390]) {
    test(`is a full-screen sheet at ${String(width)}px that keeps the page out of reach and gives focus back to the row`, async ({
      page,
    }) => {
      await openKit(page, 'panels', { width });
      const row = sample(page).getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' });

      await row.scrollIntoViewIfNeeded();
      await row.click();
      const sheet = page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
      await expect(sheet).toBeVisible();
      expect(Math.round((await box(sheet)).width)).toBe(width);
      // The header is a row with the code at its start, as the docked panel's is, and not a centred column (the primitive's header is a column).
      expect((await box(sheet.getByRole('heading', { level: 2 }))).x).toBeLessThan(width / 4);
      await expect(page.getByRole('heading', { level: 2, name: 'ACC-PR-7KQ2MZ' })).toBeFocused();
      await expect(page.getByRole('button', { name: 'Open ACC-PR-4HT9WD' })).toHaveCount(0);

      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(row).toBeFocused();
    });
  }

  // Break caught: the code of a record not 26/32 in the monospaced face, or a tracker drawn in colours that are not the tokens' for done, current and not reached.
  test('draws the code at 26/32 in the monospaced face, and the stages in the colours of the tokens', async ({
    page,
  }) => {
    await openKit(page, 'panels');
    const header = specimen(page, 'At the second stage');
    const code = header.getByRole('heading', { level: 2, name: 'ACC-PR-7KQ2MZ' });

    expect(await px(code, 'font-size')).toBe(26);
    expect(await px(code, 'line-height')).toBe(32);
    expect(
      await code.locator('.ui-code').evaluate((element) => getComputedStyle(element).fontFamily),
    ).toContain('JetBrains Mono');
    const bars = header.locator('.ui-stage-tracker__bar');
    const colourOf = (index: number) =>
      bars.nth(index).evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(await colourOf(0)).toBe(
      await resolvedColour(page, '--color-text-secondary', 'backgroundColor'),
    );
    expect(await colourOf(1)).toBe(
      await resolvedColour(page, '--color-brand-default', 'backgroundColor'),
    );
    expect(await colourOf(2)).toBe(
      await resolvedColour(page, '--color-border-default', 'backgroundColor'),
    );
  });

  // Break caught: a tracker that stacks by the width of the window and not of the room it is in, so that it is squeezed in a narrow column of a wide screen (a
  // panel beside a list): the stages of the narrow specimen are one above the other on a window of 1440px, and those of the wide one are side by side.
  test('stacks its stages when the room is narrow, whatever the width of the window', async ({
    page,
  }) => {
    await openKit(page, 'panels', { width: 1440 });
    const flow = (caption: string): Promise<string> =>
      specimen(page, caption)
        .locator('.ui-stage-tracker')
        .evaluate((element) => getComputedStyle(element).gridAutoFlow);

    expect(await flow('At the second stage')).toBe('column');
    expect(await flow('In a narrow room: the stages stack')).toBe('row');
  });

  // Break caught: a label column that is not 110px, or labels that are not muted.
  test('gives a description list a label column of 110px and muted labels', async ({ page }) => {
    await openKit(page, 'panels', { width: 1440 });
    const list = specimen(page, 'With a code, a badge and a fact not stated');
    const label = list.locator('dt').first();

    expect((await box(label)).width).toBeCloseTo(110, 0);
    expect(await label.evaluate((element) => getComputedStyle(element).color)).toBe(
      await resolvedColour(page, '--color-text-muted', 'color'),
    );
    await expect(list.getByText('Not recorded')).toBeVisible();
  });

  // Break caught: radii other than 12px for a panel and 16px for the page card.
  test('draws a panel with 12px corners and the page card with 16px', async ({ page }) => {
    await openKit(page, 'panels');
    const panel = specimen(page, 'A panel with a title and an action').locator(
      '[data-slot="card"]',
    );
    const card = specimen(page, 'The page card (16px)').locator('[data-slot="card"]');

    expect(await px(panel, 'border-top-left-radius')).toBe(12);
    expect(await px(card, 'border-top-left-radius')).toBe(16);
    expect(await panel.evaluate((element) => getComputedStyle(element).boxShadow)).toBe('none');
  });

  // Break caught: a figure that is not 22px in weight 700, or a label that is not small capitals; one that never reaches its figure, or that counts under
  // reduced motion.
  test('draws a figure at 22px bold with a small capital label, and counts up to the figure exactly', async ({
    page,
  }) => {
    await openKit(page, 'panels');
    const tile = specimen(page, 'A figure with a caption');
    const figure = tile.locator('.ui-stat-tile__value');

    expect(await px(figure, 'font-size')).toBe(22);
    expect(await figure.evaluate((element) => getComputedStyle(element).fontWeight)).toBe('700');
    const label = tile.locator('.ui-stat-tile__label');
    expect(await px(label, 'font-size')).toBeCloseTo(11.5, 1);
    expect(await label.evaluate((element) => getComputedStyle(element).textTransform)).toBe(
      'uppercase',
    );

    const counting = specimen(page, 'Counts up once');
    await expect(counting.locator('.ui-stat-tile__value')).toHaveText('248', { timeout: 5000 });
  });

  // Break caught: a figure that counts up (with a moving copy and a hidden final one) for a person who asked the system for less motion.
  test('shows the counted figure at once under reduced motion', async ({ page }) => {
    await openKit(page, 'panels', { reducedMotion: true });
    await expect(
      specimen(page, 'Counts up once').locator('.ui-stat-tile__value [aria-hidden="true"]'),
    ).toHaveCount(0);
    await expect(specimen(page, 'Counts up once').locator('.ui-stat-tile__value')).toHaveText(
      '248',
    );
  });

  // Break caught: a figure not stated drawn as 0.
  test('never draws a figure that was not stated as 0', async ({ page }) => {
    await openKit(page, 'panels');

    const missing = specimen(page, 'Not available');
    await expect(missing.locator('.ui-stat-tile__value')).not.toContainText(/\b0\b/);
    await expect(missing.getByText('Not available', { exact: true })).toBeAttached();
    await expect(
      specimen(page, 'Loading: a bar').locator('.ui-stat-tile__value'),
    ).not.toContainText(/\d/);
  });
});

test.describe('ActionMenu and Toast in a browser', () => {
  const trigger = (page: Page) =>
    specimen(page, 'An act that cannot be taken, and a destructive one').getByRole('button', {
      name: 'More actions for ACC-PR-7KQ2MZ',
    });

  // Break caught: a menu that a keyboard cannot open, move in, leave, or that gives focus to the wrong place.
  test('opens from the keyboard, lists the destructive act last, and Escape closes it and gives focus back', async ({
    page,
  }) => {
    await openKit(page, 'menus');

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    const names = await menu.getByRole('menuitem').allTextContents();
    expect(names[names.length - 1]).toBe('Cancel request');
    expect(
      await menu
        .getByRole('menuitem', { name: 'Cancel request' })
        .evaluate((element) => getComputedStyle(element).color),
    ).toBe(await resolvedColour(page, '--color-status-danger-foreground', 'color'));
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  // Break caught: an act that is greyed out and says nothing, or one that cannot be reached by the keyboard.
  test('gives the reason of an act that cannot be taken, on focus, and does nothing when it is chosen', async ({
    page,
  }) => {
    await openKit(page, 'menus');

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    const escalate = page.getByRole('menuitem', { name: 'Escalate' });
    await page.keyboard.press('ArrowDown');
    await expect(escalate).toBeFocused();
    await expect(escalate.getByText('An approver decides this.')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(escalate).toHaveAttribute('aria-disabled', 'true');
  });

  // Break caught: a destructive act that runs without a question, or whose question does not start on the safe choice, or does not give focus back.
  test('asks before a destructive act, starts on Cancel, and gives focus back', async ({
    page,
  }) => {
    await openKit(page, 'menus');

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Cancel request' }).click();
    const question = page.getByRole('alertdialog', { name: 'Cancel request ACC-PR-7KQ2MZ?' });
    await expect(question).toBeVisible();
    // The dismiss never repeats the act's verb (task R5.2, M3: the question is about cancelling a request, so its safe button is "Go back", not "Cancel").
    await expect(question.getByRole('button', { name: 'Go back', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(question).toBeHidden();
    await expect(trigger(page)).toBeFocused();
  });

  // Break caught: an open menu or its question that fails a rule only when it is open, in either theme.
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no violation with the menu open, and with its question open, in the ${scheme} theme`, async ({
      page,
    }) => {
      await openKit(page, 'menus', { scheme });

      await trigger(page).click();
      await expect(page.getByRole('menu')).toBeVisible();
      // Radix hides the page behind a menu from assistive technology and holds focus in it; axe takes only a dialog for a modal, and reports the controls
      // behind as hidden but focusable. That one rule is off for the open menu, as in primitives.spec.ts.
      expect(await wcagViolations(page, { disable: ['aria-hidden-focus'] })).toEqual([]);
      await page.getByRole('menuitem', { name: 'Cancel request' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
    });
  }

  const toasts = (page: Page) => page.locator('[data-sonner-toast]');

  // Break caught: a toast that is not at the bottom right, whose disc is not 22px, or whose message is not drawn once.
  test('appears at the bottom right with a 22px disc and the message once', async ({ page }) => {
    await openKit(page, 'menus', { width: 1440 });

    await page.getByRole('button', { name: 'Success', exact: true }).click();
    const toast = page.locator('.ui-toast', { hasText: 'Request ACC-PR-7KQ2MZ confirmed.' });
    await expect(toast).toBeVisible();
    const disc = await box(toast.locator('.ui-toast__disc'));
    expect(Math.round(disc.width)).toBe(22);
    expect(Math.round(disc.height)).toBe(22);
    const at = await box(toast);
    const viewport = page.viewportSize();
    expect(at.x + at.width).toBeGreaterThan((viewport?.width ?? 0) - 60);
    expect(at.y + at.height).toBeGreaterThan((viewport?.height ?? 0) - 60);
    expect(at.x).toBeGreaterThan((viewport?.width ?? 0) / 2);
  });

  // Break caught: a code in a toast broken across two lines like a word ("ACC-MF-" over "Q92422"), which people read aloud on calls and copy: it is in its own
  // element, on one line (found by the screenshots).
  test('keeps a code in the message whole, on one line', async ({ page }) => {
    await openKit(page, 'menus', { width: 1440 });

    await page.getByRole('button', { name: 'With Undo' }).click();
    const code = page.locator('.ui-toast .ui-code', { hasText: 'ACC-MF-Q92422' });
    await expect(code).toBeVisible();

    expect(await code.evaluate((element) => element.getClientRects().length)).toBe(1);
  });

  // Break caught: a toast with an action that goes before the person can use it, one without that never goes, or one that cannot be dismissed.
  test('stays with an action until it is dismissed, and goes by itself without one', async ({
    page,
  }) => {
    await page.clock.install();
    await openKit(page, 'menus');

    await page.getByRole('button', { name: 'Success', exact: true }).click();
    await page.getByRole('button', { name: 'With Open' }).click();
    await expect(toasts(page)).toHaveCount(2);
    await page.clock.runFor(10_000);

    await expect(page.locator('.ui-toast', { hasText: 'confirmed.' })).toHaveCount(0);
    const kept = page.locator('.ui-toast', { hasText: 'Request ACC-PR-7KQ2MZ booked.' });
    await expect(kept).toBeVisible();
    await page.clock.runFor(120_000);
    await expect(kept).toBeVisible();
    await kept.getByRole('button', { name: 'Dismiss this message' }).click();
    await expect(kept).toHaveCount(0);
  });

  // Break caught: a toast that a keyboard cannot reach or use, or that takes focus from the page when it appears.
  test('appears without taking focus, is reached with Alt+T, and its action works from the keyboard', async ({
    page,
  }) => {
    await openKit(page, 'menus');
    const button = page.getByRole('button', { name: 'With Open' });

    await button.focus();
    await page.keyboard.press('Enter');
    await expect(toasts(page)).toHaveCount(1);
    await expect(button).toBeFocused();
    await page.keyboard.press('Alt+T');
    expect(await focusIn(page, '[data-sonner-toaster]')).toBe(true);
    // Sonner's list takes focus, and its toasts are in the Tab order: the toast itself, then its action.
    const open = page.getByRole('button', { name: 'Open', exact: true });
    for (let step = 0; step < 3; step += 1) {
      if (await open.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(open).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toasts(page)).toHaveCount(0);
  });

  // Break caught: two actions that squeeze the message into a few words beside them instead of standing under it, that a keyboard cannot reach in the order primary,
  // secondary, dismiss, that are not told apart (the secondary one is the quieter), or that leave the toast on the screen after one of them is used.
  test('has two actions under the message, told apart, reached from the keyboard in order, and either takes the toast away', async ({
    page,
  }) => {
    await openKit(page, 'menus', { width: 1440 });
    await page.getByRole('button', { name: 'With two actions' }).focus();
    await page.keyboard.press('Enter');
    const toast = page.locator('.ui-toast', { hasText: 'Request ACC-PR-4HT9WD booked.' });
    await expect(toast).toBeVisible();
    // Sonner slides a toast in: the boxes are read once it has arrived, or the message and the actions would be read at two moments of the slide.
    await settled(page);

    // Under the message and not beside it; the dismiss control is at the end of the toast, as it is with one action.
    const message = await box(toast.locator('.ui-toast__message'));
    const actions = await box(toast.locator('.ui-toast__actions'));
    const dismiss = toast.getByRole('button', { name: 'Dismiss this message' });
    expect(actions.y).toBeGreaterThanOrEqual(message.y + message.height - 1);
    expect((await box(dismiss)).x).toBeGreaterThan(actions.x + actions.width - 1);
    // The primary action is in the link colour, the secondary one in the quieter secondary text.
    const primary = toast.getByRole('button', { name: 'Open', exact: true });
    const secondary = toast.getByRole('button', { name: 'Book another', exact: true });
    expect(await colourOf(primary, 'color')).toBe(
      await resolvedColour(page, '--color-text-link', 'color'),
    );
    expect(await colourOf(secondary, 'color')).toBe(
      await resolvedColour(page, '--color-text-secondary', 'color'),
    );

    // The keyboard: Alt+T moves to the toasts, and the Tab order is the primary action, the secondary one, then dismiss.
    await page.keyboard.press('Alt+T');
    for (let step = 0; step < 3; step += 1) {
      if (await primary.evaluate((element) => element === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(primary).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(secondary).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dismiss).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(secondary).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toasts(page)).toHaveCount(0);

    // The primary action takes it away too.
    await page.getByRole('button', { name: 'With two actions' }).click();
    await expect(toast).toBeVisible();
    await primary.click();
    await expect(toasts(page)).toHaveCount(0);
  });

  // Break caught: a toast with two actions that goes before the person can use either (WCAG 2.2.1): any action keeps it until it is dismissed.
  test('stays with two actions until it is dismissed', async ({ page }) => {
    await page.clock.install();
    await openKit(page, 'menus');

    await page.getByRole('button', { name: 'With two actions' }).click();
    const kept = page.locator('.ui-toast', { hasText: 'Request ACC-PR-4HT9WD booked.' });
    await expect(kept).toBeVisible();
    await page.clock.runFor(120_000);
    await expect(kept).toBeVisible();
    await kept.getByRole('button', { name: 'Dismiss this message' }).click();
    await expect(kept).toHaveCount(0);
  });

  // Break caught: a toast that fails a rule in either theme, with an action showing, and with two.
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no violation with toasts showing, in the ${scheme} theme`, async ({ page }) => {
      await openKit(page, 'menus', { scheme });
      await page.getByRole('button', { name: 'With Undo' }).click();
      await page.getByRole('button', { name: 'Danger', exact: true }).click();
      await page.getByRole('button', { name: 'With two actions' }).click();
      await expect(toasts(page)).toHaveCount(3);

      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});

test.describe('ReorderList in a browser', () => {
  const stops = (page: Page) =>
    specimen(page, 'Four stops').getByRole('list', { name: 'Stops of the sample run' });
  const order = (page: Page) => stops(page).locator('.ui-code').allTextContents();

  // Break caught: a move that does not change the order, that loses the focus, or that jumps: it glides, and the glide is the layout animation of Motion.
  test('moves a stop, keeps focus on the button, and glides to the new place', async ({ page }) => {
    await openKit(page, 'lists');
    const down = stops(page).getByRole('button', { name: 'Move Stop 1, ACC-PR-7KQ2MZ down' });

    await down.focus();
    const sampled = await page.evaluate(async () => {
      const button = document.activeElement;
      if (!(button instanceof HTMLElement)) return null;
      const item = button.closest('li');
      const before = item?.getBoundingClientRect().top ?? 0;
      button.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return { before, transform: item === null ? '' : getComputedStyle(item).transform };
    });

    expect(await order(page)).toEqual([
      'ACC-PR-4HT9WD',
      'ACC-PR-7KQ2MZ',
      'ACC-PR-2MX8RC',
      'ACC-PR-9WXH4T',
    ]);
    await expect(
      stops(page).getByRole('button', { name: 'Move Stop 2, ACC-PR-7KQ2MZ down' }),
    ).toBeFocused();
    // Mid-flight, the item is carried by a transform; once it has landed there is none.
    expect(sampled?.transform).not.toBe('none');
    await expect
      .poll(() =>
        stops(page)
          .locator('li')
          .first()
          .evaluate((element) => getComputedStyle(element).transform),
      )
      .toBe('none');
  });

  // Break caught: a glide under reduced motion.
  test('does not glide under reduced motion', async ({ page }) => {
    await openKit(page, 'lists', { reducedMotion: true });
    await stops(page).getByRole('button', { name: 'Move Stop 1, ACC-PR-7KQ2MZ down' }).focus();

    const transform = await page.evaluate(async () => {
      const button = document.activeElement;
      if (!(button instanceof HTMLElement)) return null;
      const item = button.closest('li');
      button.click();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return item === null ? null : getComputedStyle(item).transform;
    });

    expect(transform).toBe('none');
    expect(await order(page)).toEqual([
      'ACC-PR-4HT9WD',
      'ACC-PR-7KQ2MZ',
      'ACC-PR-2MX8RC',
      'ACC-PR-9WXH4T',
    ]);
  });
});

test.describe('StatusBadge, CountBadge and Avatar in a browser', () => {
  // Break caught: a badge without its dot, a dot that is not a 6px circle in the colour of its words, or a pair drawn in colours other than its tokens (a hand-picked colour).
  test('draws each of the five pairs in the colours of its tokens, with a 6px round dot', async ({
    page,
  }) => {
    await openKit(page, 'badges');
    const pairs = specimen(page, 'The five pairs');

    for (const [pair, token] of [
      ['waiting', 'warning'],
      ['success', 'success'],
      ['info', 'info'],
      ['neutral', 'neutral'],
      ['danger', 'danger'],
    ] as const) {
      const badge = pairs.locator(`.ui-status-badge--${pair}`);
      await expect(badge, pair).toHaveCount(1);
      const foreground = await resolvedColour(page, `--color-status-${token}-foreground`, 'color');
      expect(await colourOf(badge, 'color'), pair).toBe(foreground);
      expect(await colourOf(badge, 'backgroundColor'), pair).toBe(
        await resolvedColour(page, `--color-status-${token}-background`, 'backgroundColor'),
      );
      const dot = badge.locator('.ui-status-badge__dot');
      const found = await box(dot);
      expect([Math.round(found.width), Math.round(found.height)], pair).toEqual([6, 6]);
      expect(await colourOf(dot, 'backgroundColor'), pair).toBe(foreground);
      expect(await px(dot, 'border-top-left-radius'), pair).toBeGreaterThanOrEqual(3);
    }
  });

  // Break caught: a variant of the count drawn in other colours than the ones named for it: strong is the primary action's pair, on-crimson is white at 18% on the crimson, and a 0 that was
  // read has no fill in either.
  test('draws strong as Ink with a white figure and on-crimson as white at 18%, and a 0 without a fill', async ({
    page,
  }) => {
    await openKit(page, 'badges');
    const strong = specimen(page, 'Strong, for the current view').locator('.ui-count-badge');
    expect(await colourOf(strong.nth(1), 'backgroundColor')).toBe(
      await resolvedColour(page, '--color-action-primary', 'backgroundColor'),
    );
    expect(await colourOf(strong.nth(1), 'color')).toBe(
      await resolvedColour(page, '--color-action-primary-text', 'color'),
    );
    expect(await colourOf(strong.nth(0), 'backgroundColor')).toBe('rgba(0, 0, 0, 0)');

    const onCrimson = specimen(page, 'On crimson').locator('.ui-count-badge');
    expect(await colourOf(onCrimson.first(), 'backgroundColor')).toBe(
      await resolvedColour(page, '--shell-active-badge', 'backgroundColor'),
    );
    expect(await colourOf(onCrimson.first(), 'color')).toBe(
      await resolvedColour(page, '--shell-active-text', 'color'),
    );
    expect(await colourOf(onCrimson.nth(1), 'backgroundColor')).toBe('rgba(0, 0, 0, 0)');
  });

  // Break caught: an avatar that is a circle, in the muted text colour that does not read on its ground (4.22:1), or of a size other than 24, 32 and 40px; and a picture that
  // never replaces the initials once it has loaded.
  test('draws the initials in text.secondary on surface.selected, in an 8px tile of 24, 32 and 40px', async ({
    page,
  }) => {
    await openKit(page, 'badges');
    const sizes = specimen(page, 'Sizes: 24, 32 and 40px').locator('.ui-avatar');
    const found: number[][] = [];
    for (const avatar of await sizes.all()) {
      const at = await box(avatar);
      found.push([Math.round(at.width), Math.round(at.height)]);
    }
    expect(found).toEqual([
      [24, 24],
      [32, 32],
      [40, 40],
    ]);

    expect(await px(sizes.nth(1), 'border-top-left-radius')).toBe(8);
    const fallback = sizes.nth(1).locator('.ui-avatar__fallback');
    expect(await colourOf(fallback, 'backgroundColor')).toBe(
      await resolvedColour(page, '--color-surface-selected', 'backgroundColor'),
    );
    expect(await colourOf(fallback, 'color')).toBe(
      await resolvedColour(page, '--color-text-secondary', 'color'),
    );

    await expect(specimen(page, 'A picture, once it has loaded').locator('img')).toHaveCount(2);
  });
});

test.describe('EmptyState v2, Skeleton v2 and LoadingRow in a browser', () => {
  // Break caught: a motif that is not a 10px square of the brand crimson, an all-clear that does not read as good news, or an empty state drawn in a frame of its own.
  test('draws a 10px crimson square, and the all-clear title in the success colour, with no frame', async ({
    page,
  }) => {
    await openKit(page, 'states');
    const empty = specimen(page, 'Empty: nothing yet, with the next step').locator('.ui-empty-v2');
    const motif = empty.locator('.ui-empty-v2__motif');
    const at = await box(motif);
    expect([Math.round(at.width), Math.round(at.height)]).toEqual([10, 10]);
    expect(await colourOf(motif, 'backgroundColor')).toBe(
      await resolvedColour(page, '--color-brand-default', 'backgroundColor'),
    );
    expect(await px(empty, 'border-top-width')).toBe(0);

    const clear = specimen(page, 'All-clear: worked to nothing').locator('.ui-empty-v2__title');
    expect(await colourOf(clear, 'color')).toBe(
      await resolvedColour(page, '--color-status-success-foreground', 'color'),
    );
  });

  // Break caught: a placeholder that pulses for someone who asked for no motion, or one that does not pulse for someone who did not.
  for (const reduced of [false, true]) {
    test(`pulses the bars of a loading card only where motion is welcome${reduced ? ' (it does not under reduced motion)' : ''}`, async ({
      page,
    }) => {
      await openKit(page, 'states', { reducedMotion: reduced });
      const bar = specimen(page, 'A card with a title and three lines')
        .locator('.ui-skeleton-bar')
        .first();

      const running = await bar.evaluate((element) => element.getAnimations().length);

      if (reduced) expect(running).toBe(0);
      else expect(running).toBeGreaterThan(0);
    });
  }

  // Break caught: loading rows of a height of their own, so that the table jumps when its rows arrive.
  test('keeps the height of a row while the rows load', async ({ page }) => {
    await openKit(page, 'states');
    const queue = specimen(page, "The queue's table while it loads");
    const loading = queue.getByRole('table', { name: 'Pickup requests, loading' });
    const loaded = queue.getByRole('table', { name: 'Pickup requests, loaded' });

    const loadingRow = await box(loading.locator('tbody tr').first());
    const loadedRow = await box(loaded.locator('tbody tr').first());

    expect(Math.round(loadingRow.height)).toBe(Math.round(loadedRow.height));
  });
});

test.describe('Tooltip, Popover and Dialog in a browser', () => {
  const tooltip = (page: Page) => page.locator('[data-slot="tooltip-content"]');
  const confirm = (page: Page) =>
    specimen(page, 'A hint on a button').getByRole('button', { name: 'Confirm the request' });

  // Break caught: a tooltip that is there at once under the pointer (it flickers over what the pointer crosses), that never comes by keyboard focus, or that stays after Escape. The wait
  // is measured inside the page, from the pointer event to the tooltip's being drawn, so that the time the test takes to ask does not count.
  test('appears after 300ms under the pointer, at once on keyboard focus, and goes with Escape', async ({
    page,
  }) => {
    await openKit(page, 'overlays');
    const words = 'Tells the vendor that the hub has confirmed this pickup.';

    const waited = await confirm(page).evaluate(async (element) => {
      const start = performance.now();
      element.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }),
      );
      while (document.querySelector('[data-slot="tooltip-content"]') === null) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return performance.now() - start;
    });
    expect(waited).toBeGreaterThanOrEqual(290);
    await page.keyboard.press('Escape');
    await expect(tooltip(page)).toHaveCount(0);

    await confirm(page).focus();
    await expect(tooltip(page)).toContainText(words);
    await page.keyboard.press('Escape');
    await expect(tooltip(page)).toHaveCount(0);
    await expect(confirm(page)).toBeFocused();
  });

  // Break caught: a tooltip that stands other than 8px from what it names, or without the one floating shadow.
  test('stands 8px above its button on the floating shadow', async ({ page }) => {
    await openKit(page, 'overlays');

    await confirm(page).focus();
    await expect(tooltip(page)).toBeVisible();

    // Measured once the tooltip has finished coming in (it slides and grows into place).
    await expect
      .poll(async () => {
        const button = await box(confirm(page));
        const hint = await box(tooltip(page));
        return Math.round(button.y - (hint.y + hint.height));
      })
      .toBe(8);
    expect(await tooltip(page).evaluate((element) => getComputedStyle(element).boxShadow)).toBe(
      await resolvedShadow(page, '--shadow-floating'),
    );
  });

  const service = (page: Page) =>
    specimen(page, 'Opened from a button').getByRole('button', { name: 'Service date' });

  // Break caught: a popover that a keyboard cannot open, that does not take focus in, that stands other than 8px below its button or without the floating shadow, or that does not give
  // focus back on Escape.
  test('opens from the keyboard, stands 8px below its button, and Escape gives focus back', async ({
    page,
  }) => {
    await openKit(page, 'overlays');
    await service(page).focus();

    await page.keyboard.press('Enter');
    const popover = page.getByRole('dialog', { name: 'Choose a service date' });
    await expect(popover).toBeVisible();

    expect(await focusIn(page, '[data-slot="popover-content"]')).toBe(true);
    await expect
      .poll(async () => {
        const button = await box(service(page));
        const panel = await box(popover);
        return Math.round(panel.y - (button.y + button.height));
      })
      .toBe(8);
    expect(await popover.evaluate((element) => getComputedStyle(element).boxShadow)).toBe(
      await resolvedShadow(page, '--shadow-floating'),
    );
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(service(page)).toBeFocused();
  });

  // Break caught: a popover opened inside a dialog that is drawn under it (the page behind a modal dialog cannot be reached), or whose Escape closes the dialog with it.
  test('opens inside a dialog, drawn into it, and Escape closes only the popover', async ({
    page,
  }) => {
    await openKit(page, 'overlays');
    await specimen(page, 'A dialog with a form')
      .getByRole('button', { name: 'Add a note' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add a note' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Choose a hub' }).click();
    const popover = page.getByRole('dialog', { name: 'Choose a hub for the note' });
    await expect(popover).toBeVisible();
    await expect(page.locator('dialog [data-slot="popover-content"]')).toHaveCount(1);
    await expect(popover.getByText('Tema')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(dialog).toBeVisible();
  });

  // Break caught: an open tooltip, popover or dialog that fails a rule only when it is open, in either theme.
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no violation with a tooltip, a popover and a dialog open, in the ${scheme} theme`, async ({
      page,
    }) => {
      await openKit(page, 'overlays', { scheme });

      await confirm(page).focus();
      await expect(tooltip(page)).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);

      await service(page).click();
      await expect(page.getByRole('dialog', { name: 'Choose a service date' })).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');

      await specimen(page, 'A dialog with a form')
        .getByRole('button', { name: 'Add a note' })
        .click();
      await expect(page.getByRole('dialog', { name: 'Add a note' })).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});

test.describe('the composed examples in a browser', () => {
  // Break caught: a queue workspace whose parts do not work together in a page: views, the table, the record beside it, focus.
  test('the queue: the views narrow the rows, a row opens the record beside the table, and Escape gives focus back', async ({
    page,
  }) => {
    await openKit(page, 'example-queue', { width: 1440 });
    const table = page.getByRole('table', { name: 'Pickup requests' });

    const all = await table.locator('tbody tr').count();
    await page.getByRole('tab', { name: /^Cancelled/ }).click();
    expect(await table.locator('tbody tr').count()).toBeLessThan(all);
    await page.getByRole('tab', { name: /^All/ }).click();

    const row = table.getByRole('button', { name: /^Open ACC-PR-7KQ2MZ/ });
    await row.click();
    const panel = page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
    await expect(panel).toBeVisible();
    // Beside the table, not over it: the panel is to the right of the table's card (the table scrolls inside the card, so the card is the box to compare).
    const card = page.locator('.showcase-kit-card');
    expect((await box(panel)).x).toBeGreaterThanOrEqual(
      (await box(card)).x + (await box(card)).width - 1,
    );
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(row).toBeFocused();
  });

  // Break caught: a table whose square corners are drawn over the rounded corners of its card (the card does not cut what runs to its edges), or whose cells
  // wrap into a taller row when a panel beside it narrows the room (a row is one line, or a code over a name; what does not fit is scrolled to).
  test('the queue cuts its table to the corners of its card and keeps a cell on one line when the room narrows', async ({
    page,
  }) => {
    await openKit(page, 'example-queue', { width: 1440 });
    const card = page.locator('.showcase-kit-card [data-slot="card"]');
    // `clip`, not `hidden`: a box that is `hidden` is a scroll container, which pins a sticky bar inside it to a box that never scrolls (task R5.2, M12).
    expect(await card.evaluate((element) => getComputedStyle(element).overflow)).toBe('clip');
    // What the card cuts must not be the focus ring of the box that scrolls (it takes focus, so that the rows off to the side can be reached): the ring is drawn
    // inside the box, where nothing cuts it.
    const scroller = page.getByRole('region', { name: 'Pickup requests' });
    await scroller.focus();
    expect(await px(scroller, 'outline-width')).toBe(2);
    expect(await px(scroller, 'outline-offset')).toBe(-2);

    await page
      .getByRole('table', { name: 'Pickup requests' })
      .getByRole('button', { name: /^Open ACC-PR-7KQ2MZ/ })
      .click();
    await expect(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
    // The cells of a row, after the box that chooses it and the state: the service date.
    const date = page
      .getByRole('table', { name: 'Pickup requests' })
      .locator('tbody tr')
      .first()
      .getByRole('cell', { name: 'Mon 9 Nov 2026' });
    expect(await date.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap');
    // The text of the date is on one line: the height of the text is one line of the table's text, whatever the row's height.
    expect(
      await date.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
    ).toBe(1);
  });

  // Break caught: a queue workspace that makes the page of a tablet or a phone scroll sideways, because its table does not scroll inside its own box.
  test('the queue fits 1440, 768 and 390px with the table scrolling inside its box', async ({
    page,
  }) => {
    for (const width of [1440, 768, 390]) {
      await openKit(page, 'example-queue', { width });
      expect(await overflow(page), `${String(width)}px`).toBeLessThanOrEqual(0);
    }
  });

  // Break caught: a record page whose two columns do not become one on a narrow screen.
  test('the record page keeps its two columns at 1440px and one at 390px', async ({ page }) => {
    await openKit(page, 'example-record', { width: 1440 });
    const main = await box(page.getByRole('heading', { level: 3, name: 'Pickup' }));
    const side = await box(page.getByRole('heading', { level: 3, name: 'Sender' }));
    expect(side.x).toBeGreaterThan(main.x + 200);

    await openKit(page, 'example-record', { width: 390 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const narrowMain = await box(page.getByRole('heading', { level: 3, name: 'Pickup' }));
    const narrowSide = await box(page.getByRole('heading', { level: 3, name: 'Sender' }));
    expect(narrowSide.y).toBeGreaterThan(narrowMain.y);
  });

  // Break caught: a hub-floor task whose targets are smaller than 56px on the tablet, or one that shows the sender's declared count before the count is sent.
  test('the tablet blind count has 56px rows and targets, and shows no declared count', async ({
    page,
  }) => {
    await openKit(page, 'example-count', { width: 768 });
    const rows = page.getByRole('table', { name: 'Parcels to count' }).locator('tbody tr');

    // A row is as tall as its density, or as its tallest control with a little air: here a row holds a 56px control, 4px above and below it, and the 1px
    // separator (the rows of the touch density alone are exactly 56px: the data page measures them).
    const rowHeight = (await box(rows.first())).height;
    expect(rowHeight).toBeGreaterThanOrEqual(56);
    expect(rowHeight).toBeLessThanOrEqual(66);
    for (const control of [
      page.getByRole('button', { name: 'One more parcel from Sample Fabrics Ltd' }),
      page.getByRole('button', { name: 'One fewer parcel from Sample Fabrics Ltd' }),
      page.getByRole('textbox', { name: 'Parcels counted from Sample Fabrics Ltd' }),
      page.getByRole('button', { name: 'Send the count' }),
      page.getByRole('button', { name: 'Save and come back' }),
    ]) {
      const found = await box(control);
      expect(found.height).toBeGreaterThanOrEqual(55.5);
      expect(found.width).toBeGreaterThanOrEqual(55.5);
    }
    await expect(page.getByText(/declared/i)).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  // Break caught: a count that can be sent with a line not counted (the officer would send a count that is not whole), or never enabled once every line is.
  test('the tablet blind count sends only when every line is counted', async ({ page }) => {
    await openKit(page, 'example-count', { width: 768 });
    const send = page.getByRole('button', { name: 'Send the count' });

    await expect(send).toBeDisabled();
    for (const name of ['Sample Fabrics Ltd', 'Sample Bakery', 'Sample Pharmacy', 'Sample Books']) {
      await page.getByRole('textbox', { name: `Parcels counted from ${name}` }).fill('3');
    }
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.locator('.ui-toast', { hasText: 'Your count was sent.' })).toBeVisible();
  });
});

/**
 * The browser proof of task R5.2, M9: every page of the kit on the narrowest screen with the largest text, and under forced colours. The kit's pages have the scan of
 * WCAG 2.2 in both themes above; these are the conditions that scan does not make.
 */
test.describe('the kit on a 320px screen with the text at 200%: WCAG 1.4.4 and 1.4.10', () => {
  const enlarge = (page: Page) =>
    page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

  // Break caught: a component that is wider than the narrowest screen, as it is or with the text twice as large (a code, a badge or a row that does not wrap, a width in
  // pixels), which scrolls the whole page sideways: found in the record's title, a description value, a stop in a list and a long status.
  for (const group of GROUPS) {
    test(`the ${group} page does not scroll sideways, and has no violation, at 200%`, async ({
      page,
    }) => {
      const seen = await openKit(page, group, { width: 320, height: 640 });
      expect(await overflow(page), 'at 100%').toBeLessThanOrEqual(0);

      await enlarge(page);
      expect(await overflow(page), 'at 200%').toBeLessThanOrEqual(0);
      expect(await wcagViolations(page)).toEqual([]);
      expect(seen.problems).toEqual([]);
    });
  }

  // Break caught: a size written in pixels, which leaves a row, a tab or a button as it was when the text is enlarged, so that the larger words are cut or crowd their box
  // (WCAG 1.4.4).
  test('grows a row, a tab, a chip and a button with the text', async ({ page }) => {
    await openKit(page, 'data', { width: 1440, height: 900 });
    const row = specimen(page, 'Single line, 36px rows').locator('tbody tr').first();
    const rowBefore = (await box(row)).height;
    await openKit(page, 'header', { width: 1440, height: 900 });
    const tab = page.locator('.ui-view-tabs__tab').first();
    const chip = page.locator('.ui-filter-bar__chip').first();
    const tabBefore = (await box(tab)).height;
    const chipBefore = (await box(chip)).height;

    await enlarge(page);

    expect((await box(tab)).height, 'a tab').toBeGreaterThanOrEqual(tabBefore * 1.6);
    expect((await box(chip)).height, 'a chip').toBeGreaterThanOrEqual(chipBefore * 1.6);
    await openKit(page, 'data', { width: 1440, height: 900 });
    await enlarge(page);
    expect(
      (await box(specimen(page, 'Single line, 36px rows').locator('tbody tr').first())).height,
      'a row',
    ).toBeGreaterThanOrEqual(rowBefore * 1.6);
  });

  // Break caught: an open menu, popover, panel or toast wider than the screen, or pushed off its edge, when the text is large: what opens is part of the reflow. Motion is
  // reduced, so that each box is measured where it rests and not part-way through its entrance.
  test('keeps the menu, the filter popover, the side panel as a sheet and a toast inside the screen', async ({
    page,
  }) => {
    const inside = async (locator: Locator, what: string) => {
      const found = await box(locator);
      expect(found.x, `${what}: left edge`).toBeGreaterThanOrEqual(-0.5);
      expect(found.x + found.width, `${what}: right edge`).toBeLessThanOrEqual(320.5);
    };

    await openKit(page, 'menus', { width: 320, height: 640, reducedMotion: true });
    await enlarge(page);
    await page
      .getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' })
      .first()
      .scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' }).first().click();
    await inside(page.getByRole('menu'), 'the menu');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Success', exact: true }).click();
    await inside(page.locator('.ui-toast').first(), 'the toast');
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await openKit(page, 'header', { width: 320, height: 640, reducedMotion: true });
    await enlarge(page);
    const filter = specimen(page, 'Three filters, with Clear all').getByRole('button', {
      name: 'Filter',
      exact: true,
    });
    await filter.scrollIntoViewIfNeeded();
    await filter.click();
    await inside(page.getByRole('dialog', { name: 'Filter' }), 'the filter popover');
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await openKit(page, 'panels', { width: 320, height: 640, reducedMotion: true });
    await enlarge(page);
    const row = specimen(page, 'Beside a list of sample requests').getByRole('button', {
      name: 'Open ACC-PR-7KQ2MZ',
    });
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await inside(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' }), 'the sheet');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe('the kit under forced colours: a fill is never the only thing that draws a surface or tells a state', () => {
  test.skip(
    ({ browserName }) => browserName === 'webkit',
    'Playwright cannot emulate forced colours in WebKit; the rules are held by the stylesheets and the token guard.',
  );

  /** What a system colour resolves to in this page (as a background, which is what a fill is drawn in). */
  const system = (page: Page, name: 'Highlight' | 'CanvasText' | 'Canvas'): Promise<string> =>
    page.evaluate((value) => {
      const probe = document.createElement('span');
      probe.style.background = value;
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return resolved;
    }, name);

  /** Whether an element draws an edge of its own: a border on a side, or an outline. A shadow is not one: forced colours drop it. */
  const edged = (locator: Locator): Promise<boolean> =>
    locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const border = ['Top', 'Right', 'Bottom', 'Left'].some(
        (side) =>
          parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
          style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none',
      );
      return border || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0);
    });

  /**
   * The classes of the kit on the page, each with whether its first element is a fill (a background that is not its parent's) and draws an edge. Read in the normal colours
   * and again in forced colours on the same page, a surface that was drawn by its fill alone is the one that has lost its edge.
   */
  const surfaces = (page: Page) =>
    page.evaluate(() => {
      const found: Record<string, { filled: boolean; edged: boolean }> = {};
      const transparent = (colour: string) =>
        colour === 'transparent' || /^rgba\(.*,\s*0\)$/.test(colour) || /\/\s*0\)$/.test(colour);
      for (const element of document.querySelectorAll('[class*="ui-"]')) {
        const at = element.getBoundingClientRect();
        if (at.width < 6 || at.height < 6) continue;
        const style = getComputedStyle(element);
        const parent = element.parentElement ? getComputedStyle(element.parentElement) : null;
        const filled =
          !transparent(style.backgroundColor) && style.backgroundColor !== parent?.backgroundColor;
        const border = ['top', 'right', 'bottom', 'left'].some(
          (side) =>
            parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
            style.getPropertyValue(`border-${side}-style`) !== 'none',
        );
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
        for (const name of String(element.getAttribute('class')).split(/\s+/)) {
          if (name.startsWith('ui-') && !(name in found))
            found[name] = { filled, edged: border || outline };
        }
      }
      return found;
    });

  /**
   * Fills that are not surfaces of their own: the scroller sits inside the table's frame, which has the edge; the header of the table is a `thead`, whose cells carry the
   * rule under it; the dot of a badge is a mark, which the test of the badge holds to a system colour.
   */
  const NOT_A_SURFACE = new Set([
    'ui-data-table__scroller',
    'ui-data-table__head',
    'ui-status-badge__dot',
  ]);

  // Break caught: a component drawn by its fill alone (a tile on a tinted ground, a chip, a dot), which forced colours replace with the page's own ground, so that it has no
  // boundary and no mark at all. Every filled class of every page is read in the normal colours and again in forced colours, so that a new component is held too.
  for (const group of GROUPS) {
    test(`the ${group} page keeps an edge or an outline on every fill`, async ({ page }) => {
      await openKit(page, group, { width: 1440, height: 900, reducedMotion: true });
      const before = await surfaces(page);
      await page.emulateMedia({ forcedColors: 'active' });
      expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
      const after = await surfaces(page);

      const lost = Object.entries(before)
        .filter(([name, mark]) => mark.filled && !NOT_A_SURFACE.has(name))
        .filter(([name]) => after[name] !== undefined && !after[name].edged)
        .map(([name]) => name);

      expect(lost).toEqual([]);
    });
  }

  // Break caught: a status told by a dot that forced colours erase (a `currentcolor` background becomes the page's ground), or a badge with no border.
  test('keeps the dot and the border of a status badge', async ({ page }) => {
    await openKit(page, 'badges', { forcedColors: true });
    const badge = page.locator('.ui-status-badge').first();

    expect(await edged(badge)).toBe(true);
    expect(await colourOf(badge.locator('.ui-status-badge__dot'), 'backgroundColor')).toBe(
      await system(page, 'CanvasText'),
    );
  });

  // Break caught: the current view told by an underline that is a fill (a pseudo-element's background, which forced colours drop), or the current stage by a bar of the
  // colour of the others.
  test('tells the current view and the current stage by a system colour', async ({ page }) => {
    await openKit(page, 'header', { forcedColors: true });
    const current = page.locator('.ui-view-tabs__tab[data-state="active"]').first();
    const other = page.locator('.ui-view-tabs__tab:not([data-state="active"])').first();
    const highlight = await system(page, 'Highlight');
    expect(await current.evaluate((element) => getComputedStyle(element).borderBottomColor)).toBe(
      highlight,
    );
    expect(await other.evaluate((element) => getComputedStyle(element).borderBottomColor)).not.toBe(
      highlight,
    );

    await openKit(page, 'panels', { forcedColors: true });
    const bar = page
      .locator('.ui-stage-tracker__stage[data-state="current"] .ui-stage-tracker__bar')
      .first();
    expect(await colourOf(bar, 'backgroundColor')).toBe(highlight);
    expect(await edged(bar)).toBe(true);
  });

  // Break caught: a chosen row told by its tint alone, a bar of acts with no boundary over the rows, or an item of a menu that the keyboard is on but that is not drawn.
  test('tells a chosen row, the bar of acts and the item a menu is on', async ({ page }) => {
    await openKit(page, 'data', { forcedColors: true, width: 1440, height: 900 });
    const two = specimen(page, 'Two lines (a code over a name)');
    await two.getByRole('checkbox', { name: 'Select ACC-PR-4HT9WD' }).check();
    const chosen = two.locator('tr[data-state="selected"]').first();
    expect(await edged(chosen)).toBe(true);
    expect(await chosen.evaluate((element) => getComputedStyle(element).outlineColor)).toBe(
      await system(page, 'Highlight'),
    );
    expect(await edged(two.getByRole('group', { name: 'Actions for the chosen rows' }))).toBe(true);

    await openKit(page, 'menus', { forcedColors: true });
    await page.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' }).first().focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    const item = page.getByRole('menuitem', { name: 'Escalate' });
    await expect(item).toBeFocused();
    const background = await colourOf(item, 'backgroundColor');
    expect(
      (await edged(item)) || background === (await system(page, 'Highlight')),
      'the item the menu is on is drawn',
    ).toBe(true);
  });

  // Break caught: a menu, a popover, a panel or a toast that is a card by its fill and its shadow alone, which forced colours drop: it would float over the page with no edge.
  test('draws an edge on the menu, the popover, the panel and the toast', async ({ page }) => {
    await openKit(page, 'menus', { forcedColors: true });
    await page.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' }).first().click();
    expect(await edged(page.getByRole('menu'))).toBe(true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Success', exact: true }).click();
    expect(await edged(page.locator('.ui-toast').first())).toBe(true);

    await openKit(page, 'header', { forcedColors: true });
    await specimen(page, 'Three filters, with Clear all')
      .getByRole('button', { name: 'Filter', exact: true })
      .click();
    expect(await edged(page.getByRole('dialog', { name: 'Filter' }))).toBe(true);

    await openKit(page, 'panels', { forcedColors: true, width: 1440, height: 900 });
    await specimen(page, 'Beside a list of sample requests')
      .getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' })
      .click();
    expect(await edged(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' }))).toBe(true);
  });
});

/**
 * The fix round of task R5.2 in a browser: what jsdom cannot show of it (a press that lands on something else, a control under a sticky header, a scroll the browser clamps, a
 * top layer, a box that is narrow). Each test names the break it catches and failed before the fix it holds.
 */
test.describe('the fix round of task R5.2 in a browser', () => {
  const NO_RECORD = 'No record is open.';

  // Break caught: the stretched button that opens a row lying over a field in a cell, so that a press on the field opened the record and never reached the field (M4).
  test('gives a press on a field in a cell to the field, and opens nothing', async ({ page }) => {
    await openKit(page, 'data', { width: 1440, height: 900 });
    const fields = specimen(page, 'A field in a cell');
    const note = fields.getByRole('textbox', { name: /^Note for / }).first();
    const hub = fields.getByRole('combobox', { name: /^Hub for / }).first();

    for (const field of [note, hub]) {
      await field.scrollIntoViewIfNeeded();
      const at = await box(field);
      await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
      await expect(field).toBeFocused();
    }
    await expect(fields.getByText(NO_RECORD)).toBeVisible();
  });

  // Break caught: only the 20px box of the checkbox being the target, so that a press beside it (in the cell, which is 44px wide) opened the record (M4): the whole cell is the
  // box's, at least 24px in each direction (WCAG 2.5.8), and a press in it chooses the row and opens nothing.
  test('chooses the row on a press beside the box, and opens nothing', async ({ page }) => {
    // Motion is reduced, so that the bar of acts is where it will rest the moment it is there.
    await openKit(page, 'data', { width: 1440, height: 900, reducedMotion: true });
    const two = specimen(page, 'Two lines (a code over a name)');
    const checkbox = two.getByRole('checkbox', { name: 'Select ACC-PR-4HT9WD' });
    const target = checkbox.locator('xpath=ancestor::label[contains(@class,"ui-data-table__box")]');
    await checkbox.scrollIntoViewIfNeeded();

    const area = await box(target);
    expect(area.width).toBeGreaterThanOrEqual(24);
    expect(area.height).toBeGreaterThanOrEqual(24);
    // The box is read again before each press: choosing a row brings the bar of acts in above the rows, which moves them down.
    const pressBeside = async (side: 'left' | 'right') => {
      const at = await box(checkbox);
      await page.mouse.click(
        side === 'left' ? at.x - 8 : at.x + at.width + 8,
        at.y + at.height / 2,
      );
    };
    for (const side of ['left', 'right'] as const) {
      await pressBeside(side);
      await expect(checkbox, `a press to the ${side} chooses`).toBeChecked();
      await expect(two.getByRole('group', { name: 'Actions for the chosen rows' })).toBeVisible();
      await pressBeside(side);
      await expect(checkbox, `a second press to the ${side} clears`).not.toBeChecked();
    }
    await expect(two.getByText(NO_RECORD)).toBeVisible();
  });

  // Break caught: a control that takes focus under the sticky header of a box that has scrolled (the arrows move to a row that the header covers), which hides the focus
  // from a person who cannot see where it went (WCAG 2.4.11) (M6).
  test('keeps the control that takes focus clear of the header while the rows are scrolled', async ({
    page,
  }) => {
    await openKit(page, 'data', { width: 1440, height: 900 });
    const boxed = specimen(page, 'A box of its own');
    const scroller = boxed.locator('.ui-data-table__scroller');
    // The sticky cell, not the `thead` (a `thead` is not sticky: its cells are, and its own box scrolls away with the rows, so it is no reference).
    const header = boxed.locator('thead th').first();
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const last = boxed.getByRole('button', { name: /^Open / }).last();
    await last.focus();

    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press('ArrowUp');
      const focused = page.locator(':focus');
      const under = (await box(header)).y + (await box(header)).height;
      expect((await box(focused)).y, `step ${String(step + 1)}`).toBeGreaterThanOrEqual(under - 1);
    }
  });

  // Break caught: the place the person left put back while the table was still loading short rows, where the browser clamps the scroll to the top and nothing applies it again
  // when the rows arrive (M7).
  test('puts the place the person left back once the rows have arrived', async ({ page }) => {
    await openKit(page, 'data', { width: 1440, height: 900 });
    const scroller = specimen(page, 'Loading, then the rows').locator('.ui-data-table__scroller');

    await expect
      .poll(() => scroller.evaluate((element) => Math.round(element.scrollTop)))
      .toBe(200);
  });

  // Break caught: a menu, a popover, a filter or a tooltip drawn into the page behind the dialog that opened it, under its top layer and inert, so that it cannot be seen or
  // used (M8).
  test('draws the menu, the popover, the filter and the tooltip into the dialog and reaches each', async ({
    page,
  }) => {
    await openKit(page, 'overlays', { width: 1440, height: 900, reducedMotion: true });
    await page.getByRole('button', { name: 'Open the request' }).click();
    const dialog = page.getByRole('dialog', { name: 'Request ACC-PR-7KQ2MZ' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' }).click();
    const menu = page.locator('dialog [data-slot="dropdown-menu-content"]');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Add a note' }).click();
    await expect(menu).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Who can read this' }).hover();
    await expect(page.locator('dialog [data-slot="tooltip-content"]').first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Choose a hub' }).click();
    const popover = page.locator('dialog [data-slot="popover-content"]');
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Filter the notes', exact: true }).click();
    await expect(dialog.getByRole('dialog', { name: 'Filter the notes' })).toBeVisible();
  });

  // Break caught: a toast raised as a dialog closes, drawn behind the dialog's scrim and inert, where nobody sees or reaches it (M11): it is held, and shown after the dialog is gone.
  test('shows a toast raised in a dialog after the dialog has closed, and not before', async ({
    page,
  }) => {
    await openKit(page, 'overlays', { width: 1440, height: 900, reducedMotion: true });
    await page.evaluate(() => {
      const order: string[] = [];
      (window as unknown as { order: string[] }).order = order;
      document.addEventListener(
        'close',
        () => {
          order.push('dialog closed');
        },
        true,
      );
      new MutationObserver(() => {
        if (document.querySelector('.ui-toast') !== null && !order.includes('toast shown'))
          order.push('toast shown');
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.getByRole('button', { name: 'Add a note', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add a note' })).toBeVisible();
    await page.getByRole('button', { name: 'Save the note' }).click();

    await expect(page.locator('.ui-toast', { hasText: 'The note is saved.' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { order: string[] }).order)).toEqual([
      'dialog closed',
      'toast shown',
    ]);
  });

  // Break caught: a toast over the submit bar that sticks to the bottom of a phone (it covers the one control the person needs), where the bar publishes its height and the
  // toast stands above it (M11).
  test('stands a toast above a bar at the bottom of a phone', async ({ page }) => {
    await openKit(page, 'menus', { width: 390, height: 800, reducedMotion: true });
    await page.getByRole('button', { name: 'Show a submit bar' }).click();
    const bar = page.getByTestId('sticky-bar');
    await expect(bar).toBeVisible();
    await page.getByRole('button', { name: 'Success', exact: true }).click();
    const toast = page.locator('.ui-toast', { hasText: 'Request ACC-PR-7KQ2MZ confirmed.' });
    await expect(toast).toBeVisible();

    const above = await box(toast);
    expect(above.y + above.height).toBeLessThanOrEqual((await box(bar)).y + 0.5);
  });

  // Break caught: a table that scrolls sideways on a phone in place of cards, or cards where there is room for the table (M12): which is drawn follows the table's own box.
  test('draws cards where its box is narrow and the table where it is wide, each card one press', async ({
    page,
  }) => {
    await openKit(page, 'data', { width: 1440, height: 900 });
    const narrow = specimen(page, 'Cards, where the box is narrow');
    await expect(narrow.locator('.ui-data-table__cards')).toBeVisible();
    await expect(narrow.getByRole('table')).toHaveCount(0);
    // The second card is confirmed already, so it has no act at its end: a press at its far edge, where no control is, opens the record (the one button is stretched over the card).
    const card = narrow.locator('.ui-data-table__card').nth(1);
    await card.scrollIntoViewIfNeeded();
    const at = await box(card);
    await page.mouse.click(at.x + at.width - 8, at.y + at.height / 2);
    await expect(narrow.getByText(/^Opened ACC-PR-4HT9WD/)).toBeVisible();
    expect(
      await narrow
        .locator('.ui-data-table__scroller')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(0);

    const wide = specimen(page, 'Single line, 36px rows');
    await expect(wide.getByRole('table')).toBeVisible();
    await expect(wide.locator('.ui-data-table__cards')).toHaveCount(0);
  });

  // Break caught: the lesser columns kept at a width that has no room for them, so that a side panel opened beside the table makes it scroll sideways (M12): the columns go
  // by priority, the row's name and its box always staying.
  test('lets the lesser columns go as the box narrows, and the others stay', async ({ page }) => {
    await openKit(page, 'data', { width: 1440, height: 900 });
    const sixty = specimen(page, 'Column priority at 60rem');
    await expect(sixty.getByRole('columnheader', { name: 'Service date' })).toBeVisible();
    await expect(sixty.getByRole('columnheader', { name: 'Packages' })).toHaveCount(0);

    const forty = specimen(page, 'Column priority at 40rem');
    await expect(forty.getByRole('columnheader', { name: 'State' })).toBeVisible();
    await expect(forty.getByRole('columnheader', { name: 'Service date' })).toHaveCount(0);
    expect(
      await forty
        .locator('.ui-data-table__scroller')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(0);
  });

  // Break caught: the filter popover opened on a phone with no margin from the edge of the screen, its text against the glass (M12).
  test('keeps the filter popover clear of the edges of a 390px screen', async ({ page }) => {
    await openKit(page, 'header', { width: 390, height: 800, reducedMotion: true });
    const filter = specimen(page, 'Three filters, with Clear all').getByRole('button', {
      name: 'Filter',
      exact: true,
    });
    await filter.scrollIntoViewIfNeeded();
    await filter.click();
    const popover = await box(page.getByRole('dialog', { name: 'Filter' }));

    expect(popover.x).toBeGreaterThanOrEqual(7.5);
    expect(popover.x + popover.width).toBeLessThanOrEqual(382.5);
  });
});
