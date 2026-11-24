import type { Locator, Page } from '@playwright/test';

import { expect, test } from './support/guarded-test';
import {
  IDS,
  parcelIdOf,
  storedOrder,
  stubOrdersApi,
  world,
  type OrdersApi,
  type World,
} from './support/orders-api';
import { watchPage, wcagViolations } from './support/page';
import { menuEntry } from './support/shell';
import { expectNoTableScrollsSideways } from './support/tables';

/**
 * The order screens (S1.40) in a real browser: from the queue of the vendors with orders to make to the first order (the price is beside the form by itself, and the one save is at that price), a price that changes
 * while the officer looks, a double tap at each point where a price appears or changes, the close of a vendor and its summary, a change of an order that is not confirmed, and a request to change who pays with the
 * checker's decision. What jsdom cannot show is here: the layout at the verified widths with axe (WCAG 2.2 A and AA), no sideways scrolling at 320 px, the form by keyboard alone, and the picture beside the form
 * really drawn.
 *
 * **The API is a stateful stand-in that keeps what the API keeps** (`support/orders-api.ts`): the vendor's version moves when its state does and not with each order, so a save on an older read is refused; the price
 * is the stand-in's server's and the page sends none (a save is on the digest of the terms that were read, and a price that changed meanwhile answers the terms as they are now); a key makes an order once; a change
 * of who pays is a request a checker decides. Every request is recorded as the browser sent it.
 *
 * The same file runs against the production build and against the development server (strict mode runs every effect twice).
 */
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

const VENDOR = IDS.vendor;
const ORDERS = `/intakes/${VENDOR}/orders`;
const NEW_ORDER = `${ORDERS}/new`;
const FIRST = storedOrder(1);
const EARLY_ID = storedOrder(2).id;
const CORRECTION_ID = '0f0f0f0f-0000-4000-8000-000000000001';
const DIAGNOSTIC = 'Diagnostic text that must never reach a screen.';
/** D-S7-2: a press in the moment after the price changed at the save is ignored (about 600 ms); a press that is meant comes after it. */
const GUARD_WAIT_MS = 750;

async function open(
  page: Page,
  path: string,
  setup: Partial<World> = {},
): Promise<{ api: OrdersApi; watch: ReturnType<typeof watchPage> }> {
  const watch = watchPage(page);
  const api = await stubOrdersApi(page, world(setup));
  await page.goto(path);
  return { api, watch };
}

/** The requests the page made to one operation. */
const made = (api: OrdersApi, method: string, path: string) =>
  api.calls.filter((call) => call.method === method && call.path === `/api/v1${path}`);

/** Goes to a control with the Tab key, as a person does, and fails if it is not reached within a few presses (never by focusing it from the script: the review of 499399c). */
async function tabTo(page: Page, target: Locator, presses = 16): Promise<void> {
  for (let step = 0; step < presses; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** What the officer knows of the parcel in front of them, and the size they judge it to be. */
async function fillIn(page: Page, size = 'Medium'): Promise<void> {
  await page.getByLabel('Recipient’s name').fill('Kofi Asante');
  await page.getByLabel('Recipient’s phone').fill('024 765 4321');
  await page.getByLabel('Delivery address').fill('7 Spintex Road, near the mall');
  await page.getByRole('radio', { name: size }).check();
}

const overflowOf = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

/** The controls whose content is wider than the control: a label cut off. */
function clippedControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, input, select, textarea')]
      .filter((element) => element.getClientRects().length > 0)
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.getAttribute('aria-label') ?? element.textContent),
  );
}

