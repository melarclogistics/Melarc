import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  json,
  type FakeApi,
  type Handler,
} from '../../../test-support/fake-api';
import { INTAKE_HUB_ID, preCountFixture } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  blindRow,
  captured,
  capturedRefusal,
  EXPECTED_PARCEL,
  NEW_TOKEN,
  ORDER_ID,
  PARCELS,
  parcelRow,
  termsOf,
  TOKEN,
  VENDOR_ID,
  worklistOf,
  progressOf,
  orderOf,
} from '../../../test-support/orders-fixture';
import { MANIFEST_ID } from '../../../test-support/manifest-fixture';
import {
  blindVendorFixture,
  checkInFixture,
  EVIDENCE_LIMITS,
  parcelFixture,
  photoLinkHandlers,
  runFixture,
} from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { PRICE_DEBOUNCE_MS, SAVE_GUARD_MS } from './use-order-flow';

/**
 * `/intakes/{id}/orders/new` (`previewOrder` then `itemizeOrder`; S1.40; AC-SLICE-001-47 to 59, 90, 104). **An order is made for one parcel with its photo beside the form, and the price is beside the form by
 * itself** (D-S7-2): once what is entered is complete the server works out what saving gives, the officer reads it, and the one save is made on the digest of exactly those terms. Each break named below is one
 * these tests catch.
 *
 * The price comes a moment after the last key by design (`PRICE_DEBOUNCE_MS`), so a test that waits for it waits for that moment and a little more: `PRICE_WAIT` is the debounce and two seconds, the one wait of
 * these tests that is longer than a `findBy`'s own.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const KEYS = ['hub.read', 'hub.intake.itemize', 'hub.intake.close', 'pricing.read'];
const PREVIEW = `POST /hub-intakes/${VENDOR_ID}/orders/preview`;
const SAVE = `POST /hub-intakes/${VENDOR_ID}/orders`;
const RECORD = `GET /hub-intakes/${VENDOR_ID}`;
const LIST = `GET /hub-intakes/${VENDOR_ID}/orders`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|terms_token|token)\b/i;
const FIRST_PARCEL = PARCELS[0]?.id ?? '';
const SAVED = (id: string) => ({
  ...orderOf('frozen'),
  id,
  code: 'ACC-OR-2CD3FG',
  intake_parcel_id: PARCELS[0]?.id,
});

const PRICE_WAIT = { timeout: PRICE_DEBOUNCE_MS + 2000 };
/** The one save as soon as its price is on the screen: *Save the order at GH₵35.00*, with the moment in which a press is ignored still open. */
const pricedSaveAtOnce = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /^Save the order at / }, PRICE_WAIT);
/** The one save once its price is on the screen and the moment in which a press is ignored has passed (the clock is held, and moved on here: a price that has just appeared is not pressed by a finger that meant the button before it). */
const pricedSave = async (): Promise<HTMLElement> => {
  const button = await pricedSaveAtOnce();
  clock += SAVE_GUARD_MS + 1;
  return button;
};
const pause = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * The save at a changed price ignores a press for a moment, measured on the monotonic clock (\`performance.now\`). A test holds that clock still, so that "at once" is at once however slow the machine is, and
 * moves it on by hand when the moment has passed.
 */
let clock = 0;
function holdTheClock(): void {
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
}

let api: FakeApi;
// Every test holds the clock: a price that appears opens a moment in which a press is ignored (OB-S1-170a), measured on the monotonic clock, and a test moves it on by hand, as a finger that waits does.
beforeEach(() => {
  holdTheClock();
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handlers: Record<string, Handler> = {},
  path = `/intakes/${VENDOR_ID}/orders/new?parcel=${FIRST_PARCEL}`,
  keys: readonly string[] = KEYS,
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [RECORD]: () =>
        json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' }), { ETag: '"v1"' }),
      [PREVIEW]: () => json(200, termsOf()),
      [LIST]: () =>
        json(
          200,
          worklistOf([parcelRow(2, 'NEEDS_ORDER')], { needs_order: 1, itemized: 2, orders: 2 }),
        ),
      ...photoLinkHandlers(PARCELS),
      ...handlers,
    }),
  );
  return renderApp(path);
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}` === route,
  );
const bodyOf = async (request: Request | undefined): Promise<Record<string, unknown>> =>
  request === undefined ? {} : ((await request.clone().json()) as Record<string, unknown>);
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(
      screen
        .getAllByRole('alert')
        .some((alert) =>
          typeof text === 'string'
            ? alert.textContent.includes(text)
            : text.test(alert.textContent),
        ),
    ).toBe(true);
  });
  const found = screen
    .getAllByRole('alert')
    .find((alert) =>
      typeof text === 'string' ? alert.textContent.includes(text) : text.test(alert.textContent),
    );
  if (found === undefined) throw new Error('no alert');
  return found;
};

type User = ReturnType<typeof renderApp>['user'];

/** Fills what the officer knows of the parcel in front of them, and judges its size. */
async function fillIn(user: User, size = 'Medium'): Promise<void> {
  await user.type(await screen.findByLabelText(/Recipient’s name/), 'Ama Mensah');
  await user.type(screen.getByLabelText(/Recipient’s phone/), '024 123 4567');
  await user.type(screen.getByLabelText(/Delivery address/), '12 Madina Estate, near the market');
  await user.click(screen.getByRole('radio', { name: size }));
}

