import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  captured,
  correctionOf,
  EARLY_ORDER_ID,
  ORDER_CODE,
  ORDER_ID,
  orderOf,
} from '../../../test-support/orders-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/orders/{id}` (`getOrder`; S1.40): **the record of one order, read as one snapshot with its history and its version.** It says what the order holds, the price told as what it is (a price calculated and kept
 * until the order is confirmed, or the price fixed), who pays, and what happened to it, each change with who made it and why and never the values. Acts are offered by key and by what the record says: *Change
 * this order* while its price is not fixed, *Change who pays* once it is, *Take back the arrival* for a senior officer.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const OFFICER = ['hub.read', 'hub.intake.itemize', 'pricing.read', 'pricing.correction.create'];
const SENIOR = [...OFFICER, 'hub.osd.adjudicate'];
const READ = (id: string) => `GET /orders/${id}`;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|terms_token|token)\b/i;

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  body: unknown,
  keys: readonly string[] = OFFICER,
  handlers: Record<string, Handler> = {},
  id = ORDER_ID,
  state?: unknown,
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [READ(id)]: () => json(200, body, { ETag: '"o1"' }),
      ...handlers,
    }),
  );
  return renderApp(state === undefined ? `/orders/${id}` : { pathname: `/orders/${id}`, state });
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}` === route,
  );
const bodyOf = async (request: Request | undefined): Promise<unknown> =>
  request === undefined ? undefined : ((await request.clone().json()) as unknown);
const dialog = async (): Promise<HTMLElement> => screen.findByRole('alertdialog');

describe('an order whose price is fixed', () => {
  // Break caught: a fixed price drawn as a quote (or the other way), the portions not shown, a phone drawn nowhere, or an act drawn for a key that is not held.
  it('shows the fixed price, who pays, what it holds and what the officer may do', async () => {
    open(orderOf('frozen'));
    expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    expect(screen.getByText('Confirmed: its price is fixed.')).toBeVisible();
    const price = within(screen.getByRole('region', { name: 'The price' }));
    expect(price.getByText('Fixed price').nextElementSibling).toHaveTextContent('GH₵35.00');
    expect(price.queryByText('Calculated price (not fixed)')).toBeNull();
    const payer = within(screen.getByRole('region', { name: 'Who pays' }));
    expect(payer.getByText('The recipient pays').nextElementSibling).toHaveTextContent('GH₵35.00');
    expect(payer.getByText('The sender pays').nextElementSibling).toHaveTextContent('GH₵0.00');
    const holds = within(screen.getByRole('region', { name: 'What it holds' }));
    expect(holds.getByText('Ama Mensah')).toBeVisible();
    expect(holds.getByText('Small')).toBeVisible();
    // The price is fixed: the order is not changed here, who pays is a correction.
    expect(screen.queryByRole('link', { name: 'Change this order' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change who pays' })).toBeVisible();
    // The officer has no key to take back an arrival, and is told who does.
    expect(screen.queryByRole('button', { name: 'Take back the arrival' })).toBeNull();
    expect(screen.getByText('A senior officer takes back an arrival.')).toBeVisible();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: a take-back that does not say that no more orders can be made for the vendor until a senior officer decides (an officer finds out when the form refuses).
  it('says in the take-back that no more orders can be made for the vendor until a senior officer decides', async () => {
    const { user } = open(orderOf('frozen'), SENIOR);
    await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
    expect(
      within(await dialog()).getByText(
        /No more orders can be made for this vendor until a senior officer decides\./,
      ),
    ).toBeVisible();
  });

  it('offers a senior officer the arrival to take back', async () => {
    open(orderOf('frozen'), SENIOR);
    expect(await screen.findByRole('button', { name: 'Take back the arrival' })).toBeVisible();
    expect(screen.queryByText('A senior officer takes back an arrival.')).toBeNull();
  });

  // Break caught: a reversal without a reason, sent without the version of the order, or one that leaves the record as it was.
  it('takes back an arrival with a reason, on the version read, and says what it did', async () => {
    let reads = 0;
    const { user } = open(orderOf('frozen'), SENIOR, {
      [READ(ORDER_ID)]: () => {
        reads += 1;
        // The reload answers for the same order, taken back: the captured reversed order is another order, so it is given this one's identity.
        const body =
          reads === 1
            ? orderOf('frozen')
            : { ...orderOf('reversed'), id: ORDER_ID, code: ORDER_CODE };
        return json(200, body, { ETag: reads === 1 ? '"o1"' : '"o2"' });
      },
      [`POST /orders/${ORDER_ID}/arrival-reversal`]: () =>
        json(200, { ...captured('reversal'), order_id: ORDER_ID }),
    });
    await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
    const asked = within(await dialog());
    // The reason is required.
    await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));
    expect(await asked.findByText('Write why the arrival is being taken back.')).toBeVisible();
    expect(sent(`POST /orders/${ORDER_ID}/arrival-reversal`)).toHaveLength(0);
    await user.type(
      asked.getByLabelText(/Why is the arrival being taken back\?/),
      'The parcel was not on the table',
    );
    await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));

    expect(
      await screen.findByText(/The arrival was taken back\. The vendor now counts/),
    ).toBeVisible();
    const request = sent(`POST /orders/${ORDER_ID}/arrival-reversal`)[0];
    expect(request?.headers.get('If-Match')).toBe('"o1"');
    expect(request?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await bodyOf(request)).toEqual({ note: 'The parcel was not on the table' });
    // The record is read again: the order is taken back, and no act is offered on it.
    await waitFor(() => {
      expect(screen.getByText('Taken back')).toBeVisible();
    });
    expect(screen.queryByRole('button', { name: 'Take back the arrival' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change who pays' })).toBeNull();
  });

  // Break caught: a proposal sent as a portion of the price (the page works the money out), no reason, or a split with no way of sharing.
  it('asks to change who pays by intent and reason, on the version read, and leads to the request', async () => {
    const requested = correctionOf();
    const { user } = open(orderOf('frozen'), OFFICER, {
      [`POST /orders/${ORDER_ID}/payer-correction`]: () =>
        json(201, { ...requested, order_id: ORDER_ID }, { ETag: '"c1"' }),
      [READ(ORDER_ID)]: () => json(200, orderOf('frozen'), { ETag: '"o1"' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Change who pays' }));
    const asked = within(await dialog());
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));
    expect(await asked.findByText('Choose who pays.')).toBeVisible();
    await user.click(asked.getByRole('radio', { name: 'The sender pays all of it' }));
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));
    expect(await asked.findByText('Write why who pays should change.')).toBeVisible();
    await user.type(
      asked.getByLabelText(/Why should it change\?/),
      'The vendor will pay on the phone',
    );
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));

    expect(
      await screen.findByText(/The change was asked for\. A senior officer decides it\./),
    ).toBeVisible();
    const request = sent(`POST /orders/${ORDER_ID}/payer-correction`)[0];
    expect(request?.headers.get('If-Match')).toBe('"o1"');
    expect(await bodyOf(request)).toEqual({
      proposed: { payer_intent: 'SENDER_PAYS_FULL' },
      note: 'The vendor will pay on the phone',
    });
    expect(screen.getByRole('link', { name: 'Open the correction' })).toHaveAttribute(
      'href',
      `/payer-corrections/${requested.id as string}`,
    );
  });

  it('asks how a split is shared, and sends the sender’s share as it was typed', async () => {
    const { user } = open(orderOf('frozen'), OFFICER, {
      [`POST /orders/${ORDER_ID}/payer-correction`]: () =>
        json(201, { ...correctionOf(), order_id: ORDER_ID }, { ETag: '"c1"' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Change who pays' }));
    const asked = within(await dialog());
    await user.click(
      asked.getByRole('radio', { name: 'Split between the sender and the recipient' }),
    );
    await user.click(asked.getByRole('radio', { name: 'A fixed amount' }));
    await user.type(asked.getByLabelText(/The sender pays \(GH₵\)/), '10.00');
    await user.type(asked.getByLabelText(/Why should it change\?/), 'Shared as agreed');
    await user.click(asked.getByRole('button', { name: 'Ask for the change' }));
    await screen.findByText(/The change was asked for\./);
    expect(await bodyOf(sent(`POST /orders/${ORDER_ID}/payer-correction`)[0])).toEqual({
      proposed: {
        payer_intent: 'SPLIT',
        split_basis: 'FIXED_AMOUNT',
        split_sender_amount: { amount_minor: 1000, currency: 'GHS' },
      },
      note: 'Shared as agreed',
    });
  });
});

describe('an order that waits for its parcel', () => {
  // Break caught: a quote drawn as a fixed price, or an order that waits drawn as one that cannot be changed.
  it('shows the price as calculated, not fixed, and offers the change', async () => {
    open(orderOf('early'), OFFICER, {}, EARLY_ORDER_ID);
    expect(
      await screen.findByText(/Made before the parcel was checked in for good\./),
    ).toBeVisible();
    const price = within(screen.getByRole('region', { name: 'The price' }));
    expect(price.getByText('Calculated price (not fixed)').nextElementSibling).toHaveTextContent(
      'GH₵35.00',
    );
    expect(price.queryByText('Fixed price')).toBeNull();
    expect(screen.getByRole('link', { name: 'Change this order' })).toHaveAttribute(
      'href',
      `/orders/${EARLY_ORDER_ID}/amend`,
    );
    // Who pays is worked out when the order is confirmed.
    expect(screen.getByText('Worked out when the order is confirmed.')).toBeVisible();
  });

  it('does not offer the change to a session that may not make orders', async () => {
    open(orderOf('early'), ['hub.read', 'pricing.read'], {}, EARLY_ORDER_ID);
    await screen.findByText(/Made before the parcel was checked in for good\./);
    expect(screen.queryByRole('link', { name: 'Change this order' })).toBeNull();
  });
});

describe('an order the change page has just saved', () => {
  // Break caught: a change saved with no word of it where the officer lands, or a word that is said again on every return to the page.
  it('says the order was changed, where the officer lands, and takes the word off the history', async () => {
    const { router } = open(orderOf('early'), OFFICER, {}, EARLY_ORDER_ID, {
      amended: 'ACC-OR-UA7K72',
    });
    expect(await screen.findByText('Order ACC-OR-UA7K72 was changed.')).toBeVisible();
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    // The word is read once: it is on the screen still, and the history no longer holds it.
    expect(screen.getByText('Order ACC-OR-UA7K72 was changed.')).toBeVisible();
  });

  // Break caught: a history state drawn as it is (it is the browser's, and holds whatever put it there).
  it('draws nothing from a history state that is not a code', async () => {
    open(orderOf('early'), OFFICER, {}, EARLY_ORDER_ID, {
      amended: '<b>Order made</b> by someone else',
    });
    expect(await screen.findByRole('heading', { level: 1, name: /ACC-OR-/ })).toBeVisible();
    expect(screen.queryByText(/was changed\./)).toBeNull();
    expect(document.body.textContent).not.toContain('someone else');
  });
});

describe('what happened to an order', () => {
  // Break caught: the values of a change drawn (they hold a person's details), or a history that loses who changed what and why.
  it('says what changed and why, and never the values', async () => {
    open(
      orderOf('early', {
        amendments: [
          {
            id: 'a1111111-2222-4333-8444-555555555555',
            amended_by: 'b1111111-2222-4333-8444-555555555555',
            amended_at: '2026-11-22T09:15:00.000Z',
            note: 'The recipient moved',
            changed: ['recipient', 'size_class'],
          },
        ],
      }),
      OFFICER,
      {},
      EARLY_ORDER_ID,
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'What happened' })).toBeVisible();
    const history = within(screen.getByRole('list', { name: 'What happened of the record' }));
    expect(history.getByText('Changed: the recipient and the size.')).toBeVisible();
    expect(history.getByText(/Reason: The recipient moved/)).toBeVisible();
    expect(history.getByText(/09:15/)).toBeVisible();
  });
});

describeInterfaceStates('the record of an order', {
  loading: {
    test: async () => {
      open(null, OFFICER, { [READ(ORDER_ID)]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the order…')).toBeVisible();
    },
  },
  empty: {
    inapplicable:
      'A record is never empty: an order that does not exist is the not-found page, which is tested below.',
  },
  'validation error': {
    test: async () => {
      const { user } = open(orderOf('frozen'));
      await user.click(await screen.findByRole('button', { name: 'Change who pays' }));
      await user.click(within(await dialog()).getByRole('button', { name: 'Ask for the change' }));
      expect(await within(await dialog()).findByText('Choose who pays.')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(null, OFFICER, { [READ(ORDER_ID)]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('This order could not be loaded.');
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(null, OFFICER, {
        [READ(ORDER_ID)]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : json(200, orderOf('frozen'), { ETag: '"o1"' });
        },
      });
      await user.click(await screen.findByRole('button', { name: /Try again|Retry/ }));
      expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const { user } = open(orderOf('frozen'), SENIOR, {
        [`POST /orders/${ORDER_ID}/arrival-reversal`]: () =>
          refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
      });
      await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
      const asked = within(await dialog());
      await user.type(
        asked.getByLabelText(/Why is the arrival being taken back\?/),
        'Not on the table',
      );
      await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));
      expect(
        await asked.findByText(/This order changed after you opened it, so nothing was changed\./),
      ).toBeVisible();
    },
  },
  success: {
    test: async () => {
      open(orderOf('frozen'));
      expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      // The route lets the session in (it holds the key the page asks for) and the API refuses the read: the refusal is told as what the account cannot do, in the table's words.
      open(null, OFFICER, { [READ(ORDER_ID)]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your account can’t see the price of an order.',
        );
      });
      expect(screen.queryByRole('heading', { level: 1, name: ORDER_CODE })).toBeNull();
    },
  },
});

describe('a session that may not read a price', () => {
  // Break caught: the order read for a session whose key does not open the page (the route is the screen's half; the server's refusal is the other).
  it('is stopped at the route, and the order is not read', async () => {
    open(orderOf('frozen'), ['hub.read']);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    expect(screen.getByText(/Your account can’t see the price of an order\./)).toBeVisible();
    expect(sent(READ(ORDER_ID))).toHaveLength(0);
  });
});

describe('an order that is not there', () => {
  it('is told as one, with no figure drawn', async () => {
    open(null, OFFICER, { [READ(ORDER_ID)]: () => refusal(404, 'NOT_FOUND') });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'This order could not be found.' }),
    ).toBeVisible();
  });
});

describe('the order changed after it was opened (Run F, Part 2, item 4)', () => {
  // Break caught: every order page telling every officer that the order changed after they opened it, with a Reload, the moment it opens, when nothing has said so (the page passed its conflict to the template
  // whatever had happened).
  it('is not said when the order has just been read', async () => {
    open(orderOf('frozen'));
    expect(await screen.findByRole('heading', { level: 1, name: ORDER_CODE })).toBeVisible();
    expect(screen.queryByText(/changed after you opened it/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  // Break caught: a refusal as stale that the page behind the dialog never says, so that the officer who closes the dialog is left looking at an order that is not as it is now.
  it('is said once an act of the page is refused as stale', async () => {
    const { user } = open(orderOf('frozen'), SENIOR, {
      [`POST /orders/${ORDER_ID}/arrival-reversal`]: () =>
        refusal(409, 'STATE_CONFLICT', { rule: 'stale' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Take back the arrival' }));
    const asked = within(await dialog());
    await user.type(
      asked.getByLabelText(/Why is the arrival being taken back\?/),
      'Not on the table',
    );
    await user.click(asked.getByRole('button', { name: 'Take back the arrival' }));
    await asked.findByText(/This order changed after you opened it, so nothing was changed\./);
    await waitFor(() => {
      expect(document.body.textContent).toContain('Reload to see it as it is now.');
    });
  });
});
