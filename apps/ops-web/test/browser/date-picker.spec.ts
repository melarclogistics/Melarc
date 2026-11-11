import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import { watchPage, wcagViolations } from './support/page';

/**
 * The date field of the development-only showcase (COMPONENT_PATTERNS section 22a), in a real browser: what jsdom cannot show of a
 * calendar that opens over the page. The same showcase built for production and served under the strict policy is
 * `date-picker-policy.spec.ts`. These checks do not replace the recorded keyboard-only and screen-reader passes.
 *
 * The date field is one text field for DD/MM/YYYY and a calendar in a popover. Until the last block these are the earlier field's checks with every assertion as it was
 * written (the Product Owner's decision of 6 November 2026): only the way a test finds the control changed, because the three parts (day, month, year) became one
 * field. `part()` is the one field, which holds all three. The last block is what the one field adds.
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
const field = (page: Page, name = REQUIRED): Locator => group(page, name).getByRole('textbox');
/** One part of the date: the one field, which holds all three (the earlier control had a spinbutton for each). */
const part = (page: Page, _kind: 'day' | 'month' | 'year', name = REQUIRED): Locator =>
  field(page, name);
const calendarButton = (page: Page, name = REQUIRED): Locator =>
  group(page, name).getByRole('button', { name: /^Calendar/ });
/** The calendar's popover: the page has other dialogs, so it is found by its own name. */
const dialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Choose a date' });

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

  // Break caught: a day that cannot be chosen with a pointer, or today's day not marked when the calendar opens on it.
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

    await expect(part(page, 'day', range)).toHaveValue('12/10/2026');
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
  /** What the focused element itself draws: for the field's text, nothing (its box draws the one ring). */
  readonly ownOutlineStyle: string;
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
    // The text of the field draws no ring inside the box: the box draws one (the review of 5edada2: one ring, not two), so its ring is the one read.
    const box = element.classList.contains('ui-date-picker__input')
      ? element.closest('.ui-date-picker__control')
      : null;
    const style = getComputedStyle(box ?? element);
    const probe = document.createElement('span');
    probe.style.color = 'var(--focus-ring)';
    document.body.append(probe);
    const ringColour = getComputedStyle(probe).color;
    probe.remove();
    return {
      // The field has no text and no label of its own to show here (the Field's label names it), so it is told by what it asks for.
      name: (
        element.getAttribute('aria-label') ??
        element.getAttribute('placeholder') ??
        element.textContent
      ).trim(),
      ownOutlineStyle: getComputedStyle(element).outlineStyle,
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineOffset: parseFloat(style.outlineOffset),
      outlineColour: style.outlineColor,
      ringColour,
    };
  });
}

