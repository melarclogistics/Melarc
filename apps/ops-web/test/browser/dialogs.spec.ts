import { expect, test, type Page, type Route } from '@playwright/test';

import { watchPage, wcagViolations } from './support/page';

/**
 * The dialogs of the development-only showcase, in a real browser, in each engine. A modal dialog is the one component whose defining
 * behaviour a jsdom test cannot show: that the page behind it is inert, that Tab stays inside it, that the backdrop is drawn and that focus
 * goes back to what opened it. These tests prove those, and the workflow that uses it: the reason, the key and the version that a retry
 * carries.
 *
 * The confirmation demos call the real API client against `/api/v1`; this file answers those calls itself, as secrets.spec.ts does, and keeps
 * the requests it saw so a test can compare the first attempt with its retry.
 */
const SHOWCASE = '/__showcase';
const REASONS_PATH = '/api/v1/reason-definitions';
const SKIP_PATH = /\/api\/v1\/pickup-stops\/[0-9a-f-]{36}\/skip$/;
const RESET_PATH = /\/api\/v1\/ops\/staff\/[0-9a-f-]{36}\/mfa\/reset$/;

const VERIFIED_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

async function openShowcase(page: Page): Promise<void> {
  await page.goto(SHOWCASE);
  await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
}

/** Opens a dialog the way a keyboard user does: focus the button, press Enter. */
async function openWithKeyboard(page: Page, name: string) {
  const opener = page.getByRole('button', { name });
  await opener.focus();
  await page.keyboard.press('Enter');
  return opener;
}

/** What has focus, as a person would say it: in the dialog, `outside` it, or `document` for the body (where a browser's own interface lies). */
const focusPlace = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) return 'document';
    return active.closest('dialog') === null ? 'outside' : 'dialog';
  });

const REASONS = [
  {
    code: 'DEMO_REASON_ONE',
    domain: 'IDENTITY',
    label: 'Demo reason one',
    attribution: 'MELARC',
    active: true,
    consumesDeliveryAttempt: false,
    requiresNote: false,
    permittedOperations: [{ operationId: 'revokeSession', branch: null }],
  },
  {
    code: 'DEMO_REASON_NOTE',
    domain: 'IDENTITY',
    label: 'Demo reason that needs a note',
    attribution: 'MELARC',
    active: true,
    consumesDeliveryAttempt: false,
    requiresNote: true,
    permittedOperations: [{ operationId: 'revokeSession', branch: null }],
  },
];

/** Answers the reason catalogue with made-up reasons and records what was asked. */
async function answerReasons(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route(`**${REASONS_PATH}**`, async (route) => {
    asked.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      json: REASONS,
    });
  });
  return asked;
}

