import { expect, test, type Page } from '@playwright/test';

import { stubApi } from './support/api';
import { settled, watchPage, wcagViolations } from './support/page';
import { answerSessionWith, topBar } from './support/shell';

/**
 * The application's one toaster, in the signed-in frame (the Product Owner's answer of 7 November 2026, afternoon; COMPONENT_PATTERNS section 21), in a real
 * browser. No screen raises a toast yet, so these tests raise one themselves, **through the module that the application itself runs**: the development server
 * serves the source of `components/ui/toast/Toast.tsx` at its own address, and an ordinary module script of the test imports it from there, so that the toast is raised
 * on the same store as the frame's toaster and no hook is put into the application for it. (The production build has no such address and gains no hook: `test/build.test.ts`
 * holds that, and `shell.spec.ts` shows the one toaster in the production build under the strict policy.)
 *
 * Everything on the page is synthetic: the session is the stand-in of `support/api.ts` and the toasts say made-up things.
 */
const TOAST_MODULE = '/src/components/ui/toast/Toast.tsx';

const TOASTER = 'section[aria-label^="Notifications"]';

interface OpenOptions {
  readonly scheme?: 'light' | 'dark';
  readonly reducedMotion?: boolean;
  readonly width?: number;
}

/** The signed-in frame, My work in it, with the stand-in for the API. */
async function openFrame(page: Page, options: OpenOptions = {}) {
  const seen = watchPage(page);
  if (options.width !== undefined)
    await page.setViewportSize({ width: options.width, height: 900 });
  if (options.scheme !== undefined) await page.emulateMedia({ colorScheme: options.scheme });
  if (options.reducedMotion !== undefined) {
    await page.emulateMedia({ reducedMotion: options.reducedMotion ? 'reduce' : 'no-preference' });
  }
  await stubApi(page);
  await answerSessionWith(page, { permissions: ['staff.read'] });
  await page.goto('/');
  await expect(topBar(page)).toBeVisible();
  return seen;
}

/** Raises a toast the way a screen would (`showToast`), from a module script that imports the application's own copy of the module. `options` is the object, as source. */
async function raise(page: Page, options: string): Promise<void> {
  await page.addScriptTag({
    type: 'module',
    content: `import { showToast } from '${TOAST_MODULE}'; showToast(${options});`,
  });
}

const TWO_ACTIONS = `{
  tone: 'success',
  message: 'Request ACC-PR-4HT9WD booked.',
  action: { label: 'Open', onClick: () => undefined },
  secondaryAction: { label: 'Book another', onClick: () => undefined },
}`;

test.describe('the application’s one toaster, in the signed-in frame, in a browser', () => {
  // Break caught: a frame with no toaster (a toast that a screen raises is never seen), with two (every toast shown twice), or one that is not at the bottom right.
  test('draws one toaster, and a toast raised in the frame is shown once, at the bottom right', async ({
    page,
  }) => {
    const seen = await openFrame(page, { width: 1440 });
    await expect(page.locator(TOASTER)).toHaveCount(1);

    await raise(page, `{ tone: 'success', message: 'Request ACC-PR-7KQ2MZ confirmed.' }`);
    const toast = page.locator('.ui-toast', { hasText: 'Request ACC-PR-7KQ2MZ confirmed.' });
    await expect(toast).toHaveCount(1);
    await expect(toast).toBeVisible();
    await settled(page);

    const at = await toast.boundingBox();
    const viewport = page.viewportSize();
    expect(at).not.toBeNull();
    expect((at?.x ?? 0) + (at?.width ?? 0)).toBeGreaterThan((viewport?.width ?? 0) - 60);
    expect((at?.y ?? 0) + (at?.height ?? 0)).toBeGreaterThan((viewport?.height ?? 0) - 60);
    expect(at?.x ?? 0).toBeGreaterThan((viewport?.width ?? 0) / 2);
    await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute(
      'data-y-position',
      'bottom',
    );
    await expect(page.locator('[data-sonner-toaster]')).toHaveAttribute('data-x-position', 'right');
    await expect(page.locator(TOASTER)).toHaveCount(1);
    // The toast raised in the frame is raised on the page's one store: nothing else drew it, and nothing failed.
    await expect(page.getByText('Request ACC-PR-7KQ2MZ confirmed.')).toHaveCount(1);
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a toaster that moves for someone who asked the system for less motion, or one that does not move for anyone else (a check that cannot fail). Sonner's
  // stylesheet takes the transitions and the animations of a toast away under reduced motion; the computed durations of the toast are read in each case.
  for (const reduced of [false, true]) {
    test(`moves a toast in only when motion is welcome${reduced ? ' (it does not under reduced motion)' : ''}`, async ({
      page,
    }) => {
      await openFrame(page, { reducedMotion: reduced });

      await raise(page, `{ tone: 'success', message: 'Request ACC-PR-2MX8RC confirmed.' }`);
      const toast = page.locator('[data-sonner-toast]', {
        hasText: 'Request ACC-PR-2MX8RC confirmed.',
      });
      await expect(toast).toBeVisible();

      const motion = await toast.evaluate((element) => {
        const style = getComputedStyle(element);
        const seconds = (list: string): number[] =>
          list.split(',').map((part) => parseFloat(part.trim()));
        return {
          transitions: seconds(style.transitionDuration),
          animation: style.animationName,
        };
      });
      if (reduced) {
        expect(motion.transitions.every((duration) => duration === 0)).toBe(true);
        expect(motion.animation).toBe('none');
      } else {
        expect(motion.transitions.some((duration) => duration > 0)).toBe(true);
      }
    });
  }

  // Break caught: a toast with two actions that fails a rule of WCAG 2.2 in the frame that carries it (its contrast on the raised surface, a name, a landmark), in either
  // theme.
  for (const scheme of ['light', 'dark'] as const) {
    test(`has no violation with a toast of two actions showing in the frame, in the ${scheme} theme`, async ({
      page,
    }) => {
      await openFrame(page, { scheme });
      await raise(page, TWO_ACTIONS);
      await expect(
        page.locator('.ui-toast', { hasText: 'Request ACC-PR-4HT9WD booked.' }),
      ).toBeVisible();

      expect(await wcagViolations(page)).toEqual([]);
    });
  }
});
