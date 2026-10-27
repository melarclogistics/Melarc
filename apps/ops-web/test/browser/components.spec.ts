import { expect, test, type Page } from '@playwright/test';

import { reachableNames, tabReachesLinks, watchPage, wcagViolations } from './support/page';

/**
 * The real components in the development-only showcase, in a real browser. These are the checks that contrast figures
 * and jsdom cannot make (DESIGN_SYSTEM section 14): keyboard interaction, focus that is visible, reflow and text
 * enlargement, forced colours, reduced motion and an automated WCAG 2.2 scan with layout. They do not replace the
 * recorded keyboard-only and screen-reader passes the first identity flow needs.
 */
const SHOWCASE = '/__showcase';

async function openShowcase(page: Page): Promise<void> {
  await page.goto(SHOWCASE);
  await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
}

/** How far the document is wider than the window; zero or less means no sideways scrolling. */
const overflow = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

interface FocusStop {
  readonly name: string;
  readonly outlineStyle: string;
  readonly outlineWidth: number;
  readonly outlineOffset: number;
  readonly outlineColour: string;
  /** What `--focus-ring` computes to, so a test names no colour of its own. */
  readonly ringColour: string;
  /** What `--focus-ring-inverse` computes to, the ring on the Ink side menu of the shell. */
  readonly inverseRingColour: string;
  /** Whether the element sits in the Ink side menu, where the inverse ring is the specified one (DESIGN_SYSTEM section 4.6). */
  readonly inInk: boolean;
}

async function focusStop(page: Page): Promise<FocusStop | null> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return null;
    const style = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.style.color = 'var(--focus-ring)';
    document.body.append(probe);
    const ringColour = getComputedStyle(probe).color;
    probe.style.color = 'var(--focus-ring-inverse)';
    const inverseRingColour = getComputedStyle(probe).color;
    probe.remove();
    const labelled =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? element.labels?.[0]?.textContent
        : null;
    return {
      name: (element.getAttribute('aria-label') ?? labelled ?? element.textContent).trim(),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineOffset: parseFloat(style.outlineOffset),
      outlineColour: style.outlineColor,
      ringColour,
      inverseRingColour,
      inInk: element.closest('.ui-side-menu') !== null,
    };
  });
}

