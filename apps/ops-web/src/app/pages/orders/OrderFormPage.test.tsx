import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
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

/**
 * `/intakes/{id}/orders/new` (`previewOrder` then `itemizeOrder`; S1.40; AC-SLICE-001-47 to 59, 90, 104). **An order is made for one parcel with its photo beside the form, and the officer checks the price
 * before anything is saved**: the server works out what confirming gives, the officer reads it, and the save is made on the digest of exactly those terms. Each break named below is one these tests catch.
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

let api: FakeApi;
afterEach(() => {
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
    // The parcel's photo is beside the form, and nothing of an identifier is drawn.
    expect(screen.getByRole('heading', { level: 2, name: 'The parcel' })).toBeVisible();

    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Check the price' }));

    // The review is the server's: the price, its parts, where it goes, the date, who pays and what that means.
    expect(await screen.findByRole('heading', { level: 2, name: 'Check the order' })).toBeVisible();
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

    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();

    const request = sent(SAVE)[0];
    expect(request?.headers.get('If-Match')).toBe('"v1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bodyOf(request)).toMatchObject({
      reviewed_terms: TOKEN,
      parcel_id: PARCELS[0]?.id,
      size_class: 'MEDIUM',
    });
    // After a save the way on is the next parcel, with what is left counted by the server.
    expect(screen.getByRole('link', { name: 'Make the next order' })).toBeVisible();
    expect(screen.getByText('1 parcel needs an order.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
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
  // Break caught: an order saved on a price the officer did not read; the earlier figure lost; a second confirmation that does not say what it is for; entries lost.
  it('shows the new terms beside the old, asks for a second confirmation at the new figure, and keeps what was entered', async () => {
    let saves = 0;
    const { user } = open({
      [SAVE]: () => {
        saves += 1;
        return saves === 1
          ? json(409, {
              code: 'STATE_CONFLICT',
              message: 'Diagnostic text that must never reach a screen.',
              request_id: 'r1',
              details: { rule: 'terms_changed', current_terms: termsOf({}, 4000, NEW_TOKEN) },
            })
          : json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' });
      },
    });
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('heading', { level: 2, name: 'Check the order' });
    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));

    const warning = await alertSaying('The terms changed while you were looking');
    expect(warning.textContent).toContain('Price: GH₵35.00 before, GH₵40.00 now.');
    // The officer is asked to confirm the new figure, not the old one.
    expect(screen.getByRole('button', { name: 'Confirm at GH₵40.00' })).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    expect(sent(SAVE)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Confirm at GH₵40.00' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)).toHaveLength(2);
    // The second save is on the new terms.
    expect(await bodyOf(sent(SAVE)[1])).toMatchObject({ reviewed_terms: NEW_TOKEN });
    // Nothing the officer entered was asked for again: one preview, and the save carried the same size.
    expect(sent(PREVIEW)).toHaveLength(1);
    expect(await bodyOf(sent(SAVE)[1])).toMatchObject({ size_class: 'MEDIUM' });
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('heading', { level: 2, name: 'Check the order' });
    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));

    const alert = await alertSaying('The hub’s prices are being changed');
    expect(alert.textContent).toContain('nothing was saved');
    await user.click(screen.getByRole('button', { name: 'Check the price again' }));

    // The same entries are checked again, and the new figure is the one the officer is asked to confirm.
    await waitFor(() => {
      expect(sent(PREVIEW)).toHaveLength(2);
    });
    expect(await bodyOf(sent(PREVIEW)[1])).toEqual(await bodyOf(sent(PREVIEW)[0]));
    expect((await screen.findAllByText('GH₵36.00')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Confirm at GH₵36.00' })).toBeVisible();
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('heading', { level: 2, name: 'Check the order' });
    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
    await alertSaying('This vendor changed while you were working');
    await user.click(screen.getByRole('button', { name: 'Check the price again' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm the order' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    // The second save is made on the version read again.
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('heading', { level: 2, name: 'Check the order' });
    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();
    expect(sent(SAVE)[0]?.headers.get('If-Match')).toBe('"v1"');

    await user.click(screen.getByRole('link', { name: 'Make the next order' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Make an order for parcel 2' }),
    ).toBeVisible();
    await fillIn(user);
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('heading', { level: 2, name: 'Check the order' });
    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('heading', { level: 2, name: 'Check the order' });
    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
    expect(await screen.findByText('Order ACC-OR-2CD3FG is saved.')).toBeVisible();

    await user.click(screen.getByRole('link', { name: 'Make the next order' }));
    // The form is there again, empty, for the next place; the screen of the order just saved is gone.
    expect(await screen.findByLabelText(/Recipient’s name/)).toHaveValue('');
    expect(screen.queryByText('Order ACC-OR-2CD3FG is saved.')).toBeNull();
    expect(saves).toBe(1);
  });
});

describe('a refusal and an outcome nobody knows', () => {
  // Break caught: a refusal about one field told as a banner, the field not marked, or the server's own words drawn.
  it('tells a refusal on the field it is about, in the floor’s words, and shows no review', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    expect(
      await screen.findByText(
        /A value this high needs the sender’s agreement to the liability limit/,
      ),
    ).toBeVisible();
    expect(screen.getByLabelText(/Declared value/)).toBeInvalid();
    expect(screen.queryByRole('heading', { level: 2, name: 'Check the order' })).toBeNull();
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('heading', { level: 2, name: 'Check the order' });
    await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    const group = await screen.findByRole('group', { name: /Which zone is it\?/ });
    for (const radio of within(group).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Accra Central' })).toBeVisible();
    expect(within(group).getByRole('radio', { name: 'Tema' })).toBeVisible();

    // No zone is sent until one is chosen with its reason.
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    expect(await screen.findByText('Choose the zone.')).toBeVisible();
    expect(sent(PREVIEW)).toHaveLength(1);
    await user.click(within(group).getByRole('radio', { name: 'Tema' }));
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    expect(await screen.findByText('Say why you chose this zone.')).toBeVisible();
    await user.type(screen.getByLabelText(/Why this zone/), 'The market is in Tema');
    await user.click(screen.getByRole('button', { name: 'Check the price' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Check the order' })).toBeVisible();
    expect(screen.getByText('Zone chosen by you')).toBeVisible();
    const second = await bodyOf(sent(PREVIEW)[1]);
    expect(second.destination_zone_authorization).toEqual({
      zone_id: '5eed0101-0000-4000-8000-000000000001',
      note: 'The market is in Tema',
    });
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
    await user.click(screen.getByRole('button', { name: 'Check the price' }));
    await screen.findByRole('group', { name: /Which zone is it\?/ });
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
      await user.click(await screen.findByRole('button', { name: 'Check the price' }));
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
      await user.click(screen.getByRole('button', { name: 'Check the price' }));
      await screen.findByRole('heading', { level: 2, name: 'Check the order' });
      await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
      await alertSaying('This vendor changed while you were working');
    },
  },
  success: {
    test: async () => {
      const { user } = open({
        [SAVE]: () => json(201, SAVED('11111111-2222-4333-8444-555555555555'), { ETag: '"o1"' }),
      });
      await fillIn(user);
      await user.click(screen.getByRole('button', { name: 'Check the price' }));
      await screen.findByRole('heading', { level: 2, name: 'Check the order' });
      await user.click(screen.getByRole('button', { name: 'Confirm the order' }));
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
