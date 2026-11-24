import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID, preCountFixture } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { MANIFEST_ID } from '../../../test-support/manifest-fixture';
import {
  blindRow,
  captured,
  PARCELS,
  parcelRow,
  VENDOR_ID,
  worklistOf,
} from '../../../test-support/orders-fixture';
import {
  blindVendorFixture,
  checkInFixture,
  parcelFixture,
  photoLinkHandlers,
  runFixture,
} from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/orders` (`listIntakeOrders`; S1.40; OB-S1-147): **the work that is really left**, rebuilt from the server whenever the page is opened. A vendor with door photos is a list of its parcels with the
 * server's counts of the whole vendor beside the views; a vendor counted without photos is a list of its orders with how many more are needed (or that the count is awaited). Acts are offered by key and by
 * what the row says, and the page works out nothing.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const OFFICER = ['hub.read', 'hub.intake.itemize', 'hub.intake.close', 'pricing.read'];
const RECORD = `GET /hub-intakes/${VENDOR_ID}`;
const LIST = `GET /hub-intakes/${VENDOR_ID}/orders`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN = /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server)\b/i;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

/** What the vendor has: a parcel with an order made and confirmed, one that needs an order, and one that is not here yet (the vendor's check-in is open for it). */
const SECOND_PARCEL = PARCELS[1]?.id ?? '';
const ROWS = [
  parcelRow(1, 'ITEMIZED'),
  parcelRow(2, 'NEEDS_ORDER'),
  parcelRow(3, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED' }),
];

function open(
  handlers: Record<string, Handler> = {},
  keys: readonly string[] = OFFICER,
  state = 'ITEMIZING',
  path = `/intakes/${VENDOR_ID}/orders`,
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [RECORD]: () =>
        json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state }), { ETag: '"v1"' }),
      [LIST]: () =>
        json(
          200,
          worklistOf(ROWS, { needs_order: 1, awaiting_arrival: 1, itemized: 1, orders: 1 }),
        ),
      ...photoLinkHandlers(PARCELS),
      ...handlers,
    }),
  );
  return renderApp(path);
}

const listReads = () =>
  api.requests
    .filter(
      (request) => new URL(request.url).pathname === `/api/v1/hub-intakes/${VENDOR_ID}/orders`,
    )
    .map((request) => new URL(request.url).searchParams);

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Parcels and orders' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};

describe('a vendor with door photos', () => {
  // Break caught: counts of the page drawn as the vendor's, a count the server did not state drawn as nothing, a row without where it stands, or the server's own words.
  it('lists the parcels with where each stands, and the counts of the whole vendor on the views', async () => {
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Orders for Kente Crafts' }),
    ).toBeVisible();
    const rows = within(await table());
    expect(rows.getByText('Parcel 2')).toBeVisible();
    expect(rows.getAllByText('Needs an order').length).toBeGreaterThan(0);
    expect(rows.getAllByText('Not here yet').length).toBeGreaterThan(0);
    expect(rows.getAllByText('Confirmed — price fixed').length).toBeGreaterThan(0);
    // The views are the server's filter, with the counts of the whole vendor.
    const views = within(screen.getByRole('tablist', { name: 'Views of the orders' }));
    expect(views.getByRole('tab', { name: /Needs an order/ })).toHaveTextContent('1');
    expect(views.getByRole('tab', { name: /Confirmed/ })).toHaveTextContent('1');
    expect(listReads()[0]?.get('view')).toBe('needs_order');
    // What is really left is said in the figures of the whole vendor: arrived, needing an order, made.
    expect(screen.getByText('Arrived').nextElementSibling).toHaveTextContent('3');
    expect(screen.getByText('Need an order').nextElementSibling).toHaveTextContent('1');
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: a block inside a paragraph (the page's summary of the vendor was drawn inside the work list's note, a paragraph: React says so in development, and a screen reader is given a paragraph that holds a list).
  it('draws no block inside a paragraph', async () => {
    open();
    await table();
    expect(document.querySelector('p p, p div, p dl, p ul, p ol, p table, p section')).toBeNull();
  });

  // Break caught: the next act missing for an officer who may make orders, or an act drawn for a session that may not.
  it('offers the next order to an officer who may make one, and each row its own act', async () => {
    open();
    await table();
    const next = screen.getByRole('link', { name: 'Make the next order' });
    expect(next).toHaveAttribute('href', `/intakes/${VENDOR_ID}/orders/new`);
    const act = within(await table()).getByRole('link', { name: /Make order: Parcel 2/ });
    expect(act).toHaveAttribute('href', `/intakes/${VENDOR_ID}/orders/new?parcel=${SECOND_PARCEL}`);
    // A parcel that is not here yet can have its order made early.
    expect(within(await table()).getByRole('link', { name: /Make order: Parcel 3/ })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Close this vendor' })).toBeVisible();
  });

  it('offers a session that may only read no act at all', async () => {
    open({}, ['hub.read']);
    await table();
    expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Make order/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Close this vendor' })).toBeNull();
    // The parcels are still there to be looked at.
    expect(within(await table()).getByText('Parcel 2')).toBeVisible();
  });

  // Break caught: an order offered for a parcel that arrived while the vendor is still being checked in (the server would refuse it and the officer would not know why).
  it('does not offer an order for an arrived parcel while the vendor is not cleared, and says why', async () => {
    const { user } = open({}, OFFICER, 'AWAITING_COUNT');
    await table();
    expect(within(await table()).queryByRole('link', { name: /Make order: Parcel 2/ })).toBeNull();
    await user.click(within(await table()).getByRole('button', { name: /Parcel 2/ }));
    expect(await screen.findByText(/This vendor is not cleared for orders yet\./)).toBeVisible();
  });

  // Break caught: a closed vendor offered orders, or no way to its summary.
  it('leads a closed vendor to its summary and offers no order', async () => {
    open({}, OFFICER, 'CLOSED');
    await table();
    expect(screen.getByRole('link', { name: 'See the summary' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR_ID}/summary`,
    );
    expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
    expect(
      screen.getByText('This vendor is closed. Its orders can no longer be changed here.'),
    ).toBeVisible();
  });

  it('asks for the view the officer chose, from the server', async () => {
    const { user } = open();
    await table();
    await user.click(screen.getByRole('tab', { name: /Confirmed/ }));
    await waitFor(() => {
      expect(listReads().some((read) => read.get('view') === 'itemized')).toBe(true);
    });
  });

  it('closes a vendor whose parcels all have an order, as the main act', async () => {
    open({
      [LIST]: () =>
        json(
          200,
          worklistOf([parcelRow(1, 'ITEMIZED')], {
            needs_order: 0,
            awaiting_arrival: 0,
            itemized: 3,
            orders: 3,
          }),
        ),
    });
    await table();
    expect(
      await screen.findByText(
        'Every parcel that arrived has an order. Close the vendor when you are done.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Close this vendor' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
  });

  // Break caught: a payment due left unsaid on a row that waits for it.
  it('says that payment is due on an order that waits for it', async () => {
    open({
      [LIST]: () =>
        json(
          200,
          worklistOf(
            [
              parcelRow(1, 'ITEMIZED', {
                order: {
                  id: 'a0000001-0000-4000-8000-000000000001',
                  code: 'ACC-OR-2CD3FG',
                  recipient_name: 'Ama Mensah',
                  service_area: 'ACCRA_TEMA',
                  size_class: 'SMALL',
                  commercial_state: 'PAYMENT_REQUIRED',
                  confirmed: true,
                  payment_required: true,
                },
              }),
            ],
            { payment_required: 1 },
          ),
        ),
    });
    expect(await within(await table()).findByText('Payment due')).toBeVisible();
  });
});

