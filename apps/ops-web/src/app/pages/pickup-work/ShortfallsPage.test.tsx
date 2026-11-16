import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { PICKUP_HUB_ID } from '../../../test-support/pickup-fixture';
import {
  WORK_MANIFEST_ID,
  WORK_STOP_ID,
  shortfallFixture,
} from '../../../test-support/pickup-work-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/collection-shortfalls` (`listCollectionShortfalls`; S1.30). The counts the office was flagged on, oldest first: what was declared and counted, the reason the rider gave and its note (staff's own),
 * when the flag was raised and the pickup. A row opens the stop. **Nothing marks a shortfall as read or worked yet, so the page offers no such act.** No price, total or fee is drawn.
 */
const LIST = 'GET /collection-shortfalls';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEYS = ['pickup.read', 'pickup.handshake.override'];

const flagged = shortfallFixture();
const later = shortfallFixture({
  id: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
  pickup_stop_id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
  request_code: 'ACC-PR-9XM4TQ',
  sender_name: 'Kente Traders',
  declared_count: 8,
  collected_count: 7,
  variance: 'SHORT',
  difference_count: 1,
  note: null,
  run_state: 'COMPLETED',
});
// Run D, D-D5: the list holds the counts over the booking too: a rider at the door counted more parcels than were booked.
const over = shortfallFixture({
  id: '8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f',
  pickup_stop_id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a',
  request_code: 'ACC-PR-4HT8WE',
  sender_name: 'Osei Wholesale',
  declared_count: 4,
  collected_count: 6,
  variance: 'OVER',
  difference_count: 2,
  reason: { code: 'VENDOR_ADDED_PARCELS', label: 'Vendor added parcels', attribution: 'CUSTOMER' },
  note: null,
  stop_state: 'COLLECTED',
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => page([flagged, later]),
  keys: readonly string[] = KEYS,
  path = '/collection-shortfalls',
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler },
    ),
  );
  return renderApp(path);
}

const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Count differences' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const queryOf = () =>
  new URL(
    api.requests
      .filter((request) => new URL(request.url).pathname === '/api/v1/collection-shortfalls')
      .at(-1)?.url ?? 'http://x/',
  ).searchParams;

describe('the short counts: what the list shows', () => {
  it('shows what was declared and counted, the reason and its note, and when the office was told', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Count differences' }),
    ).toBeVisible();
    const row = within((await screen.findByText('ACC-PR-7KQ2MZ')).closest('tr') as HTMLElement);
    expect(row.getByText('3 counted of 5 booked')).toBeVisible();
    expect(row.getByText('Short by 2')).toBeVisible();
    expect(row.getByText('Some parcels were not ready')).toBeVisible();
    expect(row.getByText('The rest were still being packed.')).toBeVisible();
    expect(row.getByText('In progress')).toBeVisible();
    const other = within((await screen.findByText('ACC-PR-9XM4TQ')).closest('tr') as HTMLElement);
    expect(other.getByText('The rider left no note.')).toBeVisible();
    expect(other.getByText('Completed')).toBeVisible();
  });

  // Break caught (Run D, D-D5; fails before it: the page says `Short by` of every row, whichever side of the booking the count is on): a count over the booking drawn as a short one.
  it('says an over count is over, and by how many, as the server stated it', async () => {
    open(() => page([over, flagged]));

    const row = within((await screen.findByText('ACC-PR-4HT8WE')).closest('tr') as HTMLElement);
    expect(row.getByText('6 counted of 4 booked')).toBeVisible();
    expect(row.getByText('Over by 2')).toBeVisible();
    expect(row.queryByText(/Short by/)).toBeNull();
    expect(row.getByText('Vendor added parcels')).toBeVisible();
    // A short count in the same list is still a short one.
    const short = within((await screen.findByText('ACC-PR-7KQ2MZ')).closest('tr') as HTMLElement);
    expect(short.getByText('Short by 2')).toBeVisible();
    expect(short.queryByText(/Over by/)).toBeNull();
  });

  // Break caught: a row that opens nothing (a short count whose stop cannot be reached from it).
  it('links each row to the stop it is about', async () => {
    open();
    await table();

    expect(screen.getAllByRole('link', { name: 'ACC-PR-7KQ2MZ' })[0]).toHaveAttribute(
      'href',
      `/manifests/${WORK_MANIFEST_ID}/stops/${WORK_STOP_ID}`,
    );
  });

  // Break caught: an act drawn that the API cannot do (nothing marks a shortfall as read or worked yet), or a sentence in the voice of the people who built the page about what the list does not do (the
  // pictures' review, defect 4: "This list supplements the rider’s phone call and replaces nothing. Nothing marks a count difference as read or worked yet, so there is no act here.").
  it('offers no act of marking a count as read or worked, and says nothing of what the list does not do', async () => {
    open();
    await table();

    expect(screen.queryByRole('button', { name: /mark|worked|resolve|read/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /supplements|replaces nothing|Nothing marks|no act here/,
    );
  });

  // Break caught: a price, a total or a fee drawn on a count (section 7: no price, total or fee).
  it('draws no price, total or fee', async () => {
    open();
    await table();

    expect(document.body.textContent).not.toMatch(/GH₵|cedi|\bfee\b|\bprice\b|\btotal\b/i);
  });

  it.each([
    ['ended', 'false'],
    ['all', null],
  ])('asks the server for the %s view with open=%s', async (view, value) => {
    open(() => page([later]), KEYS, `/collection-shortfalls?view=${view}`);
    await table();

    expect(queryOf().get('open')).toBe(value);
  });
});

