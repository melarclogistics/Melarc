import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID, preCountFixture } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { captured } from '../../../test-support/orders-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/orders-to-make` (`listHubIntakes`; S1.40): **the vendors a hub has cleared for their orders**, oldest handover first, in the server's views (ready to start, being worked), so that an officer finds the work
 * without remembering which vendors finished checking in. **How many orders are made is not on a row** (the list does not state it) and the page draws no figure it was not given. Each break named below is one
 * these tests catch.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const OFFICER = ['hub.read', 'hub.intake.itemize'];
const LIST = 'GET /hub-intakes';
const WORKED =
  (captured('intakes-itemizing') as { items: Record<string, unknown>[] }).items[0] ?? {};
const READY = { ...WORKED, state: 'READY_FOR_ITEMIZATION' };
const VENDOR = WORKED.id as string;
const BLIND_ID = 'b1b1b1b1-2222-4333-8444-555555555555';
const BLIND = {
  ...preCountFixture({ id: BLIND_ID }),
  state: 'ITEMIZING',
  count_phase: 'POST_COUNT',
  rider_declared_count: 3,
  physical_count: 3,
  count_variance: 'MATCH',
  count_difference: 0,
  condition: 'OK',
  condition_findings: [],
  parcel_photo_ids: [],
};
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|token)\b/i;

const pageOf = (items: readonly unknown[]) => ({ items: [...items], next_page_token: null });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

/** The list answers for the view it is asked for: the vendors waiting for a first order, or the ones being worked. */
const byState =
  (ready: readonly unknown[], worked: readonly unknown[]): Handler =>
  (request) =>
    json(
      200,
      pageOf(new URL(request.url).searchParams.get('state') === 'ITEMIZING' ? worked : ready),
    );

function open(handlers: Record<string, Handler> = {}, keys: readonly string[] = OFFICER) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [LIST]: byState([READY], [WORKED]),
      ...handlers,
    }),
  );
  return renderApp('/orders-to-make');
}

const reads = () =>
  api.requests
    .filter((request) => new URL(request.url).pathname === '/api/v1/hub-intakes')
    .map((request) => new URL(request.url).searchParams);

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Vendors with orders to make' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};

describe('the vendors with orders to make', () => {
  // Break caught: a count of the orders made drawn on a row (the list does not state it), the received count worked out by the page, a view that is not the server's filter.
  it('lists the vendors the server cleared, by what they received and how long ago they were handed over', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Orders to make' })).toBeVisible();
    const rows = within(await table());
    expect(rows.getByText('Fixture Sender')).toBeVisible();
    expect(rows.getByText('ACC-IN-TSWQVE')).toBeVisible();
    expect(rows.getAllByText('3 parcels').length).toBeGreaterThan(0);
    // The first view is what waits for its first order, and it is the server's filter.
    expect(reads()[0]?.get('state')).toBe('READY_FOR_ITEMIZATION');
    const views = within(screen.getByRole('tablist', { name: 'Views of the vendors' }));
    expect(views.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Ready to start',
      'Being worked',
    ]);
    // How many orders are made is on the vendor's own page, and the page says so.
    expect(screen.getByText('How many orders are made is on the vendor’s own page.')).toBeVisible();
    expect(rows.queryByText(/orders? made/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('asks the server for the view the officer chose', async () => {
    const { user } = open();
    await table();
    await user.click(screen.getByRole('tab', { name: 'Being worked' }));
    await waitFor(() => {
      expect(reads().some((read) => read.get('state') === 'ITEMIZING')).toBe(true);
    });
  });

  // Break caught: a vendor counted without photos shown with a name it does not have, or with the rider's number.
  it('names a vendor counted without photos by its code, and says how it was counted', async () => {
    const { user } = open({ [LIST]: byState([READY], [BLIND]) });
    await user.click(await screen.findByRole('tab', { name: 'Being worked' }));
    const rows = within(await table());
    expect(await rows.findByText('Counted without photos')).toBeVisible();
    expect(rows.queryByText('Fixture Sender')).toBeNull();
  });

  // Break caught: the act that leads on missing, leading to the wrong place, or offered to an account that may not see the vendor.
  it('opens the vendor beside the list with the one act that is next, which leads to its orders', async () => {
    const { user } = open();
    await user.click(
      within(await table()).getByRole('button', { name: 'Make orders for Fixture Sender' }),
    );
    const act = await screen.findByRole('link', { name: 'Make orders' });
    expect(act).toHaveAttribute('href', `/intakes/${VENDOR}/orders`);
    expect(screen.getByRole('link', { name: 'Fixture Sender' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR}`,
    );
    expect(screen.getByRole('link', { name: 'ACC-MF-SMU5WW' })).toBeVisible();
  });
});

describeInterfaceStates('the vendors with orders to make', {
  loading: {
    test: async () => {
      open({ [LIST]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText(/Loading/)).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open({ [LIST]: byState([], []) });
      expect(
        await screen.findByText(
          'No vendor is waiting for its first order. Vendors whose orders are being made are under Being worked.',
        ),
      ).toBeVisible();
    },
  },
  'validation error': {
    inapplicable:
      'The list has two views and no filter to type: a view that is not one of them is no filter.',
  },
  error: {
    test: async () => {
      open({ [LIST]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeVisible();
      });
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open({
        [LIST]: (request) => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SERVICE_UNAVAILABLE')
            : byState([READY], [WORKED])(request);
        },
      });
      await user.click(await screen.findByRole('button', { name: /Retry|Try again/ }));
      expect(within(await table()).getByText('Fixture Sender')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list changes nothing and holds no version: a vendor whose orders are all made is simply not in the next read.',
  },
  success: {
    test: async () => {
      open();
      expect(within(await table()).getByText('Fixture Sender')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [LIST]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeVisible();
      });
      expect(screen.queryByText('Fixture Sender')).toBeNull();
    },
  },
});
