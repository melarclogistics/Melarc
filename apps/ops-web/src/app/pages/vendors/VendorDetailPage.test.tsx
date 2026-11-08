import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { reasonFixture } from '../../../test-support/reason-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import {
  VENDOR_ACCOUNT_ID,
  VENDOR_HUB_ID,
  vendorAccountFixture,
  vendorDeviceFixture,
} from '../../../test-support/vendor-fixture';

/**
 * `/admin/vendors/{id}` (`getVendorAccount`, `reissueVendorCredentialSetup`, `recoverVendorCredential`; S0.52b; AC-SLICE-000-15). One account,
 * its browsers, and the two acts on its credential, each sent with the version read and a reason. The secret and every link are never shown.
 */
const RECORD = `GET /ops/vendors/${VENDOR_ACCOUNT_ID}`;
const REISSUE = `POST /ops/vendors/${VENDOR_ACCOUNT_ID}/credential/setup/reissue`;
const RECOVER = `POST /ops/vendors/${VENDOR_ACCOUNT_ID}/credential/recover`;
const REASONS = 'GET /reason-definitions';
const READER = ['vendor.read', 'settings.reason.read'];
const APPROVER = [...READER, 'vendor.organization.approve'];
const RECOVERER = [...READER, 'vendor.credential.recover'];

const detail = (account = vendorAccountFixture(), devices = [vendorDeviceFixture()]) => ({
  account,
  devices,
});
const reasonsOf =
  (operationId: 'recoverVendorCredential' | 'reissueVendorCredentialSetup', code: string) => () =>
    json(200, [
      reasonFixture({
        code,
        label: 'A reason',
        permittedOperations: [{ operationId, branch: null }],
      }),
    ]);

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  keys: readonly string[] = READER,
  handlers: Record<string, Handler> = {},
  id = VENDOR_ACCOUNT_ID,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: VENDOR_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [RECORD]: () => json(200, detail(), etag('v1')),
        ...handlers,
      },
    ),
  );
  return renderApp(`/admin/vendors/${id}`);
}

const posts = () => api.requests.filter((request) => request.method === 'POST');

describe('the vendor account: what it shows', () => {
  it('names the account and its organisation, and its authentication status in words', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'K7M2Q9X4' })).toBeVisible();
    expect(document.title).toBe('K7M2Q9X4 · Melarc Ops Portal');
    expect(screen.getByText('This account can sign in.')).toBeVisible();
    expect(screen.getByText('Its registered email')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to vendors' })).toHaveAttribute(
      'href',
      '/admin/vendors',
    );
  });

  // Break caught (AC-SLICE-000-15): a browser the shared account registered attributed to a person rather than to the organisation.
  it('attributes a browser the vendor registered to the organisation, never to a person', async () => {
    open(READER, {
      [RECORD]: () =>
        json(
          200,
          detail(vendorAccountFixture(), [
            vendorDeviceFixture(),
            vendorDeviceFixture({ id: '0f1a2b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3c', status: 'REVOKED' }),
          ]),
          etag('v1'),
        ),
    });
    const table = await screen.findByRole('table', { name: 'Browsers of the account' });
    expect(within(table).getAllByText('Asante Fabrics Ltd')).toHaveLength(2);
    expect(within(table).getByText('Revoked')).toBeVisible();
  });

  // Break caught: a credential, a hash or a recovery address that a server should never send drawn on the page.
  it('draws nothing of a secret, a device credential or a recovery address, even when an answer carries one', async () => {
    open(READER, {
      [RECORD]: () =>
        json(
          200,
          {
            account: {
              ...vendorAccountFixture(),
              secret_hash: 'SECRET-HASH',
              recovery_email: 'owner@asante.example',
            },
            devices: [{ ...vendorDeviceFixture(), device_credential_hash: 'DEVICE-HASH' }],
          },
          etag('v1'),
        ),
    });
    await screen.findByRole('heading', { level: 1, name: 'K7M2Q9X4' });
    expect(document.body.textContent).not.toMatch(/SECRET-HASH|DEVICE-HASH|owner@asante\.example/);
  });

  it('is a page of its own for an account outside the session’s hubs, and for one that does not exist', async () => {
    const view = open(READER, { [RECORD]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });
    expect(await screen.findByText(/hub your session does not act in/)).toBeVisible();
    view.unmount();
    api.restore();

    open(READER, { [RECORD]: () => refusal(404, 'NOT_FOUND') });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Account not found' }),
    ).toBeVisible();
  });
});