test.describe('the components in a browser: keyboard', () => {
  // Break caught: a control a keyboard user cannot reach, one reachable that should not be (a disabled button), or a
  // focus indicator that is missing or not the one the design system specifies, on any stop.
  test('Tab walks the page in document order; every stop shows the specified focus ring; a disabled control is skipped', async ({
    page,
  }) => {
    await openShowcase(page);
    const tabs = await tabReachesLinks(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
    // Document order is the Tab order here (nothing sets a positive tabindex). Where the engine does not Tab to links, the
    // walk is the same list without them.
    const expected = await reachableNames(page, tabs);
    expect(expected.length).toBeGreaterThan(tabs ? 15 : 8);

    const stops: FocusStop[] = [];
    for (let step = 0; step < expected.length; step += 1) {
      await page.keyboard.press('Tab');
      const stop = await focusStop(page);
      expect(stop, `Tab ${String(step + 1)} left the page`).not.toBeNull();
      if (stop !== null) stops.push(stop);
    }

    for (const stop of stops) {
      expect(stop.outlineStyle, stop.name).toBe('solid');
      expect(stop.outlineWidth, stop.name).toBe(2);
      expect(stop.outlineOffset, stop.name).toBe(2);
      expect(stop.outlineColour, stop.name).toBe(
        stop.inInk ? stop.inverseRingColour : stop.ringColour,
      );
    }
    const names = stops.map((stop) => stop.name);
    expect(names).toEqual(expected);
    // What the walk must include, and what it must not.
    for (const name of [
      'Demo page action',
      'Primary action',
      'Secondary action',
      'Demo name (required)',
      'Demo note',
      'Demo read-only value',
      'Submit demo',
    ]) {
      expect(names, name).toContain(name);
    }
    expect(names.filter((name) => name === 'Saving…')).toHaveLength(2);
    expect(names).not.toContain('Disabled action');
    expect(names).not.toContain('Demo disabled value');
    expect(names).not.toContain('Demo disabled note');
    // The disabled controls exist on the page; they are simply not stops.
    await expect(page.getByRole('button', { name: 'Disabled action' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Demo disabled value' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Demo disabled note' })).toBeDisabled();
    if (tabs) expect(names[0]).toBe('Skip to main content');
  });

  // Break caught: a select that cannot be driven by its own keys (the arrows, type-ahead), or one that loses the specified focus ring.
  test('a select is chosen from with the keyboard, and shows the focus ring', async ({ page }) => {
    await openShowcase(page);
    const select = page.getByRole('combobox', { name: 'Demo choice' });
    await select.focus();

    await page.keyboard.press('ArrowDown');
    await expect(select).toHaveValue('a');
    await page.keyboard.type('Demo option B');
    await expect(select).toHaveValue('b');

    const ring = await focusStop(page);
    expect(ring?.outlineStyle).toBe('solid');
    expect(ring?.outlineWidth).toBe(2);
    expect(ring?.outlineColour).toBe(ring?.ringColour);
  });

  // Break caught: a checkbox that the keyboard cannot turn on or off, whose label is not part of its target, or that loses the specified focus
  // ring (COMPONENT_PATTERNS section 7.10).
  test('a checkbox is turned on and off with Space, by its label too, and shows the focus ring', async ({
    page,
  }) => {
    await openShowcase(page);
    const box = page.getByRole('checkbox', { name: 'Demo remember this choice' });
    await expect(box).not.toBeChecked();
    await box.focus();

    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    const ring = await focusStop(page);
    expect(ring?.outlineStyle).toBe('solid');
    expect(ring?.outlineWidth).toBe(2);
    expect(ring?.outlineColour).toBe(ring?.ringColour);

    await page.keyboard.press('Space');
    await expect(box).not.toBeChecked();
    await page.getByText('Demo remember this choice').click();
    await expect(box).toBeChecked();
    await expect(box).toHaveAccessibleDescription(/Nothing is sent or stored/);
  });

  // Break caught: a danger button drawn as a fill, which would be almost the colour of the primary button, or one that does not change under
  // the pointer (DESIGN_SYSTEM section 4.6, the outline recipe).
  test('a danger button is an outline in the danger colour, and changes under the pointer', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShowcase(page);
    const button = page.getByRole('button', { name: 'Danger action' });
    const colours = () =>
      button.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = (name: string) => {
          const span = document.createElement('span');
          span.style.color = `var(${name})`;
          document.body.append(span);
          const value = getComputedStyle(span).color;
          span.remove();
          return value;
        };
        return {
          border: style.borderTopColor,
          text: style.color,
          fill: style.backgroundColor,
          danger: probe('--color-status-danger-foreground'),
          surface: probe('--color-surface-default'),
          soft: probe('--color-status-danger-background'),
        };
      });

    const resting = await colours();
    expect(resting.border).toBe(resting.danger);
    expect(resting.text).toBe(resting.danger);
    expect(resting.fill).toBe(resting.surface);

    await button.hover();
    expect((await colours()).fill).toBe(resting.soft);
  });

  // Break caught: an action that works with the mouse and not with Enter or Space.
  test('Enter and Space activate a button', async ({ page }) => {
    await openShowcase(page);
    const primary = page.getByRole('button', { name: 'Primary action' });
    await primary.focus();

    await page.keyboard.press('Enter');
    await expect(page.getByText(/Primary action pressed 1 times/)).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByText(/Primary action pressed 2 times/)).toBeVisible();
  });

  // Break caught: a failed submit that leaves focus on the button, so a screen reader user never hears the error, or
  // an error that is not tied to its field.
  test('a failed submit puts focus on the first invalid field, which reads its error; fixing it succeeds', async ({
    page,
  }) => {
    await openShowcase(page);
    const field = page.getByRole('textbox', { name: 'Demo name (required)' });
    await page.getByRole('button', { name: 'Submit demo' }).click();

    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription(
      'Any text. Nothing is sent or stored. Enter a demo name.',
    );
    await expect(page.getByText('Enter a demo name.')).toBeVisible();
    // The states a user reaches only by acting: the contrast of the invalid border and the error text, with layout.
    expect(await wcagViolations(page), 'with the error showing').toEqual([]);

    await page.keyboard.type('A demo name');
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('status').filter({ hasText: 'The demo form was accepted' }),
    ).toBeVisible();
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    expect(await wcagViolations(page), 'with the success alert showing').toEqual([]);
  });

  // Break caught: a read-only value that can be edited, or one that looks and acts like a disabled one.
  test('a read-only field takes focus and refuses typing; a disabled one is inert', async ({
    page,
  }) => {
    await openShowcase(page);
    const readOnly = page.getByRole('textbox', { name: 'Demo read-only value' });
    const disabled = page.getByRole('textbox', { name: 'Demo disabled value' });

    await readOnly.focus();
    await page.keyboard.type('x');
    await expect(readOnly).toHaveValue('Synthetic value');
    await expect(readOnly).toBeEnabled();
    await expect(disabled).toBeDisabled();
  });
});

