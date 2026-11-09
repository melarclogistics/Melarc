import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  adHocSenderFixture,
  estimateFixture,
  LOCATION_ID,
  OTHER_LOCATION_ID,
  PICKUP_HUB_ID,
  pickupRequestFixture,
  REQUEST_ID,
  savedLocationFixture,
  SENDER_ID,
  unavailableEstimate,
  VENDOR_ORG_ID,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { vendorAccountFixture } from '../../../test-support/vendor-fixture';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/pickup-requests/new` (`createPickupRequest`; S1.19; AC-SLICE-001-69 to 72, 81). The intent is chosen first and decides the rest; the
 * booking carries payer intent and never a price; the server's estimate is shown as an estimate; a lost answer is tried again under the same
 * `Idempotency-Key`; a refusal that states a rule says the rule.
 */
const PATH = '/pickup-requests/new';
const CREATE = 'POST /pickup-requests';
const VENDORS = 'GET /ops/vendors';
const LOCATIONS = `GET /vendor-organizations/${VENDOR_ORG_ID}/pickup-locations`;
const SENDERS = 'GET /ad-hoc-senders';
const CREATOR = [
  'pickup.read',
  'pickup.request.create',
  'vendor.read',
  'vendor.pickup_location.manage',
];
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const booked = (estimate = estimateFixture()): Response =>
  json(201, pickupRequestFixture({ indicative_estimate: estimate }), etag('v1'));

const ACCRA = { id: PICKUP_HUB_ID, display_name: 'Accra Central' };
const TEMA_HUB_ID = '7c3e1f2a-9b4d-4c6e-8a5f-1d2e3f4a5b6c';
const TEMA = { id: TEMA_HUB_ID, display_name: 'Tema' };

function open(
  keys: readonly string[] = CREATOR,
  handlers: Record<string, Handler> = {},
  hubs: readonly { readonly id: string; readonly display_name: string }[] = [ACCRA],
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [...hubs],
      }),
      {
        [VENDORS]: () => json(200, { items: [vendorAccountFixture()], next_page_token: null }),
        [LOCATIONS]: () =>
          json(200, {
            items: [
              savedLocationFixture(),
              savedLocationFixture({
                id: OTHER_LOCATION_ID,
                label: 'Demo warehouse',
                location: { address: '22 Demo Road, Spintex' },
                is_default: false,
              }),
            ],
          }),
        [CREATE]: () => booked(),
        ...handlers,
      },
    ),
  );
  return renderApp(PATH);
}

type User = ReturnType<typeof renderApp>['user'];

const creates = () => api.requests.filter((request) => request.method === 'POST');
const bodyOf = async (request: Request | undefined): Promise<unknown> =>
  request === undefined ? undefined : request.clone().json();

async function chooseIntent(user: User, label: string): Promise<void> {
  await user.click(await screen.findByRole('radio', { name: label }));
}

async function chooseVendor(user: User): Promise<void> {
  await user.type(screen.getByRole('searchbox', { name: /Search vendors/ }), 'asante{Enter}');
  await user.click(await screen.findByRole('button', { name: 'Choose: Asante Fabrics Ltd' }));
}

/** Types a date into the date field: the digits of day, month and year, which the field puts its slashes into. */
async function typeDate(user: User, digits: string): Promise<void> {
  const group = screen.getByRole('group', { name: /Service date/ });
  await user.click(within(group).getByRole('textbox'));
  await user.keyboard(digits);
}

/** The common half of every booking: a Tuesday, three packages, the recipient pays. */
async function fillCommon(user: User): Promise<void> {
  await typeDate(user, '03112026');
  await user.type(screen.getByRole('textbox', { name: /Number of packages/ }), '3');
  await user.click(screen.getByRole('radio', { name: 'The recipient pays' }));
}

const send = (user: User) => user.click(screen.getByRole('button', { name: 'Book the pickup' }));

/** A first-time walk-in sender and everything else of the booking, but for the hub: the person has still to say which hub, where one is asked. */
async function fillNewWalkIn(user: User): Promise<void> {
  await chooseIntent(user, 'A walk-in sender');
  await user.click(screen.getByRole('radio', { name: 'No: this is their first time' }));
  await user.type(screen.getByRole('textbox', { name: /Sender’s name/ }), 'Kojo Demo');
  await user.type(screen.getByRole('textbox', { name: /Sender’s phone/ }), '+233245556666');
  await user.type(
    screen.getByRole('textbox', { name: /Address the parcel is collected from/ }),
    '1 Demo Avenue',
  );
  await user.type(screen.getByRole('textbox', { name: /What is being sent today/ }), 'Books');
  await user.type(
    screen.getByRole('textbox', { name: /Contact phone for this pickup/ }),
    '+233245556666',
  );
  await fillCommon(user);
}

const hubField = () => screen.getByRole('combobox', { name: /^Hub/ });

describe('booking: the intent comes first', () => {
  // MSC-DEC-335: there is no universal form; the intent is chosen before anything else is asked, and nothing chooses it for the person.
  it('asks what is being booked first, with nothing chosen, and nothing else until it is', async () => {
    open();

    const intent = await screen.findByRole('group', { name: 'What is being booked (required)' });
    expect(
      within(intent)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['OWN_PACKAGES', 'COLLECT_FOR_VENDOR', 'ADHOC_SENDER']);
    for (const radio of within(intent).getAllByRole('radio')) expect(radio).not.toBeChecked();
    expect(screen.queryByRole('group', { name: /Service date/ })).toBeNull();
    expect(screen.getByText(/Choose what is being booked first/)).toBeVisible();
  });

  it('refuses a booking with no intent, on the intent', async () => {
    const { user } = open();
    await screen.findByRole('group', { name: /What is being booked/ });

    await send(user);

    const first = screen.getByRole('radio', { name: 'A vendor’s own packages' });
    await waitFor(() => {
      expect(first).toHaveFocus();
    });
    expect(first).toHaveAccessibleDescription(
      expect.stringContaining('Choose what is being booked.'),
    );
    expect(creates()).toHaveLength(0);
  });
});

describe('booking a vendor’s own packages', () => {
  // AC-SLICE-001-69: the vendor and its saved location, and what changes today; no collection point, and never a price.
  it('books from a saved location with a fresh key, and shows the estimate as an estimate', async () => {
    const { user } = open();
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Saved location' }),
      OTHER_LOCATION_ID,
    );
    await user.type(
      screen.getByRole('textbox', { name: /What is being sent today/ }),
      'Fabric rolls',
    );
    await fillCommon(user);

    await send(user);

    expect(await screen.findByRole('heading', { name: 'Pickup booked' })).toBeVisible();
    const [request] = creates();
    expect(request?.headers.get('Idempotency-Key')).toMatch(KEY);
    expect(request?.headers.has('If-Match')).toBe(false);
    expect(await bodyOf(request)).toEqual({
      pickup_intent: 'OWN_PACKAGES',
      vendor_organization_id: VENDOR_ORG_ID,
      vendor_pickup_location_id: OTHER_LOCATION_ID,
      current_item_description: 'Fabric rolls',
      scheduled_service_date: '2026-11-03',
      declared_package_count: 3,
      default_payer_intent: 'RECIPIENT_PAYS',
    });
    expect(
      screen.getByText(
        'ACC-PR-7KQ2MZ is booked for Tue 3 Nov 2026. It is waiting for confirmation.',
      ),
    ).toBeVisible();
    const estimate = screen.getByRole('region', { name: 'Indicative estimate (provisional)' });
    expect(within(estimate).getByText(/^About/)).toHaveTextContent('About GH₵45.00');
    expect(screen.getByRole('link', { name: 'View the request' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ID}`,
    );
  });

  it('leaves the location out for the vendor’s default, and sends an override for this pickup only', async () => {
    const { user } = open();
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    expect(await screen.findByRole('combobox', { name: 'Saved location' })).toHaveValue('');
    await user.click(screen.getByRole('checkbox', { name: /Collect from another address/ }));
    await user.type(screen.getByRole('textbox', { name: /Address for this pickup/ }), '5 Demo Way');
    await fillCommon(user);

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    const body = (await bodyOf(creates()[0])) as Record<string, unknown>;
    expect(body).not.toHaveProperty('vendor_pickup_location_id');
    expect(body.location_overrides).toEqual({ address: '5 Demo Way' });
    expect(body).not.toHaveProperty('collection_point');
    expect(body).not.toHaveProperty('primary_phone');
  });

  it('names the key a session needs to search the vendors, and books nothing without one', async () => {
    const { user } = open(['pickup.request.create']);
    await chooseIntent(user, 'A vendor’s own packages');

    expect(await screen.findByText(cannotText('vendor.read'))).toBeVisible();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('uses the vendor’s default location when the session may not list the others, and says why', async () => {
    const { user } = open(['pickup.request.create', 'vendor.read']);
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);

    expect(
      await screen.findByText('The request uses the vendor’s default saved location.'),
    ).toBeVisible();
    expect(screen.getByText(cannotText('vendor.pickup_location.manage'))).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Saved location' })).toBeNull();
  });
});