describe('a vendor whose check-in is still open: the early orders (Run G2, Part 2, item 1; D-D6, OB-S1-169 item 9)', () => {
  // The vendor's three parcels are not checked in yet: one has an order made from its photo, two have none.
  const NOT_HERE = Array.from({ length: 3 }, (_, index) => parcelFixture(index + 1));
  const ROWS_EARLY = [
    parcelRow(1, 'PREPARED', { parcelState: 'EXPECTED' }),
    parcelRow(2, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED' }),
    parcelRow(3, 'AWAITING_ARRIVAL', { parcelState: 'EXPECTED' }),
  ];
  const PROGRESS_EARLY = {
    received: 0,
    awaiting_arrival: 3,
    needs_order: 0,
    prepared: 1,
    itemized: 0,
    orders: 1,
  };
  const early = (
    handlers: Record<string, Handler> = {},
    keys: readonly string[] = OFFICER,
    progress: Record<string, unknown> = PROGRESS_EARLY,
  ) =>
    open(
      {
        [RECORD]: () =>
          json(200, checkInFixture(NOT_HERE, { id: VENDOR_ID, state: 'AWAITING_COUNT' }), {
            ETag: '"v1"',
          }),
        [LIST]: () =>
          json(
            200,
            worklistOf(ROWS_EARLY, progress, {
              intake_state: 'AWAITING_COUNT',
            }),
          ),
        ...handlers,
      },
      keys,
      'AWAITING_COUNT',
    );

  // Break caught: a vendor whose check-in is open that opens on "Needs an order" (nothing is there: the parcels that are here cannot be ordered yet), so that the one thing an officer can do, the early orders, is a tab away.
  it('opens on the parcels that are not here yet', async () => {
    early();
    await table();
    expect(listReads()[0]?.get('view')).toBe('awaiting_arrival');
    const views = within(screen.getByRole('tablist', { name: 'Views of the orders' }));
    expect(views.getByRole('tab', { name: /Not here yet/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // The other views are still there.
    expect(views.getByRole('tab', { name: /Needs an order/ })).toBeVisible();
  });

  // Break caught: no way to the next order while the check-in is open (the page offered it only to a vendor that is cleared), or a close offered to a vendor that is still being checked in.
  it('offers the next order, and no close, to an officer who may make orders', async () => {
    early();
    await table();
    expect(screen.getByRole('link', { name: 'Make the next order' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR_ID}/orders/new`,
    );
    expect(screen.queryByRole('link', { name: 'Close this vendor' })).toBeNull();
    // Each parcel that is not here yet and has no order has its own act.
    expect(within(await table()).getByRole('link', { name: /Make order: Parcel 2/ })).toBeVisible();
  });

  // Break caught: a note that says the parcels that are here can be ordered once the check-in is finished and says nothing of what can be done now.
  it('says that the parcels that are not here yet can be ordered now, and what happens at the check-in', async () => {
    early();
    await table();
    expect(
      await screen.findByText(/You can make orders now for the parcels that are not here yet/),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  // Break caught: the next order offered to a session that may only read, or when there is no parcel left that is not here yet.
  it('offers the next order to nobody who may not make orders, and when no parcel is left that is not here yet', async () => {
    early({}, ['hub.read']);
    await table();
    expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
  });

  it('offers no next order when no parcel is left that is not here yet', async () => {
    early({}, OFFICER, { ...PROGRESS_EARLY, awaiting_arrival: 0, received: 3, prepared: 0 });
    await table();
    expect(screen.queryByRole('link', { name: 'Make the next order' })).toBeNull();
  });
});

describe('the order of a parcel that is missing (Run G2, Part 2, item 1; D-D6, D-S7-4)', () => {
  const ORDER_OF_MISSING = {
    id: 'a0000003-0000-4000-8000-000000000003',
    code: 'ACC-OR-6NP7QR',
    recipient_name: 'Ama Mensah',
    service_area: 'ACCRA_TEMA',
    size_class: 'SMALL',
    commercial_state: null,
    confirmed: false,
    payment_required: false,
  };
  const WRITTEN_OFF_FINDING = {
    id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    kind: 'ADJUDICATION',
    intake_parcel_id: null,
    condition: null,
    outcome: 'WRITTEN_OFF',
    note: 'The vendor was told and the parcel did not come.',
    evidence_ids: [],
    recorded_by_name: 'Kojo Mensah',
    recorded_at: '2026-11-14T11:00:00Z',
  };
  const missing = (findings: readonly unknown[] = []) =>
    open(
      {
        [RECORD]: () =>
          json(
            200,
            checkInFixture(PARCELS, {
              id: VENDOR_ID,
              state: 'ITEMIZING',
              condition_findings: findings,
            }),
            { ETag: '"v1"' },
          ),
        [LIST]: () =>
          json(
            200,
            worklistOf(
              [parcelRow(3, 'MISSING', { order: ORDER_OF_MISSING, parcelState: 'MISSING' })],
              { received: 2, missing: 1, needs_order: 0, prepared: 1, itemized: 2, orders: 3 },
            ),
          ),
      },
      OFFICER,
      'ITEMIZING',
    );

  // Break caught: a parcel that is missing whose order says only "Missing" (an officer who opens it cannot tell that the order will not go out, or what would change that), or is offered no way to the order.
  it('says that the order will not go out unless the parcel is found, with the way to the order', async () => {
    const { user } = missing();
    await user.click(within(await table()).getByRole('button', { name: /Parcel 3/ }));
    expect(
      await screen.findByText(
        'Parcel missing — this order will not go out unless the parcel is found.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open order' })).toHaveAttribute(
      'href',
      `/orders/${ORDER_OF_MISSING.id}`,
    );
  });

  // Break caught: a parcel that was written off still told as one that may be found (the order would be left as a promise), or an order of a parcel that was written off with no word of what it is.
  it('says that the parcel was not received once the vendor’s missing parcels are written off', async () => {
    const { user } = missing([WRITTEN_OFF_FINDING]);
    await user.click(within(await table()).getByRole('button', { name: /Parcel 3/ }));
    expect(
      await screen.findByText(
        'Parcel not received — the order stays on record, with no price to pay, and will not go out.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/this order will not go out unless the parcel is found/)).toBeNull();
  });
});

describe('a vendor counted without photos', () => {
  const blindOpen = (
    rows: readonly unknown[],
    progress: Record<string, unknown>,
    keys: readonly string[] = OFFICER,
  ) =>
    open(
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
        [LIST]: () => json(200, worklistOf(rows, progress, { receiving_mode: 'BLIND_COUNT' })),
      },
      keys,
    );

  // Break caught (Run G1, Part 2, item 9): a vendor counted without photos named by its run (a read of its own, for this page alone) or not named at all: the record names it, and nothing else is read for the name.
  it('is named by the vendor the record names, with no other read for the name', async () => {
    open({
      [RECORD]: () =>
        json(
          200,
          { ...captured('intake-blind-named'), id: VENDOR_ID, state: 'ITEMIZING' },
          { ETag: '"v1"' },
        ),
      [LIST]: () =>
        json(
          200,
          worklistOf(
            [blindRow(1)],
            { received: 3, needs_order: 2, itemized: 1, orders: 1, awaiting_arrival: 0 },
            { receiving_mode: 'BLIND_COUNT' },
          ),
        ),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Orders for Fixture Sender' }),
    ).toBeVisible();
  });

  // Break caught: how many more orders are needed worked out by the page, or the count awaited drawn as zero.
  it('says how many more orders are needed, as the server counted them', async () => {
    blindOpen([blindRow(1)], {
      received: 3,
      needs_order: 2,
      itemized: 1,
      orders: 1,
      awaiting_arrival: 0,
    });
    expect(await screen.findByText(/2 more orders needed\./)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Make an order' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR_ID}/orders/new`,
    );
  });

  it('says that the count is awaited when the server has none', async () => {
    blindOpen([], {
      received: null,
      needs_order: null,
      itemized: 0,
      orders: 0,
      awaiting_arrival: 0,
    });
    expect(
      await screen.findByText(
        'The count has not been recorded yet, so how many orders are needed is not known.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Make an order' })).toBeNull();
  });

  it('says that every parcel has its order, and leads to the close', async () => {
    blindOpen([blindRow(1)], {
      received: 1,
      needs_order: 0,
      itemized: 1,
      orders: 1,
      awaiting_arrival: 0,
    });
    expect(await screen.findByText(/The parcel has its order\./)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Close this vendor' })).toBeVisible();
  });
});

describeInterfaceStates('the orders of a vendor', {
  loading: {
    test: async () => {
      open({ [LIST]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText(/Loading parcels/)).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open({
        [LIST]: () =>
          json(
            200,
            worklistOf([], { needs_order: 0, awaiting_arrival: 0, itemized: 0, orders: 0 }),
          ),
      });
      expect(await screen.findByRole('heading', { name: 'No parcels yet' })).toBeVisible();
      expect(screen.getByText('Every parcel that arrived has an order.')).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open({
        [LIST]: () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: '/view', rule: 'enum' }],
          }),
      });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'That view was not accepted. Choose one of the views.',
        );
      });
    },
  },
  error: {
    test: async () => {
      open({ [LIST]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('The orders could not be read.');
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [LIST]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, worklistOf(ROWS, { needs_order: 1, awaiting_arrival: 1, itemized: 1 }));
        },
      });
      await user.click(await screen.findByRole('button', { name: 'Retry' }));
      expect(within(await table()).getByText('Parcel 2')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The orders page changes nothing: an act is taken on the pages of the form, the order and the close, which tell a version that changed there.',
  },
  success: {
    test: async () => {
      open();
      expect(within(await table()).getByText('Parcel 2')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [LIST]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your account can’t see what has been handed over at a hub.',
        );
      });
    },
  },
});

