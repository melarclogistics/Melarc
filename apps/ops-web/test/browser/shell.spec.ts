import { expect, test, type Locator, type Page } from '@playwright/test';

import { SESSION_PATH, stubApi } from './support/api';
import { reachableNames, tabReachesLinks, watchPage, wcagViolations } from './support/page';
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

/** From this width the menu is docked at the side; below it a bar with a menu button stands in its place (side-menu.css: 48rem). */
const DOCKED_FROM = 768;

test.describe('the application shell in a browser', () => {
  // Break caught: a production build that does not start, logs errors, or reaches for anything other than its own
  // files. The one thing it asks of the API is who is signed in, once, on this origin.
  test('renders the landing for a signed-in person, with no errors, asking the API only who is signed in', async ({
    page,
    baseURL,
  }) => {
    const api = await stubApi(page);
    const seen = watchPage(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
    // The stand-in's server gave this session no queue, so the landing says nothing of waiting: not that nothing is, and no heading over nothing.
    await expect(page.getByText('Nothing is waiting.')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2, name: 'Waiting for you' })).toHaveCount(0);
    // The landing is a signed-in screen, so the shell's side menu is beside it: one navigation, and the control to leave. There is no
    // banner above the page: on a wide screen the menu carries the product's name, and its slim bar is for a narrow screen alone.
    await expect(page.getByRole('banner')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Main menu' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page).toHaveTitle('Melarc Ops Portal');
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
  test('a visit with nobody signed in goes to sign-in and never shows the landing', async ({
    page,
  }) => {
    const api = await stubApi(page, 'signed-out');
    const landingShown: boolean[] = [];
    await page.exposeFunction('noteLanding', () => landingShown.push(true));
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (document.querySelector('main h1')?.textContent === 'Melarc Ops Portal') {
          void (window as unknown as { noteLanding: () => Promise<void> }).noteLanding();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    await page.goto('/');

    await expect(page).toHaveURL('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
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

    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
  });

  // Break caught: the shell keeping anything in the browser before any workflow exists.
  test('stores nothing in the browser', async ({ page }) => {
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

  // Break caught: a keyboard user who cannot see where focus is, cannot skip the header, or is left
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
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeFocused();
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
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();

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
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();

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
    // The full logo is the neutral frame's banner, which an address that matches no route has (a signed-in screen has the menu's mark instead).
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

  // Break caught: the mark of the side menu blocked by the policy (inlined, or from another origin) or not shipped, so that the menu names the
  // product beside an empty square; or the name of the product missing from the menu, whose mark is decorative and says nothing.
  test('shows the mark and the name of the product in the side menu under the strict policy', async ({
    page,
    baseURL,
  }) => {
    const violations = await enforceStrictPolicy(page);
    await stubApi(page);
    const seen = watchPage(page);
    await page.goto('/');
    const menu = page.getByRole('complementary', { name: 'Main menu' });
    await expect(menu).toBeVisible();

    await expect(menu.getByText('Melarc Logistics')).toBeVisible();
    await expect(menu.getByText('Ops Portal')).toBeVisible();
    const mark = menu.locator('.ui-brand-lockup__mark img');
    await expect(mark).toBeVisible();
    const loaded = await mark.evaluate((image: HTMLImageElement) => ({
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      src: image.currentSrc,
      alt: image.alt,
    }));
    expect(loaded.complete).toBe(true);
    expect(loaded.naturalWidth).toBeGreaterThan(0);
    expect(new URL(loaded.src).origin).toBe(baseURL);
    expect(new URL(loaded.src).pathname).toBe('/favicon.svg');
    expect(loaded.alt).toBe('');

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

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${path} overflows sideways`).toBeLessThanOrEqual(0);
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
  const menuOf = (page: Page) => page.getByRole('complementary', { name: 'Main menu' });
  const navOf = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
  const panelOf = (page: Page) => page.locator('.ui-side-menu__panel');
  const widthOf = async (page: Page): Promise<number> =>
    (await panelOf(page).boundingBox())?.width ?? 0;

  /** The panel has stopped sliding and is at the left edge: what a screenshot, an axe run and a click should wait for. */
  async function settled(page: Page): Promise<void> {
    await expect.poll(async () => (await panelOf(page).boundingBox())?.x ?? -1).toBe(0);
  }

  // Break caught: the menu inside the main content, where the skip link would land on it, or after it, where a keyboard user finds it last; a
  // top band left above it; a menu that is not at the edge, the height of the window, with the page beginning where it ends.
  test('draws the side menu beside the main content: before it, outside it, at the left edge and as tall as the window', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(navOf(page)).toBeVisible();

    const layout = await page.evaluate(() => {
      const everything = [...document.body.querySelectorAll('*')];
      const index = (selector: string): number => {
        const found = document.querySelector(selector);
        return found === null ? -1 : everything.indexOf(found);
      };
      const menu = document.querySelector('aside[aria-label="Main menu"]')?.getBoundingClientRect();
      const main = document.querySelector('main')?.getBoundingClientRect();
      return {
        menu: index('aside[aria-label="Main menu"]'),
        nav: index('aside nav[aria-label="Primary"]'),
        signOut: document.querySelector('aside button[aria-label="Sign out"]') !== null,
        main: index('main'),
        navInMain: document.querySelector('main nav') !== null,
        menuInMain: document.querySelector('main aside') !== null,
        band: document.querySelector('.app-header') !== null,
        menuBox:
          menu === undefined
            ? null
            : { x: menu.x, y: menu.y, height: menu.height, width: menu.width },
        mainLeft: main?.left ?? -1,
        windowHeight: window.innerHeight,
      };
    });
    expect(layout.menu).toBeGreaterThanOrEqual(0);
    expect(layout.nav).toBeGreaterThan(layout.menu);
    expect(layout.main).toBeGreaterThan(layout.nav);
    expect(layout.signOut).toBe(true);
    expect(layout.navInMain).toBe(false);
    expect(layout.menuInMain).toBe(false);
    expect(layout.band).toBe(false);
    expect(layout.menuBox?.x).toBe(0);
    expect(layout.menuBox?.y).toBe(0);
    expect(layout.menuBox?.height).toBeCloseTo(layout.windowHeight, 0);
    expect(layout.mainLeft).toBeGreaterThanOrEqual(layout.menuBox?.width ?? Number.MAX_VALUE);
    await expect(navOf(page).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // Break caught: an entry with no picture (the same family of icons everywhere is the rule), or a picture that reaches a screen reader as a
  // second name for the entry.
  test('gives every entry an icon of the family, which is decoration beside the entry’s name', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(navOf(page)).toBeVisible();

    const links = await navOf(page)
      .getByRole('link')
      .evaluateAll((all) =>
        all.map((link) => ({
          name: link.textContent.trim(),
          pictures: link.querySelectorAll('svg').length,
          hidden: link.querySelector('svg')?.getAttribute('aria-hidden'),
        })),
      );
    expect(links.map((link) => link.name)).toEqual([
      'Overview',
      'Staff',
      'Sessions',
      'Trusted browsers',
    ]);
    for (const link of links)
      expect(link, link.name).toMatchObject({ pictures: 1, hidden: 'true' });
  });

  // Break caught: the account card missing, or saying who is signed in with a picture alone, or naming a person other than the session's.
  test('says who is signed in and where they act, in a card with the control to leave', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');

    const account = page.getByRole('group', { name: 'Your account' });
    await expect(account.getByText('Synthetic Officer')).toBeVisible();
    await expect(account.getByText('Synthetic Hub')).toBeVisible();
    await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
    // The initials are decoration: the name beside them is the content.
    await expect(account.locator('.ui-side-menu__avatar')).toHaveText('SO');
    await expect(account.locator('.ui-side-menu__avatar')).toHaveAttribute('aria-hidden', 'true');
  });

  // Break caught: the neutral frame gaining the menu: an address that matches no route cannot know whether a session exists.
  test('is not around an unknown address', async ({ page }) => {
    await stubApi(page);
    await page.goto('/no-such-page');

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  });

  // Break caught: the focus indicator of the Ink menu being the default blue ring, which is only 2.64:1 on Ink, or being lost; a menu button
  // missing from the walk, or one that is out of sight (the narrow screen's) taking a stop on a wide screen.
  test('walks by Tab through the skip link, the collapse button, the entries and sign-out, each with the inverse focus ring', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(navOf(page)).toBeVisible();
    const tabs = await tabReachesLinks(page);
    await expect(navOf(page)).toBeVisible();

    const stops: { name: string; outline: string; width: number; ring: string }[] = [];
    // The stubbed session holds `staff.read`, so the menu also has the staff list and the sessions page (S0.44), and every session is
    // offered the person's own trusted browsers (S0.46).
    const expected = tabs
      ? [
          'Skip to main content',
          'Collapse menu',
          'Overview',
          'Staff',
          'Sessions',
          'Trusted browsers',
          'Sign out',
        ]
      : ['Collapse menu', 'Sign out'];
    for (const name of expected) {
      await page.keyboard.press('Tab');
      stops.push(
        await page.evaluate(() => {
          const element = document.activeElement;
          if (element === null) return { name: '', outline: '', width: 0, ring: '' };
          const style = getComputedStyle(element);
          const probe = document.createElement('span');
          probe.style.color = 'var(--focus-ring-inverse)';
          document.body.append(probe);
          const ring = getComputedStyle(probe).color;
          probe.remove();
          return {
            name: (element.getAttribute('aria-label') ?? element.textContent).trim(),
            outline: style.outlineColor,
            width: parseFloat(style.outlineWidth),
            ring,
          };
        }),
      );
      expect(stops.at(-1)?.name, `the stop after ${String(stops.length)} Tab presses`).toBe(name);
    }

    expect(stops.map((stop) => stop.name)).toEqual(expected);
    for (const stop of stops.filter((candidate) => candidate.name !== 'Skip to main content')) {
      expect(stop.width, stop.name).toBe(2);
      expect(stop.outline, stop.name).toBe(stop.ring);
    }
  });

  // Break caught: a menu that cannot be collapsed, or that loses the names of its entries when it is (a screen reader then hears "link" and a
  // picture), or that leaves the room it gave up empty, or whose choice is written to the browser.
  test('collapses to a rail of icons and expands again, each entry keeping its name', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await stubApi(page);
    await page.goto('/');
    const rem = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
    const toggle = page.getByRole('button', { name: 'Collapse menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await widthOf(page)).toBe(16 * rem);
    const mainBefore = (await page.getByRole('main').boundingBox())?.x ?? 0;

    await toggle.click();

    const expand = page.getByRole('button', { name: 'Expand menu' });
    await expect(expand).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => widthOf(page)).toBe(4.5 * rem);
    // The page takes the room the menu gave up.
    expect((await page.getByRole('main').boundingBox())?.x ?? Number.MAX_VALUE).toBeLessThan(
      mainBefore,
    );
    for (const name of ['Overview', 'Staff', 'Sessions']) {
      const link = navOf(page).getByRole('link', { name });
      await expect(link).toHaveAttribute('title', name);
      // The label is drawn out of sight, not taken out of the document, and the picture stays.
      expect(
        (await link.locator('.ui-primary-nav__label').boundingBox())?.width ?? 99,
      ).toBeLessThanOrEqual(1);
      expect((await link.locator('svg').boundingBox())?.width ?? 0).toBeGreaterThan(0);
    }
    const account = page.getByRole('group', { name: 'Your account' });
    await expect(account.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(
      (await account.getByText('Synthetic Officer').boundingBox())?.width ?? 99,
    ).toBeLessThanOrEqual(1);
    expect(
      await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
    ).toEqual({ local: 0, session: 0 });

    // By keyboard, with focus staying on the button, whose name now says what it will do.
    await expand.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeFocused();
    await expect.poll(() => widthOf(page)).toBe(16 * rem);

    // What was chosen lasts as long as the page and no longer: nothing was written, so a reload starts expanded.
    await page.getByRole('button', { name: 'Collapse menu' }).click();
    await expect.poll(() => widthOf(page)).toBe(4.5 * rem);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
    expect(await widthOf(page)).toBe(16 * rem);
  });

  // Break caught: the narrow screen's controls (the bar and its button) drawn on a wide screen, or the wide screen's collapse button on a narrow
  // one, where the menu does not dock and there is nothing to collapse.
  test('shows the collapse button on a wide screen and the menu button on a narrow one, never both', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Close menu' })).toBeHidden();

    await page.setViewportSize({ width: 600, height: 800 });

    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeHidden();
    await expect(menuOf(page)).toBeHidden();
  });

  test.describe('on a narrow screen', () => {
    test.use({ viewport: { width: 320, height: 640 } });

    // Break caught: a menu that is only out of sight, so that a keyboard user tabs into entries they cannot see, or a screen whose only way
    // to leave or navigate is inside a closed menu with no button to open it.
    test('keeps the menu behind a button, out of the tab order while it is closed, under a bar that names the product', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const open = page.getByRole('button', { name: 'Open menu' });

      await expect(open).toBeVisible();
      await expect(open).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('banner').getByText('Melarc Logistics')).toBeVisible();
      await expect(menuOf(page)).toBeHidden();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeHidden();
      const names = await reachableNames(page, true);
      expect(names).toContain('Open menu');
      for (const name of ['Overview', 'Sign out', 'Close menu', 'Collapse menu']) {
        expect(names, name).not.toContain(name);
      }
      // The landing's own list of places has a link to the staff and to the sessions: the menu's entries of the same names are not stops.
      expect(names.filter((name) => name === 'Staff')).toHaveLength(1);
      expect(names.filter((name) => name === 'Sessions')).toHaveLength(1);
    });

    // Break caught: a menu that opens without taking focus in, or leaves the page behind it operable, or cannot be closed from the keyboard, or
    // closes and leaves focus nowhere.
    test('slides in over the page, takes focus, makes the page behind it inert, and Escape closes it and gives focus back', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const open = page.getByRole('button', { name: 'Open menu' });

      await open.click();

      await expect(menuOf(page)).toBeVisible();
      await expect(open).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('button', { name: 'Close menu' })).toBeFocused();
      await expect(page.locator('main')).toHaveAttribute('inert', '');
      await settled(page);
      const box = await panelOf(page).boundingBox();
      expect(box?.height).toBe(640);
      expect(box?.width ?? 999).toBeLessThanOrEqual(0.85 * 320);
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
      await expect(navOf(page).getByRole('link', { name: 'Overview' })).toBeVisible();

      await page.keyboard.press('Escape');

      await expect(menuOf(page)).toBeHidden();
      await expect(open).toBeFocused();
      await expect(open).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('main')).not.toHaveAttribute('inert');
    });

    // Break caught: a scrim that does not close the menu, or a close button that does and leaves focus behind.
    test('closes by the scrim and by its close button, each giving focus back to the menu button', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const open = page.getByRole('button', { name: 'Open menu' });

      await open.click();
      await settled(page);
      await page.locator('.ui-side-menu__scrim').click({ position: { x: 300, y: 320 } });
      await expect(menuOf(page)).toBeHidden();
      await expect(open).toBeFocused();

      await open.click();
      await settled(page);
      await page.getByRole('button', { name: 'Close menu' }).click();
      await expect(menuOf(page)).toBeHidden();
      await expect(open).toBeFocused();
      await expect(page.locator('main')).not.toHaveAttribute('inert');
    });

    // Break caught: the slide or its visibility change running for a person who asked for no motion. The rule that says so must win over the
    // rule of the open state, which names more.
    test('does not animate the slide when the person asked for less motion, and does when they did not', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      const open = page.getByRole('button', { name: 'Open menu' });
      const durations = (): Promise<string> =>
        panelOf(page).evaluate((panel) => getComputedStyle(panel).transitionDuration);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      expect(await durations(), 'closed, reduced motion').toBe('0s');
      await open.click();
      await expect(menuOf(page)).toBeVisible();
      expect(await durations(), 'open, reduced motion').toBe('0s');
      await page.keyboard.press('Escape');

      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await open.click();
      await expect(menuOf(page)).toBeVisible();
      expect(await durations(), 'open, motion allowed').not.toBe('0s');
    });

    // Break caught: the bar or the open menu overflowing the screen when text is enlarged; the name of the product crushed into a column of single
    // letters beside the mark, which made the head taller than the window and squeezed the entries until the account card spilled out of the
    // panel; an entry or the sign-out control that no keyboard can bring into view (WCAG 1.4.4, 1.4.10, 2.4.11).
    test('keeps the bar and the open menu whole when text is enlarged to 200%', async ({
      page,
    }) => {
      await stubApi(page);
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();

      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });

      const overflow = (): Promise<number> =>
        page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const within = async (name: string, control: Locator): Promise<void> => {
        const box = await control.boundingBox();
        expect(box?.x ?? -1, `${name}: left edge`).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), `${name}: right edge`).toBeLessThanOrEqual(320);
        expect(box?.y ?? -1, `${name}: top edge`).toBeGreaterThanOrEqual(0);
        expect((box?.y ?? 0) + (box?.height ?? 0), `${name}: bottom edge`).toBeLessThanOrEqual(640);
      };
      expect(await overflow(), 'the bar').toBeLessThanOrEqual(0);
      await within('Open menu', page.getByRole('button', { name: 'Open menu' }));

      await page.getByRole('button', { name: 'Open menu' }).click();
      await settled(page);

      expect(await overflow(), 'the open menu').toBeLessThanOrEqual(0);
      await within('Close menu', page.getByRole('button', { name: 'Close menu' }));

      // The name of the product reads in lines, not letters: no line of it is narrower than its longest word.
      const name = await panelOf(page)
        .locator('.ui-brand-lockup__name')
        .evaluate((element) => {
          const line = parseFloat(getComputedStyle(element).lineHeight);
          return {
            lines: Math.round(element.getBoundingClientRect().height / line),
            width: element.getBoundingClientRect().width,
          };
        });
      expect(name.lines, 'lines the name takes').toBeLessThanOrEqual(2);
      expect(name.width, 'width the name has').toBeGreaterThan(100);

      // Nothing is squeezed or overlaps: every entry lies inside the list, and the account card begins where the list ends.
      const [list, card] = await Promise.all([
        navOf(page).boundingBox(),
        page.getByRole('group', { name: 'Your account' }).boundingBox(),
      ]);
      for (const entry of ['Overview', 'Staff', 'Sessions']) {
        const box = await navOf(page).getByRole('link', { name: entry }).boundingBox();
        expect((box?.y ?? 0) + (box?.height ?? 0), `${entry}: inside the list`).toBeLessThanOrEqual(
          (list?.y ?? 0) + (list?.height ?? 0) + 1,
        );
      }
      expect(card?.y ?? 0, 'the account card starts below the list').toBeGreaterThanOrEqual(
        (list?.y ?? 0) + (list?.height ?? 0) - 1,
      );

      // The panel scrolls as a whole when it is taller than the window, so focus brings each control into view. Firefox scrolls to a
      // focused control only when none of it can be seen, so what holds in every engine is that some of it is in view, and that the control
      // is wholly inside across.
      for (const [label, control] of [
        ['Overview', navOf(page).getByRole('link', { name: 'Overview' })],
        ['Sessions', navOf(page).getByRole('link', { name: 'Sessions' })],
        ['Sign out', page.getByRole('button', { name: 'Sign out' })],
      ] as const) {
        await control.focus();
        await expect(control, `${label}, once focused`).toBeInViewport();
        const box = await control.boundingBox();
        expect(box?.x ?? -1, `${label}: left edge`).toBeGreaterThanOrEqual(0);
        expect((box?.x ?? 0) + (box?.width ?? 0), `${label}: right edge`).toBeLessThanOrEqual(320);
      }
    });
  });

  test('signs out: ends the session on the server with the CSRF token, and leaves the signed-in pages', async ({
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

    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL('/sign-in');
    await expect(page.getByText('Synthetic Officer')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    expect(api.requests).toEqual([`GET ${SESSION_PATH}`, `DELETE ${SESSION_PATH}`]);
    expect(api.signOutTokens).toEqual(['synthetic-csrf-token']);
    expect(api.unexpected).toEqual([]);
    // Back does not return to a page that cannot be shown.
    await page.goBack();
    await expect(page.getByText('Synthetic Officer')).toHaveCount(0);
  });

  test('reads as done when the session had already ended', async ({ page }) => {
    await stubApi(page, 'signed-in', { signOut: 'session-invalid' });
    await page.goto('/');
    await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL('/sign-in');
    await expect(page.getByText(/did not finish|SESSION_INVALID|Diagnostic/)).toHaveCount(0);
  });

  // Break caught: telling the person they are signed out while the session may be live.
  for (const answer of ['fault', 'csrf-refused', 'no-connection'] as const) {
    test(`stays signed in and says so when sign-out meets ${answer}, and tries again`, async ({
      page,
    }) => {
      await stubApi(page, 'signed-in', {
        signOut: answer === 'fault' ? 'fault-then-ok' : answer,
      });
      await page.goto('/');
      await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();

      await page.getByRole('button', { name: 'Sign out' }).click();

      await expect(
        page
          .getByRole('alert')
          .filter({ hasText: 'Sign-out did not finish, so you are still signed in.' }),
      ).toBeVisible();
      await expect(page.getByRole('main').getByText('Synthetic Officer')).toBeVisible();
      await expect(navOf(page)).toBeVisible();
      await expect(page.getByText(/Diagnostic text|SESSION_|CSRF_/)).toHaveCount(0);
      expect(await wcagViolations(page), 'with the failure showing').toEqual([]);
      if (answer === 'fault') {
        await page.getByRole('button', { name: 'Try again' }).click();
        await expect(page).toHaveURL('/sign-in');
      }
    });
  }

  for (const { width, height } of VERIFIED_VIEWPORTS) {
    // Break caught: a menu that clips or makes the page scroll sideways at a verified width, or contrast and target sizes that fail with the real
    // layout, in each state the menu has there (docked and collapsed on a wide screen, closed and open on a narrow one).
    test(`has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px, with the menu`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await stubApi(page);
      await page.goto('/');
      await expect(navOf(page).or(page.getByRole('button', { name: 'Open menu' }))).toBeVisible();
      const overflow = (): Promise<number> =>
        page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

      expect(await wcagViolations(page), 'as first drawn').toEqual([]);
      expect(await overflow(), 'as first drawn').toBeLessThanOrEqual(0);

      if (width >= DOCKED_FROM) {
        await page.getByRole('button', { name: 'Collapse menu' }).click();
        await expect(page.getByRole('button', { name: 'Expand menu' })).toBeVisible();
        await expect.poll(() => widthOf(page)).toBeLessThan(100);
        expect(await wcagViolations(page), 'collapsed').toEqual([]);
        expect(await overflow(), 'collapsed').toBeLessThanOrEqual(0);
      } else {
        await page.getByRole('button', { name: 'Open menu' }).click();
        await expect(menuOf(page)).toBeVisible();
        await settled(page);
        expect(await wcagViolations(page), 'open').toEqual([]);
        expect(await overflow(), 'open').toBeLessThanOrEqual(0);
      }

      const box = await page.getByRole('button', { name: 'Sign out' }).boundingBox();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    });
  }

  // Break caught: the menu lost under forced colours, where the Ink fill is dropped: its edge, and the current entry, must still be marked.
  test('keeps the edge of the menu and the current page marked under forced colours', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName === 'webkit',
      'Playwright cannot emulate forced colours in WebKit; the menu’s edge and its current entry are plain borders and system colours in every engine.',
    );
    await page.emulateMedia({ forcedColors: 'active' });
    await stubApi(page);
    await page.goto('/');
    await expect(navOf(page)).toBeVisible();

    const marks = await page.evaluate(() => {
      const panel = document.querySelector('.ui-side-menu__panel');
      const current = document.querySelector('.ui-primary-nav a[aria-current="page"]');
      const other = document.querySelector('.ui-primary-nav a:not([aria-current])');
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
  });
});