describe('booking a collection for a vendor', () => {
  // AC-SLICE-001-70: a collection point, a reference, an item and a destination; the vendor's default is a destination of its own.
  it('sends the collection point, the reference, the item and the vendor’s default as the destination', async () => {
    const { user } = open();
    await chooseIntent(user, 'A collection for a vendor');
    await chooseVendor(user);
    await user.type(
      await screen.findByRole('textbox', { name: /Person or business holding/ }),
      'Demo seller',
    );
    await user.type(screen.getByRole('textbox', { name: /Their phone/ }), '+233200000001');
    await user.type(screen.getByRole('textbox', { name: /Their address/ }), '3 Demo Market Road');
    await user.type(
      screen.getByRole('textbox', { name: /Name the seller holds it under/ }),
      'Demo order',
    );
    await user.type(screen.getByRole('textbox', { name: /^Item/ }), 'Demo sandals');
    await user.type(screen.getByRole('textbox', { name: /How many items/ }), '2');
    await user.selectOptions(screen.getByRole('combobox', { name: /Destination/ }), 'DEFAULT');
    await user.type(
      screen.getByRole('textbox', { name: /Contact phone for this pickup/ }),
      '+233201112233',
    );
    await fillCommon(user);

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    expect(await bodyOf(creates()[0])).toEqual({
      use_vendor_default_destination: true,
      pickup_intent: 'COLLECT_FOR_VENDOR',
      vendor_organization_id: VENDOR_ORG_ID,
      collection_point: {
        contact_name: 'Demo seller',
        phone: '+233200000001',
        location: { address: '3 Demo Market Road' },
      },
      collection_reference: { reference_name: 'Demo order' },
      collection_item: { description: 'Demo sandals', quantity: 2 },
      primary_phone: '+233201112233',
      scheduled_service_date: '2026-11-03',
      declared_package_count: 3,
      default_payer_intent: 'RECIPIENT_PAYS',
    });
  });

  it('sends a saved location as the destination by its id', async () => {
    const { user } = open();
    await chooseIntent(user, 'A collection for a vendor');
    await chooseVendor(user);
    await user.type(
      await screen.findByRole('textbox', { name: /Person or business holding/ }),
      'Demo seller',
    );
    await user.type(screen.getByRole('textbox', { name: /Their phone/ }), '+233200000001');
    await user.type(screen.getByRole('textbox', { name: /Their address/ }), '3 Demo Market Road');
    await user.type(
      screen.getByRole('textbox', { name: /Name the seller holds it under/ }),
      'Demo order',
    );
    await user.type(screen.getByRole('textbox', { name: /^Item/ }), 'Demo sandals');
    await user.type(screen.getByRole('textbox', { name: /How many items/ }), '1');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: /Destination/ }),
      LOCATION_ID,
    );
    await user.type(
      screen.getByRole('textbox', { name: /Contact phone for this pickup/ }),
      '+233201112233',
    );
    await fillCommon(user);

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    const body = (await bodyOf(creates()[0])) as Record<string, unknown>;
    expect(body.destination_location_id).toBe(LOCATION_ID);
    expect(body).not.toHaveProperty('use_vendor_default_destination');
  });

  it('refuses a collection with its point, item and destination missing, field by field', async () => {
    const { user } = open();
    await chooseIntent(user, 'A collection for a vendor');
    await chooseVendor(user);
    await fillCommon(user);

    await send(user);

    const name = await screen.findByRole('textbox', { name: /Person or business holding/ });
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    expect(screen.getByRole('combobox', { name: /Destination/ })).toHaveAccessibleDescription(
      'Choose where the parcel goes.',
    );
    expect(screen.getByRole('textbox', { name: /How many items/ })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(creates()).toHaveLength(0);
  });
});

