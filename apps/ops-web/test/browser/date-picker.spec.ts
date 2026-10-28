import { expect, test, type Locator, type Page } from '@playwright/test';

import { watchPage, wcagViolations } from './support/page';

/**
 * The date field of the development-only showcase (COMPONENT_PATTERNS section 22a), in a real browser: what jsdom cannot show of a
 * calendar that opens over the page. The same showcase built for production and served under the strict policy is
 * `date-picker-policy.spec.ts`. These checks do not replace the recorded keyboard-only and screen-reader passes.
 */
const SHOWCASE = '/__showcase';
const REQUIRED = 'Demo date (required)';

/** Wednesday 28 October 2026 in Accra, so that a calendar with no date opens on a month the test knows. */
const NOW = new Date('2026-10-28T10:00:00Z');

async function openShowcase(page: Page): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(SHOWCASE);
  await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
  await page.getByRole('heading', { level: 2, name: 'Date field' }).scrollIntoViewIfNeeded();
}

const group = (page: Page, name = REQUIRED): Locator => page.getByRole('group', { name });
const part = (page: Page, kind: 'day' | 'month' | 'year', name = REQUIRED): Locator =>
  group(page, name).getByRole('spinbutton', { name: new RegExp(`^${kind}`) });
const calendarButton = (page: Page, name = REQUIRED): Locator =>
  group(page, name).getByRole('button', { name: /^Calendar/ });
const dialog = (page: Page): Locator => page.getByRole('dialog');

/** How far the document is wider than the window; zero or less means no sideways scrolling. */
const overflow = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe('the date field in a browser: keyboard and pointer', () => {
  // Break caught: a date that cannot be typed, a calendar a keyboard cannot reach or leave, or a date the page is given in another shape.
  test('takes a typed date, opens its calendar from the keyboard, chooses with the arrows and Enter, and gives focus back', async ({
    page,
  }) => {
    const seen = watchPage(page);
    await openShowcase(page);

    await part(page, 'day').click();
    await page.keyboard.type('28102026');
    await expect(page.getByText('The page holds: 2026-10-28')).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(calendarButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Wednesday, 28 October 2026 selected/ }),
    ).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.getByText('The page holds: 2026-10-29')).toBeVisible();
    await expect(dialog(page)).toBeHidden();
    await expect(calendarButton(page)).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(calendarButton(page)).toBeFocused();
    await expect(page.getByText('The page holds: 2026-10-29')).toBeVisible();
    expect(seen.problems).toEqual([]);
  });

  test('chooses a day with the pointer', async ({ page }) => {
    await openShowcase(page);

    await calendarButton(page).click();
    await expect(page.getByRole('button', { name: /Wednesday, 28 October 2026/ })).toHaveClass(
      /ui-date-picker__day--today/,
    );
    await page.getByRole('button', { name: /Friday, 30 October 2026/ }).click();

    await expect(dialog(page)).toBeHidden();
    await expect(page.getByText('The page holds: 2026-10-30')).toBeVisible();
  });

  // Break caught: the order and the words of the date taken from the browser's language (Playwright's is United States English: month
  // first, the week from Sunday), so that 03/04 means two days to two people. The portal's are fixed (DATE_LOCALE).
  test('shows day, month and year, and a week that starts on Monday, whatever the browser says', async ({
    page,
  }) => {
    await openShowcase(page);
    expect(await page.evaluate(() => navigator.language)).toBe('en-US');
    const range = 'Demo date in a range';

    await expect(part(page, 'day', range)).toHaveText('12');
    await expect(part(page, 'month', range)).toHaveText('10');
    await expect(part(page, 'year', range)).toHaveText('2026');
    await calendarButton(page, range).click();
    const headers = await dialog(page)
      .getByRole('columnheader', { includeHidden: true })
      .allTextContents();
    expect(headers).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });

  // Break caught: a range taken for a rule or ignored: the days outside it are drawn as unavailable and are not chosen by a click.
  test('does not offer the days outside the range it was told of', async ({ page }) => {
    await openShowcase(page);
    const range = 'Demo date in a range';

    await calendarButton(page, range).click();
    const outside = page.getByRole('button', { name: /Wednesday, 21 October 2026/ });
    await expect(outside).toHaveAttribute('aria-disabled', 'true');
    await outside.click({ force: true });

    await expect(dialog(page)).toBeVisible();
    await expect(page.getByText('The page holds: 2026-10-12')).toBeVisible();
  });
});

