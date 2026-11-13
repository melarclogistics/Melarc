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
  disputeFixture,
} from '../../../test-support/pickup-work-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/collection-disputes` (`listCollectionDisputes`; S1.30). The Ops side of a dispute a vendor raised, oldest first, each beside what was counted at the door. **A dispute never reverses physical
 * completion, and no operation resolves one in this slice**, so every item is open and the page offers no resolution. The vendor's words are drawn as text and never as markup.
 */
const LIST = 'GET /collection-disputes';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;
const KEYS = ['pickup.read'];

const raised = disputeFixture();

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;
afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => page([raised]),
  keys: readonly string[] = KEYS,
  path = '/collection-disputes',
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
  const found = await screen.findByRole('table', { name: 'Collection disputes' });
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
      .filter((request) => new URL(request.url).pathname === '/api/v1/collection-disputes')
      .at(-1)?.url ?? 'http://x/',
  ).searchParams;

describe('the collection disputes: what the list shows', () => {
  it('shows the vendor’s words beside what was counted at the door', async () => {
    open();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Collection disputes' }),
    ).toBeVisible();
    const row = within((await screen.findByText('ACC-PR-7KQ2MZ')).closest('tr') as HTMLElement);
    expect(row.getByText('The rider took three parcels and I handed over five.')).toBeVisible();
    expect(row.getByText('3 counted of 5 declared')).toBeVisible();
    expect(row.getByText('The count was short of what was declared.')).toBeVisible();
    expect(row.getByText('Open')).toBeVisible();
    expect(row.getByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toHaveAttribute(
      'href',
      `/manifests/${WORK_MANIFEST_ID}/stops/${WORK_STOP_ID}`,
    );
  });

  // Break caught: the vendor's words drawn as markup: a script or an image in a note would run in the officer's session.
  it('draws the vendor’s words as text and never as markup', async () => {
    open(() => page([disputeFixture({ note: '<img src=x onerror=alert(1)> and <b>bold</b>' })]));
    await table();

    expect(screen.getByText('<img src=x onerror=alert(1)> and <b>bold</b>')).toBeVisible();
    expect(document.querySelector('main img')).toBeNull();
    expect(document.querySelector('main b')).toBeNull();
  });

  // Break caught: a resolution drawn as an act the API does not have, or a page that does not say whose the reconciliation is.
  it('offers no resolution, and says what it is', async () => {
    open();
    await table();

    expect(
      screen.getByText(/no operation resolves one yet: that is the reconciliation workflow’s/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /resolve|reverse|refund|close/i })).toBeNull();
  });

  it.each([
    ['resolved', 'false'],
    ['all', null],
  ])('asks the server for the %s view with open=%s', async (view, value) => {
    open(
      () => page([disputeFixture({ state: 'RESOLVED', resolved_at: '2026-11-05T09:00:00Z' })]),
      KEYS,
      `/collection-disputes?view=${view}`,
    );
    const found = await table();

    expect(queryOf().get('open')).toBe(value);
    expect(within(found).getByText('Resolved')).toBeVisible();
  });
});

describeInterfaceStates('the collection disputes list', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading collection disputes')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(
        await screen.findByRole('heading', { name: 'No collection disputes yet' }),
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
      await alertSaying('The collection disputes could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const { user } = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SERVICE_UNAVAILABLE') : page([raised]);
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
        'Your account can’t see collection disputes. Ask an administrator for access.',
      );
    },
  },
});