describe('a parcel the officer is waiting on the vendor’s details for (Run G1, Part 2, item 4; D-S7-12)', () => {
  const MARK = {
    since: '2026-11-24T10:30:00.000Z',
    note: 'Called the vendor, waiting on WhatsApp',
  };
  const WAITING_LIST = worklistOf(
    [
      parcelRow(1, 'ITEMIZED'),
      parcelRow(2, 'NEEDS_ORDER', { waiting: MARK }),
      parcelRow(3, 'NEEDS_ORDER'),
    ],
    { needs_order: 2, itemized: 1, orders: 1, waiting_for_vendor: 1 },
  );
  const handlers = (): Record<string, Handler> => ({
    [LIST]: (request) => {
      const view = new URL(request.url).searchParams.get('view');
      return json(
        200,
        view === 'waiting_for_vendor'
          ? { ...WAITING_LIST, items: [WAITING_LIST.items[1]] }
          : WAITING_LIST,
      );
    },
  });

  // Break caught: a parcel the officer is waiting on that the other officers cannot see on the vendor's page; a tab with no count (or the count worked out by the page); a view the server is not asked for.
  it('has a tab of its own with the server’s count, and says on the parcel’s row that it is waited on, with the note', async () => {
    const { user } = open(handlers());
    const views = within(await screen.findByRole('tablist', { name: 'Views of the orders' }));
    const tab = await views.findByRole('tab', { name: /Waiting for the vendor’s details/ });
    expect(tab).toHaveTextContent('1');
    // The parcel's row, in the list as it opens, says it and says what was asked and how.
    const rows = within(await screen.findByRole('table', { name: 'Parcels and orders' }));
    expect(await rows.findByText('Waiting for the vendor’s details')).toBeVisible();
    expect(rows.getByText('Called the vendor, waiting on WhatsApp')).toBeVisible();
    // The tab asks the server for its view, and lists the parcels that wait.
    await user.click(tab);
    await waitFor(() => {
      expect(
        api.requests.some(
          (request) =>
            new URL(request.url).searchParams.get('view') === 'waiting_for_vendor' &&
            new URL(request.url).pathname.endsWith('/orders'),
        ),
      ).toBe(true);
    });
    expect(await screen.findByText('Called the vendor, waiting on WhatsApp')).toBeVisible();
  });

  // Break caught: a count drawn as zero for a server that did not give one, so that the tab says "0" over parcels that wait.
  it('draws no count on the tab when the server did not give one', async () => {
    open({
      [LIST]: () =>
        json(200, {
          ...WAITING_LIST,
          progress: { ...WAITING_LIST.progress, waiting_for_vendor: null },
        }),
    });
    const views = within(await screen.findByRole('tablist', { name: 'Views of the orders' }));
    const tab = await views.findByRole('tab', { name: /Waiting for the vendor’s details/ });
    expect(tab.textContent).not.toMatch(/\d/);
  });

  // Break caught: a tab of parcels that wait for a vendor counted without photos, which has no parcel to mark.
  it('has no such tab for a vendor counted without photos', async () => {
    open({
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
      ['GET /receiving-runs/' + MANIFEST_ID]: () =>
        json(200, runFixture([blindVendorFixture({ intake_id: VENDOR_ID })])),
      [LIST]: () =>
        json(
          200,
          worklistOf(
            [blindRow(1)],
            { needs_order: 2, orders: 1, itemized: 1, received: 3 },
            { receiving_mode: 'BLIND_COUNT' },
          ),
        ),
    });
    const views = within(await screen.findByRole('tablist', { name: 'Views of the orders' }));
    expect(views.queryByRole('tab', { name: /Waiting for the vendor’s details/ })).toBeNull();
  });
});