interface FocusRing {
  readonly name: string;
  readonly outlineStyle: string;
  readonly outlineWidth: number;
  readonly outlineOffset: number;
  readonly outlineColour: string;
  readonly ringColour: string;
}

async function focusRing(page: Page): Promise<FocusRing | null> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return null;
    const style = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.style.color = 'var(--focus-ring)';
    document.body.append(probe);
    const ringColour = getComputedStyle(probe).color;
    probe.remove();
    return {
      name: (element.getAttribute('aria-label') ?? element.textContent).trim(),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineOffset: parseFloat(style.outlineOffset),
      outlineColour: style.outlineColor,
      ringColour,
    };
  });
}

test.describe('the date field in a browser: focus and accessibility', () => {
  // Break caught: a part of the date a keyboard user reaches with no visible focus, or with a ring other than the design system's.
  test('Tab walks day, month, year and the calendar button, each with the specified focus ring', async ({
    page,
  }) => {
    await openShowcase(page);
    await part(page, 'day').focus();

    const stops: FocusRing[] = [];
    for (let step = 0; step < 4; step += 1) {
      const ring = await focusRing(page);
      expect(ring, `stop ${String(step + 1)}`).not.toBeNull();
      if (ring !== null) stops.push(ring);
      await page.keyboard.press('Tab');
    }

    expect(stops.map((stop) => stop.name)).toEqual(['day,', 'month,', 'year,', 'Calendar']);
    for (const stop of stops) {
      expect(stop.outlineStyle, stop.name).toBe('solid');
      expect(stop.outlineWidth, stop.name).toBe(2);
      expect(stop.outlineOffset, stop.name).toBe(2);
      expect(stop.outlineColour, stop.name).toBe(stop.ringColour);
    }
  });

  // Break caught: a contrast, target-size, name or relationship failure that shows only with layout, with the calendar open over the page.
  test('has no WCAG 2.2 A or AA violation with the calendar closed or open', async ({ page }) => {
    await openShowcase(page);
    expect(await wcagViolations(page)).toEqual([]);

    await calendarButton(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(await wcagViolations(page)).toEqual([]);
  });

  // Break caught: the muted text colour on the selected fill (4.32:1 against the 4.5:1 that WCAG 1.4.3 needs for 14px text), which shows
  // only when an empty part has focus, or on the subtle fill of an empty read-only date. Neither state is on the page until it is made.
  test('has no WCAG 2.2 A or AA violation with an empty part focused, or in an empty read-only date', async ({
    page,
  }) => {
    await openShowcase(page);

    await part(page, 'day').focus();
    await expect(part(page, 'day')).toHaveAttribute('data-focused', 'true');
    await expect(part(page, 'day')).toHaveAttribute('data-placeholder', 'true');
    expect(await wcagViolations(page)).toEqual([]);

    const readOnly = group(page, 'Demo empty read-only date').getByRole('spinbutton').first();
    await expect(readOnly).toHaveAttribute('data-placeholder', 'true');
    expect(await wcagViolations(page)).toEqual([]);
  });
});

/** The colour a design token resolves to in this page, as the browser writes it, for the property asked. */
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

test.describe('the date field in a browser: what only the stylesheet gives', () => {
  // Break caught: the looks that no other test sees, because they are CSS alone: an invalid control told by colour at 1px, a focused part
  // with no fill, today with no bold and no bar, days of the next month drawn, and a day that does not answer the pointer.
  test('draws the invalid border, the focused part, today and the days that are not in the month, and answers the pointer', async ({
    page,
  }) => {
    // Without motion the states are the ones the rules give, not a step of a transition between two of them.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShowcase(page);

    const invalid = await group(page, 'Demo date with an error').evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.borderTopWidth, colour: style.borderTopColor };
    });
    expect(invalid.width).toBe('2px');
    expect(invalid.colour).toBe(
      await resolvedColour(page, '--color-status-danger-foreground', 'color'),
    );

    await part(page, 'day').focus();
    expect(
      await part(page, 'day').evaluate((element) => getComputedStyle(element).backgroundColor),
    ).toBe(await resolvedColour(page, '--color-surface-selected', 'backgroundColor'));

    await calendarButton(page).click();
    const today = page.getByRole('button', { name: /Wednesday, 28 October 2026/ });
    const look = await today.evaluate((element) => {
      const own = getComputedStyle(element);
      const bar = getComputedStyle(element, '::after');
      const other = document.querySelector('.ui-date-picker__day:not(.ui-date-picker__day--today)');
      return {
        weight: Number(own.fontWeight),
        otherWeight: other === null ? 0 : Number(getComputedStyle(other).fontWeight),
        barWidth: bar.borderBottomWidth,
        barStyle: bar.borderBottomStyle,
      };
    });
    expect(look.weight).toBeGreaterThan(look.otherWeight);
    expect([look.barWidth, look.barStyle]).toEqual(['2px', 'solid']);

    const outside = page.locator('.ui-date-picker__day[data-outside-month]').first();
    expect(await outside.evaluate((element) => getComputedStyle(element).visibility)).toBe(
      'hidden',
    );

    const other = page.getByRole('button', { name: /Friday, 30 October 2026/ });
    const background = (): Promise<string> =>
      other.evaluate((element) => getComputedStyle(element).backgroundColor);
    await other.hover();
    expect(await background()).toBe(
      await resolvedColour(page, '--color-surface-subtle', 'backgroundColor'),
    );
    await page.mouse.down();
    expect(await background()).toBe(
      await resolvedColour(page, '--button-pressed-background', 'backgroundColor'),
    );
    await page.mouse.up();
  });

  // Break caught: a calendar that opens under a modal dialog (the page behind it is inert and its top layer sits above the body), so that a
  // date field in a confirmation dialog opens a calendar nobody can see or click.
  test('opens its calendar inside a modal dialog, where it is seen, chosen from and left without closing the dialog', async ({
    page,
  }) => {
    await openShowcase(page);
    await page.getByRole('heading', { level: 2, name: 'Dialogs' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Open the demo date dialog' }).click();
    const modal = page.getByRole('dialog', { name: 'Demo dialog with a date' });
    await expect(modal).toBeVisible();

    await group(page, 'Demo date in a dialog')
      .getByRole('button', { name: /^Calendar/ })
      .click();
    const friday = page.getByRole('button', { name: /Friday, 30 October 2026/ });
    await expect(friday).toBeVisible();
    // The day is what is at its own centre: not under the dialog's backdrop, not inert.
    expect(
      await friday.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return at === element || element.contains(at);
      }),
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(friday).toBeHidden();
    await expect(modal).toBeVisible();

    await group(page, 'Demo date in a dialog')
      .getByRole('button', { name: /^Calendar/ })
      .click();
    await page.getByRole('button', { name: /Friday, 30 October 2026/ }).click();
    await expect(modal.getByText('The dialog holds: 2026-10-30')).toBeVisible();
    await expect(modal).toBeVisible();
  });
});