// Run D, D-D5: the list holds the short counts and the over counts, and the kind of difference is a filter of it, in the address like the others (the contract's `variance`, SHORT or OVER).
describe('the kind of difference', () => {
  // Break caught: a filter the address holds and the list does not ask for, or one drawn with no word of it on the screen.
  it('asks for the kind the address holds, and says it in a chip', async () => {
    open(() => page([flagged]), KEYS, '/collection-shortfalls?variance=SHORT');
    await table();

    expect(queryOf().get('variance')).toBe('SHORT');
    expect(screen.getByText('Kind of difference: Short')).toBeVisible();
  });

  it('asks for no kind when the address holds none, so that short and over come together', async () => {
    open();
    await table();

    expect(queryOf().has('variance')).toBe(false);
    expect(screen.queryByText(/Kind of difference:/)).toBeNull();
  });

  // Break caught: a kind chosen that is not put in the address (so that a reload or a shared link loses it), or one that cannot be taken off.
  it('chooses a kind in the filter, puts it in the address, and takes it off with its chip', async () => {
    const { user, router } = open();
    await table();

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind of difference' }), 'OVER');

    await waitFor(() => {
      expect(queryOf().get('variance')).toBe('OVER');
    });
    expect(router.state.location.search).toContain('variance=OVER');
    expect(await screen.findByText('Kind of difference: Over')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Remove.*Kind of difference: Over/ }));
    await waitFor(() => {
      expect(queryOf().has('variance')).toBe(false);
    });
    expect(router.state.location.search).not.toContain('variance');
  });

  // Break caught: a value in the address that the contract does not have sent to the API, which refuses it, or drawn as a chip.
  it('ignores a kind the contract does not have', async () => {
    open(() => page([flagged]), KEYS, '/collection-shortfalls?variance=BOTH');
    await table();

    expect(queryOf().has('variance')).toBe(false);
    expect(screen.queryByText(/Kind of difference:/)).toBeNull();
  });

  // Break caught: a view that forgets the kind (the filters are the list's together), or a kind that forgets the view.
  it('keeps the kind when the view changes, and the view when the kind does', async () => {
    const { user, router } = open(
      () => page([flagged]),
      KEYS,
      '/collection-shortfalls?variance=SHORT',
    );
    await table();

    await user.click(screen.getByRole('tab', { name: 'Ended runs' }));
    await waitFor(() => {
      expect(queryOf().get('open')).toBe('false');
    });
    expect(queryOf().get('variance')).toBe('SHORT');
    expect(router.state.location.search).toContain('variance=SHORT');
  });
});

describeInterfaceStates('the short counts list', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading count differences')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(
        await screen.findByRole('heading', { name: 'No count differences yet' }),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(() =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/open', rule: 'type' }],
        }),
      );
      await alertSaying('That filter was not accepted. Choose one of the views of the list.');
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The count differences could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SERVICE_UNAVAILABLE') : page([flagged]);
      });
      await alertSaying(/could not be loaded/);
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list has no act, so nothing the officer does can leave it stale or in conflict: a read again is the freshness line’s own Refresh.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(() => refusal(403, 'PERMISSION_DENIED'));
      await alertSaying(
        'Your account can’t work the handshakes, short counts and photo exceptions of a pickup. Ask an administrator for access.',
      );
    },
  },
});