test.describe('the components in a browser: layout, zoom and reflow', () => {
  // Break caught: a layout that needs sideways scrolling at 320 CSS pixels (WCAG 1.4.10), or one that clips a label.
  test('reflows at 320 px without sideways scrolling or clipped controls', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')]
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.textContent || element.getAttribute('aria-label')),
    );
    expect(clipped).toEqual([]);
  });

  // Break caught: sizes written in pixels, so enlarged text does not grow the controls, or enlarged text that breaks the
  // layout or clips its container (WCAG 1.4.4). Text is enlarged by scaling the root font size, which the rem units follow.
  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 640, height: 800 },
  ]) {
    test(`text enlarged to 200% grows the controls and does not break the layout at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await openShowcase(page);
      const button = page.getByRole('button', { name: 'Primary action' });
      const normal = (await button.boundingBox())?.height ?? 0;

      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });

      const enlarged = (await button.boundingBox())?.height ?? 0;
      expect(normal).toBeGreaterThan(0);
      expect(enlarged).toBeGreaterThanOrEqual(normal * 1.8);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const clipped = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent || element.getAttribute('aria-label')),
      );
      expect(clipped).toEqual([]);
    });
  }

  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 320, height: 640 },
  ]) {
    // Break caught: a contrast, target-size or structure failure that appears only with layout, in a real browser.
    test(`has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await openShowcase(page);

      expect(await wcagViolations(page)).toEqual([]);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('the components in a browser: states under the pointer', () => {
  // Reduced motion makes a state change immediate, so the test reads the style after the pointer arrives, not mid-fade.
  const fill = (page: Page, name: string, index: number): Promise<string> =>
    page
      .getByRole('button', { name })
      .nth(index)
      .evaluate((element) => getComputedStyle(element).backgroundColor);

  // Break caught: an action link in an alert turning the link colour on hover, which leaves the text colour the alert
  // was verified for (DESIGN_SYSTEM section 4.6: an action link uses the alert's own foreground, underlined).
  test('an action link inside an alert keeps the alert text colour under the pointer', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShowcase(page);
    const link = page.locator('.ui-alert a', { hasText: 'Go to the start page' });

    await link.hover();

    const colours = await link.evaluate((element) => ({
      link: getComputedStyle(element).color,
      alert: getComputedStyle(element.closest('.ui-alert') ?? element).color,
    }));
    expect(colours.link).toBe(colours.alert);
  });

  // Break caught: a button that is under way changing colour under the pointer, when loading keeps the colours. A button
  // that is not loading must still change, or the check proves nothing.
  test('a loading button keeps its fill under the pointer, and an ordinary one changes it', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShowcase(page);

    const ordinary = await fill(page, 'Primary action', 0);
    await page.getByRole('button', { name: 'Primary action' }).hover();
    expect(await fill(page, 'Primary action', 0)).not.toBe(ordinary);

    for (const index of [0, 1]) {
      const before = await fill(page, 'Saving…', index);
      await page.getByRole('button', { name: 'Saving…' }).nth(index).hover();
      expect(await fill(page, 'Saving…', index), `loading button ${String(index)}`).toBe(before);
    }
  });
});