test.describe('the date field in a browser: focus and accessibility', () => {
  // Break caught: a stop of the date a keyboard user reaches with no visible focus, or with a ring other than the design system's, or with two rings, one inside the other. (The earlier
  // control had three stops before the button, one for each of day, month and year; this one has the field.)
  test('Tab walks the field and the calendar button, each with the specified focus ring', async ({
    page,
  }) => {
    await openShowcase(page);
    await part(page, 'day').focus();

    const stops: FocusRing[] = [];
    for (let step = 0; step < 2; step += 1) {
      const ring = await focusRing(page);
      expect(ring, `stop ${String(step + 1)}`).not.toBeNull();
      if (ring !== null) stops.push(ring);
      await page.keyboard.press('Tab');
    }

    expect(stops.map((stop) => stop.name)).toEqual(['dd/mm/yyyy', 'Calendar']);
    // One ring on the field: its box draws it, and the text inside draws none (a second ring inside the first); the button is a control of its own and draws its own.
    expect(stops[0]?.ownOutlineStyle).toBe('none');
    expect(stops[1]?.ownOutlineStyle).toBe('solid');
    for (const stop of stops) {
      expect(stop.outlineStyle, stop.name).toBe('solid');
      expect(stop.outlineWidth, stop.name).toBe(2);
      expect(stop.outlineOffset, stop.name).toBe(2);
      expect(stop.outlineColour, stop.name).toBe(stop.ringColour);
    }
  });

  // Break caught: a contrast, target-size, name or relationship failure that shows only with layout, with the calendar open over the page. One test for each state: two scans of the page in one
  // test took 26 s on WebKit with 30 allowed (the engines run of 10 November 2026); the time is not raised, the work is divided.
  test('has no WCAG 2.2 A or AA violation with the calendar closed', async ({ page }) => {
    await openShowcase(page);
    expect(await wcagViolations(page)).toEqual([]);
  });

  test('has no WCAG 2.2 A or AA violation with the calendar open', async ({ page }) => {
    await openShowcase(page);
    await calendarButton(page).click();
    await expect(dialog(page)).toBeVisible();
    expect(await wcagViolations(page)).toEqual([]);
  });

  // Break caught: the muted text colour on the selected fill (4.32:1 against the 4.5:1 that WCAG 1.4.3 needs for 14px text), which shows
  // only when an empty field has focus, or on the subtle fill of an empty read-only date. Neither state is on the page until it is made. One test for each state: two scans of the page in one
  // test took 25 s on WebKit with 30 allowed (the engines run of 10 November 2026); the time is not raised, the work is divided.
  test('has no WCAG 2.2 A or AA violation with an empty part focused', async ({ page }) => {
    await openShowcase(page);

    await part(page, 'day').focus();
    // The state is on the page: the field has focus and nothing typed in it, so that its placeholder shows (the earlier control said it with data-focused and data-placeholder).
    await expect(part(page, 'day')).toBeFocused();
    await expect(part(page, 'day')).toHaveValue('');
    expect(await wcagViolations(page)).toEqual([]);
  });

  test('has no WCAG 2.2 A or AA violation in an empty read-only date', async ({ page }) => {
    await openShowcase(page);

    const readOnly = field(page, 'Demo empty read-only date');
    await expect(readOnly).toHaveValue('');
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
  // Break caught: the looks that no other test sees, because they are CSS alone: an invalid control told by colour at 1px, today with no bold and no bar,
  // days of the next month drawn, and a day that does not answer the pointer.
  test('draws the invalid border, today and the days that are not in the month, and answers the pointer', async ({
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

  // Break caught: the control, with its field that does not wrap, wider than a 320 px screen once the text is twice as large (WCAG 1.4.10
  // and 1.4.4 together, the narrowest screen with the largest text): the page scrolls sideways, or the date is off the screen.
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
    // The earlier control checked each of its three parts; the date is in the one field.
    const box = await part(page, 'day').boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0), 'the field').toBeLessThanOrEqual(320);
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

  // Break caught: a calendar that animates for someone who asked the system for less motion, or one that does not animate for anyone else. The check can fail both ways. With
  // no preference the popover must start an animation that LASTS SOME TIME: an event is also delivered for an animation of no duration, so the animation removed fails the
  // first assertion, and so does its token (`--motion-normal`) set to 0. Under reduced motion it must start NO animation at all, not even one that lasts no time (the
  // stylesheet switches the animation off, it does not only shorten it), so the rule of date-picker.css taken away fails the second. The three breaks were made, run and
  // restored, and their output is in R5-report.md section 11.1.
  test('animates the calendar only when motion is welcome', async ({ page }) => {
    await openShowcase(page);
    // The animations are not sampled frame by frame. The popover primitive keeps its animation off until it has placed the calendar, and the calendar's
    // first frame can take longer than its whole animation (350 to 460 ms in a headless browser without a GPU, against 200 ms), so a sample finds
    // none that is running about half of the time. The start of an animation is an event, delivered even when the frame was late: the starts of the
    // calendar's animations are counted, all of them and those that last some time (both -1 if the calendar never came).
    const starts = (): Promise<{ all: number; timed: number }> =>
      page.evaluate(async () => {
        let all = 0;
        let timed = 0;
        const seconds = (text: string): number =>
          text.endsWith('ms') ? parseFloat(text) / 1000 : parseFloat(text);
        const onStart = (event: AnimationEvent): void => {
          const target = event.target;
          if (
            !(target instanceof Element) ||
            !target.classList.contains('ui-date-picker__popover')
          ) {
            return;
          }
          all += 1;
          // The animation's own duration, read from the computed style of the element at the moment it starts (names and durations are lists, in step).
          const style = getComputedStyle(target);
          const names = style.animationName.split(',').map((part) => part.trim());
          const durations = style.animationDuration.split(',').map((part) => part.trim());
          const at = Math.max(0, names.indexOf(event.animationName));
          if (seconds(durations[at % durations.length] ?? '0s') > 0) timed += 1;
        };
        const wait = (milliseconds: number): Promise<void> =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, milliseconds);
          });
        document.addEventListener('animationstart', onStart, true);
        document.querySelector<HTMLElement>('.ui-date-picker__button')?.click();
        for (
          let waited = 0;
          waited < 3000 && document.querySelector('.ui-date-picker__popover') === null;
          waited += 50
        ) {
          await wait(50);
        }
        const drawn = document.querySelector('.ui-date-picker__popover') !== null;
        await wait(1000);
        document.removeEventListener('animationstart', onStart, true);
        return drawn ? { all, timed } : { all: -1, timed: -1 };
      });

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect((await starts()).timed).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect((await starts()).all).toBe(0);
  });
});

