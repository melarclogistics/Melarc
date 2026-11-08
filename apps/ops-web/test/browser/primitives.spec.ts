import { expect, test, type Locator, type Page } from '@playwright/test';

import { watchPage, wcagViolations } from './support/page';

/**
 * The shadcn/ui primitives of the development-only showcase (`/__showcase/primitives`), in a real browser: the checks that jsdom cannot make
 * (DESIGN_SYSTEM section 29). An automated WCAG 2.2 scan in both themes, with each overlay open; and, for every overlay, what a person with a keyboard
 * does: open it, move inside it, close it with Escape, and find focus where they left it. They do not replace the recorded keyboard-only and
 * screen-reader passes the first identity flow needs.
 */
const SHOWCASE = '/__showcase/primitives';

type Scheme = 'light' | 'dark';

async function openShowcase(page: Page, scheme?: Scheme): Promise<ReturnType<typeof watchPage>> {
  const seen = watchPage(page);
  if (scheme !== undefined) await page.emulateMedia({ colorScheme: scheme });
  await page.goto(SHOWCASE);
  await expect(page.getByRole('heading', { level: 1, name: 'Primitives showcase' })).toBeVisible();
  return seen;
}

/** Whether keyboard focus is inside an element that matches the selector. */
const focusIn = (page: Page, selector: string): Promise<boolean> =>
  page.evaluate((within) => document.activeElement?.closest(within) != null, selector);

/** What the page paints behind everything, as the browser computed it: the proof that a theme was applied before a scan is trusted. */
const ground = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

interface Overlay {
  readonly name: string;
  /** What opens it, found on the page. */
  readonly trigger: (page: Page) => Locator;
  /** What shows that it is open. */
  readonly shows: string;
  /**
   * A modal that axe does not take for one, because it is not a dialog (axe looks for a `dialog` or `aria-modal`, or for a fixed layer that covers three
   * quarters of the window). Radix hides the page behind it from assistive technology and holds focus inside it (Tab does not leave an open menu or list:
   * the keyboard tests below prove it), so the focusable controls axe finds behind it cannot be reached; axe reports them as hidden but focusable.
   */
  readonly modalAxeDoesNotKnow?: boolean;
}

/** The overlays of the page, each opened with a click. */
const OVERLAYS: readonly Overlay[] = [
  {
    name: 'dialog',
    trigger: (page) => button(page, 'Edit the pickup note'),
    shows: '[role="dialog"]',
  },
  {
    name: 'alert dialog',
    trigger: (page) => button(page, 'Cancel the request'),
    shows: '[role="alertdialog"]',
  },
  {
    name: 'sheet',
    trigger: (page) => button(page, 'Open the request panel'),
    shows: '[role="dialog"]',
  },
  {
    name: 'menu',
    trigger: (page) => button(page, 'Row actions'),
    shows: '[role="menu"]',
    modalAxeDoesNotKnow: true,
  },
  {
    name: 'select',
    trigger: (page) => page.getByRole('combobox', { name: 'Hub', exact: true }),
    shows: '[data-slot="select-content"]',
    modalAxeDoesNotKnow: true,
  },
  {
    name: 'popover',
    trigger: (page) => button(page, 'Filters'),
    shows: '[data-slot="popover-content"]',
  },
  { name: 'command palette', trigger: (page) => button(page, 'Go to…'), shows: '[role="dialog"]' },
];