test.describe('making the orders of a vendor', () => {
  // Break caught: a vendor that cannot be found again from the queue, an order form that works the price out itself, a price that is not there for the officer to read before the one save, a save with no key or no
  // version, or a parcel without its photo.
  test('from the queue to a saved order: the price is beside the form by itself, and the save is on the terms that were read', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/orders-to-make');
    await expect(page.getByRole('heading', { level: 1, name: 'Orders to make' })).toBeVisible();
    // The vendor's name is the link to its orders: a row opens the page it leads to, with no panel between (item 16 of the review of 23 November 2026).
    await page.getByRole('link', { name: 'Kente Crafts' }).click();

    await expect(page).toHaveURL(ORDERS);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Orders for Kente Crafts' }),
    ).toBeVisible();
    // The work that is really left: three parcels need an order, as the server counted.
    const rows = page.getByRole('table', { name: 'Parcels and orders' });
    await expect(rows.getByText('Parcel 1')).toBeVisible();
    await expect(rows.getByText('Parcel 3')).toBeVisible();
    await expect(
      page.getByText('Need an order', { exact: true }).locator('xpath=following-sibling::*[1]'),
    ).toHaveText('3');

    await page.getByRole('link', { name: 'Make the next order' }).click();
    // The form opens on the first parcel that needs an order, which the address names.
    await expect(page).toHaveURL(new RegExp(`${NEW_ORDER}\\?parcel=[0-9a-f-]{36}$`));
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
    // The parcel's photo is beside the form, drawn from the page's own origin.
    await expect.poll(() => api.images.length).toBeGreaterThan(0);

    await fillIn(page);
    // The price comes by itself, a moment after the last key, beside the form; the one save says it, and a line above it says what was typed.
    const saveAt = page.getByRole('button', { name: 'Save the order at GH₵40.00' });
    await expect(saveAt).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'The price' })).toBeVisible();
    await expect(page.getByText('GH₵40.00').first()).toBeVisible();
    await expect(
      page.getByText(/Kofi Asante · 024 765 4321 · 7 Spintex Road, near the mall · Medium/),
    ).toBeVisible();
    // Nothing is saved until the officer presses the save, and what was sent to price carries no price of the page's own.
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(0);
    const preview = made(api, 'POST', `/hub-intakes/${VENDOR}/orders/preview`).at(-1)
      ?.body as Record<string, unknown>;
    expect(preview).toMatchObject({ size_class: 'MEDIUM', lane: 'DOORSTEP' });
    for (const never of ['price', 'total', 'zone', 'locked_price', 'reviewed_terms'])
      expect(preview).not.toHaveProperty(never);

    await saveAt.click();
    await expect(page.getByText(/^Order ACC-OR-2CD3FG is saved\.$/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Make the next order' })).toBeVisible();

    const save = made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)[0];
    expect(save?.ifMatch).toBe('"v1"');
    expect(save?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(save?.body).toMatchObject({
      size_class: 'MEDIUM',
      reviewed_terms: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(api.world.orders).toHaveLength(1);
    // The first order moved the vendor from ready to being worked.
    expect(api.world.vendorState).toBe('ITEMIZING');
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: an order saved at a price the officer did not read; the earlier figure lost; a second save that does not name the new figure; the focus left where the new figure is not read; an order made twice.
  test('a price that changed while the officer looked is shown beside the old one and saved again at the new figure', async ({
    page,
  }) => {
    const { api, watch } = await open(page, NEW_ORDER, { repriceOnce: 4500 });
    await fillIn(page);
    await page.getByRole('button', { name: 'Save the order at GH₵40.00' }).click();

    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'The terms changed while you were looking' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Price: GH₵40.00 before, GH₵45.00 now.');
    expect(api.world.orders).toHaveLength(0);
    // The save is now a button of its own that says the new figure, and the focus is on the price beside the form, so that the new figure is read before it is pressed.
    const again = page.getByRole('button', { name: 'Save at GH₵45.00' });
    await expect(again).toBeVisible();
    await expect(page.locator('.orders-price__body')).toBeFocused();
    await page.waitForTimeout(GUARD_WAIT_MS);
    await again.click();

    await expect(page.getByText(/^Order ACC-OR-2CD3FG is saved\.$/)).toBeVisible();
    // Two saves were sent (the first refused with the terms as they now are), one order was made, and what the officer typed was never asked for again.
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(2);
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders/preview`)).toHaveLength(1);
    expect(api.world.orders).toHaveLength(1);
    expect(api.world.orders[0]?.price).toBe(4500);
    expect(api.unexpected).toEqual([]);
    // The refusal that carried the new terms is the one answer of 409 this test expects (the browser logs it as a failed resource).
    expect(watch.problems.filter((problem) => !problem.includes('409'))).toEqual([]);
  });

  // Break caught (found by looking at the pictures of Run F, which the checks of text and of axe could not see): the photo and the price put in one cell of the column beside the form, the photo drawn over the top of
  // the price, so that its title and its total were on the page and nowhere to be read.
  for (const viewport of VIEWPORTS) {
    test(`the price beside the form is not covered by the photo, at ${String(viewport.width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const { api, watch } = await open(page, NEW_ORDER);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
      ).toBeVisible();
      await fillIn(page);
      await expect(page.getByRole('button', { name: /^Save the order at / })).toBeVisible();
      // A trial click does everything a click does but the press, and fails when another element would receive it: what is drawn over the price is found, and not only what exists.
      await page
        .getByRole('heading', { level: 2, name: 'The price' })
        .click({ trial: true, timeout: 4000 });
      await page.locator('.orders-review__total').click({ trial: true, timeout: 4000 });
      expect(api.unexpected).toEqual([]);
      expect(watch.problems).toEqual([]);
    });
  }

  // Break caught: a form that cannot be completed without a pointer, a save that cannot be reached with the Tab key, or a saved order that leaves the officer to look for what happened.
  test('the form and the save can all be done from the keyboard, and focus follows the officer', async ({
    page,
  }) => {
    const { api, watch } = await open(page, NEW_ORDER);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();

    await tabTo(page, page.getByLabel('Recipient’s name'));
    await page.keyboard.type('Kofi Asante');
    await page.keyboard.press('Tab');
    await page.keyboard.type('024 765 4321');
    await page.keyboard.press('Tab');
    await page.keyboard.type('7 Spintex Road, near the mall');
    // The size is a judgement and nothing is chosen for the officer: Tab reaches the group, the arrow keys choose in it.
    await tabTo(page, page.getByRole('radio', { name: 'Small' }));
    await page.keyboard.press('Space');
    await expect(page.getByRole('radio', { name: 'Small' })).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Medium' })).toBeChecked();

    // The price comes by itself, and the one save is the next stop of the Tab key that matters.
    const save = page.getByRole('button', { name: 'Save the order at GH₵40.00' });
    await expect(save).toBeVisible();
    await tabTo(page, save, 24);
    await page.keyboard.press('Enter');
    await expect(page.getByText(/^Order ACC-OR-2CD3FG is saved\.$/)).toBeVisible();
    // Focus is on what happened, so that it is read out and the officer is not left on a button that is gone.
    await expect(page.locator('.orders-saved[tabindex="-1"]').first()).toBeFocused();
    expect(api.world.orders).toHaveLength(1);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: the next order made on the version of the vendor read before the first one (the first order moves a vendor from ready to being worked, and the stand-in refuses a save on the older version as the API does, so
  // the officer would be told the vendor changed and asked to check the price again, on the commonest path there is).
  test('every order is made on the vendor as it is when its form opens, and the vendor then has no parcel left to order', async ({
    page,
  }) => {
    const { api } = await open(page, NEW_ORDER);
    await fillIn(page, 'Small');
    await page.getByRole('button', { name: /^Save the order at / }).click();
    await expect(page.getByText(/^Order ACC-OR-2CD3FG is saved\.$/)).toBeVisible();
    await page.getByRole('link', { name: 'Make the next order' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 2' }),
    ).toBeVisible();
    await fillIn(page, 'Medium');
    await page.getByRole('button', { name: /^Save the order at / }).click();
    await expect(page.getByText(/^Order ACC-OR-4HJ5KM is saved\.$/)).toBeVisible();
    await page.getByRole('link', { name: 'Make the next order' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 3' }),
    ).toBeVisible();
    await fillIn(page, 'Large');
    await expect(page.getByText('GH₵50.00').first()).toBeVisible();
    await page.getByRole('button', { name: 'Save the order at GH₵50.00' }).click();
    await expect(page.getByText(/^Order ACC-OR-6NP7QR is saved\.$/)).toBeVisible();

    // Every parcel has its order, and the page leads to the close and not to another order. No save was refused as stale, and no officer was asked to check a price again.
    expect(api.world.orders).toHaveLength(3);
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`).map((call) => call.ifMatch)).toEqual([
      '"v1"',
      '"v2"',
      '"v2"',
    ]);
    await expect(page.getByText(/This vendor changed while you were working/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Close this vendor' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Make the next order' })).toHaveCount(0);
  });
});

/**
 * Two taps of one finger, a moment apart (less than 200 ms), on the place where the control is when the first lands: what a double tap is, and what the review of 23 November 2026 reproduced saving an order that
 * had not been read (the second tap landed on the control that had taken the first one's place). The place is read once, as a finger would find it, and the second tap goes to the same place wherever the control has
 * gone.
 */
async function doubleTap(page: Page, target: Locator, gap = 120): Promise<void> {
  // A finger taps what it can see: the control is brought into view first, and its place is read after that.
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error('the control to tap has no place on the screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  await page.waitForTimeout(gap);
  await page.mouse.click(x, y);
}

test.describe('a double tap never saves what was not read (D-S7-2, item 2 of the review of 23 November 2026)', () => {
  // Break caught: a double tap on the save of an order that makes the order twice, or a price that changed at the save taken by the second tap of the same finger (the two steps of the old form: the second tap landed on
  // "Confirm the order" in the place of "Check the price", reproduced in Chromium).
  test('at the save, where the price changes under the finger: one refused save, and the second tap saves nothing', async ({
    page,
  }) => {
    const { api, watch } = await open(page, NEW_ORDER, { repriceOnce: 4500 });
    await fillIn(page);
    const save = page.getByRole('button', { name: 'Save the order at GH₵40.00' });
    await expect(save).toBeVisible();

    await doubleTap(page, save);
    // The first tap was refused with the terms as they now are (GH₵45.00), and the button that says the new figure is in the same place: the second tap, 120 ms after the first, did not press it.
    const again = page.getByRole('button', { name: 'Save at GH₵45.00' });
    await expect(again).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Price: GH₵40.00 before' }),
    ).toBeVisible();
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(1);
    expect(api.world.orders).toHaveLength(0);

    // A press that is meant, after the figure was read, saves at the new price.
    await page.waitForTimeout(GUARD_WAIT_MS);
    await again.click();
    await expect(page.getByText(/^Order ACC-OR-2CD3FG is saved\.$/)).toBeVisible();
    expect(api.world.orders).toHaveLength(1);
    expect(api.world.orders[0]?.price).toBe(4500);
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(2);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems.filter((problem) => !problem.includes('409'))).toEqual([]);
  });

  // Break caught: the save pressable while the price is being worked out (a tap on it saves on a price that is not the price of what is on the screen), or a double tap that makes an order twice.
  test('where the price first appears: taps on the button while the price is being checked save nothing', async ({
    page,
  }) => {
    const { api, watch } = await open(page, NEW_ORDER, { previewDelayMs: 900 });
    await fillIn(page);
    const checking = page.getByRole('button', { name: 'Checking the price…' });
    await expect(checking).toBeVisible();
    await expect(checking).toBeDisabled();

    await doubleTap(page, checking);
    // The price arrives (the stand-in is slow on purpose): nothing was saved by the taps, and the save is there for a press that is meant.
    await expect(page.getByRole('button', { name: 'Save the order at GH₵40.00' })).toBeVisible();
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(0);
    expect(api.world.orders).toHaveLength(0);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a price that changed because an entry was changed (the size) that the save is pressable on while the new price is being worked out, so that a tap saves the old price for the new size.
  test('where the price changes with an entry: taps while the new price is being checked save nothing, and the new price is the one shown', async ({
    page,
  }) => {
    const { api, watch } = await open(page, NEW_ORDER);
    await fillIn(page, 'Small');
    await expect(page.getByRole('button', { name: 'Save the order at GH₵35.00' })).toBeVisible();

    // The price of a bigger parcel is slow to come (the stand-in is slow on purpose, from now on).
    api.world.previewDelayMs = 900;
    await page.getByRole('radio', { name: 'Large' }).check();
    const checking = page.getByRole('button', { name: 'Checking the price…' });
    await expect(checking).toBeVisible();
    await expect(checking).toBeDisabled();

    await doubleTap(page, checking);
    await expect(page.getByRole('button', { name: 'Save the order at GH₵50.00' })).toBeVisible();
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(0);
    expect(api.world.orders).toHaveLength(0);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: a double tap on a save that is pressable that makes two orders (the second tap is the same press: the command takes one at a time and a retry would be under the same key).
  test('on a save that is ready: two taps make one order', async ({ page }) => {
    const { api, watch } = await open(page, NEW_ORDER);
    await fillIn(page);
    const save = page.getByRole('button', { name: 'Save the order at GH₵40.00' });
    await expect(save).toBeVisible();

    await doubleTap(page, save);
    await expect(page.getByText(/^Order ACC-OR-2CD3FG is saved\.$/)).toBeVisible();
    expect(api.world.orders).toHaveLength(1);
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(1);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('a double tap on the change of an order (D-S7-2)', () => {
  const early = () => storedOrder(2, { status: 'EARLY_QUOTE', size: 'SMALL', price: 3500 });

  // Break caught: the change saved on a price that is not the price of what is on the screen, by taps while the new price is being worked out.
  test('taps while the price of the change is being checked save nothing', async ({ page }) => {
    const order = early();
    const { api, watch } = await open(page, `/orders/${order.id}/amend`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1), order],
      previewDelayMs: 900,
    });
    await page.getByRole('radio', { name: 'Large' }).check();
    await page
      .getByLabel(/Why are you changing this order\?/)
      .fill('The parcel is bigger than its photo showed');
    const checking = page.getByRole('button', { name: 'Checking the price…' });
    await expect(checking).toBeVisible();
    await expect(checking).toBeDisabled();

    await doubleTap(page, checking);
    await expect(page.getByRole('button', { name: 'Save the change at GH₵50.00' })).toBeVisible();
    expect(made(api, 'PATCH', `/orders/${order.id}`)).toHaveLength(0);
    expect(api.world.orders[1]?.size).toBe('SMALL');
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('what the stand-in keeps that the API keeps (Run F, Part 3)', () => {
  // Break caught: a stand-in that lets the officer who asked for a change decide it, so that the answer of the screen to the API's refusal (SELF_APPROVAL_FORBIDDEN) was never seen in a browser.
  test('the officer who asked for a change of who pays is told that a different officer decides it', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/orders/${FIRST.id}`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1)],
      permissions: [
        'hub.read',
        'pricing.read',
        'pricing.correction.create',
        'pricing.correction.approve',
      ],
    });
    await page.getByRole('button', { name: 'Change who pays' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('radio', { name: 'The sender pays all of it' }).check();
    await dialog.getByLabel(/Why should it change\?/).fill('The vendor will pay on the phone');
    await dialog.getByRole('button', { name: 'Ask for the change' }).click();
    await page.getByRole('link', { name: 'Open the correction' }).click();

    // The same officer holds the key to decide, and the server's rule is that nobody decides what they asked.
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, approve' }).click();
    await expect(
      page
        .getByRole('alertdialog')
        .getByText('A different officer decides a change you asked for.'),
    ).toBeVisible();
    expect(api.world.corrections[0]?.state).toBe('REQUESTED');
    expect(api.unexpected).toEqual([]);
    // The refusal is the one answer of its kind this test expects (the browser logs a refused request as a failed resource).
    expect(watch.problems.filter((problem) => !problem.includes('422'))).toEqual([]);
  });

  // Break caught: a stand-in that prices a parcel that already has an order, so that the answer of the screen to that refusal (parcel_ordered) was never seen in a browser.
  test('a parcel that already has an order is refused when its price is asked for, in words, and nothing is saved', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `${NEW_ORDER}?parcel=${parcelIdOf(1)}`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1)],
    });
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
    await fillIn(page);
    await expect(
      page.getByRole('alert').filter({ hasText: 'This parcel already has an order.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^Save the order at / })).toHaveCount(0);
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(0);
    expect(api.world.orders).toHaveLength(1);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems.filter((problem) => !problem.includes('409'))).toEqual([]);
  });

  // Break caught: a digest that covers the size and the price alone, which accepts a save whose terms (who pays, the declared value) are not the ones that were priced; and a key seen with another body that makes a second
  // order or is answered as the first save.
  test('the digest of a price covers every term it was worked out from, and a key seen with another body is refused', async ({
    page,
  }) => {
    const { api } = await open(page, NEW_ORDER);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
    // Requests sent as the page sends them (the stand-in answers every request of the browser to the API), with the bodies of a person: not through the screen, which would never send a stale digest.
    const result = await page.evaluate(
      async ({ vendor, parcel }) => {
        const headers = { 'content-type': 'application/json' };
        const base = {
          parcel_id: parcel,
          recipient: {
            name: 'Kofi Asante',
            phone: '024 765 4321',
            location: { address: '7 Spintex Road' },
          },
          size_class: 'MEDIUM',
          lane: 'DOORSTEP',
          is_high_value: false,
          is_serialized_goods: false,
        };
        const post = async (path: string, body: unknown, extra: Record<string, string> = {}) => {
          const response = await fetch(`/api/v1/hub-intakes/${vendor}${path}`, {
            method: 'POST',
            headers: { ...headers, ...extra },
            body: JSON.stringify(body),
          });
          return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>,
          };
        };
        const priced = await post('/orders/preview', base);
        const token = priced.body.terms_token as string;
        // Who pays is another term: the digest of the first price is not the digest of this one.
        const key = crypto.randomUUID();
        const changed = await post(
          '/orders',
          { ...base, payer_override: { payer_intent: 'RECIPIENT_PAYS' }, reviewed_terms: token },
          { 'Idempotency-Key': key, 'If-Match': '"v1"' },
        );
        // The same save, as priced, is made once; the same key with the same body answers the first; with another body it is refused.
        const made = await post(
          '/orders',
          { ...base, reviewed_terms: token },
          { 'Idempotency-Key': key, 'If-Match': '"v1"' },
        );
        const replay = await post(
          '/orders',
          { ...base, reviewed_terms: token },
          { 'Idempotency-Key': key, 'If-Match': '"v1"' },
        );
        const other = await post(
          '/orders',
          { ...base, size_class: 'SMALL', reviewed_terms: token },
          { 'Idempotency-Key': key, 'If-Match': '"v1"' },
        );
        return { changed, made, replay, other };
      },
      { vendor: VENDOR, parcel: parcelIdOf(1) },
    );
    expect(result.changed.status).toBe(409);
    expect((result.changed.body.details as { rule: string }).rule).toBe('terms_changed');
    expect(result.made.status).toBe(201);
    expect(result.replay.status).toBe(201);
    expect(result.replay.body).toEqual(result.made.body);
    expect(result.other.status).toBe(409);
    expect(result.other.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    // One order was made, whatever was asked of the key afterwards.
    expect(api.world.orders).toHaveLength(1);
  });

  // Break caught: a long vendor read as one list, the count of a page told for the count of the vendor, or a next page that is not asked for with the token the first gave.
  test('a vendor of 130 parcels is worked a page at a time, and its counts are the vendor’s', async ({
    page,
  }) => {
    const { api, watch } = await open(page, ORDERS, { parcelCount: 130 });
    await expect(
      page.getByRole('heading', { level: 1, name: 'Orders for Kente Crafts' }),
    ).toBeVisible();
    // The counts are the vendor's: 130 parcels need an order, which no page holds.
    await expect(
      page.getByText('Need an order', { exact: true }).locator('xpath=following-sibling::*[1]'),
    ).toHaveText('130');
    const rows = page.getByRole('table', { name: 'Parcels and orders' });
    await expect(rows.getByText('Parcel 1', { exact: true })).toBeVisible();
    const first = made(api, 'GET', `/hub-intakes/${VENDOR}/orders`).at(-1);
    const size = Number(new URLSearchParams(first?.search).get('page_size') ?? '100');
    expect(size).toBeLessThan(130);
    await expect(rows.getByText(`Parcel ${String(size)}`, { exact: true })).toBeVisible();
    await expect(rows.getByText(`Parcel ${String(size + 1)}`, { exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(rows.getByText('Parcel 130', { exact: true })).toBeVisible();
    await expect(rows.getByText('Parcel 1', { exact: true })).toHaveCount(0);
    // The second page was asked for with the token the first one gave, and never as one list.
    const second = made(api, 'GET', `/hub-intakes/${VENDOR}/orders`).at(-1);
    expect(new URLSearchParams(second?.search).get('page_token')).toBe(String(size));
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

test.describe('correcting the recipient of a confirmed order (D-S7-1, Run F)', () => {
  // Break caught: a correction with no reason, the whole recipient sent for one field, the version not sent, an order not read again, or a history that does not say a correction was made and why.
  test('an officer corrects a phone with a reason, on the version read, and the history keeps it', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/orders/${FIRST.id}`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1)],
    });
    await page.getByRole('button', { name: 'Correct the recipient' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: 'Save the correction' }).click();
    await expect(dialog.getByText('Write why you are correcting this.')).toBeVisible();
    await dialog.getByLabel(/Recipient’s phone/).fill('024 765 4321');
    await dialog.getByLabel(/Why are you correcting this\?/).fill('The phone had a digit wrong');
    await dialog.getByRole('button', { name: 'Save the correction' }).click();

    await expect(
      page.getByText(`The recipient of order ${FIRST.code} was corrected.`),
    ).toBeVisible();
    const request = made(api, 'POST', `/orders/${FIRST.id}/recipient-correction`)[0];
    expect(request?.ifMatch).toBe('"o1"');
    expect(request?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.body).toEqual({
      note: 'The phone had a digit wrong',
      recipient: { phone: '024 765 4321' },
    });
    // The order is read again as it stands: the new phone is what it holds, and the history keeps the correction with its reason.
    await expect(
      page.getByRole('region', { name: 'What it holds' }).getByText('024 765 4321'),
    ).toBeVisible();
    await expect(page.getByText('Changed: the recipient.')).toBeVisible();
    await expect(page.getByText(/Reason: The phone had a digit wrong/)).toBeVisible();
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  // Break caught: an address in another zone corrected as if nothing moved (the price would), or refused as "something went wrong" with the dialog lost.
  test('an address in another zone is refused in words, and nothing changes', async ({ page }) => {
    const { api, watch } = await open(page, `/orders/${FIRST.id}`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1)],
    });
    await page.getByRole('button', { name: 'Correct the recipient' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel(/Delivery address/).fill('Community 1, Tema');
    await dialog.getByLabel(/Why are you correcting this\?/).fill('Wrong town');
    await dialog.getByRole('button', { name: 'Save the correction' }).click();
    await expect(
      dialog.getByText(/That address is in another zone, so it would change the price\./),
    ).toBeVisible();
    expect(api.world.orders[0]?.address).toBe('12 Madina Estate, near the market');
    expect(api.unexpected).toEqual([]);
    expect(watch.problems.filter((problem) => !problem.includes('409'))).toEqual([]);
  });
});

test.describe('closing a vendor and its summary', () => {
  // Three orders made, the vendor being worked: each test has orders of its own, which the stand-in changes.
  const ALL_MADE = (): Partial<World> => ({
    vendorState: 'ITEMIZING',
    orders: [
      storedOrder(1),
      storedOrder(2, { size: 'MEDIUM', price: 4000 }),
      storedOrder(3, { size: 'LARGE', price: 5000 }),
    ],
  });

  // Break caught: a close that is not on the assessment the officer read, one made with no confirmation, a vendor said to be paid when it is only closed, or no way on to the summary.
  test('the facts are shown apart, the close is confirmed, and the summary lists the orders with their prices', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/intakes/${VENDOR}/close`, ALL_MADE());
    await expect(page.getByRole('heading', { level: 1, name: 'Close Kente Crafts' })).toBeVisible();
    await expect(
      page.getByText('Every parcel received has an order. You can close this vendor.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Close this vendor' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText('Close this vendor?')).toBeVisible();
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/close`)).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Yes, close it' }).click();

    await expect(page.getByText('The vendor is closed.')).toBeVisible();
    const close = made(api, 'POST', `/hub-intakes/${VENDOR}/close`)[0];
    expect(close?.ifMatch).toBe('"v2"');
    expect(close?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(close?.body).toEqual({ reviewed_assessment: expect.stringMatching(/^[0-9a-f]{64}$/) });

    await page.getByRole('link', { name: 'See the summary' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Summary for Kente Crafts' }),
    ).toBeVisible();
    const table = page.getByRole('table', { name: 'Order' });
    await expect(table.getByText('GH₵35.00')).toBeVisible();
    await expect(table.getByText('GH₵40.00')).toBeVisible();
    await expect(table.getByText('GH₵50.00')).toBeVisible();
    await expect(page.getByText('What was said about this')).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('a vendor with parcels still to order is told so, and is not closed by an officer who has no exception to give', async ({
    page,
  }) => {
    const { api } = await open(page, `/intakes/${VENDOR}/close`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1)],
    });
    await expect(page.getByRole('heading', { level: 1, name: 'Close Kente Crafts' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close this vendor' })).toHaveCount(0);
    await expect(
      page.getByText(
        /A senior officer can close with parcels still to order\. A senior officer finds this vendor under Needs a senior\./,
      ),
    ).toBeVisible();
    // The way on is the senior officers' list, and not a request to ask one of them to open this page.
    await expect(
      page.getByRole('link', { name: 'Open the list for a senior officer' }),
    ).toHaveAttribute('href', '/orders-to-make?view=NEEDS_SENIOR');
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/close`)).toHaveLength(0);
  });
});

test.describe('an order, and who pays for it', () => {
  // Break caught: a change of an order whose price is fixed (it is a request), a price of the page's own in the proposal, or a request that does not say who decides it.
  test('an officer asks to change who pays, and a senior officer decides it on the page of the change', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/orders/${FIRST.id}`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1)],
      permissions: ['hub.read', 'pricing.read', 'pricing.correction.create'],
    });
    await expect(page.getByRole('heading', { level: 1, name: FIRST.code })).toBeVisible();
    await expect(page.getByText('Fixed price')).toBeVisible();
    // The price is fixed: the order is not changed here, who pays is a request.
    await expect(page.getByRole('link', { name: 'Change this order' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Change who pays' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('radio', { name: 'The sender pays all of it' }).check();
    await dialog.getByLabel(/Why should it change\?/).fill('The vendor will pay on the phone');
    await dialog.getByRole('button', { name: 'Ask for the change' }).click();
    await expect(
      page.getByText(/The change was asked for\. A senior officer decides it\./),
    ).toBeVisible();
    const request = made(api, 'POST', `/orders/${FIRST.id}/payer-correction`)[0];
    expect(request?.body).toEqual({
      proposed: { payer_intent: 'SENDER_PAYS_FULL' },
      note: 'The vendor will pay on the phone',
    });
    expect(request?.ifMatch).toBe('"o1"');

    // The change is found again by its own page; an account that may not decide is told who does.
    await page.getByRole('link', { name: 'Open the correction' }).click();
    await expect(page.getByText('A senior officer decides this.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    // Another officer, on another day or another device: the change is read from the server, and is decided there. The officer who asked does not decide it (the test after this one).
    api.world.principal = IDS.checker;
    api.world.permissions.push('pricing.correction.approve');
    await page.reload();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, approve' }).click();
    await expect(page.getByText('The change was approved.')).toBeVisible();
    await expect(page.getByText('What the approval did')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    expect(api.world.corrections[0]?.state).toBe('APPROVED');
    expect(
      made(api, 'POST', `/payer-corrections/${api.world.corrections[0]?.id ?? ''}/decision`),
    ).toHaveLength(1);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('the checker’s queue lists what waits, in the server’s amounts, and the menu leads to it', async ({
    page,
  }) => {
    const { api } = await open(page, '/', {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1)],
      permissions: [
        'hub.read',
        'pricing.read',
        'pricing.correction.create',
        'pricing.correction.approve',
      ],
      corrections: [
        {
          id: '0f0f0f0f-0000-4000-8000-000000000001',
          orderId: FIRST.id,
          state: 'REQUESTED',
          intent: 'SENDER_PAYS_FULL',
          note: 'The vendor pays by phone',
          version: 1,
          requestedBy: IDS.checker,
        },
      ],
    });
    await menuEntry(page, 'Who pays').click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Changes of who pays' }),
    ).toBeFocused();
    const table = page.getByRole('table', { name: 'Changes of who pays' });
    await expect(table.getByText(FIRST.code)).toBeVisible();
    await expect(
      table.getByText('The sender pays GH₵35.00 and the recipient pays GH₵0.00.'),
    ).toBeVisible();
    await page.getByRole('button', { name: new RegExp(`Open the change: ${FIRST.code}`) }).click();
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Yes, approve' }).click();
    await expect(page.getByText('The change was approved.')).toBeVisible();
    expect(api.world.corrections[0]?.state).toBe('APPROVED');
    expect(api.world.orders[0]?.sender).toBe(3500);
  });
});

test.describe('changing an order that is not confirmed', () => {
  const EARLY = storedOrder(2, { status: 'EARLY_QUOTE', size: 'SMALL', price: 3500 });
  // The orders of the world are fresh for each test: the stand-in changes them.
  const early = () => storedOrder(2, { status: 'EARLY_QUOTE', size: 'SMALL', price: 3500 });

  // Break caught: the whole order sent for a one-field change, a change made with no reason, a save that is not on the terms read, and a landing that does not say the order was changed.
  test('only what was changed is sent, with the reason, and the officer lands on the order told it was changed', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/orders/${EARLY.id}/amend`, {
      vendorState: 'ITEMIZING',
      orders: [storedOrder(1), early()],
    });
    await expect(
      page.getByRole('heading', { level: 1, name: `Change order ${EARLY.code}` }),
    ).toBeVisible();
    await expect(page.getByLabel('Recipient’s name')).toHaveValue('Ama Mensah');
    await page.getByRole('radio', { name: 'Large' }).check();
    await page
      .getByLabel(/Why are you changing this order\?/)
      .fill('The parcel is bigger than its photo showed');
    // The price of the change comes by itself, beside the one the order holds now; the reason is the save's, never the price's.
    await expect(page.getByText('Price it holds now')).toBeVisible();
    await expect(page.getByText('GH₵50.00').first()).toBeVisible();
    expect(made(api, 'POST', `/orders/${EARLY.id}/amendment-preview`).at(-1)?.body).toEqual({
      size_class: 'LARGE',
    });

    await page.getByRole('button', { name: 'Save the change at GH₵50.00' }).click();
    await expect(page).toHaveURL(`/orders/${EARLY.id}`);
    await expect(page.getByText(`Order ${EARLY.code} was changed.`)).toBeVisible();
    // The order is read again as it now stands, with the change in its history and no word of the values.
    await expect(
      page.getByText('Fixed price').or(page.getByText('Calculated price (not fixed)')),
    ).toBeVisible();
    await expect(page.getByText('Changed: the size.')).toBeVisible();
    await expect(
      page.getByText(/Reason: The parcel is bigger than its photo showed/),
    ).toBeVisible();
    const save = made(api, 'PATCH', `/orders/${EARLY.id}`)[0];
    expect(save?.ifMatch).toBe('"o1"');
    expect(save?.body).toMatchObject({
      size_class: 'LARGE',
      note: 'The parcel is bigger than its photo showed',
    });
    for (const never of ['recipient', 'lane', 'price', 'total'])
      expect(save?.body).not.toHaveProperty(never);
    // The prompt that asks before leaving a form with unsaved work did not stand in the way of a saved one.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});

/** What a screen is opened with: the world the stand-in starts from, and what the screen says when it is ready. */
interface Screen {
  readonly name: string;
  readonly path: string;
  readonly world: () => Partial<World>;
  readonly ready: (page: Page) => Locator;
  /** What is done on the page before it is read: the review of a price is a state of the form. */
  readonly then?: (page: Page) => Promise<void>;
  /** The refusal the state is made of, as the browser logs it (the status): the one problem of the page that is expected (a price that changed at the save is a refused save). */
  readonly refused?: string;
}

const SENIOR_KEYS = [
  'hub.read',
  'hub.intake.itemize',
  'hub.intake.close',
  'hub.intake.close_exception',
  'pricing.read',
  'pickup.read',
  'pricing.correction.create',
  'pricing.correction.approve',
];
const heading = (page: Page, name: string): Locator =>
  page.getByRole('heading', { level: 1, name });
const allMade = (): Partial<World> => ({
  vendorState: 'ITEMIZING',
  orders: [
    storedOrder(1),
    storedOrder(2, { size: 'MEDIUM', price: 4000 }),
    storedOrder(3, { size: 'LARGE', price: 5000 }),
  ],
  permissions: SENIOR_KEYS,
});
const firstMade = (): Partial<World> => ({
  vendorState: 'ITEMIZING',
  orders: [storedOrder(1)],
  permissions: SENIOR_KEYS,
});

const SCREENS: readonly Screen[] = [
  {
    // The first view (the vendors waiting for a first order) is empty here and says where the others are.
    name: 'the queue of the vendors with orders to make, with nothing waiting',
    path: '/orders-to-make',
    world: allMade,
    ready: (page) => page.getByText(/Vendors whose orders are being made are under Being worked\./),
  },
  {
    // A table where it fits and a card for each vendor where it does not: the vendor is found by its name, in whichever it is drawn.
    name: 'the queue of the vendors with orders to make, with a vendor being worked',
    path: '/orders-to-make',
    world: allMade,
    ready: (page) => page.getByRole('main').getByText('Kente Crafts').first(),
    then: async (page) => {
      await page.getByRole('tab', { name: 'Being worked' }).click();
    },
  },
  {
    name: 'the orders of a vendor',
    path: ORDERS,
    world: firstMade,
    ready: (page) => heading(page, 'Orders for Kente Crafts'),
  },
  {
    name: 'an order',
    path: `/orders/${FIRST.id}`,
    world: firstMade,
    ready: (page) => heading(page, FIRST.code),
  },
  {
    name: 'the checker’s queue',
    path: '/payer-corrections',
    world: () => ({
      ...firstMade(),
      corrections: [
        {
          id: '0f0f0f0f-0000-4000-8000-000000000001',
          orderId: FIRST.id,
          state: 'REQUESTED',
          intent: 'SENDER_PAYS_FULL',
          note: 'The vendor pays by phone',
          version: 1,
          requestedBy: IDS.checker,
        },
      ],
    }),
    ready: (page) => heading(page, 'Changes of who pays'),
  },
  {
    name: 'the close of a vendor',
    path: `/intakes/${VENDOR}/close`,
    world: allMade,
    ready: (page) => heading(page, 'Close Kente Crafts'),
  },
  {
    name: 'the summary of a closed vendor',
    path: `/intakes/${VENDOR}/summary`,
    world: () => ({ ...allMade(), vendorState: 'CLOSED' }),
    ready: (page) => heading(page, 'Summary for Kente Crafts'),
  },
  {
    name: 'the closes that left work',
    path: '/closed-vendors',
    world: allMade,
    ready: (page) => heading(page, 'Closed with parcels left'),
  },
  {
    name: 'the change of an order that is not confirmed',
    path: `/orders/${EARLY_ID}/amend`,
    world: () => ({
      ...firstMade(),
      orders: [
        storedOrder(1),
        storedOrder(2, { status: 'EARLY_QUOTE', size: 'SMALL', price: 3500 }),
      ],
    }),
    ready: (page) => heading(page, 'Change order ACC-OR-4HJ5KM'),
  },
  {
    name: 'the form of an order',
    path: NEW_ORDER,
    world: firstMade,
    ready: (page) => heading(page, 'Make an order for parcel 2'),
  },
  {
    // The price beside the form is what an officer reads most carefully before the one save.
    name: 'the form of an order with its price beside it',
    path: NEW_ORDER,
    world: firstMade,
    ready: (page) => page.getByRole('button', { name: /^Save the order at / }),
    then: async (page) => {
      await expect(heading(page, 'Make an order for parcel 2')).toBeVisible();
      await fillIn(page);
    },
  },
  {
    // The price changed under the officer's hand: the old figure beside the new, and a save that says the new one.
    name: 'the form of an order after its price changed at the save',
    path: NEW_ORDER,
    world: () => ({ ...firstMade(), repriceOnce: 5500 }),
    refused: '409',
    ready: (page) => page.getByRole('button', { name: 'Save at GH₵55.00' }),
    then: async (page) => {
      await expect(heading(page, 'Make an order for parcel 2')).toBeVisible();
      await fillIn(page);
      await page.getByRole('button', { name: /^Save the order at / }).click();
    },
  },
  {
    name: 'an order with the correction of its recipient open',
    path: `/orders/${FIRST.id}`,
    world: firstMade,
    ready: (page) => page.getByRole('alertdialog'),
    then: async (page) => {
      await page.getByRole('button', { name: 'Correct the recipient' }).click();
    },
  },
  {
    // One change of who pays, with the decision to be made by a checker.
    name: 'one change of who pays',
    path: '/payer-corrections/0f0f0f0f-0000-4000-8000-000000000001',
    world: () => ({
      ...firstMade(),
      corrections: [
        {
          id: '0f0f0f0f-0000-4000-8000-000000000001',
          orderId: FIRST.id,
          state: 'REQUESTED',
          intent: 'SENDER_PAYS_FULL',
          note: 'The vendor pays by phone',
          version: 1,
          requestedBy: IDS.checker,
        },
      ],
    }),
    // The page of a change is the checker's queue with the change open: the heading is the queue's, and the change is there by the decision it waits for.
    ready: (page) => page.getByRole('button', { name: 'Approve' }),
  },
];

test.describe('the screens at the verified widths', () => {
  for (const viewport of VIEWPORTS) {
    for (const screen of SCREENS) {
      // Break caught: a screen that scrolls sideways, cuts a label off, or has a WCAG 2.2 A or AA violation. One test for each screen and width, so that a screen that loads slowly (the development server serves every
      // module of a page on its own) is judged on its own and never on the time the others took.
      test(`${screen.name} has no violation, no sideways scrolling and no cut-off control at ${String(viewport.width)} px`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport);
        const { api, watch } = await open(page, screen.path, screen.world());
        await screen.then?.(page);
        await expect(screen.ready(page)).toBeVisible();
        expect(await wcagViolations(page)).toEqual([]);
        expect(await overflowOf(page), 'it scrolls sideways').toBeLessThanOrEqual(0);
        expect(await clippedControls(page), 'a control is cut off').toEqual([]);
        await expectNoTableScrollsSideways(page);
        await expect(page.getByText(DIAGNOSTIC)).toHaveCount(0);
        expect(api.unexpected).toEqual([]);
        // The one refusal a state is made of is expected, and nothing else.
        expect(
          watch.problems.filter(
            (problem) => screen.refused === undefined || !problem.includes(screen.refused),
          ),
        ).toEqual([]);
      });
    }
  }
});

/** The least space the acts that follow what a page says keep above them, in pixels: the token `--space-3`, the gap of a thumb. */
const LEAST_SPACE_ABOVE_ACTS = 12;

/** How far below the element above them the acts are drawn, in pixels. */
const spaceAboveTheActs = (acts: Locator): Promise<number> =>
  acts.evaluate((element) => {
    const above = element.previousElementSibling;
    return above === null
      ? Number.NaN
      : element.getBoundingClientRect().top - above.getBoundingClientRect().bottom;
  });

// Break caught (found by looking at the pictures of Run F; the checks of text and of axe cannot see a gap): the acts that follow the facts of a record or the note of a page, in a flow that spaces nothing, drawn
// against the line above them, so that the buttons of a decision touched the last fact.
test.describe('the buttons that follow what a page says', () => {
  test('the buttons that decide a change of who pays do not touch the facts above them', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/payer-corrections/${CORRECTION_ID}`, {
      ...firstMade(),
      corrections: [
        {
          id: CORRECTION_ID,
          orderId: FIRST.id,
          state: 'REQUESTED',
          intent: 'SENDER_PAYS_FULL',
          note: 'The vendor pays by phone',
          version: 1,
          requestedBy: IDS.checker,
        },
      ],
    });
    await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    expect(await spaceAboveTheActs(page.locator('.orders-saved__acts'))).toBeGreaterThanOrEqual(
      LEAST_SPACE_ABOVE_ACTS,
    );
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('the way back under the note of an order that cannot be changed does not touch the note', async ({
    page,
  }) => {
    const { api, watch } = await open(page, `/orders/${FIRST.id}/amend`, firstMade());
    await expect(page.locator('.orders-saved__acts')).toBeVisible();
    expect(await spaceAboveTheActs(page.locator('.orders-saved__acts'))).toBeGreaterThanOrEqual(
      LEAST_SPACE_ABOVE_ACTS,
    );
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });

  test('the buttons of a vendor closed with parcels left do not touch the note above them', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/closed-vendors', allMade());
    await page.getByRole('button', { name: /^Open the vendor: / }).click();
    const acts = page.getByRole('dialog').locator('.orders-saved__acts');
    await expect(acts).toBeVisible();
    expect(await spaceAboveTheActs(acts)).toBeGreaterThanOrEqual(LEAST_SPACE_ABOVE_ACTS);
    expect(api.unexpected).toEqual([]);
    expect(watch.problems).toEqual([]);
  });
});