describe('the vendor account: the acts on its credential', () => {
  // Break caught (ops-portal.md section 7): a re-issue offered for an account that holds a secret, a recovery for one that holds none, or
  // either offered to a session without its own key.
  it('offers a re-issue for an account with no secret and a recovery for one with a secret, each to its own key', async () => {
    const cases: [readonly string[], boolean, string | null][] = [
      [APPROVER, false, 'Send a new setup link'],
      [APPROVER, true, null],
      [RECOVERER, true, 'Start recovery'],
      [RECOVERER, false, null],
      [READER, true, null],
    ];
    for (const [keys, established, offered] of cases) {
      const view = open(keys, {
        [RECORD]: () =>
          json(
            200,
            detail(vendorAccountFixture({ credential_established: established })),
            etag('v1'),
          ),
      });
      await screen.findByRole('heading', { level: 1, name: 'K7M2Q9X4' });
      for (const name of ['Send a new setup link', 'Start recovery']) {
        const button = screen.queryByRole('button', { name });
        if (name === offered)
          expect(button, `${keys.join(',')} ${String(established)}`).toBeVisible();
        else expect(button, `${keys.join(',')} ${String(established)} ${name}`).toBeNull();
      }
      view.unmount();
      api.restore();
    }
    api = installFakeApi({});
  });

  // Break caught: a recovery sent without the version read or a reason of its own catalogue, or its outcome showing a link.
  it('starts a recovery with the version and a reason, and says where the link went and until when, showing no link', async () => {
    const view = open(RECOVERER, {
      [REASONS]: reasonsOf('recoverVendorCredential', 'CREDENTIAL_RECOVERY_ASSISTANCE'),
      [RECOVER]: () =>
        json(200, {
          id: '1a2b3c4d-5e6f-4a7b-8c8d-9e0f1a2b3c4d',
          principal_type: 'VENDOR',
          channel: 'EMAIL',
          state: 'PENDING',
          issued_at: '2026-10-23T08:00:00Z',
          expires_at: '2026-10-23T08:30:00Z',
          consumed_at: null,
          initiated_by: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
          coalesced: false,
          token: 'SECRET-TOKEN',
        }),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Start recovery' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Start recovery?' });
    expect(dialog).toHaveAccessibleDescription(/You never see the new secret\./);
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'CREDENTIAL_RECOVERY_ASSISTANCE',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Send recovery link' }));

    expect(
      await screen.findByText(
        'A recovery link is on its way to its registered email. It works until 23 Oct, 08:30.',
      ),
    ).toBeVisible();
    const [sent] = posts();
    expect(sent?.headers.get('If-Match')).toBe('"v1"');
    expect(await sent?.json()).toEqual({ reason_code: 'CREDENTIAL_RECOVERY_ASSISTANCE' });
    expect(document.body.textContent).not.toContain('SECRET');
  });

  it('re-issues a setup link with the version and a reason, and explains a conflict', async () => {
    const view = open(APPROVER, {
      [RECORD]: () =>
        json(200, detail(vendorAccountFixture({ credential_established: false })), etag('v1')),
      [REASONS]: reasonsOf('reissueVendorCredentialSetup', 'CREDENTIAL_SETUP_LINK_UNUSABLE'),
      [REISSUE]: () => refusal(409, 'STATE_CONFLICT'),
    });
    await view.user.click(await screen.findByRole('button', { name: 'Send a new setup link' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Send a new setup link?' });
    await view.user.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
      'CREDENTIAL_SETUP_LINK_UNUSABLE',
    );
    await view.user.click(within(dialog).getByRole('button', { name: 'Send new link' }));

    expect(
      await screen.findByText(/This account already holds a secret \(start a recovery instead\)/),
    ).toBeVisible();
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(posts()[0]?.headers.get('If-Match')).toBe('"v1"');
  });
});

describeInterfaceStates('The vendor account', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(READER, { [RECORD]: () => gate });
      expect(await screen.findByText('Loading the account…')).toBeInTheDocument();
      await act(async () => {
        release(json(200, detail(), etag('v1')));
        await gate;
      });
      await screen.findByText('This account can sign in.');
    },
  },
  empty: {
    test: async () => {
      open(READER, {
        [RECORD]: () =>
          json(200, detail(vendorAccountFixture({ active_device_count: 0 }), []), etag('v1')),
      });
      expect(
        await screen.findByText('No browser has been registered for this account.'),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      const view = open(RECOVERER, {
        [REASONS]: reasonsOf('recoverVendorCredential', 'CREDENTIAL_RECOVERY_ASSISTANCE'),
        [RECOVER]: () => refusal(422, 'REASON_NOT_ACTIVE'),
      });
      await view.user.click(await screen.findByRole('button', { name: 'Start recovery' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Start recovery?' });
      await view.user.selectOptions(
        await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
        'CREDENTIAL_RECOVERY_ASSISTANCE',
      );
      await view.user.click(within(dialog).getByRole('button', { name: 'Send recovery link' }));
      expect(
        await within(dialog).findByText(
          'That reason can no longer be used for this. Choose another.',
        ),
      ).toBeVisible();
    },
  },
  error: {
    test: async () => {
      const view = open(RECOVERER, {
        [REASONS]: reasonsOf('recoverVendorCredential', 'CREDENTIAL_RECOVERY_ASSISTANCE'),
        [RECOVER]: () => refusal(422, 'CREDENTIAL_DELIVERY_FAILED'),
      });
      await view.user.click(await screen.findByRole('button', { name: 'Start recovery' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Start recovery?' });
      await view.user.selectOptions(
        await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
        'CREDENTIAL_RECOVERY_ASSISTANCE',
      );
      await view.user.click(within(dialog).getByRole('button', { name: 'Send recovery link' }));
      expect(
        await screen.findByText(
          /Nothing was changed\. This account has no channel a link can be sent to/,
        ),
      ).toBeVisible();
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(READER, {
        [RECORD]: () => {
          attempts += 1;
          return attempts === 1 ? refusal(503, 'SETTING_MISSING') : json(200, detail(), etag('v1'));
        },
      });
      await view.user.click(await screen.findByRole('button', { name: /Try again/ }));
      expect(await screen.findByText('This account can sign in.')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    test: async () => {
      const view = open(RECOVERER, {
        [REASONS]: reasonsOf('recoverVendorCredential', 'CREDENTIAL_RECOVERY_ASSISTANCE'),
        [RECOVER]: () => refusal(409, 'STATE_CONFLICT'),
      });
      await view.user.click(await screen.findByRole('button', { name: 'Start recovery' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Start recovery?' });
      await view.user.selectOptions(
        await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
        'CREDENTIAL_RECOVERY_ASSISTANCE',
      );
      await view.user.click(within(dialog).getByRole('button', { name: 'Send recovery link' }));
      expect(
        await screen.findByText(/Recovery cannot start for this account as it stands/),
      ).toBeVisible();
      expect(screen.getByRole('button', { name: 'Reload the record' })).toBeVisible();
    },
  },
  success: {
    test: async () => {
      const view = open(RECOVERER, {
        [REASONS]: reasonsOf('recoverVendorCredential', 'CREDENTIAL_RECOVERY_ASSISTANCE'),
        [RECOVER]: () =>
          json(200, {
            id: '1a2b3c4d-5e6f-4a7b-8c8d-9e0f1a2b3c4d',
            principal_type: 'VENDOR',
            channel: 'EMAIL',
            state: 'PENDING',
            issued_at: '2026-10-23T08:00:00Z',
            expires_at: '2026-10-23T08:30:00Z',
            consumed_at: null,
            initiated_by: null,
            coalesced: true,
          }),
      });
      await view.user.click(await screen.findByRole('button', { name: 'Start recovery' }));
      const dialog = screen.getByRole('alertdialog', { name: 'Start recovery?' });
      await view.user.selectOptions(
        await within(dialog).findByRole('combobox', { name: 'Reason (required)' }),
        'CREDENTIAL_RECOVERY_ASSISTANCE',
      );
      await view.user.click(within(dialog).getByRole('button', { name: 'Send recovery link' }));
      expect(
        await screen.findByText(
          'A recovery link sent to its registered email a moment ago can still be used, so no new one was sent.',
        ),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(['staff.read']);
      expect(await screen.findByText(/vendor\.read/)).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'K7M2Q9X4' })).toBeNull();
    },
  },
});