test.describe('the primitives in a browser: WCAG 2.2 and both themes', () => {
  // Break caught: a primitive whose colours, sizes or roles fail a rule that contrast figures cannot see, in either theme: a scan that runs on
  // a page whose theme was never applied, which is why the page's own ground is compared.
  test('the page has no violation in the light theme and none in the dark theme, set by the system', async ({
    page,
  }) => {
    await openShowcase(page, 'light');
    const light = await ground(page);
    expect(await wcagViolations(page)).toEqual([]);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => ground(page)).not.toBe(light);
    expect(await wcagViolations(page)).toEqual([]);
  });

  // Break caught: the dark theme that works by the system setting and not by the attribute a person's choice will write (step R4), or the
  // light attribute that does not win over a dark system.
  test("the page follows the root's data-theme before the system, in both directions, and has no violation in either", async ({
    page,
  }) => {
    await openShowcase(page, 'light');
    const light = await ground(page);

    await button(page, 'Dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await ground(page)).not.toBe(light);
    expect(await wcagViolations(page)).toEqual([]);

    await page.emulateMedia({ colorScheme: 'dark' });
    await button(page, 'Light').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await ground(page)).toBe(light);

    await button(page, 'System').click();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme');
    expect(await ground(page)).not.toBe(light);
  });

  // Break caught: an overlay that fails a rule only when it is open (the surface of a menu, the focus ring on an item, a dialog's close
  // button), in either theme, which a scan of the closed page never sees. One test for each overlay and theme, because a scan of this page takes
  // seconds in the slower engines and a test has thirty: the time is not raised, the work is divided.
  for (const scheme of ['light', 'dark'] as const) {
    for (const overlay of OVERLAYS) {
      test(`the ${overlay.name} has no violation while it is open, in the ${scheme} theme`, async ({
        page,
      }) => {
        await openShowcase(page, scheme);
        await overlay.trigger(page).click();
        await expect(page.locator(overlay.shows).first()).toBeVisible();

        const violations = await wcagViolations(page, {
          disable: overlay.modalAxeDoesNotKnow === true ? ['aria-hidden-focus'] : [],
        });

        expect(violations).toEqual([]);
      });
    }
  }
});

