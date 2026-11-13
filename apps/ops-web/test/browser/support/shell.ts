import { expect, type Locator, type Page } from '@playwright/test';

import { SIGNED_IN_SESSION } from './api';
import { animationsDone } from './page';

/**
 * Where the browser tests find the parts of the signed-in shell (redesign step R4): the sidebar, the top bar and the menus of the top bar. One
 * place, so that a rename of an entry or a control is a change here and not in every spec.
 *
 * The sidebar is docked beside the page from 768 px and is the content of a sheet below it, so `primaryNav` finds it docked, or in the sheet
 * while the sheet is open (`openSheet`). Its entries are named by their label and, where the server counted a queue, by the count that follows
 * ("Requests 5 waiting for confirmation"); the stand-ins of the other specs give no count, and then the name is the label.
 */
export const primaryNav = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Primary' });

/**
 * One entry of the sidebar, by its label, with or without the count that follows it: an entry the server counted is named "Requests 5 waiting for
 * confirmation", and a name that had to equal the label would never find it (an absence check on it would pass for an entry that is there).
 * `^Requests(?: |$)` is "Requests" and "Requests, then a space and what follows", and no other entry that begins with the same letters.
 */
export const menuEntry = (page: Page, label: string): Locator =>
  primaryNav(page).getByRole('link', {
    name: new RegExp(`^${label.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(?: |$)`),
  });

/** The top bar, which is the banner of a signed-in screen. */
export const topBar = (page: Page): Locator => page.getByRole('banner');

export const accountButton = (page: Page): Locator =>
  page.getByRole('button', { name: 'Account menu' });

/** The docked sidebar: the landmark beside the page (it is absent on a narrow screen, where the sheet holds the sidebar). */
export const dockedSidebar = (page: Page): Locator =>
  page.getByRole('complementary', { name: 'Main menu' });

/** The sheet that holds the sidebar on a narrow screen. */
export const sheetOf = (page: Page): Locator => page.getByRole('dialog', { name: 'Main menu' });

/** The sidebar as a box, wherever it is: docked, or in the sheet. */
export const sidebarBox = (page: Page): Locator => page.locator('.ui-sidebar');

/** The rem of the page in pixels (what the sidebar's widths are in), at the browser's text size. */
export const remOf = (page: Page): Promise<number> =>
  page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));

/** The width of the docked sidebar in pixels. */
export const sidebarWidth = async (page: Page): Promise<number> =>
  (await page.locator('aside.ui-sidebar').boundingBox())?.width ?? 0;

/**
 * The hubs of a session that lists two: the one of the shared session of the stand-in (`SIGNED_IN_SESSION`) and a second. Synthetic, as everything
 * in these tests is.
 */
export const HUB_A = SIGNED_IN_SESSION.authorized_hubs[0];
export const HUB_B = {
  id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e',
  display_name: 'Second Synthetic Hub',
};

/**
 * Answers the read of the session with the shared session of the stand-in changed as given. Register it after `stubApi`: a route registered later
 * answers first, and what is not a read of the session (its sign-out) is passed on to the one before.
 */
export async function answerSessionWith(
  page: Page,
  changes: Readonly<Record<string, unknown>>,
): Promise<void> {
  await page.route('**/api/v1/auth/session', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      json: { ...SIGNED_IN_SESSION, ...changes },
    });
  });
}

/**
 * The shell is around the screen in the form its width gives it: the top bar always, and the sidebar docked at the side from 768 px; below it the
 * sidebar is out of the document until the bar's button opens it. By layout and not by role: a modal dialog makes the rest of the page inert, and
 * the screens that call this have a dialog open in some of their states.
 */
export async function expectShellAround(page: Page, width: number): Promise<void> {
  await expect(page.locator('header.ui-topbar')).toBeVisible();
  if (width >= 768) {
    await expect(page.locator('aside.ui-sidebar')).toBeVisible();
    await expect(page.locator('button[aria-label="Open menu"]')).toHaveCount(0);
  } else {
    await expect(page.locator('button[aria-label="Open menu"]')).toBeVisible();
    await expect(page.locator('.ui-sidebar')).toHaveCount(0);
  }
}

/** Opens the sidebar's sheet on a narrow screen with the top bar's button, and waits for the sidebar to be there. */
export async function openSheet(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Open menu' }).click();
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * The sheet has stopped sliding and is at the left edge: what a screenshot, an axe run and a click should wait for. Its slide is brought to its end (`animationsDone`) and not waited for: the
 * hosted WebKit run of 13 November 2026 found it 5.15px short of its end for the whole five seconds of the poll, a hosted WebKit's animation clock having stopped.
 */
export async function sheetSettled(page: Page): Promise<void> {
  const sheet = page.locator('[data-slot="sheet-content"]');
  await expect
    .poll(async () => {
      if ((await sheet.count()) > 0) await animationsDone(sheet.first());
      return (await sheet.first().boundingBox())?.x ?? -1;
    })
    .toBe(0);
}

/** Opens the account menu and returns it. */
export async function openAccountMenu(page: Page): Promise<Locator> {
  await accountButton(page).click();
  const menu = page.getByRole('menu', { name: 'Account menu' });
  await expect(menu).toBeVisible();
  return menu;
}

/** Signs out the way a person does: the account menu, then its Sign out item. */
export async function signOutFromMenu(page: Page): Promise<void> {
  const menu = await openAccountMenu(page);
  await menu.getByRole('menuitem', { name: /^Sign out$|^Signing out/ }).click();
}

/** What has focus, as a person meets it: its name, and the outline it is drawn with against the ring its region should have. */
export interface Stop {
  readonly name: string;
  /** Whether it is in the sidebar, which is Ink and has the inverse ring. */
  readonly inSidebar: boolean;
  readonly width: number;
  readonly outline: string;
  /** The colour of the ring the region's token gives (`--focus-ring-inverse` on Ink, `--focus-ring` elsewhere). */
  readonly ring: string;
}

/**
 * The element with focus, named as an assistive technology would name it (its `aria-label`, or its text without what is hidden from it: a
 * picture, a key hint), and how its focus is drawn.
 */
export function focusedStop(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (element === null) return { name: '', inSidebar: false, width: 0, outline: '', ring: '' };
    const copy = element.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    const inSidebar = element.closest('.ui-sidebar') !== null;
    const style = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.style.color = inSidebar ? 'var(--focus-ring-inverse)' : 'var(--focus-ring)';
    document.body.append(probe);
    const ring = getComputedStyle(probe).color;
    probe.remove();
    return {
      name: (element.getAttribute('aria-label') ?? copy.textContent).replaceAll(/\s+/g, ' ').trim(),
      inSidebar,
      width: parseFloat(style.outlineWidth),
      outline: style.outlineColor,
      ring,
    };
  });
}

/** How far the page is wider than the window: more than 0 is sideways scrolling. */
export const overflowOf = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
