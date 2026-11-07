import { expect, test, type Page } from '@playwright/test';

import { SESSION_PATH, stubApi } from './support/api';
import { reachableNames, tabReachesLinks, watchPage, wcagViolations } from './support/page';
import {
  accountButton,
  dockedSidebar,
  focusedStop,
  openAccountMenu,
  openSheet,
  overflowOf,
  primaryNav,
  remOf,
  sheetOf,
  sheetSettled,
  sidebarBox,
  sidebarWidth,
  signOutFromMenu,
  topBar,
} from './support/shell';
import { enforceStrictPolicy, STRICT_POLICY } from './support/strict-policy';

/**
 * The two widths the Ops Portal specification verifies (surfaces/ops-portal.md section 11), and 320 CSS pixels, where
 * content must reflow without sideways scrolling (WCAG 1.4.10, DESIGN_SYSTEM section 14).
 */
const VERIFIED_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

/** From this width the sidebar is docked at the side; below it the top bar's button opens it in a sheet (the frame: 47.9375rem). */
const DOCKED_FROM = 768;

test.describe('the application shell in a browser', () => {
  // Break caught: a production build that does not start, logs errors, or reaches for anything other than its own
  // files. The one thing it asks of the API is who is signed in, once, on this origin (and the counts of the queues, which the stand-in answers
  // apart from the requests it lists).
  test('renders My work for a signed-in person, with no errors, asking the API only who is signed in', async ({
    page,
    baseURL,
  }) => {
    const api = await stubApi(page);
    const seen = watchPage(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
    // The stand-in's server gave this session no queue, so My work says nothing of waiting: not that nothing is, and no heading over nothing.
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Waiting for you' })).toHaveCount(0);
    // A signed-in screen has the shell around it: the top bar is its one banner and the sidebar its one navigation, and the way to leave is in
    // the account menu, a button that is there and an item that is not on the page until the menu is opened.
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(dockedSidebar(page)).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(1);
    await expect(accountButton(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
    await expect(page).toHaveTitle('My work · Melarc Ops Portal');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    expect(seen.problems).toEqual([]);
    expect(seen.requests.length).toBeGreaterThan(0);
    for (const url of seen.requests) expect(new URL(url).origin, url).toBe(baseURL);
    expect(api.requests).toEqual([`GET ${SESSION_PATH}`]);
    expect(api.unexpected).toEqual([]);
  });

  // Break caught: the guard rendering a signed-in page for somebody the API says is not signed in, for any moment, or
  // not taking them to sign-in. The sign-in screen (S0.43) is there: the person ends on it, in the neutral frame, and
  // the screen asks the API for nothing more.
  test('a visit with nobody signed in goes to sign-in and never shows My work or the shell', async ({
    page,
  }) => {
    const api = await stubApi(page, 'signed-out');
    const landingShown: boolean[] = [];
    await page.exposeFunction('noteLanding', () => landingShown.push(true));
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (
          document.querySelector('main h1')?.textContent === 'My work' ||
          document.querySelector('header.ui-topbar') !== null ||
          document.querySelector('.ui-sidebar') !== null
        ) {
          void (window as unknown as { noteLanding: () => Promise<void> }).noteLanding();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/');

    await expect(page).toHaveURL('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(accountButton(page)).toHaveCount(0);
    expect(landingShown).toEqual([]);
    await expect(page.getByText('Synthetic Officer')).toHaveCount(0);
    expect(api.requests).toEqual([`GET ${SESSION_PATH}`]);
    // Back does not return to the guarded page: the redirect replaced its entry.
    await page.goBack();
    await expect(page).not.toHaveURL('/');
  });

  // Break caught: a connection that dropped, or a fault, reading as "signed out" (and discarding what the person was
  // doing), or as a blank page; the retry being absent or not an explicit action.
  test('when the session cannot be checked it says so, keeps the address, and signs in on retry', async ({
    page,
  }) => {
    await stubApi(page, 'unavailable-then-signed-in');
    await page.goto('/');

    await expect(
      page.getByRole('heading', { level: 1, name: 'We could not check your session' }),
    ).toBeVisible();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(/SETTING_MISSING|Diagnostic text/)).toHaveCount(0);
    expect(await wcagViolations(page), 'with the error showing').toEqual([]);

    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
  });

  // Break caught: the shell keeping anything in the browser before the person has chosen anything: the one thing that is ever kept is the
  // choice of theme (`melarc-theme`, written only for Light and Dark; test/browser/top-bar.spec.ts).
  test('stores nothing in the browser until the person chooses a theme', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const stored = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
    }));

    expect(stored).toEqual({ local: 0, session: 0, cookie: '', databases: 0, caches: 0 });
  });

  // Break caught: a keyboard user who cannot see where focus is, cannot skip the sidebar and the top bar, or is left
  // somewhere unexpected after skipping.
  test('keyboard: the skip link is the first stop, visibly focused, and moves focus to the content', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).not.toBeInViewport();

    // The first stop in the document is the skip link, in every engine; Tab arrives there wherever it reaches links.
    const tabs = await tabReachesLinks(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect((await reachableNames(page, true))[0]).toBe('Skip to main content');
    if (tabs) await page.keyboard.press('Tab');
    else await skipLink.focus();

    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();
    const outline = await skipLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).toBe('solid');
    expect(outline.width).toBeGreaterThanOrEqual(2);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
  });

  // Break caught: an unknown address giving a blank page, the page reloading when a link is followed,
  // focus left behind after a client-side navigation, or the browser's history not working.
  test('an unknown address shows page-not-found; its link works by keyboard and focuses the new heading', async ({
    page,
  }) => {
    await stubApi(page);
    const seen = watchPage(page);
    await page.goto('/definitely/not/a/page');
    const tabs = await tabReachesLinks(page);

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page).toHaveTitle('Page not found · Melarc Ops Portal');

    // Tab 1 is the skip link, tab 2 the link home. Following it must not reload the page.
    const home = page.getByRole('link', { name: 'Go to the start page' });
    await page.evaluate(() => Object.assign(window, { survivedNavigation: true }));
    if (tabs) {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
    } else {
      await home.focus();
    }
    await expect(home).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeFocused();
    expect(await page.evaluate(() => 'survivedNavigation' in window)).toBe(true);

    await page.goBack();
    await expect(page).toHaveURL('/definitely/not/a/page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(seen.problems).toEqual([]);
  });

  // Break caught: script-src needing 'unsafe-inline' or 'unsafe-eval' to run the shell. (style-src allows inline style by decision, below.)
  test('runs under a strict Content-Security-Policy', async ({ page }) => {
    const violations = await enforceStrictPolicy(page);
    await stubApi(page);
    const seen = watchPage(page);

    const response = await page.goto('/no-such-page');

    // The policy was really sent, and the application still starts and navigates under it.
    expect(response?.headers()['content-security-policy']).toBe(STRICT_POLICY);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to the start page' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  // Break caught: the relaxation of style-src (Product Owner, 5 November 2026) spreading to code. These are the three ways a page can run code
  // that `script-src 'self'` refuses, tried against the real policy in a real engine: a script written into the page, `eval`, and a script from
  // another origin. Each must not run, and the browser must report each as a violation of script-src. If one of them runs, the policy is
  // no longer the protection against injected code acting as the officer, whatever else is true of it.
  test('still refuses an inline script, eval and a script from another origin', async ({
    page,
  }) => {
    const violations = await enforceStrictPolicy(page);
    await stubApi(page);
    // A script of the page's own origin, which script-src lets run: what it then tries is what an injected script would try. (The test cannot call
    // eval from page.evaluate: Playwright runs that through DevTools, which a content-security policy does not apply to.)
    await page.route('**/policy-probe.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: [
          "window.evalError = 'none';",
          "try { (0, eval)('window.evalRan = true;'); } catch (error) { window.evalError = error.name; }",
          "window.functionError = 'none';",
          "try { new Function('window.functionRan = true;')(); } catch (error) { window.functionError = error.name; }",
        ].join('\n'),
      }),
    );
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

    const outcome = await page.evaluate(async () => {
      const probes = window as unknown as Record<string, unknown>;
      const inline = document.createElement('script');
      inline.textContent = 'window.inlineScriptRan = true;';
      document.head.append(inline);

      const own = document.createElement('script');
      own.src = '/policy-probe.js';
      const loaded = new Promise((resolve) => {
        own.addEventListener('load', resolve);
        own.addEventListener('error', resolve);
      });
      document.head.append(own);
      await loaded;

      const foreign = document.createElement('script');
      foreign.src = 'https://scripts.example.invalid/injected.js';
      document.head.append(foreign);
      await new Promise((resolve) => setTimeout(resolve, 400));

      return {
        inlineRan: probes.inlineScriptRan === true,
        evalRan: probes.evalRan === true,
        evalError: probes.evalError,
        functionRan: probes.functionRan === true,
        functionError: probes.functionError,
      };
    });

    expect(outcome).toEqual({
      inlineRan: false,
      evalRan: false,
      evalError: 'EvalError',
      functionRan: false,
      functionError: 'EvalError',
    });
    const report = violations.join('\n');
    expect(report).toMatch(/script-src[\w-]* inline/);
    expect(report).toMatch(/script-src[\w-]* eval/);
    expect(report).toMatch(/script-src[\w-]* https:\/\/scripts\.example\.invalid/);
  });

  // Break caught: the decision of 5 November 2026 not holding, so that a UI library which inserts <style> elements at run time (Radix does)
  // is refused, or the relaxation being wider than inline style. A style element and a style attribute are the two inline styles; both apply,
  // and neither is a violation.
  test('allows the inline style a library inserts at run time, and a style attribute', async ({
    page,
  }) => {
    const violations = await enforceStrictPolicy(page);
    await stubApi(page);
    await page.goto('/no-such-page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();

    const applied = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = ':root { --policy-probe: applied; }';
      document.head.append(style);

      const box = document.createElement('div');
      box.setAttribute('style', 'min-width: 123px');
      box.textContent = 'An element with a style attribute';
      document.body.append(box);

      return {
        fromElement: getComputedStyle(document.documentElement)
          .getPropertyValue('--policy-probe')
          .trim(),
        fromAttribute: getComputedStyle(box).minWidth,
      };
    });

    expect(applied).toEqual({ fromElement: 'applied', fromAttribute: '123px' });
    expect(violations).toEqual([]);
  });

  // Break caught: the typeface being declared but never loading under the policy of this file (font-src 'self'), so that
  // every user silently gets the fallback stack. Inter's Latin subset is the one the page's text needs.
  test('loads Inter from its own files under the strict policy', async ({ page, baseURL }) => {
    const violations = await enforceStrictPolicy(page);
    await stubApi(page);
    const seen = watchPage(page);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();

    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => face.family.replaceAll(/["']/g, ''));
    });
    expect(loaded).toContain('Inter');
    const fontFiles = seen.requests.filter((url) => new URL(url).pathname.endsWith('.woff2'));
    expect(fontFiles.length).toBeGreaterThan(0);
    for (const url of fontFiles) expect(new URL(url).origin, url).toBe(baseURL);

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  // Break caught: the logo broken or blocked (inlined as a data: URI, which `img-src 'self'` refuses, or not shipped),
  // squashed or stretched (BRAND_FOUNDATION 4.6), or not growing with enlarged text. The proportions are those of the
  // supplied artwork, 217.24 by 69.34.
  test('shows the logo under the strict policy, as its own file, in its proportions', async ({
    page,
    baseURL,
  }) => {
    const violations = await enforceStrictPolicy(page);
    await stubApi(page);
    const seen = watchPage(page);
    // The full logo is the neutral frame's banner, which an address that matches no route has (a signed-in screen has the sidebar's lockup).
    await page.goto('/no-such-page');
    const logo = page.getByRole('banner').getByRole('img', { name: 'Melarc Logistics' });
    await expect(logo).toBeVisible();

    const loaded = await logo.evaluate((image: HTMLImageElement) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      src: image.currentSrc,
    }));
    expect(loaded.complete).toBe(true);
    expect(loaded.naturalWidth).toBeGreaterThan(0);
    const source = new URL(loaded.src);
    expect(source.origin).toBe(baseURL);
    expect(source.pathname).toMatch(/^\/assets\/melarc-logo-primary-[\w-]+\.svg$/);
    expect(loaded.src.startsWith('data:')).toBe(false);

    const box = await logo.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(217.24 / 69.34, 1);
    const before = box?.height ?? 0;

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    expect((await logo.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(before * 1.8);

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  // Break caught: the lockup of the sidebar blocked by the policy (inlined, or from another origin) or not shipped, so that the sidebar names the
  // product beside an empty square; the lockup squashed; or, on the rail, the symbol missing from its tile.
  test('shows the all-white lockup in the sidebar, and the symbol on its tile on the rail, as their own files under the strict policy', async ({
    page,
    baseURL,
  }) => {
    const violations = await enforceStrictPolicy(page);
    await stubApi(page);
    const seen = watchPage(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const lockup = dockedSidebar(page).getByRole('img', { name: 'Melarc Logistics' });
    await expect(lockup).toBeVisible();

    const loaded = await lockup.evaluate((image: HTMLImageElement) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      src: image.currentSrc,
    }));
    expect(loaded.complete).toBe(true);
    expect(loaded.naturalWidth).toBeGreaterThan(0);
    const source = new URL(loaded.src);
    expect(source.origin).toBe(baseURL);
    expect(source.pathname).toMatch(/^\/assets\/melarc-logo-dark-[\w-]+\.svg$/);
    expect(loaded.src.startsWith('data:')).toBe(false);
    // The proportions of the artwork, and about 132 by 42 at the browser's text size.
    const box = await lockup.boundingBox();
    expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(188.88 / 60.29, 1);
    expect(box?.height ?? 0).toBeCloseTo(42, 0);

    await page.getByRole('button', { name: 'Collapse menu' }).click();
    const mark = dockedSidebar(page).locator('.ui-brand-lockup__mark img');
    await expect(mark).toBeVisible();
    const tile = await mark.evaluate((image: HTMLImageElement) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      src: image.currentSrc,
      alt: image.alt,
    }));
    expect(tile.complete).toBe(true);
    expect(tile.naturalWidth).toBeGreaterThan(0);
    expect(new URL(tile.src).origin).toBe(baseURL);
    expect(new URL(tile.src).pathname).toBe('/favicon.svg');
    expect(tile.alt).toBe('');
    // The name of the product stays in the rail for a screen reader.
    await expect(dockedSidebar(page).getByText('Melarc Logistics')).toBeAttached();

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  for (const { width, height } of VERIFIED_VIEWPORTS) {
    // Break caught: a layout that breaks at a verified width, or colour contrast that fails in a real
    // browser, which jsdom cannot check. Also with the skip link showing, its most exposed state.
    test(`has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await stubApi(page);

      for (const path of ['/', '/no-such-page']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await wcagViolations(page), path).toEqual([]);
        expect(await overflowOf(page), `${path} overflows sideways`).toBeLessThanOrEqual(0);
      }

      await page.goto('/');
      const tabs = await tabReachesLinks(page);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (tabs) await page.keyboard.press('Tab');
      else await page.getByRole('link', { name: 'Skip to main content' }).focus();
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeInViewport();
      expect(await wcagViolations(page), 'with the skip link focused').toEqual([]);
    });
  }
});

test.describe('the authenticated Ops shell in a browser', () => {
  // Break caught: the sidebar inside the main content, where the skip link would land on it, or after it, where a keyboard user finds it last;
  // the top bar anywhere but over the page, or not the page's banner; a sidebar that is not at the edge, the height of the window, 248px wide, with
  // the page beginning where it ends; a top bar that is not 56px; the old band above everything left in the frame.
  test('draws the sidebar and the top bar around the main content: in the order of the landmarks, the sidebar full height at the left edge, the top bar 56px over the page', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(primaryNav(page)).toBeVisible();
    const rem = await remOf(page);

    const layout = await page.evaluate(() => {
      const everything = [...document.body.querySelectorAll('*')];
      const index = (selector: string): number => {
        const found = document.querySelector(selector);
        return found === null ? -1 : everything.indexOf(found);
      };
      const box = (selector: string) => {
        const found = document.querySelector(selector)?.getBoundingClientRect();
        return found === undefined
          ? null
          : { x: found.x, y: found.y, width: found.width, height: found.height };
      };
      return {
        skip: index('a.skip-link'),
        menu: index('aside[aria-label="Main menu"]'),
        nav: index('aside nav[aria-label="Primary"]'),
        bar: index('header.ui-topbar'),
        main: index('main'),
        navInMain: document.querySelector('main nav') !== null,
        menuInMain: document.querySelector('main aside') !== null,
        barInMain: document.querySelector('main header.ui-topbar') !== null,
        band: document.querySelector('.app-header') !== null,
        menuBox: box('aside[aria-label="Main menu"]'),
        barBox: box('header.ui-topbar'),
        mainBox: box('main'),
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
      };
    });
    // The order of the document: the skip link, the sidebar (landmark, then its navigation), the top bar, then the main content.
    expect(layout.skip).toBeGreaterThanOrEqual(0);
    expect(layout.menu).toBeGreaterThan(layout.skip);
    expect(layout.nav).toBeGreaterThan(layout.menu);
    expect(layout.bar).toBeGreaterThan(layout.nav);
    expect(layout.main).toBeGreaterThan(layout.bar);
    expect(layout.navInMain).toBe(false);
    expect(layout.menuInMain).toBe(false);
    expect(layout.barInMain).toBe(false);
    expect(layout.band).toBe(false);
    // The sidebar: at the corner, 248px (15.5rem), as tall as the window.
    expect(layout.menuBox?.x).toBe(0);
    expect(layout.menuBox?.y).toBe(0);
    expect(layout.menuBox?.width).toBe(15.5 * rem);
    expect(layout.menuBox?.height).toBeCloseTo(layout.windowHeight, 0);
    // The top bar: beside the sidebar and over the page, 56px (3.5rem).
    expect(layout.barBox?.x).toBe(layout.menuBox?.width);
    expect(layout.barBox?.y).toBe(0);
    expect(layout.barBox?.height).toBe(3.5 * rem);
    expect((layout.barBox?.x ?? 0) + (layout.barBox?.width ?? 0)).toBeCloseTo(
      layout.windowWidth,
      0,
    );
    // The page begins where the sidebar ends and under the top bar.
    expect(layout.mainBox?.x ?? -1).toBeGreaterThanOrEqual(
      layout.menuBox?.width ?? Number.MAX_VALUE,
    );
    expect(layout.mainBox?.y ?? -1).toBeGreaterThanOrEqual(
      layout.barBox?.height ?? Number.MAX_VALUE,
    );
    await expect(primaryNav(page).getByRole('link', { name: 'My work' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // Break caught: the entries not in the groups of the specification or not in their order, a group named by a heading that adds to the page's
  // outline, an entry with no picture (the same family of icons everywhere is the rule), or a picture that reaches a screen reader as a second name.
  test('lists the entries in groups, each a list named by its heading, each entry with an icon of the family that is decoration beside its name', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(primaryNav(page)).toBeVisible();

    // The stubbed session holds `staff.read`: it is given My work, and the staff list and the sessions page. The groups with nothing in them are not drawn.
    await expect(primaryNav(page).locator('.ui-sidebar__heading')).toHaveText([
      'Today',
      'People and access',
    ]);
    await expect(
      primaryNav(page).getByRole('list', { name: 'Today' }).getByRole('link'),
    ).toHaveText(['My work']);
    await expect(
      primaryNav(page).getByRole('list', { name: 'People and access' }).getByRole('link'),
    ).toHaveText(['Staff', 'Sessions']);
    // A group's heading is a label of its list and is not a heading of the page: the page's outline is its own.
    await expect(page.getByRole('heading')).toHaveText(['My work']);

    const links = await primaryNav(page)
      .getByRole('link')
      .evaluateAll((all) =>
        all.map((link) => ({
          name: link.textContent.trim(),
          pictures: link.querySelectorAll('svg').length,
          hidden: link.querySelector('svg')?.getAttribute('aria-hidden'),
        })),
      );
    expect(links.map((link) => link.name)).toEqual(['My work', 'Staff', 'Sessions']);
    for (const link of links)
      expect(link, link.name).toMatchObject({ pictures: 1, hidden: 'true' });
  });

  // Break caught: the current entry told by colour alone (a plain colour change is what the Product Owner rejected on 6 November 2026), or
  // not the solid crimson fill of the specification.
  test('marks the current entry by more than its colour: a solid fill, bold, and aria-current', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(primaryNav(page)).toBeVisible();

    const current = primaryNav(page).getByRole('link', { name: 'My work' });
    const other = primaryNav(page).getByRole('link', { name: 'Staff' });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect(primaryNav(page).locator('[aria-current="page"]')).toHaveCount(1);
    const read = (link: typeof current) =>
      link.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--shell-active)';
        document.body.append(probe);
        const crimson = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { weight: style.fontWeight, fill: style.backgroundColor, crimson };
      });
    const [now, then] = await Promise.all([read(current), read(other)]);
    expect(now.fill).toBe(now.crimson);
    expect(then.fill).not.toBe(now.crimson);
    expect(Number(now.weight)).toBeGreaterThan(Number(then.weight));
  });

  // Break caught: the account card missing from the foot, or saying who is signed in with a picture alone, or naming a person other than the
  // session's. The sign-out is the account menu's and is not in the foot.
  test('says who is signed in and where they act at the foot of the sidebar', async ({ page }) => {
    await stubApi(page);
    await page.goto('/');

    const account = page.getByRole('group', { name: 'Your account' });
    await expect(account.getByText('Synthetic Officer')).toBeVisible();
    await expect(account.getByText('Synthetic Hub')).toBeVisible();
    // The initials are decoration: the name beside them is the content.
    await expect(account.locator('.ui-sidebar__avatar')).toHaveText('SO');
    await expect(account.locator('.ui-sidebar__avatar')).toHaveAttribute('aria-hidden', 'true');
    await expect(account.getByRole('button')).toHaveCount(0);
  });

  // Break caught: the neutral frame gaining the shell: an address that matches no route cannot know whether a session exists.
  test('is not around an unknown address', async ({ page }) => {
    await stubApi(page);
    await page.goto('/no-such-page');

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(accountButton(page)).toHaveCount(0);
    await expect(page.locator('header.ui-topbar')).toHaveCount(0);
  });

  // Break caught: the focus indicator of the Ink sidebar being the default blue ring, which is only 2.96:1 on Ink, or being lost; a control
  // missing from the walk, or one that is out of sight taking a stop.
  test('walks by Tab through the skip link, the sidebar, then the top bar, each stop with the ring of its ground', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(primaryNav(page)).toBeVisible();
    const tabs = await tabReachesLinks(page);
    await expect(primaryNav(page)).toBeVisible();

    const stops: Awaited<ReturnType<typeof focusedStop>>[] = [];
    // The stubbed session holds `staff.read`, so the sidebar has the staff list and the sessions page. The hub is one, so its name is drawn and is
    // no stop; the session may create nothing, so there is no New menu. The links are no stop in an engine that leaves them out of the Tab order.
    const expected = tabs
      ? [
          'Skip to main content',
          'Collapse menu',
          'My work',
          'Staff',
          'Sessions',
          'Search a code, name or phone',
          'Theme: System',
          'Account menu',
        ]
      : ['Collapse menu', 'Search a code, name or phone', 'Theme: System', 'Account menu'];
    for (const name of expected) {
      await page.keyboard.press('Tab');
      stops.push(await focusedStop(page));
      expect(stops.at(-1)?.name, `the stop after ${String(stops.length)} Tab presses`).toBe(name);
    }

    expect(stops.map((stop) => stop.name)).toEqual(expected);
    for (const stop of stops.filter((candidate) => candidate.name !== 'Skip to main content')) {
      expect(stop.width, stop.name).toBe(2);
      expect(stop.outline, stop.name).toBe(stop.ring);
    }
    // The sidebar's stops are on Ink and have the inverse ring; the top bar's are on the page and have the standard one.
    expect(stops.filter((stop) => stop.inSidebar).map((stop) => stop.name)).toEqual(
      expected.filter(
        (name) =>
          ![
            'Skip to main content',
            'Search a code, name or phone',
            'Theme: System',
            'Account menu',
          ].includes(name),
      ),
    );
  });

  // Break caught: a sidebar that cannot be collapsed, or that loses the names of its entries when it is (a screen reader then hears "link" and a
  // picture), or that leaves the room it gave up empty, or whose choice is written to the browser.
  test('collapses to a rail of icons and expands again, each entry keeping its name', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page);
    await page.goto('/');
    const rem = await remOf(page);
    const toggle = page.getByRole('button', { name: 'Collapse menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // 248px: 15.5rem at the browser's text size.
    expect(await sidebarWidth(page)).toBe(15.5 * rem);
    const mainBefore = (await page.getByRole('main').boundingBox())?.x ?? 0;

    await toggle.click();

    const expand = page.getByRole('button', { name: 'Expand menu' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    // The 64px rail: 4rem.
    await expect.poll(() => sidebarWidth(page)).toBe(4 * rem);
    // The page takes the room the sidebar gave up, and the top bar with it.
    expect((await page.getByRole('main').boundingBox())?.x ?? Number.MAX_VALUE).toBeLessThan(
      mainBefore,
    );
    expect((await topBar(page).boundingBox())?.x ?? Number.MAX_VALUE).toBeLessThan(mainBefore);
    for (const name of ['My work', 'Staff', 'Sessions']) {
      const link = primaryNav(page).getByRole('link', { name });
      // The label is drawn out of sight, not taken out of the document, and the picture stays.
      expect(
        (await link.locator('.ui-sidebar__label').boundingBox())?.width ?? 99,
      ).toBeLessThanOrEqual(1);
      expect((await link.locator('svg').boundingBox())?.width ?? 0).toBeGreaterThan(0);
    }
    const account = page.getByRole('group', { name: 'Your account' });
    await expect(account.locator('.ui-sidebar__avatar')).toBeVisible();
    expect(
      (await account.getByText('Synthetic Officer').boundingBox())?.width ?? 99,
    ).toBeLessThanOrEqual(1);
    // Nothing was written: the choice lasts as long as the page and no longer.
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });

    // By keyboard, with focus staying on the button, whose name now says what it will do.
    await expand.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeFocused();
    await expect.poll(() => sidebarWidth(page)).toBe(15.5 * rem);

    // What was chosen lasts as long as the page and no longer: nothing was written, so a reload starts expanded.
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await expect.poll(() => sidebarWidth(page)).toBe(4 * rem);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
    expect(await sidebarWidth(page)).toBe(15.5 * rem);
  });

  // Break caught: the rail at the width where there is room for the full sidebar, or the full sidebar where the page needs the room (below
  // 1280px the page is the rail's neighbour), or a choice of the person undone by a resize.
  test('is the full sidebar from 1280 px and the rail below it, and the person may ask for the other', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const rem = await remOf(page);
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
    expect(await sidebarWidth(page)).toBe(15.5 * rem);

    await page.setViewportSize({ width: 1279, height: 800 });

    await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
    await expect.poll(() => sidebarWidth(page)).toBe(4 * rem);

    await page.setViewportSize({ width: 768, height: 800 });
    await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
    expect(await sidebarWidth(page)).toBe(4 * rem);

    // The person asks for the full sidebar at this width, and gets it until the page is loaded again.
    await page.getByRole('button', { name: 'Expand menu' }).click();
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
    await expect.poll(() => sidebarWidth(page)).toBe(15.5 * rem);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
    expect(await sidebarWidth(page)).toBe(4 * rem);
  });

  // Break caught: the narrow screen's controls (the sheet's button) drawn on a wide screen, or the wide screen's collapse button on a narrow
  // one, where the sidebar does not dock and there is nothing to collapse.
  test('shows the collapse button on a wide screen and the menu button on a narrow one, never both', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCount(0);

    await page.setViewportSize({ width: 600, height: 800 });

    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toHaveCount(0);
    await expect(dockedSidebar(page)).toHaveCount(0);
  });

  test.describe('on a narrow screen', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    // Break caught: a sidebar that is only out of sight, so that a keyboard user tabs into entries they cannot see, or a screen whose only way
    // to navigate is inside a closed sidebar with no button to open it.
    test('keeps the sidebar behind the top bar’s button, out of the document and the tab order while it is closed', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const open = page.getByRole('button', { name: 'Open menu' });

      await expect(open).toBeVisible();
      await expect(open).toHaveAttribute('aria-expanded', 'false');
      await expect(open).toHaveAttribute('aria-haspopup', 'dialog');
      await expect(topBar(page)).toBeVisible();
      await expect(topBar(page).getByText('Synthetic Hub')).toBeVisible();
      await expect(dockedSidebar(page)).toHaveCount(0);
      await expect(primaryNav(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Collapse menu' })).toHaveCount(0);
      // The theme is chosen in the account menu on a narrow screen: the bar keeps its room for the search and the account.
      await expect(page.getByRole('button', { name: /^Theme:/ })).toHaveCount(0);
      const names = await reachableNames(page, true);
      expect(names).toContain('Open menu');
      expect(names).toContain('Account menu');
      for (const name of ['My work', 'Staff', 'Sessions', 'Close menu', 'Collapse menu']) {
        expect(names, name).not.toContain(name);
      }
    });

    // Break caught: a sheet that opens without taking focus in, or leaves the page behind it reachable, or cannot be closed from the keyboard,
    // or closes and leaves focus nowhere.
    test('opens as a sheet over the page, takes focus, hides the page behind it, and Escape closes it and gives focus back', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const open = page.getByRole('button', { name: 'Open menu' });

      await open.click();

      const sheet = sheetOf(page);
      await expect(sheet).toBeVisible();
      await expect(page.locator('button[aria-label="Open menu"]')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
      await expect(sheet.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      await expect(sheet.getByRole('link', { name: 'My work' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(sheet.getByRole('group', { name: 'Your account' })).toContainText(
        'Synthetic Officer',
      );
      // The page behind the sheet is out of reach of assistive technology while it is open.
      await expect(page.getByRole('main')).toHaveCount(0);
      await sheetSettled(page);
      const box = await page.locator('[data-slot="sheet-content"]').boundingBox();
      expect(box?.height).toBe(640);
      expect(box?.width ?? 999).toBeLessThanOrEqual(0.85 * 320);

      await page.keyboard.press('Escape');

      await expect(sheet).toHaveCount(0);
      await expect(open).toBeFocused();
      await expect(open).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('main')).toHaveCount(1);
    });

    // Break caught: a scrim that does not close the sheet, or a close button that does and leaves focus behind.
    test('closes by the scrim and by its close button, each giving focus back to the menu button', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const open = page.getByRole('button', { name: 'Open menu' });

      await open.click();
      await sheetSettled(page);
      await page.locator('[data-slot="sheet-overlay"]').click({ position: { x: 300, y: 320 } });
      await expect(sheetOf(page)).toHaveCount(0);
      await expect(open).toBeFocused();

      await open.click();
      await sheetSettled(page);
      await page.getByRole('button', { name: 'Close menu' }).click();
      await expect(sheetOf(page)).toHaveCount(0);
      await expect(open).toBeFocused();
      await expect(page.getByRole('main')).toHaveCount(1);
    });

    // Break caught: a link followed from the sheet that leaves the sheet over the new page, or leaves focus on the body: the person who went to a
    // page must land on that page's heading, as after any other navigation.
    test('following an entry closes the sheet and lands on the new page’s heading', async ({
      page,
    }) => {
      const api = await stubApi(page);
      await page.goto('/');
      const sheet = await openSheet(page);
      await sheetSettled(page);

      await sheet.getByRole('link', { name: 'Sessions' }).click();

      await expect(page).toHaveURL('/admin/sessions');
      await expect(sheetOf(page)).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeFocused();
      await expect(page.locator('button[aria-label="Open menu"]')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(api.unexpected).toEqual([]);
    });

    // Break caught: the slide running for a person who asked for no motion. The rule that says so must win over the rule of the open state.
    test('does not slide the sheet in when the person asked for less motion, and does when they did not', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const content = page.locator('[data-slot="sheet-content"]');
      const durationOf = (): Promise<string> =>
        content.evaluate((element) => getComputedStyle(element).animationDuration);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.getByRole('button', { name: 'Open menu' }).click();
      await expect(sheetOf(page)).toBeVisible();
      expect(await durationOf(), 'open, reduced motion').toBe('0s');
      await page.keyboard.press('Escape');
      await expect(content).toHaveCount(0);

      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.getByRole('button', { name: 'Open menu' }).click();
      await expect(sheetOf(page)).toBeVisible();
      expect(await durationOf(), 'open, motion allowed').not.toBe('0s');
    });

    // Break caught: the bar or the open sheet overflowing the screen when text is enlarged; the lockup pushing the close button out of the sheet; an
    // entry or the account card that no keyboard can bring into view (WCAG 1.4.4, 1.4.10, 2.4.11).
    test('keeps the bar and the open sheet whole when text is enlarged to 200%', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();

      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });

      const within = async (name: string, control: ReturnType<Page['locator']>): Promise<void> => {
        const box = await control.boundingBox();
        expect(box?.x ?? -1, `${name}: left edge`).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), `${name}: right edge`).toBeLessThanOrEqual(320);
        expect(box?.y ?? -1, `${name}: top edge`).toBeGreaterThanOrEqual(0);
        expect((box?.y ?? 0) + (box?.height ?? 0), `${name}: bottom edge`).toBeLessThanOrEqual(640);
      };
      expect(await overflowOf(page), 'the bar').toBeLessThanOrEqual(0);
      await within('Open menu', page.getByRole('button', { name: 'Open menu' }));
      await within('Account menu', accountButton(page));
      await within('Search', page.getByRole('button', { name: 'Search a code, name or phone' }));

      await page.getByRole('button', { name: 'Open menu' }).click();
      await sheetSettled(page);

      expect(await overflowOf(page), 'the open sheet').toBeLessThanOrEqual(0);
      await within('Close menu', page.getByRole('button', { name: 'Close menu' }));
      // The lockup is drawn smaller to make room and is not squeezed out of shape: it is inside the sheet.
      const logo = await sheetOf(page).getByRole('img', { name: 'Melarc Logistics' }).boundingBox();
      expect((logo?.x ?? -1) + (logo?.width ?? 0), 'the lockup, right edge').toBeLessThanOrEqual(
        272,
      );
      expect(logo?.width ?? 0, 'the lockup has room').toBeGreaterThan(60);

      // Nothing is squeezed or overlaps: every entry lies inside the list, and the account card begins where the list ends.
      const [list, card] = await Promise.all([
        primaryNav(page).boundingBox(),
        page.getByRole('group', { name: 'Your account' }).boundingBox(),
      ]);
      for (const entry of ['My work', 'Staff', 'Sessions']) {
        const box = await primaryNav(page).getByRole('link', { name: entry }).boundingBox();
        expect((box?.y ?? 0) + (box?.height ?? 0), `${entry}: inside the list`).toBeLessThanOrEqual(
          (list?.y ?? 0) + (list?.height ?? 0) + 1,
        );
      }
      expect(card?.y ?? 0, 'the account card starts below the list').toBeGreaterThanOrEqual(
        (list?.y ?? 0) + (list?.height ?? 0) - 1,
      );

      // The panel scrolls as a whole when it is taller than the window, so focus brings each control into view. Firefox scrolls to a focused
      // control only when none of it can be seen, so what holds in every engine is that some of it is in view, and that the control is wholly
      // inside across.
      for (const [label, control] of [
        ['My work', primaryNav(page).getByRole('link', { name: 'My work' })],
        ['Sessions', primaryNav(page).getByRole('link', { name: 'Sessions' })],
        ['Close menu', page.getByRole('button', { name: 'Close menu' })],
      ] as const) {
        await control.focus();
        await expect(control, `${label}, once focused`).toBeInViewport();
        const box = await control.boundingBox();
        expect(box?.x ?? -1, `${label}: left edge`).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), `${label}: right edge`).toBeLessThanOrEqual(320);
      }
    });
  });

  test('signs out from the account menu: ends the session on the server with the CSRF token, and leaves the signed-in pages', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      {
        name: 'melarc_csrf',
        value: 'synthetic-csrf-token',
        url: baseURL ?? 'http://127.0.0.1:4173',
      },
    ]);
    const api = await stubApi(page, 'signed-in', { signOut: 'ok' });
    await page.goto('/');
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();

    await signOutFromMenu(page);

    await expect(page).toHaveURL('/sign-in');
    await expect(page.getByText('Synthetic Officer')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(accountButton(page)).toHaveCount(0);
    expect(api.requests).toEqual([`GET ${SESSION_PATH}`, `DELETE ${SESSION_PATH}`]);
    expect(api.signOutTokens).toEqual(['synthetic-csrf-token']);
    expect(api.unexpected).toEqual([]);
    // Back does not return to a page that cannot be shown.
    await page.goBack();
    await expect(page.getByText('Synthetic Officer')).toHaveCount(0);
  });

  // Break caught: a menu that closes on the selection and takes the progress of the sign-out with it, or one that lets a second selection send a
  // second request.
  test('keeps the account menu open and says so while the sign-out is under way, and sends it once', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      {
        name: 'melarc_csrf',
        value: 'synthetic-csrf-token',
        url: baseURL ?? 'http://127.0.0.1:4173',
      },
    ]);
    const api = await stubApi(page, 'signed-in', { signOut: 'held-ok' });
    await page.goto('/');

    const menu = await openAccountMenu(page);
    await menu.getByRole('menuitem', { name: 'Sign out' }).click();

    // The sign-out stays under way until the test lets it finish, however long the steps below take.
    const busy = menu.getByRole('menuitem', { name: 'Signing out…' });
    await expect(busy).toBeVisible();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(menu).toBeVisible();
    // Another choice of the item while it is under way does nothing.
    await busy.press('Enter');
    api.releaseSignOut();

    await expect(page).toHaveURL('/sign-in');
    expect(api.requests.filter((request) => request.startsWith('DELETE'))).toEqual([
      `DELETE ${SESSION_PATH}`,
    ]);
  });

  test('reads as done when the session had already ended', async ({ page }) => {
    await stubApi(page, 'signed-in', { signOut: 'session-invalid' });
    await page.goto('/');
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();

    await signOutFromMenu(page);

    await expect(page).toHaveURL('/sign-in');
    await expect(page.getByText(/did not finish|SESSION_INVALID|Diagnostic/)).toHaveCount(0);
  });

  // Break caught: telling the person they are signed out while the session may be live; or the failure told inside a menu that stays open over it
  // instead of at the top of the page.
  for (const answer of ['fault', 'csrf-refused', 'no-connection'] as const) {
    test(`stays signed in and says so at the top of the page when sign-out meets ${answer}, and tries again`, async ({
      page,
    }) => {
      await stubApi(page, 'signed-in', {
        signOut: answer === 'fault' ? 'fault-then-ok' : answer,
      });
      await page.goto('/');
      await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();

      await signOutFromMenu(page);

      await expect(
        page
          .getByRole('alert')
          .filter({ hasText: 'Sign-out did not finish, so you are still signed in.' }),
      ).toBeVisible();
      // The menu that showed it under way is closed, so that the failure is not behind it.
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
      await expect(primaryNav(page)).toBeVisible();
      await expect(page.getByText(/Diagnostic text|SESSION_|CSRF_/)).toHaveCount(0);
      expect(await wcagViolations(page), 'with the failure showing').toEqual([]);
      if (answer === 'fault') {
        await page.getByRole('button', { name: 'Try again' }).click();
        await expect(page).toHaveURL('/sign-in');
      }
    });
  }

  for (const { width, height } of VERIFIED_VIEWPORTS) {
    for (const scheme of ['light', 'dark'] as const) {
      // Break caught: a sidebar or top bar that clips or makes the page scroll sideways at a verified width, or contrast and target sizes that
      // fail with the real layout in either theme, in each form the sidebar has there (the full sidebar and the rail from 768px, the sheet below it).
      test(`has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px in the ${scheme} theme, with the sidebar in each form it has there`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width, height });
        await stubApi(page);
        await page.goto('/');
        await expect(topBar(page)).toBeVisible();

        expect(await wcagViolations(page), 'as first drawn').toEqual([]);
        expect(await overflowOf(page), 'as first drawn').toBeLessThanOrEqual(0);

        if (width >= DOCKED_FROM) {
          // 1280px draws the full sidebar and 768px the rail: each is looked at, and then the other.
          const toggle = page.getByRole('button', { name: /^(Collapse|Expand) menu$/ });
          await toggle.click();
          await expect(
            page.getByRole('button', { name: /^(Collapse|Expand) menu$/ }),
          ).toBeVisible();
          await page.mouse.move(0, 0);
          expect(await wcagViolations(page), 'the other form').toEqual([]);
          expect(await overflowOf(page), 'the other form').toBeLessThanOrEqual(0);
        } else {
          await openSheet(page);
          await sheetSettled(page);
          expect(await wcagViolations(page), 'the sheet open').toEqual([]);
          expect(await overflowOf(page), 'the sheet open').toBeLessThanOrEqual(0);
        }

        const box = await accountButton(page)
          .or(page.locator('button[aria-label="Account menu"]'))
          .boundingBox();
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      });
    }
  }

  // Break caught: the sidebar lost under forced colours, where the Ink fill is dropped: its edge, and the current entry, must still be marked.
  test('keeps the edge of the sidebar and the current page marked under forced colours', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'Playwright cannot emulate forced colours in WebKit; the sidebar’s edge and its current entry are plain borders and system colours in every engine.',
    );
    await page.emulateMedia({ forcedColors: 'active' });
    await stubApi(page);
    await page.goto('/');
    await expect(primaryNav(page)).toBeVisible();

    const marks = await page.evaluate(() => {
      const panel = document.querySelector('.ui-sidebar');
      const current = document.querySelector('.ui-sidebar__link[aria-current="page"]');
      const other = document.querySelector('.ui-sidebar__link:not([aria-current])');
      return {
        edge: panel === null ? '' : getComputedStyle(panel).borderRightStyle,
        border: current === null ? '' : getComputedStyle(current).borderBottomStyle,
        // The current entry differs from the others by more than a hue: the system's highlight fills it.
        filled:
          current !== null &&
          other !== null &&
          getComputedStyle(current).backgroundColor !== getComputedStyle(other).backgroundColor,
      };
    });
    expect(marks).toEqual({ edge: 'solid', border: 'solid', filled: true });
    await expect(sidebarBox(page)).toBeVisible();
  });
});

/**
 * The widths the sticky top bar is looked at: a phone (the sheet), the first width with a docked sidebar (the 64px rail) and the full sidebar's. The
 * redesign review of 7 November 2026 found what the layers and the page's scrolling do there, which jsdom has no layout to show.
 */
const BAR_WIDTHS = [
  { width: 390, height: 800 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

/** Makes the page taller than the window: a spacer at the end of the main landmark, under what the page draws. */
async function makeScrollable(page: Page): Promise<void> {
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main === null) throw new Error('the page has no main landmark');
    const spacer = document.createElement('div');
    spacer.style.height = '4000px';
    main.append(spacer);
  });
}

/** Adds to the page a heading far down it, with room above and below, and returns nothing: it is `#far-down`. */
async function addHeadingFarDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main === null) throw new Error('the page has no main landmark');
    const above = document.createElement('div');
    above.style.height = '1600px';
    const heading = document.createElement('h2');
    heading.id = 'far-down';
    heading.tabIndex = -1;
    heading.textContent = 'A heading far down the page';
    const below = document.createElement('div');
    below.style.height = '2400px';
    main.append(above, heading, below);
  });
}

/** Adds to the page a long list of links at the end of its main landmark: sixty stops for Tab, one under the other, in the list `#long-list`. */
async function addLongList(page: Page): Promise<void> {
  await page.evaluate(() => {
    const main = document.querySelector('main');
    if (main === null) throw new Error('the page has no main landmark');
    const list = document.createElement('ul');
    list.id = 'long-list';
    for (let row = 1; row <= 60; row += 1) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#row-${String(row)}`;
      link.textContent = `Row ${String(row)} of the long list`;
      item.append(link);
      list.append(item);
    }
    main.append(list);
  });
}