test.describe('the components in a browser: forced colours and reduced motion', () => {
  // Break caught: a focus indicator or a control boundary that vanishes in Windows high contrast (forced-colors), which
  // drops shadows and backgrounds: the ring is an outline, and every control keeps a real border.
  test('under forced colours the focus ring and the control boundaries remain', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'Playwright cannot emulate forced colours in WebKit; the outline rule is checked for every engine in the focus test and the token guard.',
    );
    await page.emulateMedia({ forcedColors: 'active' });
    await openShowcase(page);
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);

    await page.getByRole('button', { name: 'Secondary action' }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const ring = await focusStop(page);
    expect(ring?.outlineStyle).toBe('solid');
    expect(ring?.outlineWidth).toBeGreaterThanOrEqual(2);

    const borders = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '.ui-button:not(:disabled), .ui-input, .ui-textarea, .ui-select, .ui-alert, .ui-status-badge, .ui-empty-state, .ui-table__scroller',
        ),
      ].map((element) => {
        const style = getComputedStyle(element);
        const label = element.getAttribute('aria-label') ?? element.textContent;
        return {
          name: label === '' ? element.className : label,
          style: style.borderTopStyle,
          width: parseFloat(style.borderTopWidth),
          colour: style.borderTopColor,
        };
      }),
    );
    expect(borders.length).toBeGreaterThan(8);
    for (const border of borders) {
      expect(border.style, border.name).toBe('solid');
      expect(border.width, border.name).toBeGreaterThanOrEqual(1);
      // A border that is solid and 1px wide but transparent is invisible; forced colours must have given it a colour.
      expect(border.colour, border.name).not.toMatch(/^transparent$|^rgba\(.*,\s*0\)$/);
    }
  });

  // Break caught: a spinner that keeps turning, or a transition that keeps running, for a user who asked for less motion.
  test('animation and transitions are off under reduced motion, and on otherwise', async ({
    page,
  }) => {
    const motion = (): Promise<{ spinner: string; transition: string }> =>
      page.evaluate(() => {
        const spinner = document.querySelector('.ui-spinner');
        const button = document.querySelector('.ui-button');
        return {
          spinner: spinner === null ? 'missing' : getComputedStyle(spinner).animationName,
          transition: button === null ? 'missing' : getComputedStyle(button).transitionDuration,
        };
      });

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openShowcase(page);
    const normal = await motion();
    expect(normal.spinner).toBe('ui-spin');
    expect(normal.transition).not.toBe('0s');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await motion();
    expect(reduced.spinner).toBe('none');
    expect(reduced.transition).toBe('0s');
  });
});