test.describe('the date field in a browser: what the one field adds', () => {
  // Break caught: a day chosen in the calendar that the field does not show, or a date typed into the field that the page is not given.
  test('writes a day chosen in the calendar into the field, and gives the page a date typed into it', async ({
    page,
  }) => {
    await openShowcase(page);

    await calendarButton(page).click();
    await page.getByRole('button', { name: /Friday, 30 October 2026/ }).click();
    await expect(field(page)).toHaveValue('30/10/2026');

    await field(page).fill('');
    await field(page).click();
    await page.keyboard.type('28102026');
    await expect(field(page)).toHaveValue('28/10/2026');
    await expect(page.getByText('The page holds: 2026-10-28')).toBeVisible();
  });

  // Break caught: a text that is not a date taken for one, or a mistake left unsaid: the strict reading, in a browser, with the words on the page.
  test('says in words a text that is not a date, and a date left half typed, and gives the page none', async ({
    page,
  }) => {
    await openShowcase(page);

    await field(page).click();
    await page.keyboard.type('10282026');
    await expect(
      page.getByText('That day is not on the calendar. Check the day and the month.'),
    ).toBeVisible();
    await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('The page holds: no date')).toBeVisible();

    await field(page).fill('');
    await page.keyboard.type('2810');
    const shape = page.getByText('Write the date as DD/MM/YYYY, for example 28/10/2026.');
    // From the field to its calendar button is not leaving the control (it is how the calendar is opened to finish a date): nothing is said yet.
    await page.keyboard.press('Tab');
    await expect(calendarButton(page)).toBeFocused();
    await expect(shape).toBeHidden();
    // Leaving the control says it.
    await page.keyboard.press('Tab');
    await expect(shape).toBeVisible();
    await expect(page.getByText('The page holds: no date')).toBeVisible();
  });

  // Break caught: an impossible date or a year in fewer than four digits moved, completed or given instead of refused (the Product Owner's decision of 7 November 2026), or refused
  // with the wrong words, or the year told while the person is still typing it, or the refusal lost when the person leaves.
  test('refuses a year in fewer than four digits when the person leaves, and a day its month does not have as soon as it is written, in words', async ({
    page,
  }) => {
    await openShowcase(page);
    const year = page.getByText('Enter the year in full, for example 2026');
    const noDay = page.getByText('There is no 30 February');

    await field(page).click();
    await page.keyboard.type('281026');
    await expect(year).toBeHidden();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(year).toBeVisible();
    await expect(field(page)).toHaveValue('28/10/26');
    await expect(field(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('The page holds: no date')).toBeVisible();

    await field(page).fill('');
    await page.keyboard.type('30022026');
    await expect(noDay).toBeVisible();
    await expect(year).toBeHidden();
    await expect(page.getByText('The page holds: no date')).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(noDay).toBeVisible();
    await expect(field(page)).toHaveValue('30/02/2026');
    await expect(page.getByText('The page holds: no date')).toBeVisible();

    // The 29th of February of a year that is not a leap year names the year (the Product Owner's decision of 7 November 2026, afternoon); every other such day keeps its words.
    await field(page).fill('');
    await page.keyboard.type('29022027');
    await expect(page.getByText('2027 has no 29 February')).toBeVisible();
    await expect(noDay).toBeHidden();
    await expect(field(page)).toHaveValue('29/02/2027');
    await expect(page.getByText('The page holds: no date')).toBeVisible();
  });

  // Break caught: the arrow keys not stepping the part under the caret, or sending the caret to the end of the field after a step.
  test('steps the part under the caret with the arrow keys', async ({ page }) => {
    await openShowcase(page);

    await field(page).click();
    await page.keyboard.type('28102026');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByText('The page holds: 2027-10-28')).toBeVisible();
    await expect(field(page)).toHaveValue('28/10/2027');

    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByText('The page holds: 2027-10-27')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByText('The page holds: 2027-10-26')).toBeVisible();
    await expect(field(page)).toHaveValue('26/10/2027');
  });

  // Break caught: a contrast, target-size, name or relationship failure that shows only with layout, in either theme, with the calendar open over the page
  // and with the words of a mistake showing under the control. One test for each theme and state: three scans of the page in one test took 32 s on WebKit with 30 allowed (the engines run of
  // 10 November 2026); the time is not raised, the work is divided.
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no WCAG 2.2 A or AA violation, in the ${scheme} theme, with the calendar closed`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openShowcase(page);
      expect(await wcagViolations(page)).toEqual([]);
    });

    test(`has no WCAG 2.2 A or AA violation, in the ${scheme} theme, with a mistake shown`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openShowcase(page);

      await field(page).click();
      await page.keyboard.type('10282026');
      await expect(page.getByText('That day is not on the calendar.')).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
    });

    test(`has no WCAG 2.2 A or AA violation, in the ${scheme} theme, with the calendar open`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openShowcase(page);

      // The calendar opens over an empty field, as it did when the same test had typed a mistake into it and cleared it first.
      await field(page).fill('');
      await calendarButton(page).click();
      await expect(dialog(page)).toBeVisible();
      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});