describe('booking a walk-in sender', () => {
  // AC-SLICE-001-71: a first-time sender is created with the booking, in one act; today's goods are asked every time (AC-SLICE-001-72).
  it('sends a new sender, today’s goods and the contact phone', async () => {
    const { user } = open();
    await chooseIntent(user, 'A walk-in sender');
    await user.click(screen.getByRole('radio', { name: 'No: this is their first time' }));
    await user.type(screen.getByRole('textbox', { name: /Sender’s name/ }), 'Kojo Demo');
    await user.type(screen.getByRole('textbox', { name: /Sender’s phone/ }), '+233245556666');
    await user.type(
      screen.getByRole('textbox', { name: /Address the parcel is collected from/ }),
      '1 Demo Avenue',
    );
    await user.type(screen.getByRole('textbox', { name: /What is being sent today/ }), 'Books');
    await user.type(
      screen.getByRole('textbox', { name: /Contact phone for this pickup/ }),
      '+233245556666',
    );
    await fillCommon(user);

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    expect(await bodyOf(creates()[0])).toEqual({
      pickup_intent: 'ADHOC_SENDER',
      // The one hub the session lists is the hub of the booking (task P1): the server asks the person to name it when its grant reaches more
      // than one, and a form that always names it works for both.
      hub_id: PICKUP_HUB_ID,
      new_ad_hoc_sender: {
        name: 'Kojo Demo',
        phone: '+233245556666',
        pickup_location: { address: '1 Demo Avenue' },
      },
      current_item_description: 'Books',
      primary_phone: '+233245556666',
      scheduled_service_date: '2026-11-03',
      declared_package_count: 3,
      default_payer_intent: 'RECIPIENT_PAYS',
    });
  });

  // AC-SLICE-001-72: a returning sender is found by phone and reused; exactly one identity source is sent.
  it('finds a returning sender by phone, and sends their id and nothing of a new sender', async () => {
    const { user } = open(CREATOR, {
      [SENDERS]: () => json(200, { items: [adHocSenderFixture()] }),
    });
    await chooseIntent(user, 'A walk-in sender');
    await user.click(screen.getByRole('radio', { name: 'Yes: find them by phone' }));
    await user.type(
      screen.getByRole('searchbox', { name: /The sender’s phone/ }),
      '+233241112222{Enter}',
    );
    await user.click(
      await screen.findByRole('button', { name: 'Use this sender: Efua Demo Sender' }),
    );
    await user.type(
      screen.getByRole('textbox', { name: /What is being sent today/ }),
      'Phone accessories',
    );
    await user.type(
      screen.getByRole('textbox', { name: /Contact phone for this pickup/ }),
      '+233241112222',
    );
    await fillCommon(user);

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    const lookup = api.requests.find(
      (request) => new URL(request.url).pathname === '/api/v1/ad-hoc-senders',
    );
    expect(new URL(lookup?.url ?? 'http://x/').searchParams.get('phone')).toBe('+233241112222');
    const body = (await bodyOf(creates()[0])) as Record<string, unknown>;
    expect(body.ad_hoc_sender_id).toBe(SENDER_ID);
    expect(body).not.toHaveProperty('new_ad_hoc_sender');
    expect(body.current_item_description).toBe('Phone accessories');
  });

  it('says so when no returning sender has the phone', async () => {
    const { user } = open(CREATOR, { [SENDERS]: () => json(200, { items: [] }) });
    await chooseIntent(user, 'A walk-in sender');
    await user.click(screen.getByRole('radio', { name: 'Yes: find them by phone' }));
    await user.type(
      screen.getByRole('searchbox', { name: /The sender’s phone/ }),
      '+233200000000{Enter}',
    );

    expect(await screen.findByText(/No returning sender has this phone/)).toBeVisible();
  });

  // Today's goods are asked every time: last time's description says nothing about this box.
  it('refuses a walk-in booking without today’s goods', async () => {
    const { user } = open();
    await chooseIntent(user, 'A walk-in sender');
    await user.click(screen.getByRole('radio', { name: 'No: this is their first time' }));
    await fillCommon(user);

    await send(user);

    expect(await screen.findByText('Say what is being sent today.')).toBeVisible();
    expect(creates()).toHaveLength(0);
  });
});