test.describe('the table and the state components in a browser', () => {
  const region = (page: Page) => page.getByRole('region', { name: 'Demo table' });
  const firstRowName = (page: Page): Promise<string | null> =>
    region(page).getByRole('rowheader').first().textContent();

  // Break caught: a sort that works with the mouse and not with the keyboard, or an order shown by an arrow alone. `aria-sort` is what
  // assistive technology reads, and focus must stay on the control that was used.
  test('sorts from the keyboard, says so with aria-sort, and keeps focus on the control', async ({
    page,
  }) => {
    await openShowcase(page);
    const button = region(page).getByRole('button', { name: 'Parcels' });
    const header = region(page).getByRole('columnheader', { name: 'Parcels' });
    await expect(header).not.toHaveAttribute('aria-sort', /./);
    await button.focus();

    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByText('Demo order: parcels ascending')).toBeVisible();
    expect(await firstRowName(page)).toBe('Demo row epsilon');
    await expect(button).toBeFocused();

    await page.keyboard.press('Space');
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(await firstRowName(page)).toBe('Demo row gamma');
    await expect(button).toBeFocused();
  });

  test('has compact rows of about 40 to 44 px', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openShowcase(page);

    const box = await region(page).getByRole('row').nth(2).boundingBox();

    expect(box?.height ?? 0).toBeGreaterThanOrEqual(39);
    expect(box?.height ?? 0).toBeLessThanOrEqual(46);
  });

  // Break caught: a wide table that makes the page scroll in two directions (WCAG 1.4.10), or one whose overflow a keyboard cannot reach.
  test('scrolls inside its own region at 320 px, which a keyboard can reach and scroll, without moving the page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);
    const scroller = region(page);
    await scroller.scrollIntoViewIfNeeded();

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    await scroller.focus();
    await expect(scroller).toBeFocused();
    // The table keeps the width of a readable table (30rem) and scrolls, rather than squeezing its columns into 320px.
    expect((await scroller.getByRole('table').boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(
      479,
    );
    await page.keyboard.press('ArrowRight');

    await expect.poll(() => scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('grows with text enlarged to 200% and does not push the page sideways', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openShowcase(page);
    const row = region(page).getByRole('row').nth(2);
    const normal = (await row.boundingBox())?.height ?? 0;

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(normal * 1.8);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  test('draws a status as its words, and a value it does not know as an unknown status', async ({
    page,
  }) => {
    await openShowcase(page);

    for (const words of ['Demo open', 'Demo held', 'Demo done', 'Demo lost', 'Demo idle']) {
      await expect(page.locator('.ui-status-badge', { hasText: words }).first()).toBeVisible();
    }
    await expect(page.locator('.ui-status-badge', { hasText: 'Unknown status' })).toBeVisible();
    await expect(page.getByText('NOT_IN_THE_MAP')).toHaveCount(0);
  });

  // Break caught: the two empty states looking alike, or a filter that hides everything with no way to take it off.
  test('tells nothing waiting from a filter that hides everything, and the way out works from the keyboard', async ({
    page,
  }) => {
    await openShowcase(page);
    await expect(page.locator('.ui-empty-state--none')).toBeVisible();
    await expect(page.locator('.ui-empty-state--filtered')).toBeVisible();

    await page.getByRole('button', { name: 'Clear the demo filters' }).focus();
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('status').filter({ hasText: 'The demo filters were cleared' }),
    ).toBeVisible();
  });

  test('names the permission in every refusal and no role', async ({ page }) => {
    await openShowcase(page);

    const refusals = page.locator('.ui-alert--danger', { has: page.locator('code') });
    await expect(refusals).toHaveCount(3);
    await expect(page.getByText('This is outside your hubs')).toBeVisible();
    const text =
      (await page.locator('section', { hasText: 'Forbidden states' }).textContent()) ?? '';
    expect(text).not.toMatch(/admin|role|bundle|officer|senior ops|ops staff/i);
  });

  // Break caught: a skeleton that keeps pulsing for a person who asked for less motion, or one that a screen reader reads.
  test('stops the skeleton under reduced motion, and hides it from assistive technology', async ({
    page,
  }) => {
    const pulse = (): Promise<string> =>
      page.evaluate(() => {
        const line = document.querySelector('.ui-skeleton__line');
        return line === null ? 'missing' : getComputedStyle(line).animationName;
      });

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openShowcase(page);
    expect(await pulse()).toBe('ui-skeleton-pulse');
    await expect(page.locator('.ui-skeleton')).toHaveAttribute('aria-hidden', 'true');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await pulse()).toBe('none');
  });
});

test.describe('the side menu in a browser', () => {
  const demo = (page: Page) => page.locator('.showcase-side-menu');
  const panel = (page: Page) => demo(page).locator('.ui-side-menu__panel');
  const entries = (page: Page) =>
    demo(page).getByRole('navigation', { name: 'Primary' }).getByRole('link');
  const widthOf = async (page: Page): Promise<number> =>
    (await panel(page).boundingBox())?.width ?? 0;

  // Break caught: a menu that cannot be collapsed, or that loses the names of its entries when it is, or that comes back wider or narrower than
  // it was. Motion is off, so that a width is read where it ended and not on the way.
  test('collapses to a rail of icons and expands again, each entry keeping its name', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShowcase(page);
    await demo(page).scrollIntoViewIfNeeded();
    const rem = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    expect(await widthOf(page)).toBe(16 * rem);

    await demo(page).getByRole('button', { name: 'Collapse menu' }).click();

    await expect(demo(page).getByRole('button', { name: 'Expand menu' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(await widthOf(page)).toBe(4.5 * rem);
    for (const name of ['Demo overview', 'Demo staff', 'Demo add a profile', 'Demo sessions']) {
      await expect(entries(page).filter({ hasText: name })).toHaveAttribute('title', name);
    }
    expect(await entries(page).count()).toBe(4);

    await demo(page).getByRole('button', { name: 'Expand menu' }).click();

    expect(await widthOf(page)).toBe(16 * rem);
  });

  // Break caught: the menu's narrow-screen form clipping an entry or making the page scroll sideways at 320 px, or its panel in the tab order
  // and on the screen before anyone opened it.
  test('is a bar with a menu button at 320 px, and its panel slides in without scrolling the page sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);
    await demo(page).scrollIntoViewIfNeeded();
    const open = demo(page).getByRole('button', { name: 'Open menu' });

    await expect(open).toBeVisible();
    await expect(panel(page)).toBeHidden();
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await open.click();

    await expect(panel(page)).toBeVisible();
    await expect(demo(page).getByRole('button', { name: 'Close menu' })).toBeFocused();
    await expect.poll(async () => (await panel(page).boundingBox())?.x ?? -1).toBe(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const boxes = await entries(page).evaluateAll((links) =>
      links.map((link) => {
        const rect = link.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          clipped: link.scrollWidth > link.clientWidth + 1,
        };
      }),
    );
    expect(boxes).toHaveLength(4);
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(320);
      expect(box.clipped).toBe(false);
    }
    expect(await wcagViolations(page), 'with the demo menu open').toEqual([]);

    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(open).toBeFocused();
  });

  // Break caught: the bar or the open panel pushing a control out of the screen at 320 px with text enlarged to 200% (WCAG 1.4.4, 1.4.10).
  test('keeps its controls inside the screen at 320 px with text enlarged to 200%', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);
    await demo(page).scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await demo(page).getByRole('button', { name: 'Open menu' }).click();
    await expect.poll(async () => (await panel(page).boundingBox())?.x ?? -1).toBe(0);

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    for (const control of [
      demo(page).getByRole('button', { name: 'Close menu' }),
      entries(page).first(),
      entries(page).last(),
      demo(page).getByRole('button', { name: 'Sign out' }),
    ]) {
      await control.focus();
      const box = await control.boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    }
  });

  // Break caught: the current entry told by colour alone, or lost under forced colours.
  test('marks the current entry by more than its colour', async ({ page }) => {
    await openShowcase(page);
    const current = entries(page).filter({ hasText: 'Demo overview' });

    await expect(current).toHaveAttribute('aria-current', 'page');
    const [currentStyle, otherStyle] = await Promise.all([
      current.evaluate((element) => {
        const style = getComputedStyle(element);
        return { weight: style.fontWeight, fill: style.backgroundColor };
      }),
      entries(page)
        .filter({ hasText: 'Demo staff' })
        .evaluate((element) => {
          const style = getComputedStyle(element);
          return { weight: style.fontWeight, fill: style.backgroundColor };
        }),
    ]);
    expect(Number(currentStyle.weight)).toBeGreaterThan(Number(otherStyle.weight));
    expect(currentStyle.fill).not.toBe(otherStyle.fill);
  });

  test('is Ink, with the text of the shell colours', async ({ page }) => {
    await openShowcase(page);

    const colours = await demo(page).evaluate((element) => {
      const resolve = (property: 'color' | 'backgroundColor', name: string): string => {
        const span = document.createElement('span');
        span.style[property] = `var(${name})`;
        document.body.append(span);
        const value = getComputedStyle(span)[property];
        span.remove();
        return value;
      };
      const panelElement = element.querySelector('.ui-side-menu__panel');
      const link = element.querySelector('.ui-primary-nav a:not([aria-current])');
      const name = element.querySelector('.ui-side-menu__name');
      return {
        fill: panelElement === null ? '' : getComputedStyle(panelElement).backgroundColor,
        entry: link === null ? '' : getComputedStyle(link).color,
        person: name === null ? '' : getComputedStyle(name).color,
        ink: resolve('backgroundColor', '--color-surface-inverse'),
        muted: resolve('color', '--shell-text-muted'),
        text: resolve('color', '--shell-text'),
      };
    });
    expect(colours.fill).toBe(colours.ink);
    expect(colours.entry).toBe(colours.muted);
    expect(colours.person).toBe(colours.text);
  });
});