/** How far the top of an element is from the top of the window. */
const topOf = (page: Page, selector: string): Promise<number> =>
  page.evaluate(
    (css) => document.querySelector(css)?.getBoundingClientRect().top ?? Number.NaN,
    selector,
  );

test.describe('the sticky top bar, the skip link and the page’s padding in a browser', () => {
  for (const { width, height } of BAR_WIDTHS) {
    // Break caught (review of 7 November 2026): the focused skip link painted under the sticky top bar, whose layer is above the link's: invisible on
    // a phone (the link lies wholly inside the bar) and half hidden over the rail at 768px, the one thing a keyboard user needs to see on the first
    // Tab (WCAG 2.4.7). `toBeInViewport` is the window's intersection and sees nothing of what is painted over the link: the element at the link's
    // own centre, and at the corners of its box, is what shows whether the link is the topmost thing there.
    test(`paints the focused skip link above the top bar: it is the element at its own centre and corners at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await stubApi(page);
      await page.goto('/');
      const tabs = await tabReachesLinks(page);
      await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
      const skipLink = page.getByRole('link', { name: 'Skip to main content' });
      if (tabs) await page.keyboard.press('Tab');
      else await skipLink.focus();
      await expect(skipLink).toBeFocused();
      await expect(skipLink).toBeInViewport();

      const covered = await skipLink.evaluate((link) => {
        const box = link.getBoundingClientRect();
        const places = [
          ['centre', 0.5, 0.5],
          ['top left', 0.04, 0.12],
          ['top right', 0.96, 0.12],
          ['bottom left', 0.04, 0.88],
          ['bottom right', 0.96, 0.88],
        ] as const;
        return places
          .map(([place, across, down]) => {
            const found = document.elementFromPoint(
              box.left + box.width * across,
              box.top + box.height * down,
            );
            const topmost = found !== null && (found === link || link.contains(found));
            return topmost ? '' : `${place}: ${found?.tagName.toLowerCase() ?? 'nothing'}`;
          })
          .filter((missed) => missed !== '');
      });
      expect(covered, 'where something else is painted over the link').toEqual([]);
    });

    // Break caught (review of 7 November 2026): a top bar that does not stay at the top of the window while the page scrolls (its `position: sticky`
    // lost, or a layout in which it has no room to stick, as a grid item in a row as tall as itself may have in an engine that keeps a sticky item
    // inside its grid area), so that what the specification draws (the bar and the sidebar always in reach) is gone. That the bar stays was
    // asserted in a comment and never tested. It is also what a pointer reaches at the top edge of a scrolled page.
    test(`keeps the top bar at the top of the window while the page scrolls, at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await stubApi(page);
      await page.goto('/');
      await expect(topBar(page)).toBeVisible();
      await makeScrollable(page);

      await page.evaluate(() => {
        window.scrollTo(0, 1500);
      });

      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(1500);
      expect(await topOf(page, 'header.ui-topbar')).toBe(0);
      const reached = await page.evaluate(
        () =>
          document
            .elementFromPoint(window.innerWidth / 2, 4)
            ?.closest('header.ui-topbar') instanceof HTMLElement,
      );
      expect(reached, 'the bar is what is at the top edge').toBe(true);
      if (width >= DOCKED_FROM) expect(await topOf(page, 'aside.ui-sidebar')).toBe(0);
    });

    // Break caught (review of 7 November 2026): a sticky region without scroll padding (DESIGN_SYSTEM section 14: "sticky regions set scroll padding"):
    // what the browser scrolls into view, a heading the frame focuses after a navigation or a control reached by Tab, lands under the opaque bar at the
    // top edge, and the focused element is not seen (WCAG 2.4.11). A heading is scrolled into view the two ways a browser does it, and is below the bar.
    test(`brings a heading into view below the top bar, not under it, at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await stubApi(page);
      await page.goto('/');
      await expect(topBar(page)).toBeVisible();
      const barHeight = (await topBar(page).boundingBox())?.height ?? 0;
      expect(barHeight).toBeGreaterThan(0);
      await addHeadingFarDown(page);

      await page.evaluate(() => {
        document.getElementById('far-down')?.scrollIntoView({ block: 'start' });
      });
      await expect.poll(() => topOf(page, '#far-down')).toBeGreaterThanOrEqual(barHeight);

      // The way a frame focuses the heading of a page it has navigated to: the heading is partly above the top edge, and focus brings it in.
      await page.evaluate(() => {
        const heading = document.getElementById('far-down');
        if (heading === null) throw new Error('no heading');
        window.scrollTo(0, heading.getBoundingClientRect().top + window.scrollY + 8);
        heading.focus();
      });
      await expect.poll(() => topOf(page, '#far-down')).toBeGreaterThanOrEqual(barHeight);
      await expect(page.locator('#far-down')).toBeFocused();
    });
  }

  for (const size of ['100%', '200%'] as const) {
    // Break caught (audit B2, 7 November 2026): a scroll padding written for the one row of the bar (56px and a little more), so that when the bar wraps
    // into a second row (text at 200% on a phone) a control reached by Shift+Tab, backwards up a long page, is scrolled in under the bar's second row
    // and the person cannot see where focus is (WCAG 2.4.11). The padding is the bar's measured height; and each control reached on the way up is below
    // the bottom edge of the bar, whatever height the bar has. At 100% the bar is one row and the walk is the control of the test.
    test(`keeps each control reached by Shift+Tab up a long list below the top bar, with text at ${size}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 700 });
      await stubApi(page);
      await page.goto('/');
      await expect(topBar(page)).toBeVisible();
      await page.evaluate((fontSize) => {
        document.documentElement.style.fontSize = fontSize;
      }, size);
      await addLongList(page);

      const clearance = await page.evaluate(() => ({
        padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop),
        bar: document.querySelector('.app-topbar')?.getBoundingClientRect().height ?? 0,
      }));
      expect(clearance.bar).toBeGreaterThan(0);
      expect(
        clearance.padding,
        'the scroll padding is at least the height the bar has',
      ).toBeGreaterThanOrEqual(clearance.bar);

      await page.locator('#long-list a').last().focus();
      let walked = 0;
      for (let step = 0; step < 70; step += 1) {
        await page.keyboard.press('Shift+Tab');
        const state = await page.evaluate(() => {
          const active = document.activeElement;
          return {
            inList: active?.closest('#long-list') != null,
            top: active?.getBoundingClientRect().top ?? Number.NaN,
            barBottom:
              document.querySelector('.app-topbar')?.getBoundingClientRect().bottom ?? Number.NaN,
            text: active?.textContent ?? '',
          };
        });
        if (!state.inList) break;
        walked += 1;
        expect(state.top, `"${state.text}" is below the bar`).toBeGreaterThanOrEqual(
          state.barBottom,
        );
      }
      // The walk went the whole way up the list, so that every row was a stop.
      expect(walked).toBe(59);
    });
  }

  // Break caught (review of 7 November 2026): the page padded 16px beside a top bar padded 24px at exactly 768px (the stylesheet of the frame said
  // "up to 48rem" where the bar and the viewport hook say "under 48rem"), so that the page and the bar are 8px out of line at the first width with a docked
  // sidebar. At a width the sidebar is docked, both are 24px from the sidebar and from the edge; one pixel less, both are 16px.
  for (const { width, side, name } of [
    { width: 1280, side: 1.5, name: 'wide' },
    { width: 768, side: 1.5, name: 'the first width with a docked sidebar' },
    { width: 767, side: 1, name: 'the last width of the sheet' },
  ] as const) {
    test(`pads the page and the top bar alike at ${String(width)} px: ${name}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page);
      await page.goto('/');
      await expect(topBar(page)).toBeVisible();
      const rem = await remOf(page);

      const sides = await page.evaluate(() => {
        const padding = (selector: string) => {
          const style = getComputedStyle(document.querySelector(selector) ?? document.body);
          return { left: style.paddingLeft, right: style.paddingRight };
        };
        return { bar: padding('header.ui-topbar'), page: padding('main') };
      });

      const expected = `${String(side * rem)}px`;
      expect(sides).toEqual({
        bar: { left: expected, right: expected },
        page: { left: expected, right: expected },
      });
    });
  }

  // Break caught (review of 7 November 2026): the strict policy proved for the shell at a desktop's width only, with the sheet of a narrow screen (a
  // Radix dialog that inserts a style and traps focus) never drawn under it: the sheet opened, followed and closed under the policy raises no violation.
  test('runs the sheet of a narrow screen under the strict policy: opened, followed and closed', async ({
    page,
  }) => {
    const violations = await enforceStrictPolicy(page);
    await page.setViewportSize({ width: 390, height: 800 });
    const api = await stubApi(page);
    const seen = watchPage(page);

    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toBe(STRICT_POLICY);
    await expect(page.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    const sheet = await openSheet(page);
    await sheetSettled(page);
    await expect(sheet.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await sheet.getByRole('link', { name: 'Sessions' }).click();

    await expect(page).toHaveURL('/admin/sessions');
    await expect(sheetOf(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeFocused();
    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
    expect(api.unexpected).toEqual([]);
  });
});
