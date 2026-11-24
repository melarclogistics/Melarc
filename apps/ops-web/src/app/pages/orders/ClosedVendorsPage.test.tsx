import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import { INTAKE_HUB_ID } from '../../../test-support/hub-intake-fixture';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { captured } from '../../../test-support/orders-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/closed-vendors` (`listClosedIntakeExceptions`; S1.40; OB-S1-151): **the work a close left behind is found again**, by another officer, after a reload or on the next shift. Each row is a vendor that was closed
 * with the approved exception and still has received parcels without an order. **Nothing here adds the missing orders** (a closed vendor cannot take more; the reopening is scheduled and not built), and the page
 * says so in words and draws no act it does not have. Each break named below is one these tests catch.
 */
const ACCRA = { id: INTAKE_HUB_ID, display_name: 'Accra Hub' };
const SENIOR = ['hub.read', 'hub.intake.close_exception', 'pickup.read'];
const LIST = 'GET /hub-intake-exceptions';
const ITEM = (captured('closed-exceptions') as { items: Record<string, unknown>[] }).items[0] ?? {};
const VENDOR = ITEM.intake_id as string;
const CODE = ITEM.intake_code as string;
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|the server|token)\b/i;

const pageOf = (items: readonly unknown[]) => ({ items: [...items], next_page_token: null });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handlers: Record<string, Handler> = {}, keys: readonly string[] = SENIOR) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: [ACCRA] }), {
      [LIST]: () => json(200, pageOf([ITEM])),
      ...handlers,
    }),
  );
  return renderApp('/closed-vendors');
}

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', {
    name: 'Vendors closed with parcels still to order',
  });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
const openFirst = async (user: ReturnType<typeof renderApp>['user']): Promise<void> => {
  await user.click(
    within(await table()).getByRole('button', { name: new RegExp(`Open the vendor: ${CODE}`) }),
  );
};

describe('the vendors closed with parcels still to order', () => {
  // Break caught: a vendor with nothing left listed, the parcels left worked out by the page, or the reason that was given lost.
  it('lists each vendor with what is left, as the server counted it, and the reason that was given', async () => {
    open();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Closed with parcels left' }),
    ).toBeVisible();
    const rows = within(await table());
    expect(rows.getByText(CODE)).toBeVisible();
    expect(rows.getByText('Checked in against photos')).toBeVisible();
    expect(rows.getAllByText('1 parcel').length).toBeGreaterThan(0);
    expect(rows.getByText('One parcel is on the rider’s bike')).toBeVisible();
    // The page says what it cannot do, in words, and draws no act that adds the missing orders.
    expect(screen.getByText(/Nothing here can add the missing orders yet\./)).toBeVisible();
    expect(screen.queryByRole('link', { name: /Make (an )?orders?/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  // Break caught (Run G1, Part 2, item 9): a closed vendor told by its code alone (a vendor counted without photos has no other name on the page), or the code lost when the vendor is named: the name is the title,
  // the code and how it was received stay beneath it, and the row opens the vendor by name.
  it('names each closed vendor by its vendor, with its code and how it was received beneath', async () => {
    const named = captured('closed-exceptions-named') as { items: Record<string, unknown>[] };
    open({ [LIST]: () => json(200, named) });
    const rows = within(await table());
    expect(rows.getAllByRole('button', { name: 'Open the vendor: Fixture Sender' })).toHaveLength(
      2,
    );
    // The vendor's name is what each row is titled by (the row header), and the code stays beneath it.
    const headers = rows.getAllByRole('rowheader');
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(within(header).getByText('Fixture Sender')).toBeVisible();
    }
    for (const item of named.items) {
      const how =
        item.receiving_mode === 'BLIND_COUNT'
          ? 'Counted without photos'
          : 'Checked in against photos';
      expect(rows.getByText(`${item.intake_code as string} · ${how}`)).toBeVisible();
    }
  });

  // Break caught: the counts of the vendor drawn from the page's own sums, an act that adds an order to a closed vendor, or a summary offered to an account that cannot read it.
  it('opens the vendor beside the list with its counts, and leads to the vendor and to its summary', async () => {
    const { user } = open();
    await openFirst(user);
    expect(await screen.findByText('Received')).toBeVisible();
    const fact = (label: string) =>
      screen.getAllByText(label).find((element) => element.tagName === 'DT')?.nextElementSibling;
    expect(fact('Received')).toHaveTextContent('3');
    expect(fact('Orders made')).toHaveTextContent('2');
    expect(fact('Still without an order')).toHaveTextContent('1 parcel');
    expect(fact('How it was received')).toHaveTextContent('Checked in against photos');
    expect(screen.getByRole('link', { name: 'Open the vendor' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR}`,
    );
    expect(screen.getByRole('link', { name: 'See the summary' })).toHaveAttribute(
      'href',
      `/intakes/${VENDOR}/summary`,
    );
  });

  it('offers no summary to an account that may not read it', async () => {
    const { user } = open({}, ['hub.read', 'hub.intake.close_exception']);
    await openFirst(user);
    expect(await screen.findByRole('link', { name: 'Open the vendor' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'See the summary' })).toBeNull();
  });

  // Break caught: a missing reason drawn as an empty cell (it would read as a close nobody explained, and is told so).
  it('says plainly when no reason was recorded', async () => {
    open({ [LIST]: () => json(200, pageOf([{ ...ITEM, exception_note: null }])) });
    expect(await within(await table()).findByText('No reason was recorded.')).toBeVisible();
  });
});

describeInterfaceStates('the vendors closed with parcels still to order', {
  loading: {
    test: async () => {
      open({ [LIST]: () => new Promise<Response>(() => undefined) });
      expect(await screen.findByText(/Loading/)).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open({ [LIST]: () => json(200, pageOf([])) });
      expect(await screen.findByText('No closed vendor has parcels still to order.')).toBeVisible();
    },
  },
  'validation error': {
    inapplicable: 'The list has one view and no filter: there is nothing to enter or to refuse.',
  },
  error: {
    test: async () => {
      open({ [LIST]: () => refusal(500, 'INTERNAL_ERROR') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'The closed vendors could not be loaded.',
        );
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
          return attempts === 1 ? refusal(503, 'SERVICE_UNAVAILABLE') : json(200, pageOf([ITEM]));
        },
      });
      await user.click(await screen.findByRole('button', { name: /Retry|Try again/ }));
      expect(within(await table()).getByText(CODE)).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list changes nothing and holds no version: a vendor that has nothing left is simply not in the next read.',
  },
  success: {
    test: async () => {
      open();
      expect(within(await table()).getByText(CODE)).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open({ [LIST]: () => refusal(403, 'PERMISSION_DENIED') });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeVisible();
      });
      expect(screen.queryByText(CODE)).toBeNull();
    },
  },
});