describe('the next order while the check-in is open (Run F, Part 2, item 5; changed by Run G2, Part 2, item 1)', () => {
  // Break caught: an order offered for a parcel that is here while the vendor is still being checked in: the form it leads to ends in a refusal, and nothing said why at the top of the page. Run F offered no next order
  // at all; since the early orders (D-D6) it is offered for the parcels that are not here yet, and the parcels that are here still wait, which the page says.
  it('offers no order for the parcels that are here until the vendor is cleared, and says why at the top', async () => {
    open({}, OFFICER, 'AWAITING_COUNT');
    await table();
    expect(within(await table()).queryByRole('link', { name: /Make order: Parcel 2/ })).toBeNull();
    expect(screen.getByText(/The parcels that are here can be ordered once it is\./)).toBeVisible();
  });
});

describe('the count of "All" (Run F, Part 2, item 15)', () => {
  // Break caught: "All 0" over a vendor with three parcels: the count of the view that lists every parcel was the number of orders. It is what the view lists.
  it('counts what the view lists: the parcels of a vendor with door photos', async () => {
    open({
      [LIST]: () =>
        json(
          200,
          worklistOf(ROWS, {
            needs_order: 1,
            awaiting_arrival: 1,
            itemized: 1,
            orders: 0,
            missing: 1,
          }),
        ),
    });
    await table();
    const views = within(screen.getByRole('tablist', { name: 'Views of the orders' }));
    const all = views.getByRole('tab', { name: /^All/ });
    expect(all).toHaveTextContent('All');
    // The parcels that are here (the progress says one received), not here yet (one) and missing (one): three, not the zero orders.
    expect(all).not.toHaveTextContent(/All\s*0$/);
  });
});
