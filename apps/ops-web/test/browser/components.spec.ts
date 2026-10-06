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
    probe.remove();
    const labelled = element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : null;
    return {
      name: (element.getAttribute('aria-label') ?? labelled ?? element.textContent).trim(),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      outlineOffset: parseFloat(style.outlineOffset),
      outlineColour: style.outlineColor,
      ringColour,
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
      expect(stop.outlineColour, stop.name).toBe(stop.ringColour);
    }
    const names = stops.map((stop) => stop.name);
    expect(names).toEqual(expected);
    // What the walk must include, and what it must not.
    for (const name of [
      'Demo page action',
      'Primary action',
      'Secondary action',
      'Demo name (required)',
      'Demo read-only value',
      'Submit demo',
    ]) {
      expect(names, name).toContain(name);
    }
    expect(names.filter((name) => name === 'Saving…')).toHaveLength(2);
    expect(names).not.toContain('Disabled action');
    expect(names).not.toContain('Demo disabled value');
    // The disabled controls exist on the page; they are simply not stops.
    await expect(page.getByRole('button', { name: 'Disabled action' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Demo disabled value' })).toBeDisabled();
    if (tabs) expect(names[0]).toBe('Skip to main content');
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
      [...document.querySelectorAll<HTMLElement>('button, input')]
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
        [...document.querySelectorAll<HTMLElement>('button, input')]
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
          '.ui-button:not(:disabled), .ui-input, .ui-alert',
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

    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /sign|log ?(in|out)|account|profile|menu/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: /sign|log ?(in|out)|account|profile/i }),
    ).toHaveCount(0);
  });
});
