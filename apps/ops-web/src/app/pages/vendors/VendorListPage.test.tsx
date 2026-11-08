import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { VENDOR_HUB_ID, vendorAccountFixture } from '../../../test-support/vendor-fixture';

/**
 * `/admin/vendors` (`listVendorAccounts`; S0.52b). The vendor accounts the session's grant reaches: identifier, organisation, status, whether a
 * secret exists and how many browsers are active. Never a credential or a recovery address.
 */
const LIST = 'GET /ops/vendors';
const READER = ['vendor.read'];

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => json(200, { items: [vendorAccountFixture()], next_page_token: null }),
  keys = READER,
  path = '/admin/vendors',
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: VENDOR_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler },
    ),
  );
  return renderApp(path);
}

describe('the vendor list', () => {
  it('shows each account by its identifier, organisation, status, secret, browsers and hub, and links to it', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Vendors' })).toBeVisible();
    const row = (await screen.findByRole('rowheader', { name: 'K7M2Q9X4' })).closest('tr');
    if (row === null) throw new Error('no row');
    expect(within(row).getByText('Asante Fabrics Ltd')).toBeVisible();
    expect(within(row).getByText('Active')).toBeVisible();
    expect(within(row).getByText('Set')).toBeVisible();
    expect(within(row).getByText('1')).toBeVisible();
    expect(within(row).getByText('Accra Central')).toBeVisible();
    expect(screen.getByRole('link', { name: 'K7M2Q9X4' })).toHaveAttribute(
      'href',
      `/admin/vendors/${vendorAccountFixture().id}`,
    );
  });

  // Break caught: a credential or a recovery address that a server should never send drawn on the list.
  it('draws nothing of a credential or a recovery address, even when an answer carries one', async () => {
    open(() =>
      json(200, {
        items: [
          {
            ...vendorAccountFixture(),
            secret_hash: 'SECRET-HASH',
            recovery_email: 'owner@asante.example',
          },
        ],
        next_page_token: null,
      }),
    );
    await screen.findByRole('rowheader', { name: 'K7M2Q9X4' });
    expect(document.body.textContent).not.toMatch(/SECRET-HASH|owner@asante\.example/);
  });

  it('sends the search in the query, and keeps it in the address', async () => {
    const view = open();
    await screen.findByRole('rowheader', { name: 'K7M2Q9X4' });

    await view.user.type(
      screen.getByRole('searchbox', { name: 'Search by organisation or account' }),
      'asante',
    );
    await view.user.click(screen.getByRole('button', { name: 'Search' }));

    await screen.findByRole('rowheader', { name: 'K7M2Q9X4' });
    const last = new URL(api.requests.at(-1)?.url ?? 'http://x');
    expect(last.searchParams.get('q')).toBe('asante');
    expect(view.router.state.location.search).toBe('?q=asante');
  });
});

describeInterfaceStates('The vendor list', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(() => gate);
      expect(await screen.findByText('Loading vendor accounts…')).toBeInTheDocument();
      await act(async () => {
        release(json(200, { items: [vendorAccountFixture()], next_page_token: null }));
        await gate;
      });
      await screen.findByRole('rowheader', { name: 'K7M2Q9X4' });
    },
  },
  empty: {
    test: async () => {
      open(() => json(200, { items: [], next_page_token: null }));
      expect(await screen.findByRole('heading', { name: 'No vendor accounts yet' })).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(
        () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: 'q', rule: 'maxLength' }],
          }),
        READER,
        '/admin/vendors?q=x',
      );
      expect(
        await screen.findByText('That search was not accepted. Use at most 128 characters.'),
      ).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      expect(await screen.findByRole('alert')).toBeVisible();
      expect(document.body.textContent).not.toContain('Diagnostic text');
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1
          ? refusal(503, 'SETTING_MISSING')
          : json(200, { items: [vendorAccountFixture()], next_page_token: null });
      });
      await view.user.click(await screen.findByRole('button', { name: /Try again/ }));
      expect(await screen.findByRole('rowheader', { name: 'K7M2Q9X4' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list changes nothing and carries no version; an account that moved is read again from its own page.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('Showing 1 account.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(undefined, ['staff.read']);
      expect(await screen.findByText(/vendor\.read/)).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    },
  },
});
