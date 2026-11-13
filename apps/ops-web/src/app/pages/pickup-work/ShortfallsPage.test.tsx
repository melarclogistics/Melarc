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
 * when the flag was raised and the pickup. A row opens the stop. **Nothing marks a shortfall as read or worked yet, so the page offers no such act and says so.** No price, total or fee is drawn.
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
  shortfall_count: 1,
  note: null,
  run_state: 'COMPLETED',
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
  const found = await screen.findByRole('table', { name: 'Short counts' });
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

    expect(await screen.findByRole('heading', { level: 1, name: 'Short counts' })).toBeVisible();
    const row = within((await screen.findByText('ACC-PR-7KQ2MZ')).closest('tr') as HTMLElement);
    expect(row.getByText('3 counted of 5 declared')).toBeVisible();
    expect(row.getByText('Short by 2')).toBeVisible();
    expect(row.getByText('Some parcels were not ready')).toBeVisible();
    expect(row.getByText('The rest were still being packed.')).toBeVisible();
    expect(row.getByText('In progress')).toBeVisible();
    const other = within((await screen.findByText('ACC-PR-9XM4TQ')).closest('tr') as HTMLElement);
    expect(other.getByText('The rider left no note.')).toBeVisible();
    expect(other.getByText('Completed')).toBeVisible();
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

  // Break caught: an act drawn that the API cannot do (nothing marks a shortfall as read or worked yet), or the page saying nothing of it.
  it('says nothing marks a short count as read or worked, and offers no such act', async () => {
    open();
    await table();

    expect(
      screen.getByText(
        /Nothing marks a short count as read or worked yet, so there is no act here\./,
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /mark|worked|resolve|read/i })).toBeNull();
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

describeInterfaceStates('the short counts list', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading short counts')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(await screen.findByRole('heading', { name: 'No short counts yet' })).toBeVisible();
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
      await alertSaying('The short counts could not be loaded.');
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