test.describe('the date field in a browser: reflow, enlarged text, forced colours and reduced motion', () => {
  // Break caught: a calendar wider than a 320 px screen that pushes the page sideways or leaves a column off the screen (WCAG 1.4.10).
  test('opens inside a 320 px screen with all seven days in view and no sideways scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);

    await calendarButton(page).click();
    await expect(dialog(page)).toBeVisible();

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const popover = page.locator('.ui-date-picker__popover');
    const box = await popover.boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    expect(
      await popover.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  });

  // Break caught: the control, with its three parts that do not wrap, wider than a 320 px screen once the text is twice as large (WCAG 1.4.10
  // and 1.4.4 together, the narrowest screen with the largest text): the page scrolls sideways, or a part of the date is off the screen.
  test('fits a 320 px screen with the text enlarged to 200%, the control and the open calendar both', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    const control = await group(page).boundingBox();
    expect(control?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((control?.x ?? 0) + (control?.width ?? 0)).toBeLessThanOrEqual(320);
    for (const kind of ['day', 'month', 'year'] as const) {
      const box = await part(page, kind).boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0), kind).toBeLessThanOrEqual(320);
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    await calendarButton(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  // Break caught: sizes written in pixels, so that enlarged text leaves the calendar as it was, or a calendar that outgrows the screen
  // at 200% (WCAG 1.4.4). Text is enlarged by scaling the root font size, which the rem units follow.
  test('grows with text enlarged to 200% and stays inside the screen', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 800 });
    await openShowcase(page);
    await calendarButton(page).click();
    await expect(dialog(page)).toBeVisible();
    const normal = (await page.locator('.ui-date-picker__day').first().boundingBox())?.width ?? 0;
    await page.keyboard.press('Escape');

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await calendarButton(page).click();
    await expect(dialog(page)).toBeVisible();

    const enlarged = (await page.locator('.ui-date-picker__day').first().boundingBox())?.width ?? 0;
    expect(normal).toBeGreaterThan(0);
    expect(enlarged).toBeGreaterThanOrEqual(normal * 1.6);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const box = await page.locator('.ui-date-picker__popover').boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(640);
  });

  // Break caught: the chosen day told by a fill alone, which forced colours drop, or a control with no boundary.
  test('under forced colours the chosen day and the control keep what shows them', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'Playwright cannot emulate forced colours in WebKit; the rules are held by the stylesheet and the token guard.',
    );
    await page.emulateMedia({ forcedColors: 'active' });
    await openShowcase(page);
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const system = await page.evaluate(() => {
      const colour = (value: string, property: 'color' | 'backgroundColor'): string => {
        const probe = document.createElement('span');
        probe.style.background = value;
        probe.style.color = value;
        document.body.append(probe);
        const resolved = getComputedStyle(probe)[property];
        probe.remove();
        return resolved;
      };
      return {
        highlight: colour('Highlight', 'backgroundColor'),
        highlightText: colour('HighlightText', 'color'),
        canvas: colour('Canvas', 'backgroundColor'),
      };
    });

    const boundary = await group(page).evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: parseFloat(style.borderTopWidth), style: style.borderTopStyle };
    });
    expect(boundary.style).toBe('solid');
    expect(boundary.width).toBeGreaterThanOrEqual(1);

    await calendarButton(page, 'Demo date in a range').click();
    const selected = page.locator('.ui-date-picker__day[data-selected]');
    await expect(selected).toBeVisible();
    expect(await selected.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      system.highlight,
    );

    // Break caught: the hover rule of the chosen day, which is more specific than the forced-colours rule and so wins, drawing the day in the
    // brand colour under the system's highlight text.
    await selected.hover();
    expect(
      await selected.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        text: getComputedStyle(element).color,
      })),
    ).toEqual({ background: system.highlight, text: system.highlightText });

    // Break caught: today's bar drawn as a fill, which forced colours drop: it is a border, drawn in a colour other than the page's.
    const bar = await page.locator('.ui-date-picker__day--today').evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      return {
        width: style.borderBottomWidth,
        style: style.borderBottomStyle,
        colour: style.borderBottomColor,
      };
    });
    expect([bar.width, bar.style]).toEqual(['2px', 'solid']);
    expect(bar.colour).not.toBe(system.canvas);
  });

  // Break caught: a calendar that animates for someone who asked the system for less motion. The check can fail: with no preference the
  // popover does animate.
  test('animates the calendar only when motion is welcome', async ({ page }) => {
    await openShowcase(page);
    const animations = (): Promise<number> =>
      page.evaluate(async () => {
        const button = document.querySelector<HTMLElement>('.ui-date-picker__button');
        button?.click();
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resolve();
            });
          });
        });
        return document.querySelector('.ui-date-picker__popover')?.getAnimations().length ?? -1;
      });

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await animations()).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await animations()).toBe(0);
  });
});