test.describe('the components in a browser: a healthy page', () => {
  // Break caught: the showcase logging an error, throwing, or reaching for anything other than its own files.
  test('logs no errors and requests only its own origin', async ({ page, baseURL }) => {
    const seen = watchPage(page);
    await openShowcase(page);
    await page.getByRole('button', { name: 'Submit demo' }).click();
    await page.keyboard.type('Name');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'accepted' })).toBeVisible();

    expect(seen.problems).toEqual([]);
    for (const url of seen.requests) expect(new URL(url).origin, url).toBe(baseURL);
  });

  // Break caught: the neutral frame gaining navigation, a menu or sign-out while the components are restyled
  // (DESIGN_SYSTEM section 13.1: the frame never shows them), or a permission-driven menu appearing from nowhere.
  test('the frame around the showcase has no navigation, user menu or sign-out', async ({
    page,
  }) => {
    await openShowcase(page);

    // The frame: the showcase's own demo of the shell band sits in the content, and the frame itself has no navigation.
    await expect(page.locator('body > nav, header nav, header + nav, .app-chrome nav')).toHaveCount(
      0,
    );
    await expect(page.locator('.app-chrome')).toBeEmpty();
    await expect(page.getByRole('banner')).toBeVisible();
    // The logo identifies the product in the frame, and loads (it is not a broken image).
    const logo = page.getByRole('banner').getByRole('img', { name: 'Melarc Logistics' });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    // The frame is the banner: the showcase's demos below it hold buttons about signing in, which are theirs and not the frame's.
    const frame = page.getByRole('banner');
    await expect(
      frame.getByRole('button', { name: /sign|log ?(in|out)|account|profile|menu/i }),
    ).toHaveCount(0);
    await expect(
      frame.getByRole('link', { name: /sign|log ?(in|out)|account|profile/i }),
    ).toHaveCount(0);
    await expect(frame.getByRole('link')).toHaveCount(0);
    await expect(frame.getByRole('button')).toHaveCount(0);
  });
});