describe('making an order, and checking the price first', () => {
  // Break caught: an order saved without the officer having read the price; a body that carries a price, a total or a zone of the page's own; a save that is not on the digest of the terms read; a save with no key or no version.
  it('checks the price, shows what the server worked out, and saves on exactly those terms', async () => {
    const { user } = open({
      [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
    await fillIn(user);

    // The price is beside the form by itself, with nothing pressed, and it is the server's: the price, its parts, where it goes, the date, who pays and what that means.
    expect(await screen.findByRole('heading', { level: 2, name: 'The price' })).toBeVisible();
    expect(await pricedSave()).toHaveTextContent('Save the order at GH₵35.00');
    // What was typed is one line above the save, for the officer to read before pressing it.
    expect(
      screen.getByText(/Ama Mensah · 024 123 4567 · 12 Madina Estate, near the market · Medium/),
    ).toBeVisible();
    expect(screen.getAllByText('GH₵35.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Delivery inside our area')).toBeVisible();
    expect(
      screen.getByText(/The order is confirmed when you save it, and the price is fixed\./),
    ).toBeVisible();
    expect(
      screen.getByText(/The sender pays nothing, so nothing is charged to the vendor\./),
    ).toBeVisible();
    // Nothing has been saved yet.
    expect(sent(SAVE)).toHaveLength(0);
    const previewBody = await bodyOf(sent(PREVIEW)[0]);
    expect(previewBody).toMatchObject({
      parcel_id: PARCELS[0]?.id,
      size_class: 'MEDIUM',
      lane: 'DOORSTEP',
      is_high_value: false,
    });
    expect(previewBody).not.toHaveProperty('reviewed_terms');
    for (const never of [
      'price',
      'total',
      'total_minor',
      'zone',
      'zone_id',
      'destination_zone_snapshot',
      'locked_price',
      'margin',
      'surcharge',
    ]) {
      expect(previewBody).not.toHaveProperty(never);
    }

    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();

    const request = sent(SAVE)[0];
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bodyOf(request)).toMatchObject({
      reviewed_terms: TOKEN,
      parcel_id: PARCELS[0]?.id,
      size_class: 'MEDIUM',
    });
    // The order that was just made opens from the saved screen by what it opens, not by a bare Open (Run G1, Part 2, item 11).
    expect(screen.getByRole('link', { name: 'Open this order' })).toHaveAttribute(
      'href',
      '/orders/11111111-2222-4333-8444-555555555555',
    );
    // After a save the way on is the next parcel, with what is left counted by the server. A vendor with door photos has its parcels to show the order on: nothing is said of a code to write on one.
    expect(screen.getByRole('link', { name: 'Make the next order' })).toBeVisible();
    expect(screen.queryByText('Write this code on the parcel.')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'The last orders of this vendor' })).toBeNull();
    expect(screen.getByText('1 parcel needs an order.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: a number that does not look right refused by the form (the server judges it, and the officer may know better than a pattern), or guidance that stays after the number is right.
  it('tells an officer, while a number is typed, that it does not look like a Ghana number, and refuses nothing', async () => {
    const { user } = open();
    const phone = await screen.findByLabelText(/Recipient’s phone/);
    await user.type(phone, '12345');
    expect(await screen.findByText(/This doesn’t look like a Ghana number\./)).toBeVisible();
    expect(phone).not.toBeInvalid();
    await user.clear(phone);
    await user.type(phone, '024 123 4567');
    expect(screen.queryByText(/This doesn’t look like a Ghana number\./)).toBeNull();
    expect(screen.getByText('As the recipient gave it, for example 024 123 4567.')).toBeVisible();
  });

  // Break caught: a size chosen for the officer (a default that becomes the answer by inertia), or a form that goes on without one.
  it('chooses no size for the officer and does not go on without one', async () => {
    const { user } = open();
    await user.type(await screen.findByLabelText(/Recipient’s name/), 'Ama Mensah');
    await user.type(screen.getByLabelText(/Recipient’s phone/), '024 123 4567');
    await user.type(screen.getByLabelText(/Delivery address/), '12 Madina Estate');
    for (const radio of within(
      screen.getByRole('group', { name: /Size of the parcel/ }),
    ).getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
    await user.click(screen.getByRole('button', { name: 'Save the order' }));
    expect(await screen.findByText('Choose the size of the parcel.')).toBeVisible();
    expect(sent(PREVIEW)).toHaveLength(0);
  });

  // Break caught: a carrier's charge asked for a parcel that goes to the door, or the third-party fields left out for a parcel that goes by a carrier.
  it('asks for the carrier’s charge and a photo of the waybill only for a parcel sent by a carrier outside our area', async () => {
    const { user } = open({ 'GET /evidence-limits': () => json(200, EVIDENCE_LIMITS) });
    await screen.findByLabelText(/Recipient’s name/);
    expect(screen.queryByLabelText(/The carrier’s charge \(GH₵\)/)).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Sent by a carrier outside our area' }));
    expect(await screen.findByLabelText(/The carrier’s charge \(GH₵\)/)).toBeVisible();
    expect(screen.getByText('Photo of the waybill')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'To the recipient’s door' }));
    expect(screen.queryByLabelText(/The carrier’s charge \(GH₵\)/)).toBeNull();
  });
});

describe('a price that appears while the officer taps (Run G1, Part 2, item 10; OB-S1-170a)', () => {
  // Break caught: a double tap that straddles the moment a price first appears (the first tap on the button that says the price is being checked, which does nothing, the second on the save that now says it) saving a price
  // that may not have been read: the moment in which a press is ignored is at every appearance of a price, not only after a price that changed at the save.
  it('ignores a press in the moment after a price first appears, and saves when it is pressed again', async () => {
    const { user } = open({
      [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
    });
    await fillIn(user);
    await user.click(await pricedSaveAtOnce());
    await pause(100);
    expect(sent(SAVE)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^Save the order at / })).toBeVisible();

    clock += SAVE_GUARD_MS + 1;
    await user.click(await pricedSaveAtOnce());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)).toHaveLength(1);
  });

  // Break caught: the moment opened only for the first price of the page: the price of entries the officer changed after the first is as new as the first, and a press at once is as much a second tap.
  it('opens the moment again for the price of entries that changed', async () => {
    let previews = 0;
    const { user } = open({
      [PREVIEW]: () => {
        previews += 1;
        return json(
          200,
          termsOf({}, previews === 1 ? 3500 : 4000, previews === 1 ? TOKEN : NEW_TOKEN),
        );
      },
      [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
    });
    await fillIn(user);
    await pricedSave();
    // The officer changes the size while the first price is on the screen: a new price comes, and a press at once is ignored.
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    await user.click(
      await screen.findByRole('button', { name: 'Save the order at GH₵40.00' }, PRICE_WAIT),
    );
    await pause(100);
    expect(sent(SAVE)).toHaveLength(0);
    clock += SAVE_GUARD_MS + 1;
    await user.click(screen.getByRole('button', { name: 'Save the order at GH₵40.00' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)).toHaveLength(1);
  });
});

describe('a price that changes while the officer looks', () => {
  /** The save answers that the price moved on the first press, and saves on the second. */
  const movesThenSaves = (): Handler => {
    let saves = 0;
    return () => {
      saves += 1;
      return saves === 1
        ? json(409, {
            code: 'STATE_CONFLICT',
            message: 'Diagnostic text that must never reach a screen.',
            request_id: 'r1',
            details: { rule: 'terms_changed', current_terms: termsOf({}, 4000, NEW_TOKEN) },
          })
        : json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' });
    };
  };

  // Break caught: an order saved on a price the officer did not read; the earlier figure lost; the new figure drawn where the focus is not, so that the button that says it is pressed unread; entries lost.
  it('shows the new price beside the old with the focus on it, offers the save again at the new figure, and keeps what was entered', async () => {
    holdTheClock();
    const { user } = open({ [SAVE]: movesThenSaves() });
    await fillIn(user);
    await user.click(await pricedSave());

    const warning = await alertSaying('The terms changed while you were looking');
    expect(warning.textContent).toContain('Price: GH₵35.00 before, GH₵40.00 now.');
    // The portions of who pays moved with the price, and nobody changed who pays: it is not said.
    expect(warning.textContent).not.toContain('Who pays has changed');
    // The officer is asked to save at the new figure, not the old one, and the new figure is read first: the price beside the form has the focus.
    expect(await screen.findByRole('button', { name: 'Save at GH₵40.00' })).toBeVisible();
    const price = screen.getByRole('region', { name: 'The price' });
    expect(price).toContainElement(warning);
    expect(price).toContainElement(document.activeElement as HTMLElement);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    expect(sent(SAVE)).toHaveLength(1);
    // What was entered is kept.
    expect(screen.getByLabelText(/Recipient’s name/)).toHaveValue('Ama Mensah');
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();

    clock += SAVE_GUARD_MS + 1;
    await user.click(screen.getByRole('button', { name: 'Save at GH₵40.00' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)).toHaveLength(2);
    // The second save is on the new terms.
    expect(await bodyOf(sent(SAVE)[1])).toMatchObject({ reviewed_terms: NEW_TOKEN });
    // Nothing the officer entered was asked for again: one preview, and the save carried the same size.
    expect(sent(PREVIEW)).toHaveLength(1);
    expect(await bodyOf(sent(SAVE)[1])).toMatchObject({ size_class: 'MEDIUM' });
  });

  // Break caught (D-S7-2): the save at the new figure pressed by the second tap of a double-tap meant for the first button, which would save a price nobody read.
  it('ignores a press in the moment after the price changed, and saves when it is pressed again', async () => {
    holdTheClock();
    const { user } = open({ [SAVE]: movesThenSaves() });
    await fillIn(user);
    await user.click(await pricedSave());
    const again = await screen.findByRole('button', { name: 'Save at GH₵40.00' });

    // The second tap of the same finger, at once: nothing is sent, and the button is still there for a press that is meant.
    await user.click(again);
    await pause(100);
    expect(sent(SAVE)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save at GH₵40.00' })).toBeVisible();

    clock += SAVE_GUARD_MS + 1;
    await user.click(screen.getByRole('button', { name: 'Save at GH₵40.00' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)).toHaveLength(2);
  });

  // Break caught: the entries lost when the hub's prices are being changed, or an alert that does not say nothing was saved and what to do.
  it('says the hub’s prices are being changed, keeps the form and checks the price again on one press', async () => {
    let previews = 0;
    const { user } = open({
      [PREVIEW]: () => {
        previews += 1;
        return json(
          200,
          termsOf({}, previews === 1 ? 3500 : 3600, previews === 1 ? TOKEN : NEW_TOKEN),
        );
      },
      [SAVE]: () =>
        json(409, {
          code: 'STATE_CONFLICT',
          message: 'Diagnostic text that must never reach a screen.',
          request_id: 'r2',
          details: { rule: 'configuration_changing' },
        }),
    });
    await fillIn(user);
    await user.click(await pricedSave());

    const alert = await alertSaying('The hub’s prices are being changed');
    expect(alert.textContent).toContain('nothing was saved');
    await user.click(screen.getByRole('button', { name: 'Check the price again' }));

    // The same entries are checked again, and the new figure is the one the officer is asked to save at, in the save itself.
    await waitFor(() => {
      expect(sent(PREVIEW)).toHaveLength(2);
    });
    expect(await bodyOf(sent(PREVIEW)[1])).toEqual(await bodyOf(sent(PREVIEW)[0]));
    expect((await screen.findAllByText('GH₵36.00')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Save the order at GH₵36.00' })).toBeVisible();
  });

  // Break caught: a vendor that changed under the officer shown as a failure that loses the form; a retry that is not one press.
  it('tells a vendor that changed, reads it again for its version, and checks the price again', async () => {
    let saves = 0;
    let reads = 0;
    const { user } = open({
      [RECORD]: () => {
        reads += 1;
        return json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' }), {
          ETag: reads === 1 ? '"v1"' : '"v2"',
        });
      },
      [SAVE]: () => {
        saves += 1;
        return saves === 1
          ? json(409, {
              code: 'STATE_CONFLICT',
              message: 'Diagnostic text that must never reach a screen.',
              request_id: 'r3',
              details: { rule: 'stale' },
            })
          : json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' });
      },
    });
    await fillIn(user);
    await user.click(await pricedSave());
    await alertSaying('This vendor changed while you were working');
    await user.click(screen.getByRole('button', { name: 'Check the price again' }));
    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    // The second save is made on the version read again.
    expect(sent(SAVE)[1]?.headers.get('If-Match')).toBe('"v2"');
  });

  // Break caught (the flow's own race): the price that proved wrong still on the screen, and its save pressable, while the vendor is read again, so that a press in that moment saves on the old version and the old figure.
  it('takes the price off the screen while the vendor is read again, so that nothing is saved on what proved wrong', async () => {
    let reads = 0;
    let saves = 0;
    let release: (() => void) | undefined;
    const { user } = open({
      [RECORD]: () => {
        reads += 1;
        const body = checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' });
        return reads === 1
          ? json(200, body, { ETag: '"v1"' })
          : new Promise<Response>((resolve) => {
              release = () => {
                resolve(json(200, body, { ETag: '"v2"' }));
              };
            });
      },
      [SAVE]: () => {
        saves += 1;
        return saves === 1
          ? json(409, {
              code: 'STATE_CONFLICT',
              message: 'Diagnostic text that must never reach a screen.',
              request_id: 'r3',
              details: { rule: 'stale' },
            })
          : json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' });
      },
    });
    await fillIn(user);
    await user.click(await pricedSave());
    await alertSaying('This vendor changed while you were working');
    await user.click(screen.getByRole('button', { name: 'Check the price again' }));

    // The vendor is being read again: the price is off the screen and the save says so and cannot be pressed.
    expect(await screen.findByRole('button', { name: 'Checking the price…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Save the order at / })).toBeNull();
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    release?.();

    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)).toHaveLength(2);
    expect(sent(SAVE)[1]?.headers.get('If-Match')).toBe('"v2"');
  });
});

describe('the next order of a vendor', () => {
  // Break caught: the next order saved on the version of the vendor read before the first one was made. The first order of a vendor moves it from ready to being worked, so its version moves with it, and the second
  // order was refused as stale: the officer had to check the price again for nothing, on the commonest path there is.
  it('is made on a fresh read of the vendor, so that it is not refused as stale', async () => {
    let reads = 0;
    let saves = 0;
    const { user } = open({
      [RECORD]: () => {
        reads += 1;
        return json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' }), {
          ETag: reads === 1 ? '"v1"' : '"v2"',
        });
      },
      [SAVE]: () => {
        saves += 1;
        return json(
          201,
          SAVED(
            saves === 1
              ? '11111111-2222-4333-8444-555555555555'
              : '22222222-3333-4444-8555-666666666666',
          ),
          {
            ETag: '"o1"',
          },
        );
      },
    });
    await fillIn(user);
    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)[0]?.headers.get('If-Match')).toBe('"v1"');

    await user.click(screen.getByRole('link', { name: 'Make the next order' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 2' }),
    ).toBeVisible();
    await fillIn(user);
    await user.click(await pricedSave());
    await waitFor(() => {
      expect(sent(SAVE)).toHaveLength(2);
    });
    // The second order is on the version the vendor has now, and nothing of it was refused.
    expect(sent(SAVE)[1]?.headers.get('If-Match')).toBe('"v2"');
    expect(screen.queryByText(/This vendor changed while you were working/)).toBeNull();
  });

  // Break caught: "Make the next order" of a vendor counted without photos that leads to the page it is on (its address never names a parcel), so that the saved screen stayed and no next form came.
  it('is a fresh form for a vendor counted without photos, and not the screen of the order just saved', async () => {
    let saves = 0;
    const { user } = open(
      {
        [RECORD]: () =>
          json(
            200,
            {
              ...preCountFixture({ id: VENDOR_ID }),
              state: 'ITEMIZING',
              count_phase: 'POST_COUNT',
              rider_declared_count: 3,
              physical_count: 3,
              count_variance: 'MATCH',
              count_difference: 0,
              condition: 'OK',
              condition_findings: [],
              parcel_photo_ids: [],
            },
            { ETag: '"v1"' },
          ),
        [`GET /receiving-runs/${MANIFEST_ID}`]: () =>
          json(200, runFixture([blindVendorFixture({ intake_id: VENDOR_ID })])),
        [LIST]: () =>
          json(
            200,
            worklistOf(
              [blindRow(1)],
              { received: 3, needs_order: 2, itemized: 1, orders: 1, awaiting_arrival: 0 },
              { receiving_mode: 'BLIND_COUNT' },
            ),
          ),
        [SAVE]: () => {
          saves += 1;
          return json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' });
        },
      },
      `/intakes/${VENDOR_ID}/orders/new`,
    );
    await fillIn(user);
    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();

    await user.click(screen.getByRole('link', { name: 'Make the next order' }));
    // The form is there again, empty, for the next place; the screen of the order just saved is gone.
    expect(await screen.findByLabelText(/Recipient’s name/)).toHaveValue('');
    expect(screen.queryByText('Order ACC-OR-2CD3FG is saved.')).toBeNull();
    expect(saves).toBe(1);
  });
});

describe('after an order of a vendor counted without photos (D-S7-3, Run F)', () => {
  const CODES = ['2CD3FG', '4HJ5KM', '6NP7QR', '8STVWX', '9ABCDE', 'FGHJKM', 'NPQRST'];
  /** The nth order of the vendor, with a code and a recipient of its own (the shared row has three codes and then repeats the last). */
  const orderRow = (n: number) => ({
    ...blindRow(n),
    order: {
      ...blindRow(n).order,
      code: `ACC-OR-${CODES[n - 1] ?? '2CD3FG'}`,
      recipient_name: `Recipient ${String(n)}`,
    },
  });
  const COUNTS = { received: 9, needs_order: 2, itemized: 7, orders: 7, awaiting_arrival: 0 };
  const BLIND = { receiving_mode: 'BLIND_COUNT' };

  function openBlind(listing: Handler) {
    return open(
      {
        [RECORD]: () =>
          json(
            200,
            {
              ...preCountFixture({ id: VENDOR_ID }),
              state: 'ITEMIZING',
              count_phase: 'POST_COUNT',
              rider_declared_count: 9,
              physical_count: 9,
              count_variance: 'MATCH',
              count_difference: 0,
              condition: 'OK',
              condition_findings: [],
              parcel_photo_ids: [],
            },
            { ETag: '"v1"' },
          ),
        [`GET /receiving-runs/${MANIFEST_ID}`]: () =>
          json(200, runFixture([blindVendorFixture({ intake_id: VENDOR_ID })])),
        [LIST]: listing,
        [SAVE]: () =>
          json(
            201,
            { ...SAVED('11111111-2222-4333-8444-555555555555'), code: 'ACC-OR-NPQRST' },
            { ETag: '"o1"' },
          ),
      },
      `/intakes/${VENDOR_ID}/orders/new`,
    );
  }

  // Break caught: a saved order that does not say what goes on the parcel (the officer copies a code from a small line), a place in the count taken from the page and not from the server, or a list that is not the last orders
  // (the list is oldest first and paged: the first five, or the last five of the first page, are not the last).
  it('shows the code large with what to do with it, where the vendor stands, and the last five orders, read to the end of the pages', async () => {
    const { user } = openBlind((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('view') !== 'all') {
        return json(200, worklistOf([orderRow(1)], COUNTS, BLIND));
      }
      return url.searchParams.get('page_token') === null
        ? json(
            200,
            worklistOf([1, 2, 3].map(orderRow), COUNTS, {
              ...BLIND,
              next_page_token: 'second-page',
            }),
          )
        : json(200, worklistOf([4, 5, 6, 7].map(orderRow), COUNTS, BLIND));
    });
    await fillIn(user);
    await user.click(await pricedSave());

    expect(await screen.findByText('Order ACC-OR-NPQRST is saved.')).toBeVisible();
    const lead = screen.getByText('Write this code on the parcel.');
    expect(lead).toBeVisible();
    expect(lead.nextElementSibling).toHaveTextContent('ACC-OR-NPQRST');
    // Both numbers are the server's: the orders made and the parcels counted.
    expect(await screen.findByText('Order 7 of 9 for this vendor.')).toBeVisible();

    const heading = screen.getByRole('heading', {
      level: 2,
      name: 'The last orders of this vendor',
    });
    const rows = within(heading.nextElementSibling as HTMLElement).getAllByRole('listitem');
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.textContent)).toEqual([
      'ACC-OR-6NP7QRRecipient 3Small',
      'ACC-OR-8STVWXRecipient 4Small',
      'ACC-OR-9ABCDERecipient 5Small',
      'ACC-OR-FGHJKMRecipient 6Small',
      'ACC-OR-NPQRSTRecipient 7Small',
    ]);
    // The pages were read to the end, a hundred orders to a page.
    const reads = api.requests.filter(
      (request) =>
        request.method === 'GET' &&
        new URL(request.url).pathname === `/api/v1/hub-intakes/${VENDOR_ID}/orders` &&
        new URL(request.url).searchParams.get('view') === 'all',
    );
    expect(reads.map((read) => new URL(read.url).searchParams.get('page_token'))).toEqual([
      null,
      'second-page',
    ]);
    expect(new URL(reads[0]?.url ?? '').searchParams.get('page_size')).toBe('100');
  });

  // Break caught: a saved screen that loses the code (the one thing the officer needs) when the list of the last orders cannot be read.
  it('says the last orders could not be read, and still shows the code and where the vendor stands', async () => {
    const { user } = openBlind((request) =>
      new URL(request.url).searchParams.get('view') === 'all'
        ? refusal(500, 'INTERNAL_ERROR')
        : json(200, worklistOf([orderRow(1)], COUNTS, BLIND)),
    );
    await fillIn(user);
    await user.click(await pricedSave());
    expect(await screen.findByText('The last orders could not be read.')).toBeVisible();
    expect(screen.getByText('Write this code on the parcel.').nextElementSibling).toHaveTextContent(
      'ACC-OR-NPQRST',
    );
    expect(await screen.findByText('Order 7 of 9 for this vendor.')).toBeVisible();
  });
});

describe('a refusal and an outcome nobody knows', () => {
  // Break caught: a refusal about one field told as a banner, the field not marked, or the server's own words drawn.
  it('tells a refusal on the field it is about, in the floor’s words, and shows no price', async () => {
    const { user } = open({
      [PREVIEW]: () =>
        json(422, {
          code: 'VALUE_DECLARATION_REQUIRED',
          message: 'Diagnostic text that must never reach a screen.',
          request_id: 'r4',
          details: { rule: 'declaration_required' },
        }),
    });
    await fillIn(user);
    await user.type(screen.getByLabelText(/Declared value/), '900');
    expect(
      await screen.findByText(
        /A value this high needs the sender’s agreement to the liability limit/,
        {},
        PRICE_WAIT,
      ),
    ).toBeVisible();
    expect(screen.getByLabelText(/Declared value/)).toBeInvalid();
    // No price is shown, and the save cannot be pressed on one: the fields say what to change.
    expect(screen.queryByRole('button', { name: /^Save the order at / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save the order' })).toBeDisabled();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: an unknown outcome told as a refusal (the officer makes the order twice), or a retry that is under another key.
  it('keeps everything when nobody knows whether the order was saved, and tries again under the same key', async () => {
    let saves = 0;
    const { user } = open({
      [SAVE]: () => {
        saves += 1;
        if (saves === 1) throw new TypeError('Failed to fetch');
        return json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' });
      },
    });
    await fillIn(user);
    await user.click(await pricedSave());
    await alertSaying('We could not tell whether the order was saved');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)).toHaveLength(2);
    expect(sent(SAVE)[1]?.headers.get('Idempotency-Key')).toBe(
      sent(SAVE)[0]?.headers.get('Idempotency-Key'),
    );
  });
});

describe('an address that matches more than one zone', () => {
  // Break caught: a zone chosen for the officer, or sent without the reason, or kept for an address it was not chosen for.
  it('offers the zones the server named, asks why this one, and sends the choice with the reason', async () => {
    let previews = 0;
    const { user } = open({
      [PREVIEW]: () => {
        previews += 1;
        const refusalBody = capturedRefusal('preview-zone-choice');
        return previews === 1
          ? json(refusalBody.status, refusalBody.body)
          : json(200, termsOf({ destination_zone_resolution: 'EXPLICITLY_AUTHORIZED' }));
      },
    });
    await fillIn(user);
    // The zones come by themselves, with the price that could not be given.
    const group = await screen.findByRole('group', { name: /Which zone is it\?/ }, PRICE_WAIT);
    for (const radio of within(group).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Accra Central' })).toBeVisible();
    expect(within(group).getByRole('radio', { name: 'Tema' })).toBeVisible();

    // No zone is sent until one is chosen with its reason: the save says what is missing.
    await user.click(screen.getByRole('button', { name: 'Save the order' }));
    expect(await screen.findByText('Choose the zone.')).toBeVisible();
    expect(sent(PREVIEW)).toHaveLength(1);
    await user.click(within(group).getByRole('radio', { name: 'Tema' }));
    await user.click(screen.getByRole('button', { name: 'Save the order' }));
    expect(await screen.findByText('Say why you chose this zone.')).toBeVisible();
    await user.type(screen.getByLabelText(/Why this zone/), 'The market is in Tema');

    // With the zone and the reason the price comes by itself, for exactly what was chosen.
    expect(await pricedSave()).toBeVisible();
    expect(screen.getByText('Zone chosen by you')).toBeVisible();
    const second = await bodyOf(sent(PREVIEW).at(-1));
    expect(second.destination_zone_authorization).toEqual({
      zone_id: '5eed0101-0000-4000-8000-000000000001',
      note: 'The market is in Tema',
    });
    expect(sent(SAVE)).toHaveLength(0);
  });

  // Break caught: a zone chosen for one address kept when the address is changed.
  it('forgets the zone chosen when the address is changed', async () => {
    const { user } = open({
      [PREVIEW]: () => {
        const refusalBody = capturedRefusal('preview-zone-choice');
        return json(refusalBody.status, refusalBody.body);
      },
    });
    await fillIn(user);
    await screen.findByRole('group', { name: /Which zone is it\?/ }, PRICE_WAIT);
    await user.type(screen.getByLabelText(/Delivery address/), ' Tema');
    expect(screen.queryByRole('group', { name: /Which zone is it\?/ })).toBeNull();
  });
});

describe('an address no zone matches (Run G1, Part 2, item 5; D-S7-5)', () => {
  const ZONES = `GET /hub-intakes/${VENDOR_ID}/destination-zones`;
  const unresolved = () => {
    const refusalBody = capturedRefusal('preview-zone-unresolved');
    return json(refusalBody.status, refusalBody.body);
  };
  const GROUP = /Which zone is it\?/;

  // Break caught: an address no zone matches that leaves an officer who knows the zone with nothing to do but reword the address; the zones of the hub not offered, or offered with one chosen for the officer, or sent without
  // the reason; a choice that does not take the focus or is not announced when it appears; and the order saved without the zone it was priced with.
  it('offers the hub’s zones with the reason, takes the focus to the choice and says it is there, and prices and saves with the zone the officer chose', async () => {
    let previews = 0;
    const { user } = open({
      [PREVIEW]: () => {
        previews += 1;
        return previews === 1
          ? unresolved()
          : json(200, termsOf({ destination_zone_resolution: 'EXPLICITLY_AUTHORIZED' }));
      },
      [ZONES]: () => json(200, captured('destination-zones')),
      [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
    });
    await fillIn(user);
    const group = await screen.findByRole('group', { name: GROUP }, PRICE_WAIT);
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => (radio as HTMLInputElement).labels?.[0]?.textContent)).toEqual([
      'Accra Central',
      'Amasaman & Environs',
      'Dansoman',
      'Kasoa Corridor',
      'Lapaz/Sowutuom',
      'Madina/Adenta',
      'Tema',
    ]);
    for (const radio of radios) expect(radio).not.toBeChecked();
    // It says what the matter is, in its own words, and not the old ones that asked for more of the address.
    const said = screen.getAllByText(
      /The address does not match a zone of this hub\. Choose the zone/,
    );
    // Once in the section, to be read, and once in the live region that says the choice is there.
    expect(said).toHaveLength(2);
    expect(said.filter((element) => element.closest('[role="status"]') !== null)).toHaveLength(1);
    expect(screen.queryByText(/Add the area or a landmark/)).toBeNull();
    // The focus is on the choice, so that nobody has to hunt for it at the bottom of a form two screens tall.
    expect(radios[0]).toHaveFocus();
    expect(sent(ZONES)).toHaveLength(1);

    // Nothing is chosen for the officer: the save says what is missing, then the price comes by itself for the zone and the reason.
    await user.click(screen.getByRole('button', { name: 'Save the order' }));
    expect(await screen.findByText('Choose the zone.')).toBeVisible();
    await user.click(within(group).getByRole('radio', { name: 'Madina/Adenta' }));
    await user.type(screen.getByLabelText(/Why this zone/), 'The sender said it is in Adenta');
    expect(await pricedSave()).toBeVisible();
    expect(await bodyOf(sent(PREVIEW).at(-1))).toMatchObject({
      destination_zone_authorization: {
        zone_id: '5eed0101-0000-4000-8000-000000000004',
        note: 'The sender said it is in Adenta',
      },
    });
    await user.click(await pricedSave());
    await screen.findByText('Order ACC-OR-2CD3FG is saved.');
    expect((await bodyOf(sent(SAVE)[0])).destination_zone_authorization).toEqual({
      zone_id: '5eed0101-0000-4000-8000-000000000004',
      note: 'The sender said it is in Adenta',
    });
  });

  // Break caught: the choice and its reason kept for an address they were not made for, so that an order is priced in a zone nobody chose for it; the hub's zones read again for each address typed.
  it('forgets the zone chosen when the address is changed, and offers the zones again for the new address without reading them again', async () => {
    const { user } = open({
      [PREVIEW]: unresolved,
      [ZONES]: () => json(200, captured('destination-zones')),
    });
    await fillIn(user);
    const group = await screen.findByRole('group', { name: GROUP }, PRICE_WAIT);
    await user.click(within(group).getByRole('radio', { name: 'Tema' }));
    await user.type(screen.getByLabelText(/Why this zone/), 'Near the harbour');
    await user.type(screen.getByLabelText(/Delivery address/), ' Tema');
    expect(screen.queryByRole('group', { name: GROUP })).toBeNull();
    const again = await screen.findByRole('group', { name: GROUP }, PRICE_WAIT);
    for (const radio of within(again).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.getByLabelText(/Why this zone/)).toHaveValue('');
    expect(sent(ZONES)).toHaveLength(1);
  });

  // Break caught: a hub whose zones cannot be read (a refusal, a fault, no zone at all) that leaves the officer with a form that says nothing, or one that loses what was typed: the address says what to do, as it did.
  it.each([
    ['a fault', () => json(503, { code: 'SERVICE_UNAVAILABLE', message: 'x', request_id: 'r1' })],
    [
      'a refusal',
      () => json(403, { code: 'PERMISSION_DENIED', message: 'x', request_id: 'r1', details: {} }),
    ],
    ['a hub with no zone', () => json(200, { items: [] })],
  ])(
    'tells the address what to do, as it did, when the zones cannot be read: %s',
    async (_name, answer) => {
      const { user } = open({ [PREVIEW]: unresolved, [ZONES]: answer });
      await fillIn(user);
      expect(
        await screen.findByText(
          /The address does not match a zone of this hub, so the order cannot be priced\. Add the area or a landmark/,
          undefined,
          PRICE_WAIT,
        ),
      ).toBeVisible();
      expect(screen.queryByRole('group', { name: GROUP })).toBeNull();
      expect(screen.getByLabelText(/Delivery address/)).toHaveValue(
        '12 Madina Estate, near the market',
      );
    },
  );

  // Break caught: a save that meets an address no zone matches, where the hub's zones cannot be read, that is told as nothing, or as a success: the refusal is told as it always was, with the entries kept.
  it('tells the address what to do when the save meets an address no zone matches and the zones cannot be read', async () => {
    const { user } = open({
      [ZONES]: () => json(503, { code: 'SERVICE_UNAVAILABLE', message: 'x', request_id: 'r1' }),
      [SAVE]: unresolved,
    });
    await fillIn(user);
    await user.click(await pricedSave());
    expect(await screen.findByText(/Add the area or a landmark to the address/)).toBeVisible();
    expect(screen.queryByRole('group', { name: GROUP })).toBeNull();
    expect(screen.getByLabelText(/Delivery address/)).toHaveValue(
      '12 Madina Estate, near the market',
    );
    expect(sent(SAVE)).toHaveLength(1);
  });

  // Break caught: a save that meets an address no zone matches any more (the hub's aliases moved since the check) told as a failure that throws the officer's entries away, instead of the offer of the zones.
  it('offers the zones when the save is the one that meets an address no zone matches', async () => {
    const { user } = open({
      [ZONES]: () => json(200, captured('destination-zones')),
      [SAVE]: unresolved,
    });
    await fillIn(user);
    await user.click(await pricedSave());
    const group = await screen.findByRole('group', { name: GROUP });
    expect(within(group).getAllByRole('radio')).toHaveLength(7);
    expect(screen.getByLabelText(/Delivery address/)).toHaveValue(
      '12 Madina Estate, near the market',
    );
    expect(sent(SAVE)).toHaveLength(1);
  });
});

describe('a vendor with nothing to order', () => {
  it('says so, with the way back, for a vendor that is closed', async () => {
    open({
      [RECORD]: () =>
        json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'CLOSED' }), { ETag: '"v1"' }),
    });
    expect(
      await screen.findByText('This vendor is closed, so no more orders can be made for it.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to the orders' })).toBeVisible();
  });

  it('goes to the first parcel that needs an order when no parcel is named, and says so when none does', async () => {
    open(
      { [LIST]: () => json(200, worklistOf([parcelRow(2, 'NEEDS_ORDER')], { needs_order: 1 })) },
      `/intakes/${VENDOR_ID}/orders/new`,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 2' }),
    ).toBeVisible();
  });

  it('says every parcel has an order when none needs one', async () => {
    open(
      { [LIST]: () => json(200, worklistOf([], { needs_order: 0 })) },
      `/intakes/${VENDOR_ID}/orders/new`,
    );
    expect(await screen.findByText('Every parcel that arrived has an order.')).toBeVisible();
  });

  // Break caught: the count of a vendor counted blind that is not committed drawn as nothing to order.
  it('says the count is awaited for a vendor counted without photos whose count is not recorded', async () => {
    open(
      {
        [RECORD]: () => json(200, preCountFixture({ id: VENDOR_ID }), { ETag: '"v1"' }),
        // A vendor counted without photos is named by its run, which the page reads once to say the vendor’s name.
        [`GET /receiving-runs/${MANIFEST_ID}`]: () =>
          json(200, runFixture([blindVendorFixture({ intake_id: VENDOR_ID })])),
      },
      `/intakes/${VENDOR_ID}/orders/new`,
    );
    expect(
      await screen.findByText(
        'The count has not been recorded yet, so orders cannot be made for this vendor.',
      ),
    ).toBeVisible();
  });
});

