import type { Locator, Page } from '@playwright/test';

import { expect, test } from './support/guarded-test';
import {
  IDS,
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
 * The order screens (S1.40) in a real browser: from the queue of the vendors with orders to make to the first order (the price checked before anything is saved), a price that changes while the officer looks, the
 * close of a vendor and its summary, a change of an order that is not confirmed, and a request to change who pays with the checker's decision. What jsdom cannot show is here: the layout at the verified widths
 * with axe (WCAG 2.2 A and AA), no sideways scrolling at 320 px, the form and the review by keyboard alone, and the picture beside the form really drawn.
 *
 * **The API is a stateful stand-in that keeps what the API keeps** (`support/orders-api.ts`): the vendor's version moves with every order, so a save on an older read is refused; the price is the stand-in's
 * server's and the page sends none (a save is on the digest of the terms that were read, and a price that changed meanwhile answers the terms as they are now); a key makes an order once; a change of who pays is
 * a request a checker decides. Every request is recorded as the browser sent it.
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
const DIAGNOSTIC = 'Diagnostic text that must never reach a screen.';

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
  // Break caught: a vendor that cannot be found again from the queue, an order form that works the price out itself or saves before the officer has read it, a save with no key or no version, or a parcel without its photo.
  test('from the queue to a saved order: the price is checked first, and the save is on the terms that were read', async ({
    page,
  }) => {
    const { api, watch } = await open(page, '/orders-to-make');
    await expect(page.getByRole('heading', { level: 1, name: 'Orders to make' })).toBeVisible();
    await page.getByRole('button', { name: 'Make orders for Kente Crafts' }).click();
    await page.getByRole('link', { name: 'Make orders', exact: true }).click();

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
    await page.getByRole('button', { name: 'Check the price' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Check the order' })).toBeVisible();
    await expect(page.getByText('GH₵40.00').first()).toBeVisible();
    // Nothing is saved until the officer confirms, and what was sent to check carries no price of the page's own.
    expect(made(api, 'POST', `/hub-intakes/${VENDOR}/orders`)).toHaveLength(0);
    const preview = made(api, 'POST', `/hub-intakes/${VENDOR}/orders/preview`)[0]?.body as Record<
      string,
      unknown
    >;
    expect(preview).toMatchObject({ size_class: 'MEDIUM', lane: 'DOORSTEP' });
    for (const never of ['price', 'total', 'zone', 'locked_price', 'reviewed_terms'])
      expect(preview).not.toHaveProperty(never);

    await page.getByRole('button', { name: 'Confirm the order' }).click();
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

  // Break caught: an order saved at a price the officer did not read; the earlier figure lost; a second confirmation that does not name the new figure; an order made twice.
  test('a price that changed while the officer looked is shown beside the old one and confirmed again', async ({
    page,
  }) => {
    const { api, watch } = await open(page, NEW_ORDER, { repriceOnce: 4500 });
    await fillIn(page);
    await page.getByRole('button', { name: 'Check the price' }).click();
    await expect(page.getByText('GH₵40.00').first()).toBeVisible();
    await page.getByRole('button', { name: 'Confirm the order' }).click();

    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'The terms changed while you were looking' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Price: GH₵40.00 before, GH₵45.00 now.');
    expect(api.world.orders).toHaveLength(0);
    await page.getByRole('button', { name: 'Confirm at GH₵45.00' }).click();

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

  // Break caught: a form that cannot be completed without a pointer, a review that takes focus nowhere, or a saved order that leaves the officer to look for what happened.
  test('the form, the review and the save can all be done from the keyboard, and focus follows the officer', async ({
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

    const check = page.getByRole('button', { name: 'Check the price' });
    await tabTo(page, check);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Check the order' })).toBeVisible();

    const confirm = page.getByRole('button', { name: 'Confirm the order' });
    await tabTo(page, confirm);
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
    await page.getByRole('button', { name: 'Check the price' }).click();
    await page.getByRole('button', { name: 'Confirm the order' }).click();
    await expect(page.getByText(/^Order ACC-OR-2CD3FG is saved\.$/)).toBeVisible();
    await page.getByRole('link', { name: 'Make the next order' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 2' }),
    ).toBeVisible();
    await fillIn(page, 'Medium');
    await page.getByRole('button', { name: 'Check the price' }).click();
    await page.getByRole('button', { name: 'Confirm the order' }).click();
    await expect(page.getByText(/^Order ACC-OR-4HJ5KM is saved\.$/)).toBeVisible();
    await page.getByRole('link', { name: 'Make the next order' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Make an order for parcel 3' }),
    ).toBeVisible();
    await fillIn(page, 'Large');
    await page.getByRole('button', { name: 'Check the price' }).click();
    await expect(page.getByText('GH₵50.00').first()).toBeVisible();
    await page.getByRole('button', { name: 'Confirm the order' }).click();
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
        /A senior officer can close with parcels still to order\. Ask one to open this page\./,
      ),
    ).toBeVisible();
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

    // A senior officer, on another day or another device: the change is read from the server, and is decided there.
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
    await page.getByRole('button', { name: 'Check the price' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Check the order' })).toBeVisible();
    await expect(page.getByText('Price it holds now')).toBeVisible();
    await expect(page.getByText('GH₵50.00').first()).toBeVisible();
    expect(made(api, 'POST', `/orders/${EARLY.id}/amendment-preview`)[0]?.body).toEqual({
      size_class: 'LARGE',
    });

    await page.getByRole('button', { name: 'Save the change' }).click();
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
    ready: (page) => heading(page, 'Closed with parcels still to order'),
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
    // The review of the price is the screen an officer reads most carefully.
    name: 'the review of a price',
    path: NEW_ORDER,
    world: firstMade,
    ready: (page) => page.getByRole('heading', { level: 2, name: 'Check the order' }),
    then: async (page) => {
      await expect(heading(page, 'Make an order for parcel 2')).toBeVisible();
      await fillIn(page);
      await page.getByRole('button', { name: 'Check the price' }).click();
    },
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
        expect(watch.problems).toEqual([]);
      });
    }
  }
});
