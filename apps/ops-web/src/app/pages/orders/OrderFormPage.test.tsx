import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  NEW_TOKEN,
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
/** The one save once its price is on the screen: *Save the order at GH₵35.00*. */
const pricedSave = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /^Save the order at / }, PRICE_WAIT);
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