describeInterfaceStates('the form of an order', {
  loading: {
    test: async () => {
      open({ [RECORD]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the vendor…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A form has no list that can be empty: a vendor with nothing to order is told in words (the tests above).',
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await user.click(await screen.findByRole('button', { name: 'Save the order' }));
      expect(await screen.findByText('Enter the recipient’s name.')).toBeVisible();
      expect(screen.getByLabelText(/Recipient’s name/)).toBeInvalid();
    },
  },
  error: {
    test: async () => {
      open({ [RECORD]: () => refusal(500, 'INTERNAL_ERROR') });
      expect(await screen.findByRole('alert')).toBeVisible();
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [RECORD]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' }), {
                ETag: '"v1"',
              });
        },
      });
      await user.click(await screen.findByRole('button', { name: /Try again|Retry/ }));
      expect(await screen.findByLabelText(/Recipient’s name/)).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open({
        [SAVE]: () =>
          json(409, {
            code: 'STATE_CONFLICT',
            message: 'x',
            request_id: 'r5',
            details: { rule: 'stale' },
          }),
      });
      await fillIn(user);
      await user.click(await pricedSave());
      await alertSaying('This vendor changed while you were working');
    },
  },
  success: {
    test: async () => {
      const { user } = open({
        [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
      });
      await fillIn(user);
      await user.click(await pricedSave());
      expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({}, `/intakes/${VENDOR_ID}/orders/new?parcel=${FIRST_PARCEL}`, ['hub.read']);
      expect(
        await screen.findByText(
          /Your account can’t make orders for the parcels received at a hub\./,
        ),
      ).toBeVisible();
    },
  },
});