test.describe('a modal dialog in a browser', () => {
  // Break caught: a dialog drawn in the page and never opened as a modal: the page behind it stays reachable.
  test('makes the page behind it inert: focus cannot reach it by Tab or by script, and a click lands on the dialog', async ({
    page,
  }) => {
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo dialog');
    const dialog = page.getByRole('dialog', { name: 'Demo dialog' });
    await expect(dialog).toBeVisible();
    expect(await focusPlace(page)).toBe('dialog');

    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Tab');
      expect(await focusPlace(page), `Tab ${String(press + 1)}`).not.toBe('outside');
    }
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press('Shift+Tab');
      expect(await focusPlace(page), `Shift+Tab ${String(press + 1)}`).not.toBe('outside');
    }

    // A script cannot focus what is behind a modal dialog, and a click where it is lands on the backdrop and does nothing.
    const behind = await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (candidate) => candidate.textContent === 'Primary action',
      );
      if (button === undefined) return null;
      button.scrollIntoView({ block: 'center' });
      button.focus();
      const rect = button.getBoundingClientRect();
      return {
        focused: document.activeElement === button,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    });
    expect(behind?.focused).toBe(false);
    await page.mouse.click(behind?.x ?? 0, behind?.y ?? 0);
    await page.keyboard.press('Escape');
    await expect(page.getByText(/Primary action pressed 0 times/)).toBeVisible();
  });

  test('puts focus inside it when it opens, and gives it back to the button when Escape closes it', async ({
    page,
  }) => {
    await openShowcase(page);
    const opener = await openWithKeyboard(page, 'Open the demo dialog');
    await expect(page.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
    expect(await focusPlace(page)).toBe('dialog');

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test('closes from its own button, and gives focus back', async ({ page }) => {
    await openShowcase(page);
    const opener = await openWithKeyboard(page, 'Open the demo dialog');

    await page.getByRole('button', { name: 'Close the demo dialog' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  // Break caught: a stray click on the backdrop discarding what a person typed.
  test('is not closed by a click on the backdrop, and keeps what was typed', async ({ page }) => {
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo dialog');
    const field = page.getByRole('textbox', { name: 'Demo dialog field' });
    await field.fill('typed in the dialog');

    await page.mouse.click(3, 3);

    await expect(page.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();
    await expect(field).toHaveValue('typed in the dialog');
  });

  // Break caught: the scrim not drawn, so the page behind looks live. A test cannot read a pixel, so the style that draws it is read.
  test('draws a scrim over the page', async ({ page }) => {
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo dialog');

    const backdrop = await page.evaluate(() => {
      const dialog = document.querySelector('dialog');
      if (dialog === null) return null;
      const style = getComputedStyle(dialog, '::backdrop');
      return { opacity: style.opacity, background: style.backgroundColor };
    });

    expect(backdrop).not.toBeNull();
    expect(Number(backdrop?.opacity)).toBeGreaterThan(0.3);
    expect(Number(backdrop?.opacity)).toBeLessThan(0.9);
    expect(backdrop?.background).not.toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
  });

  test('fits a narrow screen and enlarged text: nothing wider than the window, and the actions reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo dialog');
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    const dialog = page.getByRole('dialog', { name: 'Demo dialog' });
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(320);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(640 + 1);
    await page.getByRole('button', { name: 'Close the demo dialog' }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Close the demo dialog' })).toBeVisible();
  });

  test('keeps a border under forced colours', async ({ page, browserName }) => {
    test.skip(
      browserName === 'webkit',
      'Playwright cannot emulate forced colours in WebKit; the dialog’s border is a plain border in every engine.',
    );
    await page.emulateMedia({ forcedColors: 'active' });
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo dialog');

    const border = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('dialog') ?? document.body);
      return { style: style.borderTopStyle, width: parseFloat(style.borderTopWidth) };
    });
    expect(border.style).toBe('solid');
    expect(border.width).toBeGreaterThanOrEqual(1);
  });

  test('has no WCAG 2.2 A or AA violation with the dialog open, at each verified width', async ({
    page,
  }) => {
    for (const { width, height } of VERIFIED_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await openShowcase(page);
      await openWithKeyboard(page, 'Open the demo dialog');
      await expect(page.getByRole('dialog', { name: 'Demo dialog' })).toBeVisible();

      expect(await wcagViolations(page), `${String(width)} px`).toEqual([]);
      await page.keyboard.press('Escape');
    }
  });
});

test.describe('an alert dialog in a browser', () => {
  test('puts focus on the safe action, and Escape answers it', async ({ page }) => {
    await openShowcase(page);
    const opener = await openWithKeyboard(page, 'Open the demo confirmation');
    const dialog = page.getByRole('alertdialog', { name: 'End this demo session?' });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');

    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(page.getByText('Demo confirmation answered: cancelled.')).toBeVisible();
  });

  test('is not answered by a click on the backdrop', async ({ page }) => {
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo confirmation');

    await page.mouse.click(3, 3);

    await expect(page.getByRole('alertdialog', { name: 'End this demo session?' })).toBeVisible();
  });

  test('confirms from the keyboard with the act named, in the danger treatment', async ({
    page,
  }) => {
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo confirmation');
    const confirm = page.getByRole('button', { name: 'End the demo session' }).last();

    const style = await confirm.evaluate((element) => {
      const computed = getComputedStyle(element);
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-status-danger-foreground)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { border: computed.borderTopColor, text: computed.color, danger };
    });
    expect(style.border).toBe(style.danger);
    expect(style.text).toBe(style.danger);

    await page.keyboard.press('Tab');
    await expect(confirm).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Demo confirmation answered: confirmed.')).toBeVisible();
  });

  test('has no WCAG 2.2 A or AA violation with it open', async ({ page }) => {
    await openShowcase(page);
    await openWithKeyboard(page, 'Open the demo confirmation');
    await expect(page.getByRole('alertdialog')).toBeVisible();

    expect(await wcagViolations(page)).toEqual([]);
  });
});

test.describe('the reason and confirmation workflow in a browser', () => {
  /** Opens the workflow the way a keyboard user does, with the reasons answered. */
  async function openWorkflow(page: Page, opener: string, title: string) {
    const asked = await answerReasons(page);
    await openShowcase(page);
    await openWithKeyboard(page, opener);
    const dialog = page.getByRole('alertdialog', { name: title });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Reason (required)' })).toBeVisible();
    return { asked, dialog };
  }

  const reasoned = (page: Page) =>
    openWorkflow(
      page,
      'Open the demo reason confirmation',
      'Reset this demo person’s second factor?',
    );
  const keyed = (page: Page) =>
    openWorkflow(page, 'Open the demo keyed confirmation', 'Skip this demo stop?');

  test('asks the server for the reasons of the action and its branch, and puts focus on Cancel', async ({
    page,
  }) => {
    const { asked, dialog } = await reasoned(page);

    expect(asked).toHaveLength(1);
    const url = new URL(asked[0] ?? '');
    expect(url.searchParams.get('operation')).toBe('resetStaffMfa');
    expect(url.searchParams.get('branch')).toBe('FACTOR_ACTIVE');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  });

  // Break caught: a retry offered for a command that takes no Idempotency-Key, and a key sent to an operation that does not declare one.
  // The answer to the first attempt is lost (the connection is cut): the dialog stays, locked, and offers only a look at the record.
  test('offers only a look at the record when the answer of an act without a key is lost, and sends no key', async ({
    page,
  }) => {
    const { dialog } = await reasoned(page);
    const seen: { key: string | null; version: string | null }[] = [];
    await page.route(RESET_PATH, async (route: Route) => {
      const headers = route.request().headers();
      seen.push({ key: headers['idempotency-key'] ?? null, version: headers['if-match'] ?? null });
      await route.abort('connectionreset');
    });

    await dialog
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('DEMO_REASON_ONE');
    await dialog.getByRole('button', { name: 'Reset the second factor' }).click();

    await expect(dialog.getByText(/could not confirm whether this was done/i)).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Reason (required)' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Check the record' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    expect(seen).toEqual([{ key: null, version: '"demo-version-1"' }]);
    expect(await wcagViolations(page), 'with the unknown outcome showing').toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Check the record' }).click();
    await expect(page.getByText('Demo record reloaded: 1.')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Reason (required)' })).toBeEnabled();
  });

  // Break caught: a retry that is not the same request. The first attempt's answer is lost; the retry carries the same Idempotency-Key, the
  // same If-Match and the same body, which is what lets the server replay the first result instead of doing it twice.
  test('retries a lost command with the same key, the same version and the same body', async ({
    page,
  }) => {
    const { dialog } = await keyed(page);
    const seen: { key: string | null; version: string | null; body: string | null }[] = [];
    let attempt = 0;
    await page.route(SKIP_PATH, async (route: Route) => {
      attempt += 1;
      const request = route.request();
      seen.push({
        key: request.headers()['idempotency-key'] ?? null,
        version: request.headers()['if-match'] ?? null,
        body: request.postData(),
      });
      if (attempt === 1) await route.abort('connectionreset');
      else await route.fulfill({ status: 200, json: { id: 'demo', state: 'SKIPPED' } });
    });

    await dialog
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('DEMO_REASON_ONE');
    await dialog.getByRole('button', { name: 'Skip the demo stop' }).click();

    await expect(dialog.getByText(/could not confirm whether this was done/i)).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Reason (required)' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Try again' }).click();

    await expect(page.getByText('Demo confirmation answered: done.')).toBeVisible();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[0]?.version).toBe('"demo-version-1"');
  });

  test('says the record changed on a conflict, and reloading reads it again', async ({ page }) => {
    const { dialog } = await reasoned(page);
    let sent = 0;
    await page.route(RESET_PATH, async (route) => {
      sent += 1;
      await route.fulfill({
        status: 409,
        json: { code: 'STATE_CONFLICT', message: 'Diagnostic text.', request_id: 'req-browser-9' },
      });
    });

    await dialog
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('DEMO_REASON_ONE');
    await dialog.getByRole('button', { name: 'Reset the second factor' }).click();

    // The demo resets a second factor, whose conflict is worded for it (S0.44); what is asserted is that a conflict is said in words.
    await expect(dialog.getByText(/changed after you opened it/)).toBeVisible();
    await expect(page.getByText('Diagnostic text.')).toHaveCount(0);
    expect(await wcagViolations(page), 'with the conflict showing').toEqual([]);
    await dialog.getByRole('button', { name: 'Reload the record' }).click();
    await expect(page.getByText('Demo record reloaded: 1.')).toBeVisible();
    // Break caught (found in the rider screens, S0.60): the button of the conflict and the dialog's confirm button were one element for React,
    // whose type changed to "submit" while the click was still being handled, so that the browser then submitted the form: reading the
    // record again asked for the act again. Reloading is reading, and sends nothing.
    await expect(dialog.getByRole('button', { name: 'Reset the second factor' })).toBeVisible();
    expect(sent).toBe(1);
  });

  test('puts a mandatory note that is missing on its field before anything is sent', async ({
    page,
  }) => {
    const { dialog } = await reasoned(page);
    let sent = 0;
    await page.route(RESET_PATH, async (route) => {
      sent += 1;
      await route.abort();
    });

    await dialog
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('DEMO_REASON_NOTE');
    await dialog.getByRole('button', { name: 'Reset the second factor' }).click();

    const note = dialog.getByRole('textbox', { name: 'Note (required)' });
    await expect(note).toBeFocused();
    await expect(note).toHaveAttribute('aria-invalid', 'true');
    expect(sent).toBe(0);
  });

  test('logs no errors and reaches only its own origin', async ({ page, baseURL }) => {
    const seen = watchPage(page);
    const { dialog } = await reasoned(page);
    await page.route(RESET_PATH, (route) =>
      route.fulfill({ status: 200, json: { sessions_terminated: 1 } }),
    );
    await dialog
      .getByRole('combobox', { name: 'Reason (required)' })
      .selectOption('DEMO_REASON_ONE');
    await dialog.getByRole('button', { name: 'Reset the second factor' }).click();
    await expect(page.getByText('Demo confirmation answered: done.')).toBeVisible();

    expect(seen.problems).toEqual([]);
    for (const url of seen.requests) expect(new URL(url).origin, url).toBe(baseURL);
  });

  test('has no WCAG 2.2 A or AA violation with the workflow open, at each verified width', async ({
    page,
  }) => {
    for (const { width, height } of VERIFIED_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await reasoned(page);

      expect(await wcagViolations(page), `${String(width)} px`).toEqual([]);
      await page.keyboard.press('Escape');
      await page.unrouteAll();
    }
  });
});