describe('booking a walk-in sender: the hub', () => {
  // AC-SLICE-001-82 (task P1): a grant that reaches more than one hub (a Platform Admin's reaches them all) makes the person name the hub the
  // walk-in is booked into; the server never picks one for them, so the page asks, and sends what was chosen.
  it('asks a session of several hubs to choose the hub, and books nothing until it has', async () => {
    const { user } = open(CREATOR, {}, [ACCRA, TEMA]);
    await fillNewWalkIn(user);
    const hub = hubField();
    expect(hub).toHaveValue('');
    expect(within(hub).getAllByRole('option', { name: /Accra Central|Tema/ })).toHaveLength(2);

    await send(user);

    await waitFor(() => {
      expect(hub).toHaveFocus();
    });
    expect(hub).toHaveAttribute('aria-invalid', 'true');
    expect(hub).toHaveAccessibleDescription(
      expect.stringContaining('Choose the hub this booking is made in.'),
    );
    expect(creates()).toHaveLength(0);
  });

  it('sends the hub the person chose, and only that', async () => {
    const { user } = open(CREATOR, {}, [ACCRA, TEMA]);
    await fillNewWalkIn(user);
    await user.selectOptions(hubField(), 'Tema');

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    expect(creates()).toHaveLength(1);
    expect(await bodyOf(creates()[0])).toMatchObject({
      pickup_intent: 'ADHOC_SENDER',
      hub_id: TEMA_HUB_ID,
    });
  });

  // A session that lists one hub books into it without being asked; a form that always names it works whether the grant reaches one hub or
  // more, so a second hub opened tomorrow does not stop it.
  it('has the one hub of a session of one chosen already', async () => {
    const { user } = open();
    await chooseIntent(user, 'A walk-in sender');

    expect(hubField()).toHaveValue(PICKUP_HUB_ID);
    expect(screen.getByRole('option', { name: 'Accra Central' })).toBeInTheDocument();
  });

  it('offers no hub to choose when the session lists none, and sends none', async () => {
    const { user } = open(CREATOR, {}, []);
    await fillNewWalkIn(user);

    expect(hubField()).toBeDisabled();
    expect(hubField()).toHaveAccessibleDescription(
      expect.stringContaining('Your session lists no hub to choose from.'),
    );
    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    expect(await bodyOf(creates()[0])).not.toHaveProperty('hub_id');
  });

  // A registered vendor's booking is in its organisation's hub, whoever makes it: the page neither asks for a hub nor names one, even one the
  // person chose a moment ago for a walk-in and then left (the server refuses another hub than the organisation's).
  it.each([['A vendor’s own packages'], ['A collection for a vendor']])(
    'asks for no hub for %s, and sends none, whatever hub was chosen before',
    async (intent) => {
      const { user } = open(CREATOR, {}, [ACCRA, TEMA]);
      await chooseIntent(user, 'A walk-in sender');
      await user.selectOptions(hubField(), 'Tema');
      await chooseIntent(user, intent);
      await chooseVendor(user);

      expect(screen.queryByRole('combobox', { name: /^Hub/ })).toBeNull();
      await fillCommon(user);
      if (intent === 'A collection for a vendor') {
        await user.type(screen.getByRole('textbox', { name: /Person or business holding/ }), 'Ama');
        await user.type(screen.getByRole('textbox', { name: /Their phone/ }), '+233245550000');
        await user.type(screen.getByRole('textbox', { name: /Their address/ }), '5 Demo Lane');
        await user.type(
          screen.getByRole('textbox', { name: /Name the seller holds it under/ }),
          'Ama',
        );
        await user.type(screen.getByRole('textbox', { name: /^Item/ }), 'Shoes');
        await user.type(screen.getByRole('textbox', { name: /How many items/ }), '1');
        await user.selectOptions(screen.getByRole('combobox', { name: /Destination/ }), 'DEFAULT');
        await user.type(
          screen.getByRole('textbox', { name: /Contact phone for this pickup/ }),
          '+233245556666',
        );
      }
      await send(user);

      await screen.findByRole('heading', { name: 'Pickup booked' });
      expect(await bodyOf(creates()[0])).not.toHaveProperty('hub_id');
    },
  );

  it('puts the server’s words on the hub field when it refuses the hub', async () => {
    const { user } = open(CREATOR, {
      [CREATE]: () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/hub_id', rule: 'enum' }],
        }),
    });
    await fillNewWalkIn(user);

    await send(user);

    const hub = hubField();
    await waitFor(() => {
      expect(hub).toHaveFocus();
    });
    expect(hub).toHaveAccessibleDescription(
      expect.stringContaining('Choose the hub this booking is made in.'),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('booking: the date, the payer and the value', () => {
  // The calendar is Monday to Saturday (MSC-DEC-149); the page says so before the server refuses it.
  it('refuses a Sunday before anything is sent', async () => {
    const { user } = open();
    await chooseIntent(user, 'A walk-in sender');
    await typeDate(user, '01112026');

    await send(user);

    expect(
      await screen.findByText('Pickups run from Monday to Saturday. Choose another date.'),
    ).toBeVisible();
    expect(creates()).toHaveLength(0);
  });

  it('sends a split by a set amount in pesewas, and never as a float', async () => {
    const { user } = open();
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await typeDate(user, '03112026');
    await user.type(screen.getByRole('textbox', { name: /Number of packages/ }), '2');
    await user.click(
      screen.getByRole('radio', { name: 'Shared between the sender and the recipient' }),
    );
    await user.click(screen.getByRole('radio', { name: 'The sender pays a set amount' }));
    await user.type(screen.getByRole('textbox', { name: /The sender’s share, in cedis/ }), '15.10');

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    expect(await bodyOf(creates()[0])).toMatchObject({
      default_payer_intent: 'SPLIT',
      split_basis: 'FIXED_AMOUNT',
      split_sender_amount: { amount_minor: 1510, currency: 'GHS' },
    });
  });

  it('sends a split by a percentage, and refuses one above 100', async () => {
    const { user } = open();
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await typeDate(user, '03112026');
    await user.type(screen.getByRole('textbox', { name: /Number of packages/ }), '2');
    await user.click(
      screen.getByRole('radio', { name: 'Shared between the sender and the recipient' }),
    );
    await user.click(screen.getByRole('radio', { name: 'The sender pays a percentage' }));
    const share = screen.getByRole('textbox', { name: /The sender’s share, as a percentage/ });
    await user.type(share, '120');
    await send(user);
    expect(share).toHaveAccessibleDescription(expect.stringContaining('from 0 to 100'));
    expect(creates()).toHaveLength(0);

    await user.clear(share);
    await user.type(share, '40');
    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    expect(await bodyOf(creates()[0])).toMatchObject({
      split_basis: 'PERCENTAGE',
      split_sender_percentage: 40,
    });
  });

  // AC-SLICE-001-81: a declared value in pesewas, and the acknowledgement only when the person ticks it; never the cap's amount.
  it('sends a declared value in pesewas and the acknowledgement the person ticked', async () => {
    const { user } = open();
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await fillCommon(user);
    expect(screen.queryByRole('checkbox', { name: /liability is capped/ })).toBeNull();
    await user.type(screen.getByRole('textbox', { name: /Declared value/ }), '1,250.50');
    const acknowledgement = screen.getByRole('checkbox', { name: /liability is capped/ });
    expect(acknowledgement).not.toBeChecked();
    await user.click(acknowledgement);

    await send(user);

    await screen.findByRole('heading', { name: 'Pickup booked' });
    const body = (await bodyOf(creates()[0])) as Record<string, unknown>;
    expect(body.declared_value_minor).toBe(125_050);
    expect(body.liability_cap_acknowledged).toBe(true);
    expect(Object.keys(body)).not.toContain('liability_cap_amount');
  });

  it('says the rule when the server needs the acknowledgement', async () => {
    const { user } = open(CREATOR, { [CREATE]: () => refusal(422, 'VALUE_DECLARATION_REQUIRED') });
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await fillCommon(user);
    await user.type(screen.getByRole('textbox', { name: /Declared value/ }), '9000');

    await send(user);

    expect(
      await screen.findByText(/Tell the sender the cap, and tick the acknowledgement/),
    ).toBeVisible();
  });

  it('shows no figure for an estimate the server could not give, and says why', async () => {
    const { user } = open(CREATOR, {
      [CREATE]: () => booked(unavailableEstimate('UNAVAILABLE_SETTING_MISSING')),
    });
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await fillCommon(user);

    await send(user);

    const estimate = await screen.findByRole('region', {
      name: 'Indicative estimate (provisional)',
    });
    expect(within(estimate).getByText(/no approved fee/)).toBeVisible();
    expect(estimate.textContent).not.toMatch(/GH₵/);
  });
});

describe('booking: what the server says', () => {
  // ops-portal.md section 7: the vendor suspended while the form was filled is the stale state of this page, told as the rule it is.
  it('tells a sender suspended while the form was filled', async () => {
    const { user } = open(CREATOR, { [CREATE]: () => refusal(422, 'SENDER_SUSPENDED') });
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await fillCommon(user);

    await send(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/This sender is suspended/);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('puts a refused field’s words on the field the server named', async () => {
    const { user } = open(CREATOR, {
      [CREATE]: () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'body', pointer: '/declared_package_count', rule: 'minimum' }],
        }),
    });
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await fillCommon(user);

    await send(user);

    const packages = screen.getByRole('textbox', { name: /Number of packages/ });
    await waitFor(() => {
      expect(packages).toHaveFocus();
    });
    expect(packages).toHaveAccessibleDescription(
      expect.stringContaining('a whole number of at least 1'),
    );
  });
});

describeInterfaceStates('The booking', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const { user } = open(CREATOR, { [VENDORS]: () => gate });
      await chooseIntent(user, 'A vendor’s own packages');
      await user.type(screen.getByRole('searchbox', { name: /Search vendors/ }), 'asante{Enter}');
      expect(await screen.findByText('Searching…')).toBeInTheDocument();
      await act(async () => {
        release(json(200, { items: [vendorAccountFixture()], next_page_token: null }));
        await gate;
      });
      expect(await screen.findByText('1 found.')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      const { user } = open(CREATOR, {
        [VENDORS]: () => json(200, { items: [], next_page_token: null }),
      });
      await chooseIntent(user, 'A vendor’s own packages');
      await user.type(screen.getByRole('searchbox', { name: /Search vendors/ }), 'nobody{Enter}');
      expect(
        await screen.findByText('No vendor matches. Try another name or account.'),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      const { user } = open();
      await chooseIntent(user, 'A vendor’s own packages');
      await send(user);
      const search = screen.getByRole('searchbox', { name: /Search vendors/ });
      await waitFor(() => {
        expect(search).toHaveFocus();
      });
      expect(search).toHaveAccessibleDescription(expect.stringContaining('Choose the vendor.'));
      expect(screen.getByRole('textbox', { name: /Number of packages/ })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(creates()).toHaveLength(0);
    },
  },
  error: {
    test: async () => {
      const { user } = open(CREATOR, {
        [CREATE]: () => refusal(422, 'SERVICE_DATE_NOT_PERMITTED'),
      });
      await chooseIntent(user, 'A vendor’s own packages');
      await chooseVendor(user);
      await fillCommon(user);
      await send(user);
      const date = within(screen.getByRole('group', { name: /Service date/ }));
      expect(
        await screen.findByText('Pickups run from Monday to Saturday. Choose another date.'),
      ).toBeVisible();
      expect(date.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      // A lost answer is sent again under the same key, with the same booking, so it is never booked twice.
      let attempts = 0;
      const { user } = open(CREATOR, {
        [CREATE]: () => {
          attempts += 1;
          return attempts === 1 ? refusal(503, 'INTERNAL') : booked();
        },
      });
      await chooseIntent(user, 'A vendor’s own packages');
      await chooseVendor(user);
      await fillCommon(user);
      await send(user);
      expect(
        await screen.findByText(/We could not confirm whether the pickup was booked/),
      ).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('heading', { name: 'Pickup booked' })).toBeVisible();
      const [first, second] = creates();
      expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
      expect(await bodyOf(second)).toEqual(await bodyOf(first));
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      // The page's stale state: the sender suspended while the form was filled (ops-portal.md section 7), told as the rule.
      const { user } = open(CREATOR, { [CREATE]: () => refusal(422, 'SENDER_SUSPENDED') });
      await chooseIntent(user, 'A vendor’s own packages');
      await chooseVendor(user);
      await fillCommon(user);
      await send(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(/held, not cancelled/);
      // The form is the person's again: the next submit is a new booking.
      expect(screen.getByRole('button', { name: 'Book the pickup' })).toBeEnabled();
    },
  },
  success: {
    test: async () => {
      const { user } = open();
      await chooseIntent(user, 'A vendor’s own packages');
      await chooseVendor(user);
      await fillCommon(user);
      await send(user);
      const done = (await screen.findByRole('heading', { name: 'Pickup booked' })).closest(
        '.pickup-booked',
      );
      await waitFor(() => {
        expect(done).toHaveFocus();
      });
      await user.click(screen.getByRole('button', { name: 'Book another pickup' }));
      // A new form: nothing of the last booking is carried over.
      for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(['pickup.read']);
      expect(await screen.findByText(cannotText('pickup.request.create'))).toBeVisible();
      expect(screen.queryByRole('radio')).toBeNull();
    },
  },
});

// Task R5.2, H1: Enter in the date field must not book with the day the page still holds while the person has taken a part of it out.
describe('Enter in the date field', () => {
  // Break caught: the form sent by Enter from the field with the old day (the page keeps the day until the person leaves the field).
  it('does not book while the day is half cleared, and says why', async () => {
    const { user } = open();
    await chooseIntent(user, 'A vendor’s own packages');
    await chooseVendor(user);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Saved location' }),
      OTHER_LOCATION_ID,
    );
    await user.type(
      screen.getByRole('textbox', { name: /What is being sent today/ }),
      'Fabric rolls',
    );
    await fillCommon(user);

    const group = screen.getByRole('group', { name: /Service date/ });
    await user.click(within(group).getByRole('textbox'));
    await user.keyboard('{End}{Backspace}{Enter}');

    expect(creates()).toHaveLength(0);
    expect(await screen.findByText('Enter the year in full, for example 2026')).toBeVisible();

    // The control: the day typed in full is booked by Enter, as any field in a form sends it.
    await user.keyboard('6{Enter}');
    expect(await screen.findByRole('heading', { name: 'Pickup booked' })).toBeVisible();
    expect(creates()).toHaveLength(1);
  });
});

/**
 * The booking is drawn by the task form template (redesign step R6): sections under headings of their own, a rail of what the server does with the booking, and a guard against
 * leaving a form that holds what was entered. The booking's own rules are the tests above; these hold the frame.
 */
describe('booking: the task form', () => {
  it('draws the sections of what was chosen under headings of their own, and a rail that says what happens next', async () => {
    const { user } = open();
    await chooseIntent(user, 'A walk-in sender');

    expect(await screen.findByRole('heading', { level: 1, name: 'Book a pickup' })).toBeVisible();
    for (const heading of ['Where it is booked', 'The sender', 'When and how many', 'Who pays']) {
      expect(screen.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    }
    const rail = screen.getByRole('complementary', { name: 'After you book' });
    expect(
      within(rail).getByText('The booking waits for an Ops officer to confirm it.'),
    ).toBeVisible();
    // The booking states no price and the rail works none out: the estimate is the server's, once the booking is made.
    expect(within(rail).getByText(/an estimate, not a price/)).toBeVisible();
    expect(rail.textContent).not.toMatch(/GH₵|GHS|\d+\.\d\d/);
  });

  // Break caught: a form that loses what was typed to a link, without a word.
  it('asks before the application leaves a form that holds what was entered, and the safe answer is to stay', async () => {
    const { user, router } = open();
    await chooseIntent(user, 'A walk-in sender');

    await act(async () => {
      await router.navigate('/');
    });

    const question = await screen.findByRole('alertdialog', { name: 'Leave this page?' });
    expect(within(question).getByRole('button', { name: 'Stay here' })).toHaveFocus();
    expect(router.state.location.pathname).toBe(PATH);
    await user.click(within(question).getByRole('button', { name: 'Stay here' }));
    expect(screen.getByRole('radio', { name: 'A walk-in sender' })).toBeChecked();
  });

  it('asks nothing of a form that holds nothing entered', async () => {
    const { router } = open();
    await screen.findByRole('radio', { name: 'A walk-in sender' });

    await act(async () => {
      await router.navigate('/');
    });

    expect(screen.queryByRole('alertdialog', { name: 'Leave this page?' })).toBeNull();
    expect(router.state.location.pathname).toBe('/');
  });
});