// The captured answers are what the tests above are made of: a test that reaches for one that is not there fails here and not in a page.
describe('the captured answers', () => {
  it('are the API’s: the order it saved is the one the form reads', () => {
    expect(captured('order-saved')).toHaveProperty('code');
    expect(progressOf().orders).toBe(1);
  });
});

describe('a refusal of the parcel or of the vendor (Run F, Part 2, items 5 and 11)', () => {
  // Break caught: every conflict of a save told as "This vendor changed while you were working", with "Check the price again" as the only way on, when the refusal is about the parcel (it has an order, it is
  // missing, the check-in is open, no place is left): the words of the rule, and the way back to the orders.
  it('tells a refusal about the parcel in its own words, and offers no second check of the price', async () => {
    const { user } = open({
      [SAVE]: () =>
        json(409, {
          code: 'STATE_CONFLICT',
          message: 'Diagnostic text that must never reach a screen.',
          request_id: 'r9',
          details: { rule: 'parcel_ordered' },
        }),
    });
    await fillIn(user);
    await user.click(await pricedSave());
    await alertSaying('This parcel already has an order. Open the orders to see it.');
    expect(screen.queryByText(/This vendor changed while you were working/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check the price again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the orders' })).toBeVisible();
  });

  // Break caught (Run G1, Part 2, item 8): a refusal that removes the save (the parcel has its order) told in an alert at the top of a form that is two screens tall at 768 px, while the save was at the foot and was
  // replaced by a link: nothing says why the button is gone, and the focus, which was on the button, is lost. It is told next to the save, once, and takes the focus.
  it('tells a refusal that removes the save next to where the save was, once, and moves the focus to it', async () => {
    const { user } = open({
      [SAVE]: () =>
        json(409, {
          code: 'STATE_CONFLICT',
          message: 'Diagnostic text that must never reach a screen.',
          request_id: 'r9',
          details: { rule: 'parcel_ordered' },
        }),
    });
    await fillIn(user);
    await user.click(await pricedSave());
    const alert = await alertSaying('This parcel already has an order. Open the orders to see it.');
    // Once: not in the alerts above the form as well as beside the save.
    expect(
      screen.getAllByText('This parcel already has an order. Open the orders to see it.'),
    ).toHaveLength(1);
    // The one alert of the page: the top of the form has none of it.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const beside = alert.closest('[data-refusal]');
    expect(beside).not.toBeNull();
    // Where the save was: in the same row of actions as the way back.
    expect(beside?.parentElement).toContainElement(
      screen.getByRole('link', { name: 'Back to the orders' }),
    );
    await waitFor(() => {
      expect(beside).toHaveFocus();
    });
  });

  // Break caught (Run G1, Part 2, item 8): a save that cannot be pressed because the price could not be checked, with nothing beside it that says so (the explanation is in the price column, which at 768 px is a screen
  // above the save).
  it('says beside the save, when the price could not be checked, why it cannot be pressed yet', async () => {
    const { user } = open({
      [PREVIEW]: () => errorResponse(500, 'INTERNAL_ERROR'),
    });
    await fillIn(user);
    await screen.findByText('The price could not be checked.', {}, PRICE_WAIT);
    const why = screen.getByText(
      'The price could not be checked, so the order cannot be saved yet.',
    );
    const save = screen.getByRole('button', { name: 'Save the order' });
    expect(save).toBeDisabled();
    expect(save.getAttribute('aria-describedby')?.split(' ')).toContain(why.id);
    expect(why.parentElement).toContainElement(save);
  });

  // Break caught: a form for an arrived parcel, or for no parcel in particular, while the vendor's check-in is open: the officer fills it in and the save is refused as check_in_open.
  it('says the check-in is open before the officer fills in a form for a parcel that is here', async () => {
    open(
      {
        [RECORD]: () =>
          json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'AWAITING_COUNT' }), {
            ETag: '"v1"',
          }),
      },
      `/intakes/${VENDOR_ID}/orders/new`,
    );
    expect(
      await screen.findByText(/The vendor is still being checked in, so the parcels that are here/),
    ).toBeVisible();
    expect(screen.queryByLabelText(/Recipient’s name/)).toBeNull();
  });
});

