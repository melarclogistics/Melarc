import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { parseSummary } from '../../../platform/hub-orders/orders-shape';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  feedFixture,
  notificationFixture,
  PLANTED_NUMBER,
  plantedIn,
  suppressedFixture,
} from '../../../test-support/notification-fixture';
import { captured, PARCELS, VENDOR_ID } from '../../../test-support/orders-fixture';
import { checkInFixture } from '../../../test-support/receiving-fixture';
import { renderApp } from '../../../test-support/render-app';
import { SummaryOrderCard } from './SummaryOrderCard';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/intakes/{id}/summary` (`getIntakeSummary`; S1.40; AC-SLICE-001-46): the orders the hub made for a closed vendor and where each stands, **and nothing of the receiving side**. A price is drawn only where the
 * server gave one (for staff, where their own pricing grant reaches the hub, OB-S1-155), and a price that is not given is said not to be one this account sees, never drawn as nothing. Beside it, what was said about
 * the close, as the worker recorded it. Each break named below is one these tests catch.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const OFFICER = ['hub.read', 'pickup.read', 'pricing.read', 'notification.read'];
const RECORD = `GET /hub-intakes/${VENDOR_ID}`;
const SUMMARY = `GET /hub-intakes/${VENDOR_ID}/summary`;
const MESSAGES = 'GET /notifications';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|terms_token|token)\b/i;

const summaryOf = (
  kind: 'officer' | 'no-price' = 'officer',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...captured(kind === 'officer' ? 'summary-officer' : 'summary-no-price'),
  intake_id: VENDOR_ID,
  ...overrides,
});
const page = (items: unknown[]) => json(200, { items, next_page_token: null });
/** The pickup the summary is about: the log is asked for it, and every entry it answers is about it. */
const ABOUT = {
  subject: { type: 'PICKUP_REQUEST' as const, id: summaryOf().pickup_request_id as string },
};

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handlers: Record<string, Handler> = {}, keys: readonly string[] = OFFICER) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [RECORD]: () =>
        json(200, checkInFixture(PARCELS, { id: VENDOR_ID, state: 'CLOSED' }), { ETag: '"v1"' }),
      [SUMMARY]: () => json(200, summaryOf()),
      [MESSAGES]: () => page([]),
      ...handlers,
    }),
  );
  return renderApp(`/intakes/${VENDOR_ID}/summary`);
}

const sent = (route: string) =>
  api.requests.filter(
    (request) =>
      `${request.method} ${new URL(request.url).pathname.replace('/api/v1', '')}` === route,
  );

describe('the summary of a vendor counted without photos (Run G1, Part 2, item 9)', () => {
  // Break caught: the summary of a vendor counted without photos titled by nothing.
  it('is named by the vendor the record names', async () => {
    open({
      [RECORD]: () =>
        json(
          200,
          { ...captured('intake-blind-named'), id: VENDOR_ID, state: 'CLOSED' },
          { ETag: '"v1"' },
        ),
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Summary for Fixture Sender' }),
    ).toBeVisible();
  });
});

describe('the summary of a closed vendor', () => {
  // Break caught: a summary that draws what the receiving side holds (the rider's number, the parcels, the count), a price worked out by the page, or an identifier on the screen.
  it('lists the orders made and where each stands, with the price the server gave, and nothing of the receiving side', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: /Summary for / })).toBeVisible();
    const orders = within(await screen.findByRole('table', { name: 'Order' }));
    expect(orders.getByText('ACC-OR-CMES2Q')).toBeVisible();
    expect(orders.getByText('ACC-OR-KV57UF')).toBeVisible();
    expect(orders.getAllByText('GH₵35.00')).toHaveLength(2);
    // An account that reads prices can open each order.
    expect(orders.getByRole('link', { name: 'ACC-OR-CMES2Q' })).toHaveAttribute(
      'href',
      '/orders/01a124d3-7400-7775-8393-569a1125faf5',
    );
    expect(orders.getByText('Nothing to pay: the sender is not charged')).toBeVisible();
    expect(orders.getByText('Waiting for payment')).toBeVisible();
    expect(screen.getByText(/Closed/)).toBeVisible();
    // The receiving side is not here: neither the rider's count nor the parcels, and no hint that prices are hidden.
    expect(screen.queryByText(/Prices are not shown to your account/)).toBeNull();
    expect(screen.queryByText(/declared|rider|handed over/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught: an absent price drawn as GH₵0.00 or as a dash (a missing figure is never zero), or hidden with no word of why.
  it('says prices are not shown to an account that does not see them, and draws no price and no zero', async () => {
    open({ [SUMMARY]: () => json(200, summaryOf('no-price')) }, ['hub.read', 'pickup.read']);
    const orders = within(await screen.findByRole('table', { name: 'Order' }));
    expect(orders.getByText('ACC-OR-CMES2Q')).toBeVisible();
    expect(orders.queryByRole('columnheader', { name: 'Price' })).toBeNull();
    // An account that does not read prices cannot open an order (the link would lead to a refusal), and so is offered none.
    expect(orders.queryByRole('link')).toBeNull();
    expect(
      screen.getByText(
        'Prices are not shown to your account. You can see the orders and where each stands.',
      ),
    ).toBeVisible();
    expect(document.body.textContent).not.toMatch(/GH₵\s?0(?:\.00)?\b/);
    expect(screen.queryByText(/GH₵/)).toBeNull();
  });

  // Break caught: a vendor that closed with nothing to order drawn as an empty table with no sentence, or as one that failed.
  it('says a vendor closed with no orders, as it is', async () => {
    open({ [SUMMARY]: () => json(200, summaryOf('officer', { orders: [] })) });
    expect(await screen.findByText('This vendor closed with no orders.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // Break caught: a vendor that is not closed shown as a failure, or a summary asked for it.
  it('says a vendor that is not closed has no summary', async () => {
    open({ [SUMMARY]: () => refusal(404, 'NOT_FOUND') });
    expect(
      await screen.findByText('This vendor is not closed yet, so it has no summary.'),
    ).toBeVisible();
  });
});

describe('what was said about the close', () => {
  // Break caught: a message said to have been sent that was held back, the reason lost, or a number, a text or a code of the message drawn (the log never has them).
  it('tells each message as the worker recorded it: sent, and held back with the reason', async () => {
    open({
      [MESSAGES]: () =>
        page([
          plantedIn(
            notificationFixture({
              ...ABOUT,
              message_kind: 'INTAKE_COMPLETED_SENDER',
              audience: 'AD_HOC_SENDER',
            }),
          ),
          suppressedFixture('KILL_SWITCH', {
            ...ABOUT,
            message_kind: 'INTAKE_COMPLETED_SENDER',
            audience: 'AD_HOC_SENDER',
          }),
          feedFixture({
            ...ABOUT,
            message_kind: 'INTAKE_COMPLETED_VENDOR_FEED',
            audience: 'VENDOR_FEED',
          }),
          // A message of another kind about the same pickup is not about the close.
          notificationFixture({ ...ABOUT, message_kind: 'PICKUP_CONFIRMED_SENDER' }),
        ]),
    });
    const panel = within(await screen.findByRole('region', { name: 'What was said about this' }));
    const entries = await panel.findAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(panel.getAllByText(/Check-in finished/)).toHaveLength(3);
    expect(panel.getByText('Switched off')).toBeVisible();
    expect(panel.getByText('The provider accepted it')).toBeVisible();
    expect(panel.queryByText(/Pickup request confirmed/)).toBeNull();
    expect(panel.getByRole('link', { name: 'Open the message log' })).toHaveAttribute(
      'href',
      expect.stringContaining('/messages?subject='),
    );
    // The message was asked for by the pickup it is about, and nothing of a number is on the page.
    expect(new URL(sent(MESSAGES)[0]?.url ?? 'http://x/').searchParams.get('subject_id')).toBe(
      summaryOf().pickup_request_id,
    );
    expect(document.body.textContent).not.toContain(PLANTED_NUMBER);
  });

  // Break caught: nothing said as if the message was lost (the worker may not have run yet), or an invented entry.
  it('says nothing has been recorded yet, and invents nothing', async () => {
    open();
    const panel = within(await screen.findByRole('region', { name: 'What was said about this' }));
    expect(await panel.findByText('No message about this has been recorded yet.')).toBeVisible();
    expect(panel.queryByRole('listitem')).toBeNull();
  });

  // Break caught: the log asked for by an account that may not read it (a refusal of the log shown as a failure of the summary), or a panel for it.
  it('is not drawn, and the log is not asked, for an account that may not read the messages', async () => {
    open({}, ['hub.read', 'pickup.read', 'pricing.read']);
    await screen.findByRole('table', { name: 'Order' });
    expect(screen.queryByRole('region', { name: 'What was said about this' })).toBeNull();
    expect(sent(MESSAGES)).toHaveLength(0);
  });

  // Break caught: a refusal of the log taking the summary with it (the orders are the page; what was said is beside them).
  it('keeps the orders when the log cannot be read', async () => {
    open({ [MESSAGES]: () => refusal(500, 'INTERNAL_ERROR') });
    expect(await screen.findByRole('table', { name: 'Order' })).toBeVisible();
    const panel = within(await screen.findByRole('region', { name: 'What was said about this' }));
    expect(await panel.findByRole('alert')).toBeVisible();
    expect(screen.getByText('ACC-OR-CMES2Q')).toBeVisible();
  });
});

describeInterfaceStates('the summary of a closed vendor', {
  loading: {
    test: async () => {
      open({ [SUMMARY]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText('Loading the summary…')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open({ [SUMMARY]: () => json(200, summaryOf('officer', { orders: [] })) });
      expect(await screen.findByText('This vendor closed with no orders.')).toBeVisible();
    },
  },
  'validation error': {
    inapplicable: 'A summary is read and has no form: there is nothing to enter or to refuse.',
  },
  error: {
    test: async () => {
      open({ [SUMMARY]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('The summary could not be loaded.');
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [SUMMARY]: () => {
          attempts += 1;
          return attempts === 1 ? refusal(503, 'SERVICE_UNAVAILABLE') : json(200, summaryOf());
        },
      });
      await user.click(await screen.findByRole('button', { name: /Try again|Retry/ }));
      expect(await screen.findByRole('table', { name: 'Order' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'A summary is a read of a closed vendor, which no one changes: there is no version to be out of date.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByRole('table', { name: 'Order' })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [SUMMARY]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Your account can’t see pickup requests.',
        );
      });
    },
  },
});

describe('what the summary says of each order (Run F, Part 2, item 15 and D-S7-10)', () => {
  const withPortions = () => {
    const base = summaryOf() as { orders: Record<string, unknown>[] };
    return {
      ...base,
      orders: base.orders.map((order, index) => ({
        ...order,
        payer_allocation:
          index === 0
            ? { sender_minor: 0, recipient_minor: 3500 }
            : { sender_minor: 3500, recipient_minor: 0 },
      })),
    };
  };

  // Break caught: the area drawn as the server's code (ACCRA_TEMA), who pays left out of the summary of an account that sees the price, or a card (where the columns do not fit, 768 px) that drops the area, the size, the
  // price and who pays and keeps only the recipient and where it stands.
  it('names the area in the floor’s words, says who pays where the price is shown, and keeps every fact on the card', async () => {
    open({ [SUMMARY]: () => json(200, withPortions()) });
    const orders = within(await screen.findByRole('table', { name: 'Order' }));
    expect(orders.getAllByText('Accra & Tema').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/ACCRA_TEMA/);
    expect(orders.getByText('Sender GH₵0.00, recipient GH₵35.00')).toBeVisible();
    expect(orders.getByText('Sender GH₵35.00, recipient GH₵0.00')).toBeVisible();
  });

  // Break caught: a card (where the columns do not fit, 768 px) that drops the area, the size, the price and who pays and keeps only the recipient and where it stands.
  it('keeps every fact of the table on the card, and the price and who pays only where the price is shown', () => {
    const order = (withPortions().orders[0] ?? {}) as Record<string, unknown>;
    const parsed = parseSummary({ ...withPortions(), orders: [order] })?.orders[0];
    if (parsed === undefined) throw new Error('the order is not one the page reads');
    const { container, rerender } = render(<SummaryOrderCard order={parsed} showsPrices />);
    for (const fact of [
      'Accra & Tema',
      'Small',
      'GH₵35.00',
      'Sender GH₵0.00, recipient GH₵35.00',
    ]) {
      expect(container.textContent).toContain(fact);
    }
    rerender(<SummaryOrderCard order={parsed} showsPrices={false} />);
    expect(container.textContent).toContain('Accra & Tema');
    expect(container.textContent).not.toContain('GH₵');
  });

  // Break caught: who pays shown to an account that is not shown the price (an amount is money: absent, never zero).
  it('says nothing of who pays where the price is not shown', async () => {
    open({ [SUMMARY]: () => json(200, summaryOf('no-price')) });
    await screen.findByRole('table', { name: 'Order' });
    expect(screen.queryByText(/Sender GH₵/)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Who pays' })).toBeNull();
  });
});