test.describe('the primitives in a browser: overlays by keyboard', () => {
  // Break caught: a modal that a keyboard cannot leave or that lets focus wander out behind it, one that does not close on Escape, or one that
  // forgets where the person was (the trigger takes focus back), or leaves the page behind it in the accessibility tree.
  for (const modal of [
    {
      name: 'dialog',
      trigger: 'Edit the pickup note',
      role: 'dialog',
      title: 'Edit the pickup note',
    },
    {
      name: 'alert dialog',
      trigger: 'Cancel the request',
      role: 'alertdialog',
      title: 'Cancel request DEMO-0104?',
    },
    {
      name: 'sheet',
      trigger: 'Open the request panel',
      role: 'dialog',
      title: 'Request DEMO-0104',
    },
  ] as const) {
    test(`a ${modal.name} opens from the keyboard, keeps Tab inside, closes on Escape and gives focus back`, async ({
      page,
    }) => {
      const seen = await openShowcase(page);
      const trigger = button(page, modal.trigger);
      await trigger.focus();
      await page.keyboard.press('Enter');

      const overlay = page.getByRole(modal.role, { name: modal.title });
      await expect(overlay).toBeVisible();
      await expect.poll(() => focusIn(page, `[role="${modal.role}"]`)).toBe(true);
      // The page behind is out of reach of a screen reader while the modal is open.
      await expect(button(page, 'Row actions')).toHaveCount(0);

      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Tab');
        expect(await focusIn(page, `[role="${modal.role}"]`), `Tab ${String(step + 1)}`).toBe(true);
      }
      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await focusIn(page, `[role="${modal.role}"]`), `Shift+Tab ${String(step + 1)}`).toBe(
          true,
        );
      }

      await page.keyboard.press('Escape');
      await expect(overlay).toBeHidden();
      await expect(trigger).toBeFocused();
      await expect(button(page, 'Row actions')).toBeVisible();
      expect(seen.problems).toEqual([]);
    });
  }

  // Break caught: a menu that cannot be driven by its keys (open, move, enter a submenu, leave it), that lets Tab carry focus away from an
  // open menu, or that does not give focus back to its button.
  test('a menu opens from the keyboard, moves with the arrows, enters a submenu, closes on Escape and gives focus back', async ({
    page,
  }) => {
    const seen = await openShowcase(page);
    const trigger = button(page, 'Row actions');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Open the request/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Copy the reference' })).toBeFocused();

    // Tab does not carry focus out of an open menu.
    await page.keyboard.press('Tab');
    await expect(menu).toBeVisible();
    expect(await focusIn(page, '[role="menu"]')).toBe(true);

    // The submenu opens with the right arrow and closes with the left, and focus is in it, then back in its parent.
    const sub = page.getByRole('menuitem', { name: 'Move to another hub' });
    await sub.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitem', { name: 'Tema' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(sub).toBeFocused();

    // The submenu may still be on its way out when the menu is: both are gone before the trigger has its focus back.
    await page.keyboard.press('Escape');
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a popover that opens without taking focus in, or closes without giving it back; it is not modal, so the page stays in reach.
  test('a popover opens from the keyboard with focus in it, closes on Escape and gives focus back', async ({
    page,
  }) => {
    const seen = await openShowcase(page);
    const trigger = button(page, 'Filters');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible();
    const field = popover.getByRole('textbox', { name: 'Vendor', exact: true });
    await expect(field).toBeFocused();
    await page.keyboard.type('Bak');
    await expect(field).toHaveValue('Bak');

    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a select that cannot be opened, moved in and chosen from with the keys a native one answers to, or that does not give focus back.
  test('a select opens from the keyboard, chooses with the arrows and Enter, and closes on Escape with focus given back', async ({
    page,
  }) => {
    const seen = await openShowcase(page);
    const trigger = page.getByRole('combobox', { name: 'Hub', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');

    // The page has other listboxes (the command list in it), so the list is the select's own.
    const list = page.locator('[data-slot="select-content"]');
    await expect(list).toBeVisible();
    await expect(list.getByRole('option', { name: 'Accra Central' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option', { name: 'Tema' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(list).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('Tema');

    await page.keyboard.press('Enter');
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText('Tema');
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a command palette that opens without its field focused, whose list does not filter as someone types, or that leaves focus on
  // the body when it closes (it has no trigger of the dialog's own, so the page returns focus).
  test('the command palette opens with its field focused, filters, closes on Escape and gives focus back', async ({
    page,
  }) => {
    const seen = await openShowcase(page);
    const trigger = button(page, 'Go to…');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const palette = page.getByRole('dialog', { name: 'Go to' });
    await expect(palette).toBeVisible();
    await expect(palette.getByRole('combobox')).toBeFocused();
    await expect(palette.getByRole('option', { name: 'Riders' })).toBeVisible();
    await page.keyboard.type('man');
    await expect(palette.getByRole('option', { name: 'Manifests' })).toBeVisible();
    await expect(palette.getByRole('option', { name: 'Riders' })).toHaveCount(0);
    await page.keyboard.type('zzz');
    await expect(palette.getByText('Nothing matches.')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a tooltip that only the pointer can show, that cannot be dismissed without moving focus (WCAG 1.4.13), or that takes focus.
  test('a tooltip shows when the keyboard reaches its button, is dismissed by Escape and leaves focus where it was', async ({
    page,
  }) => {
    const seen = await openShowcase(page);
    await button(page, 'Filters').focus();
    await page.keyboard.press('Tab');
    const trigger = button(page, 'Next pickup day');
    await expect(trigger).toBeFocused();

    const tip = page.locator('[data-slot="tooltip-content"]');
    await expect(tip).toBeVisible();
    await expect(tip).toHaveText('Next pickup day');

    await page.keyboard.press('Escape');
    await expect(tip).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a toast that a keyboard cannot reach or dismiss, that takes focus from the page when it appears, or that leaves focus on the body
  // when it goes. It appears without moving focus; Alt+T (Sonner's hotkey) takes the keyboard to it; it closes from its button; focus returns.
  test('a toast appears without taking focus, is reached with Alt+T, closes from its button and gives focus back', async ({
    page,
  }) => {
    const seen = await openShowcase(page);
    const trigger = button(page, 'Show a confirmation');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const toast = page.locator('[data-sonner-toast]');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('Manifest MF-0101 dispatched');
    await expect(trigger).toBeFocused();

    await page.keyboard.press('Alt+T');
    expect(await focusIn(page, '[data-sonner-toaster]')).toBe(true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(button(page, 'Close toast')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(toast).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a tab list a keyboard cannot walk (arrows, Home, End), one that stops on a disabled tab, or one whose panel does not follow it.
  test('tabs move with the arrows, Home and End, skip a disabled tab and show the panel of the current one', async ({
    page,
  }) => {
    await openShowcase(page);
    const tab = (name: string) => page.getByRole('tab', { name, exact: true });
    await tab('Details').focus();
    await expect(tab('Details')).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowRight');
    await expect(tab('History')).toBeFocused();
    await expect(tab('History')).toHaveAttribute('aria-selected', 'true');
    await expect(
      page.getByText('Each change to the request, with who made it and when.'),
    ).toBeVisible();

    await page.keyboard.press('End');
    await expect(tab('Messages')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tab('Details')).toBeFocused();
    await expect(tab('Audit (not allowed)')).toBeDisabled();
    await page.keyboard.press('Home');
    await expect(tab('Details')).toBeFocused();
  });

  // Break caught: a calendar in the browser's language and order and not the portal's (the week starts on Monday, as the date field's does), one a
  // keyboard cannot walk (arrows move by a day, a week), whose chosen day is not told, or whose chosen day changes without Enter or Space.
  test('the calendar starts its week on Monday, is walked with the arrows and a day is chosen with Enter', async ({
    page,
  }) => {
    await openShowcase(page);
    const calendar = page.locator('[data-slot="calendar"]').first();
    const cell = (day: string) => calendar.locator(`td[data-day="${day}"]`);
    const day = (name: string) => cell(name).getByRole('button');

    await expect(calendar.locator('thead th').first()).toHaveText('Mo');
    await expect(calendar.locator('thead th').first()).toHaveAttribute('aria-label', 'Monday');
    await expect(cell('2026-11-09')).toHaveAttribute('aria-selected', 'true');

    await day('2026-11-09').focus();
    await page.keyboard.press('ArrowRight');
    await expect(day('2026-11-10')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(day('2026-11-17')).toBeFocused();
    await expect(cell('2026-11-09')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(cell('2026-11-17')).toHaveAttribute('aria-selected', 'true');
    await expect(cell('2026-11-09')).not.toHaveAttribute('aria-selected', 'true');
    // Told in the portal's order (day, month, year) and in words, with the state: not the browser's language, and not by colour.
    await expect(day('2026-11-17')).toHaveAccessibleName('Tuesday, 17 November 2026, selected');
  });

  // Break caught: a checkbox that the keyboard cannot turn on and off, or whose label is not part of its target.
  test('a checkbox turns on and off with Space, and its label is part of its target', async ({
    page,
  }) => {
    await openShowcase(page);
    const box = page.getByRole('checkbox', {
      name: 'The vendor has packed everything for this pickup',
    });
    await box.focus();
    await expect(box).not.toBeChecked();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    await page.keyboard.press('Space');
    await expect(box).not.toBeChecked();

    await page.getByText('The vendor has packed everything for this pickup').click();
    await expect(box).toBeChecked();
  });

  // Break caught: a choice of a row that does not reach the table's own count or its row's selected state, or a box that the keyboard cannot reach. (The sort of a data
  // table is the kit's `DataTable`'s, and is proved with it; the table primitive sorts nothing, task R5.2.)
  test('the table primitive counts the rows that are chosen, from the keyboard', async ({
    page,
  }) => {
    await openShowcase(page);
    const table = page.getByRole('table');

    await expect(table.getByText('None chosen.')).toBeVisible();
    await table.getByRole('checkbox', { name: 'Select DEMO-0104' }).focus();
    await page.keyboard.press('Space');
    await expect(table.getByText('1 chosen.')).toBeVisible();
    await expect(table.locator('tr[data-state="selected"]')).toHaveCount(1);

    await table.getByRole('checkbox', { name: 'Select all demo requests' }).focus();
    await page.keyboard.press('Space');
    await expect(table.getByText('6 chosen.')).toBeVisible();
    await expect(table.locator('tr[data-state="selected"]')).toHaveCount(6);
  });
});

test.describe('the primitives in a browser: reduced motion', () => {
  // Break caught: an overlay that never leaves the page when motion is reduced (every duration is zero, and an exit that waits on an animation
  // that does not run stays mounted), or that is not there when it opens.
  test('every overlay opens and is gone again after Escape when the person has asked for no motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const seen = await openShowcase(page);
    for (const overlay of OVERLAYS) {
      await overlay.trigger(page).click();
      await expect(page.locator(overlay.shows).first(), overlay.name).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator(overlay.shows), overlay.name).toHaveCount(0);
    }
    await button(page, 'Show a confirmation').click();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);
    expect(seen.problems).toEqual([]);
  });
});