describe('what the officer sees when a save is refused or its outcome is not known (Run F, Part 2, items 6 and 7)', () => {
  // Break caught: "Look at the orders" after an outcome nobody knows that throws the held command away and checks the price again (the officer is back at a form with nothing to say whether the order was made); it opens the
  // vendor's orders, sends nothing, and only "Try again" sends the save again.
  it('opens the vendor’s orders from "Look at the orders", and checks no price again', async () => {
    const { user } = open({
      [SAVE]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await fillIn(user);
    await user.click(await pricedSave());
    await alertSaying('We could not tell whether the order was saved');
    const look = screen.getByRole('link', { name: 'Look at the orders' });
    expect(look).toHaveAttribute('href', `/intakes/${VENDOR_ID}/orders`);
    await user.click(look);
    // The form holds what was entered: leaving it is asked, and the officer says yes.
    await user.click(await screen.findByRole('button', { name: 'Leave the page' }));
    // The form is gone: the officer is on the vendor's orders, and nothing was sent but the one save that was lost.
    await waitFor(() => {
      expect(screen.queryByLabelText(/Recipient’s name/)).toBeNull();
    });
    expect(sent(PREVIEW)).toHaveLength(1);
    expect(sent(SAVE)).toHaveLength(1);
  });

  // Break caught: a save refused about a field that left the officer with no message (the old review hid the field behind it): the error is on the field in the floor's words, and the field has the focus.
  it('brings the form back with the error on the field and the field in focus when a save is refused about one', async () => {
    const { user } = open({
      [SAVE]: () =>
        json(422, {
          code: 'VALUE_DECLARATION_REQUIRED',
          message: 'Diagnostic text that must never reach a screen.',
          request_id: 'r7',
          details: { rule: 'declaration_required' },
        }),
    });
    await fillIn(user);
    await user.type(screen.getByLabelText(/Declared value/), '900');
    await user.click(await pricedSave());
    expect(
      await screen.findByText(
        /A value this high needs the sender’s agreement to the liability limit/,
      ),
    ).toBeVisible();
    expect(screen.getByLabelText(/Declared value/)).toBeInvalid();
    await waitFor(() => {
      expect(screen.getByLabelText(/Declared value/)).toHaveFocus();
    });
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: the zones an address matched when the order was saved (the hub's aliases moved since the check) read as no more than "something went wrong": the officer is offered the choice, as the check offers it.
  it('offers the zones an address matches at the save, and sends no order', async () => {
    const { user } = open({
      [SAVE]: () => {
        const refusalBody = capturedRefusal('preview-zone-choice');
        return json(refusalBody.status, refusalBody.body);
      },
    });
    await fillIn(user);
    await user.click(await pricedSave());
    const group = await screen.findByRole('group', { name: /Which zone is it\?/ });
    expect(within(group).getByRole('radio', { name: 'Tema' })).toBeVisible();
    // The save was refused, so no order was made: the form is still there, and no saved screen.
    expect(screen.queryByText(/is saved\./)).toBeNull();
    expect(sent(SAVE)).toHaveLength(1);
  });
});

describe('a price check that could not be made (Run G1, Part 2, item 1)', () => {
  /** The first check fails the way the test says, and every later one is priced. */
  const failsThenPrices = (first: () => Response | Promise<Response>): Handler => {
    let asked = 0;
    return () => {
      asked += 1;
      return asked === 1 ? first() : json(200, termsOf());
    };
  };
  const tooFast = (): Response =>
    json(
      429,
      {
        code: 'RATE_LIMITED',
        message: 'Diagnostic text that must never reach a screen.',
        request_id: 'r429',
      },
      { 'Retry-After': '1' },
    );

  // Break caught: a form that is stuck after a check that failed for a reason that is no field (the price column telling the officer to look at fields none of which is marked, the save disabled, nothing offering a new
  // check); entries lost; a check that is not made again on one press.
  it.each([
    [
      'a lost connection',
      (): Promise<Response> => Promise.reject(new TypeError('Failed to fetch')),
    ],
    ['a fault of the server', (): Response => errorResponse(500, 'INTERNAL_ERROR')],
  ] as const)(
    'tells %s as what it is, keeps the entries and checks the price again on one press',
    async (_name, first) => {
      const { user } = open({ [PREVIEW]: failsThenPrices(first) });
      await fillIn(user);
      expect(
        await screen.findByText('The price could not be checked.', {}, PRICE_WAIT),
      ).toBeVisible();
      expect(screen.getByText('Your entries are kept.')).toBeVisible();
      // It is no field's fault, and the column does not say it is: nothing is marked, so nothing is pointed at.
      expect(screen.queryByText(/The fields marked say what to change/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Save the order' })).toBeDisabled();
      expect(screen.getByLabelText(/Recipient’s name/)).toHaveValue('Ama Mensah');
      expect(sent(PREVIEW)).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: 'Check the price again' }));
      expect(await pricedSave()).toHaveTextContent('Save the order at GH₵35.00');
      expect(sent(PREVIEW)).toHaveLength(2);
      // The price is on the screen and the way to check again is gone; the entries are as they were.
      expect(screen.queryByText('The price could not be checked.')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Check the price again' })).toBeNull();
      expect(screen.getByLabelText(/Recipient’s name/)).toHaveValue('Ama Mensah');
    },
  );

  // Break caught: a form that waits for the officer after a 429 with nothing to say when the wait is over; a check made at once, inside the wait the server asked for; a check made again and again (a loop of requests
  // into a limit).
  it('checks the price once more by itself when the wait the server asked for is over, and then waits for the officer', async () => {
    const { user } = open({ [PREVIEW]: failsThenPrices(tooFast) });
    await fillIn(user);
    expect(
      await screen.findByText('The price could not be checked.', {}, PRICE_WAIT),
    ).toBeVisible();
    expect(sent(PREVIEW)).toHaveLength(1);
    // Inside the wait nothing is sent; once it is over one new check is, by itself, and it prices.
    expect(
      await screen.findByRole('button', { name: /^Save the order at / }, { timeout: 6000 }),
    ).toBeVisible();
    expect(sent(PREVIEW)).toHaveLength(2);
  }, 15_000);

  it('does not check again by itself a second time: after another 429 it offers the button and sends nothing', async () => {
    const { user } = open({ [PREVIEW]: () => tooFast() });
    await fillIn(user);
    await screen.findByText('The price could not be checked.', {}, PRICE_WAIT);
    await waitFor(
      () => {
        expect(sent(PREVIEW)).toHaveLength(2);
      },
      { timeout: 6000 },
    );
    expect(await screen.findByRole('button', { name: 'Check the price again' })).toBeVisible();
    // The wait of the second 429 passes, and nothing is sent: one new check by itself, and no more.
    await pause(2200);
    expect(sent(PREVIEW)).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Check the price again' })).toBeVisible();
  }, 20_000);

  // Break caught: a price that stays on the screen, pressable, after a field it was worked out for has changed (the save is of the screen, and the figure is the earlier one's).
  it('takes the price off the screen the moment a field changes, and draws the price of the new entries when it comes', async () => {
    let asked = 0;
    const { user } = open({
      [PREVIEW]: () => {
        asked += 1;
        return json(200, asked === 1 ? termsOf() : termsOf({}, 4000, NEW_TOKEN));
      },
    });
    await fillIn(user);
    expect(await pricedSave()).toHaveTextContent('Save the order at GH₵35.00');
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    // At once: no price of the medium parcel is on the screen to press, and the save says the price is being checked.
    expect(screen.queryByRole('button', { name: /^Save the order at / })).toBeNull();
    expect(screen.getByRole('button', { name: 'Checking the price…' })).toBeDisabled();
    expect(await pricedSave()).toHaveTextContent('Save the order at GH₵40.00');
  });

  // Break caught: the price of what was entered a moment ago drawn for what is entered now (the figure on the screen is the price of the screen).
  it('throws away the answer to what was entered before, when a field changed while the check waited', async () => {
    const waiting: ((response: Response) => void)[] = [];
    const { user } = open({
      [PREVIEW]: () =>
        new Promise<Response>((resolve) => {
          waiting.push(resolve);
        }),
    });
    await fillIn(user);
    await waitFor(() => {
      expect(waiting).toHaveLength(1);
    }, PRICE_WAIT);
    // The officer changes the size while the first check is out; then the first answer, for the medium parcel, arrives.
    await user.click(screen.getByRole('radio', { name: 'Large' }));
    waiting[0]?.(json(200, termsOf()));
    await pause(100);
    // It is not drawn: the screen is no medium parcel's.
    expect(screen.queryByRole('button', { name: /^Save the order at / })).toBeNull();
    // The check for what is on the screen is made, and its answer is the one drawn.
    await waitFor(() => {
      expect(waiting).toHaveLength(2);
    }, PRICE_WAIT);
    expect(await bodyOf(sent(PREVIEW)[1])).toMatchObject({ size_class: 'LARGE' });
    waiting[1]?.(json(200, termsOf({}, 4000, NEW_TOKEN)));
    expect(await pricedSave()).toHaveTextContent('Save the order at GH₵40.00');
  });
});

describe('the screen after an order is saved offers only what the server would take (Run G1, Part 2, item 2)', () => {
  const EARLY = EXPECTED_PARCEL.id;
  const SAVED_EARLY = {
    ...orderOf('frozen'),
    id: '33333333-4444-4555-8666-777777777777',
    code: 'ACC-OR-2CD3FG',
    intake_parcel_id: EARLY,
  };
  /** A vendor whose check-in is still open, with a parcel that is not here yet: the order made for it waits for its parcel. */
  const checkInOpen = (left: number) => ({
    [RECORD]: () =>
      json(
        200,
        checkInFixture([...PARCELS, EXPECTED_PARCEL], { id: VENDOR_ID, state: 'AWAITING_COUNT' }),
        { ETag: '"v1"' },
      ),
    [LIST]: () =>
      json(200, worklistOf([], { needs_order: left, awaiting_arrival: 1, orders: 1, itemized: 0 })),
    [SAVE]: () => json(201, SAVED_EARLY, { ETag: '"o1"' }),
    ...photoLinkHandlers([...PARCELS, EXPECTED_PARCEL]),
  });

  // Break caught: a saved screen that offers "Make the next order" for a vendor whose check-in is still open when no parcel is left that is not here yet (it opens "The vendor is still being checked in…", a dead end) and
  // "Close this vendor" to a senior who cannot close it yet; the way back to the orders missing. (When a parcel is left that is not here yet the next order is offered: Run G2, Part 2, item 1.)
  it.each([
    ['with parcels that arrived and have no order', 2],
    ['with nothing left to order', 0],
  ] as const)(
    'offers neither the next order nor the close after an early order of a vendor still being checked in, %s, and offers the way back',
    async (_name, left) => {
      const { user } = open(checkInOpen(left), `/intakes/${VENDOR_ID}/orders/new?parcel=${EARLY}`);
      await fillIn(user);
      await user.click(await pricedSave());
      expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
      // No parcel is left that is not here yet (the list is empty): the screen says so, and what the parcels that are here wait for.
      await screen.findByText(/Every parcel that is not here yet has an order./);
      expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Close this vendor' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Back to the orders' })).toBeVisible();
    },
  );

  // Break caught: the dead ends removed by removing the real ways on too: a cleared vendor with a parcel left that is not offered the next order, a senior with nothing left that is not offered the close, and an
  // officer who cannot close that is offered it.
  it('still offers the next order to a vendor that is cleared with a parcel left, and the close to the one who may close it when none is left', async () => {
    const { user } = open({
      [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555')),
    });
    await fillIn(user);
    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Make the next order' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Close this vendor' })).toBeNull();
  });

  it.each([
    ['holds the key to close', KEYS, true],
    ['does not hold it', ['hub.read', 'hub.intake.itemize', 'pricing.read'], false],
  ] as const)(
    'offers the close of a cleared vendor with nothing left to the officer who %s',
    async (_name, keys, offered) => {
      const { user } = open(
        {
          [LIST]: () => json(200, worklistOf([], { needs_order: 0, orders: 3, itemized: 3 })),
          [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555')),
        },
        undefined,
        keys,
      );
      await fillIn(user);
      await user.click(await pricedSave());
      expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
      expect(await screen.findByText(/Every parcel that arrived has an order/)).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Close this vendor' }) !== null).toBe(offered);
      expect(screen.getByRole('link', { name: 'Back to the orders' })).toBeVisible();
    },
  );
});

describe('the early orders as a loop (Run G2, Part 2, item 1; D-D6, OB-S1-169 item 9)', () => {
  // The vendor's four parcels are not checked in yet (its check-in is open): the first has an order made from its photo, and the third is waited on for the vendor's details.
  const NOT_HERE = [1, 2, 3].map((n) => parcelFixture(n)).concat(EXPECTED_PARCEL);
  const N2 = NOT_HERE[1]?.id ?? '';
  const MARK = { since: '2026-11-24T10:30:00.000Z', note: null };
  const NOT_HERE_ROWS = [
    parcelRow(1, 'PREPARED', { parcelState: 'EXPECTED' }),
    parcelRow(2, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED' }),
    parcelRow(3, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED', waiting: MARK }),
    parcelRow(4, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED' }),
  ];
  const SAVED_EARLY = (parcel: string) => ({
    ...orderOf('early'),
    id: '33333333-4444-4555-8666-777777777777',
    code: 'ACC-OR-4HJ5KM',
    intake_parcel_id: parcel,
  });
  /** The worklist as the server answers it by view: `awaiting_arrival` lists the parcels that are not here yet, with an order or without. */
  const listOf =
    (rows: readonly ReturnType<typeof parcelRow>[]): Handler =>
    () =>
      json(
        200,
        worklistOf(
          rows,
          {
            received: 0,
            awaiting_arrival: rows.length,
            needs_order: 0,
            prepared: rows.filter((row) => row.order !== null).length,
            orders: rows.filter((row) => row.order !== null).length,
            itemized: 0,
            waiting_for_vendor: rows.filter((row) => row.parcel.waiting_for_vendor !== null).length,
          },
          { intake_state: 'AWAITING_COUNT' },
        ),
      );
  const early = (
    path = `/intakes/${VENDOR_ID}/orders/new`,
    rows: readonly ReturnType<typeof parcelRow>[] = NOT_HERE_ROWS,
    more: Record<string, Handler> = {},
  ) =>
    open(
      {
        [RECORD]: () =>
          json(200, checkInFixture(NOT_HERE, { id: VENDOR_ID, state: 'AWAITING_COUNT' }), {
            ETag: '"v1"',
          }),
        [LIST]: listOf(rows),
        ...photoLinkHandlers(NOT_HERE),
        ...more,
      },
      path,
    );
  const listViews = () =>
    sent(LIST).map((request) => new URL(request.url).searchParams.get('view'));

  // Break caught: a form for no parcel that tells the officer to finish the check-in first (a dead end for a vendor whose parcels are not here yet), or one that opens on a parcel that has its order, or on one that is
  // waited on.
  it('opens the form of the first parcel that is not here yet and has no order, passing the one that has an order and the one that is waited on', async () => {
    early();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 2' }),
    ).toBeVisible();
    // It asked the parcels that are not here yet, and not the ones that arrived (there are none to order yet).
    expect(listViews()).toContain('awaiting_arrival');
    expect(listViews()).not.toContain('needs_order');
  });

  // Break caught: the next order that goes back to the lowest parcel, or onto the parcel the officer is waiting on the vendor for.
  it('moves forward from the parcel just saved, and passes over a parcel that is waited on', async () => {
    early(`/intakes/${VENDOR_ID}/orders/new?after=2`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 4' }),
    ).toBeVisible();
  });

  // Break caught: a vendor whose parcels all have an order, or are waited on, told that the check-in must be finished (it is not what is in the way), or sent to a form.
  it('says that every parcel that is not here yet has an order, and what can be done next', async () => {
    early(`/intakes/${VENDOR_ID}/orders/new`, [
      parcelRow(1, 'PREPARED', { parcelState: 'EXPECTED' }),
      parcelRow(2, 'PREPARED', { parcelState: 'EXPECTED' }),
    ]);
    expect(
      await screen.findByText(/Every parcel that is not here yet has an order\./),
    ).toBeVisible();
    expect(screen.getByText(/can be ordered once the check-in is finished/)).toBeVisible();
    expect(screen.queryByLabelText(/Recipient’s name/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the orders' })).toBeVisible();
  });

  it('says that every parcel that is left is waiting for the vendor’s details, and leads to them', async () => {
    early(`/intakes/${VENDOR_ID}/orders/new`, [
      parcelRow(3, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED', waiting: MARK }),
    ]);
    expect(
      await screen.findByText('Every parcel that is left is waiting for the vendor’s details.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'See the parcels that wait' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR_ID}/orders?view=waiting_for_vendor`,
    );
  });

  // Break caught: the saved screen of an early order that leaves the officer at a dead end (Run G1 offered neither the next order nor the close while the check-in is open), so that the loop is a trip back to the
  // list for each parcel; or one that offers the close to a vendor that is still being checked in; or that does not say what the order waits for.
  it('after an early order offers the next parcel that is not here yet, and never the close', async () => {
    const { user } = early(`/intakes/${VENDOR_ID}/orders/new?parcel=${N2}`, undefined, {
      [SAVE]: () => json(201, SAVED_EARLY(N2), { ETag: '"o1"' }),
    });
    await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 2' });
    await fillIn(user);
    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-4HJ5KM is saved.')).toBeVisible();
    // What the order waits for, and when it is confirmed.
    expect(
      await screen.findByText(/The order waits for its parcel\. It is confirmed/),
    ).toBeVisible();
    // Forward from parcel 2, passing parcel 3 that is waited on: parcel 4.
    const next = screen.getByRole('link', { name: 'Make the next order' });
    expect(next).toHaveAttribute('href', `/intakes/${VENDOR_ID}/orders/new?after=2`);
    expect(screen.queryByRole('link', { name: 'Close this vendor' })).toBeNull();
    await user.click(next);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 4' }),
    ).toBeVisible();
  });

  it('after the last early order says that every parcel that is not here yet has an order, and offers no next order', async () => {
    // Two parcels that are not here yet: the first has its order, and the second gets its order now, which is the last.
    let rows = [
      parcelRow(1, 'PREPARED', { parcelState: 'EXPECTED' }),
      parcelRow(2, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED' }),
    ];
    const { user } = early(`/intakes/${VENDOR_ID}/orders/new?parcel=${N2}`, undefined, {
      [LIST]: (request) => listOf(rows)(request),
      [SAVE]: () => {
        rows = [
          parcelRow(1, 'PREPARED', { parcelState: 'EXPECTED' }),
          parcelRow(2, 'PREPARED', { parcelState: 'EXPECTED' }),
        ];
        return json(201, SAVED_EARLY(N2), { ETag: '"o1"' });
      },
    });
    await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 2' });
    await fillIn(user);
    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-4HJ5KM is saved.')).toBeVisible();
    expect(
      await screen.findByText(/Every parcel that is not here yet has an order\./),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Close this vendor' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the orders' })).toBeVisible();
  });
});

describe('a parcel the officer is waiting on the vendor’s details for (Run G1, Part 2, item 4; D-S7-12)', () => {
  const [P1, P2] = [PARCELS[0]?.id ?? '', PARCELS[1]?.id ?? ''];
  const MARK = {
    since: '2026-11-24T10:30:00.000Z',
    note: 'Called the vendor, waiting on WhatsApp',
  };
  const WAIT = (parcel: string) => `PUT /intake-parcels/${parcel}/waiting-for-vendor`;
  /** The worklist answers by view, as the server does: the parcels that need an order, or all of them. */
  const listOf =
    (rows: readonly ReturnType<typeof parcelRow>[]): Handler =>
    (request) => {
      const view = new URL(request.url).searchParams.get('view');
      const shown =
        view === 'needs_order' ? rows.filter((row) => row.work_state === 'NEEDS_ORDER') : rows;
      return json(
        200,
        worklistOf(shown, {
          needs_order: rows.filter((row) => row.work_state === 'NEEDS_ORDER').length,
          waiting_for_vendor: rows.filter((row) => row.parcel.waiting_for_vendor !== null).length,
        }),
      );
    };
  const marked = (parcel: string, note: string | null) =>
    json(200, { parcel_id: parcel, waiting: true, since: MARK.since, note });
  const markDialog = async (user: User, note?: string): Promise<HTMLElement> => {
    await user.click(
      await screen.findByRole('button', { name: 'Waiting for the vendor’s details' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    if (note !== undefined) {
      await user.type(within(dialog).getByLabelText(/What you asked, and how/), note);
    }
    return dialog;
  };

  // Break caught: a parcel the officer cannot order yet that has no way to be marked, so that the next officer meets the same parcel; a mark that is not on the vendor's version or that sends a key; a note lost; and the
  // officer left on the form of a parcel that cannot be ordered, or sent back to the lowest parcel and the one just marked.
  it('marks the parcel with the note on the vendor’s version, and goes on to the next parcel that needs an order, passing over one that is waited on', async () => {
    const { user } = open(
      {
        [LIST]: listOf([
          parcelRow(1, 'NEEDS_ORDER'),
          parcelRow(2, 'NEEDS_ORDER', { waiting: MARK }),
          parcelRow(3, 'NEEDS_ORDER'),
        ]),
        [WAIT(P1)]: () => marked(P1, 'Called the vendor'),
      },
      `/intakes/${VENDOR_ID}/orders/new?parcel=${P1}`,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
    const dialog = await markDialog(user, 'Called the vendor');
    await user.click(within(dialog).getByRole('button', { name: 'Mark the parcel' }));
    // On to the next parcel that needs an order after this one: parcel 2 is waited on, so parcel 3.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 3' }),
    ).toBeVisible();
    const request = sent(WAIT(P1))[0];
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toBeNull();
    expect(await bodyOf(request)).toEqual({ waiting: true, note: 'Called the vendor' });
  });

  // Break caught (the security review of the commit before): the dialog is drawn where the order's form holds it, so its submit bubbled to the form and saved the order that was filled and priced behind it, when
  // the officer only meant to mark the parcel. Marking sends the mark and nothing else, by the button and by Enter in the note.
  it.each([
    ['the button', false],
    ['Enter in the note', true],
  ])(
    'marking a parcel on a form that is filled and priced, by %s, saves no order',
    async (_name, byEnter) => {
      const { user } = open(
        {
          [LIST]: listOf([parcelRow(1, 'NEEDS_ORDER'), parcelRow(3, 'NEEDS_ORDER')]),
          [WAIT(P1)]: () => marked(P1, 'Called the vendor'),
          [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
        },
        `/intakes/${VENDOR_ID}/orders/new?parcel=${P1}`,
      );
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 1' });
      await fillIn(user);
      await pricedSave();
      const dialog = await markDialog(user, 'Called the vendor');
      if (byEnter) await user.keyboard('{Enter}');
      else await user.click(within(dialog).getByRole('button', { name: 'Mark the parcel' }));
      // What was typed is not saved by the mark: the guard of the form asks before it is lost, as it does for any way on, and the order is saved by nobody.
      const guard = await screen.findByRole('alertdialog');
      expect(within(guard).getByText('Leave this page?')).toBeVisible();
      expect(sent(WAIT(P1))).toHaveLength(1);
      expect(sent(SAVE)).toHaveLength(0);
      await user.click(within(guard).getByRole('button', { name: 'Leave the page' }));
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 3' });
      expect(sent(WAIT(P1))).toHaveLength(1);
      expect(sent(SAVE)).toHaveLength(0);
    },
  );

  // Break caught: a note that is optional made required, or sent as an empty text.
  it('marks a parcel with no note, and sends none', async () => {
    const { user } = open(
      {
        [LIST]: listOf([parcelRow(1, 'NEEDS_ORDER'), parcelRow(3, 'NEEDS_ORDER')]),
        [WAIT(P1)]: () => marked(P1, null),
      },
      `/intakes/${VENDOR_ID}/orders/new?parcel=${P1}`,
    );
    const dialog = await markDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Mark the parcel' }));
    await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 3' });
    expect(await bodyOf(sent(WAIT(P1))[0])).toEqual({ waiting: true });
  });

  // Break caught: a phone number let into a note the audit would then refuse after the act began, or told as "invalid" with nothing the officer can act on; the dialog closed on a refusal.
  it('refuses a note that holds a number on the note itself, in the words that say what to do, and keeps the dialog and the note', async () => {
    const { status, body } = capturedRefusal('parcel-wait-refused-number');
    const { user } = open(
      {
        [LIST]: listOf([parcelRow(1, 'NEEDS_ORDER')]),
        [WAIT(P1)]: () => json(status, body),
      },
      `/intakes/${VENDOR_ID}/orders/new?parcel=${P1}`,
    );
    const dialog = await markDialog(user, 'the number is 0244123456');
    await user.click(within(dialog).getByRole('button', { name: 'Mark the parcel' }));
    expect(await within(dialog).findByText('Leave the number out of the note.')).toBeVisible();
    expect(within(dialog).getByLabelText(/What you asked, and how/)).toHaveValue(
      'the number is 0244123456',
    );
    expect(
      screen.getByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // Break caught: a parcel that is waited on drawn as any other (the officer cannot see what was asked, or that another officer is on it) and a mark that cannot be taken off.
  it('says that the parcel is waited on, with what was asked, and takes the mark off on one press', async () => {
    let off = false;
    const { user } = open(
      {
        [LIST]: () =>
          listOf([parcelRow(1, 'NEEDS_ORDER', off ? {} : { waiting: MARK })])(
            new Request('http://x/?view=all'),
          ),
        [WAIT(P1)]: () => {
          off = true;
          return json(200, { parcel_id: P1, waiting: false, since: null, note: null });
        },
      },
      `/intakes/${VENDOR_ID}/orders/new?parcel=${P1}`,
    );
    expect(
      await screen.findByText('You are waiting for the vendor’s details for this parcel.'),
    ).toBeVisible();
    expect(screen.getByText('Called the vendor, waiting on WhatsApp')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Take the mark off' }));
    await waitFor(() => {
      expect(
        screen.queryByText('You are waiting for the vendor’s details for this parcel.'),
      ).toBeNull();
    });
    expect(await bodyOf(sent(WAIT(P1))[0])).toEqual({ waiting: false });
    expect(sent(WAIT(P1))[0]?.headers.get('If-Match')).toBe('"v1"');
    // The parcel is the officer's again: the mark can be made again.
    expect(screen.getByRole('button', { name: 'Waiting for the vendor’s details' })).toBeVisible();
  });

  // Break caught: an empty form for a parcel that already has its order (Back to ?parcel=X after saving it): the officer fills it in to be refused at the price.
  it('says that a parcel already has its order, with the code and a link, and draws no form for it', async () => {
    open(
      { [LIST]: listOf([parcelRow(1, 'ITEMIZED')]) },
      `/intakes/${VENDOR_ID}/orders/new?parcel=${P1}`,
    );
    expect(await screen.findByText(/Parcel 1 already has its order, ACC-OR-/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open the order' })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
    expect(screen.getByRole('link', { name: 'Back to the orders' })).toBeVisible();
    expect(screen.queryByLabelText(/Recipient’s name/)).toBeNull();
    expect(sent(PREVIEW)).toHaveLength(0);
  });

  // Break caught: *Make the next order* that reopens the lowest parcel without an order (the one the officer has just marked or passed) instead of moving forward from the parcel just saved, and that stops at a parcel
  // that is waited on.
  it('after an order is saved, moves forward from the parcel just saved and passes over one that is waited on', async () => {
    const { user } = open(
      {
        [LIST]: listOf([parcelRow(1, 'NEEDS_ORDER'), parcelRow(3, 'NEEDS_ORDER')]),
        [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
      },
      `/intakes/${VENDOR_ID}/orders/new?parcel=${P2}`,
    );
    await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 2' });
    await fillIn(user);
    await user.click(await pricedSave());
    await screen.findByText('Order ACC-OR-2CD3FG is saved.');
    // The address too says where to go on from (a link opened in another tab has no click handler to say it).
    expect(screen.getByRole('link', { name: 'Make the next order' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR_ID}/orders/new?after=2`,
    );
    await user.click(screen.getByRole('link', { name: 'Make the next order' }));
    // Not parcel 1, the lowest that still needs an order: parcel 3, the next after the one just saved.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 3' }),
    ).toBeVisible();
  });

  it('goes back to the lowest parcel that needs an order when none is left after this one', async () => {
    open(
      {
        [LIST]: listOf([
          parcelRow(1, 'NEEDS_ORDER'),
          parcelRow(2, 'NEEDS_ORDER', { waiting: MARK }),
        ]),
      },
      `/intakes/${VENDOR_ID}/orders/new?after=3`,
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
  });

  // Break caught: a vendor whose every parcel left is waited on that is sent to a form (or told that every parcel has an order, which is not so).
  it('says every parcel that is left is waiting for the vendor’s details, and leads to them', async () => {
    open(
      { [LIST]: listOf([parcelRow(1, 'NEEDS_ORDER', { waiting: MARK })]) },
      `/intakes/${VENDOR_ID}/orders/new?after=1`,
    );
    expect(
      await screen.findByText('Every parcel that is left is waiting for the vendor’s details.'),
    ).toBeVisible();
    expect(screen.queryByText('Every parcel that arrived has an order.')).toBeNull();
    expect(screen.getByRole('link', { name: 'See the parcels that wait' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR_ID}/orders?view=waiting_for_vendor`,
    );
    expect(screen.queryByLabelText(/Recipient’s name/)).toBeNull();
  });
});

/**
 * Run G2, OB-S1-169 item 10 (D-S7-16): a save is refused because the vendor changed under the officer, and the one press that checks again reads the vendor, and the read fails (a lost connection). The form that was
 * there, and everything typed in it, are still there, with the failure told in a line and a way to ask again; once it is read the save goes through on the version that was read.
 */
describe('a refresh that fails while an officer is typing', () => {
  /** The vendor's read, which answers until the connection is lost and again once it is back (the version moves with each answer). The screen's own read of it is not asked twice, a person does that. */
  const vendorRead = () => {
    const state = { down: false, reads: 0 };
    return {
      state,
      handler: () => {
        if (state.down) return errorResponse(500, 'INTERNAL_ERROR');
        state.reads += 1;
        return json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'ITEMIZING' }), {
          ETag: `"v${String(state.reads)}"`,
        });
      },
    };
  };

  // Break caught: the vendor's read drawn as an error in place of the form, which took the name, the phone, the address and the size with it.
  it('keeps the page and every entry, says in a line that it could not be refreshed, mends with Try again and then saves', async () => {
    const read = vendorRead();
    let saves = 0;
    const { user } = open({
      [RECORD]: read.handler,
      [SAVE]: () => {
        saves += 1;
        return saves === 1
          ? json(409, {
              code: 'STATE_CONFLICT',
              message: 'Diagnostic text that must never reach a screen.',
              request_id: 'r3',
              details: { rule: 'stale' },
            })
          : json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' });
      },
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 1' }),
    ).toBeVisible();
    await fillIn(user);
    const name = screen.getByLabelText(/Recipient’s name/);
    const phone = screen.getByLabelText(/Recipient’s phone/);
    const address = screen.getByLabelText(/Delivery address/);
    await user.click(await pricedSave());
    await alertSaying('This vendor changed while you were working');

    // The one press that checks again reads the vendor, and the connection is lost.
    read.state.down = true;
    await user.click(screen.getByRole('button', { name: 'Check the price again' }));
    expect(await screen.findByText(/could not be refreshed/i)).toBeVisible();
    // The same fields, not fields that were drawn again with the same text, and the page's one heading drawn once.
    expect(screen.getByLabelText(/Recipient’s name/)).toBe(name);
    expect(name).toHaveValue('Ama Mensah');
    expect(phone).toHaveValue('024 123 4567');
    expect(address).toHaveValue('12 Madina Estate, near the market');
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    // The connection is back: the line's own Try again reads the vendor, the line goes, and nothing typed is lost.
    read.state.down = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByText(/could not be refreshed/i)).toBeNull();
    });
    expect(screen.getByLabelText(/Recipient’s name/)).toBe(name);
    expect(name).toHaveValue('Ama Mensah');
    expect(address).toHaveValue('12 Madina Estate, near the market');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);

    // And the order is saved from the same form, on the version that was read.
    await user.click(await pricedSave());
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)[1]?.headers.get('If-Match')).toBe('"v2"');
  });
});
