import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  OTHER_RIDER_ID,
  RIDER_HUB_ID,
  RIDER_ID,
  riderDetailFixture,
  riderDeviceFixture,
  riderFixture,
  unboundRider,
} from '../../../test-support/rider-fixture';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/admin/riders/{id}` (`getRider`; S0.60a; AC-SLICE-000-113). One rider: status, whether a PIN is set and a device is active, and every device the rider has held.
 * The page offers the act that fits (the first binding for a rider who has held no device, revoking or replacing for one who has) to the key that
 * act needs, and shows no PIN, hash, key or attestation.
 */
const RECORD = `GET /ops/riders/${RIDER_ID}`;
const READER = ['dispatch.read'];
const REGISTERER = [...READER, 'staff.device.register'];
const REVOKER = [...READER, 'staff.device.revoke', 'staff.device.reregister'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
  restoreRoom();
});

function open(
  keys: readonly string[] = READER,
  handlers: Record<string, Handler> = {},
  id = RIDER_ID,
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: RIDER_HUB_ID, display_name: 'Accra Central' }],
      }),
      {
        [RECORD]: () => json(200, riderDetailFixture(), etag('v1')),
        ...handlers,
      },
    ),
  );
  return renderApp(`/admin/riders/${id}`);
}

const reads = () =>
  api.requests.filter((request) => request.url.endsWith(`/ops/riders/${RIDER_ID}`));

/** The text of a fact of the record, by its label. */
function factOf(label: string): string | null {
  const term = [...document.querySelectorAll('dt')].find(
    (candidate) => candidate.textContent === label,
  );
  return term?.nextElementSibling?.textContent ?? null;
}

describe('the rider: what it shows', () => {
  it('names the rider and the facts about readiness, in words', async () => {
    open();

    const heading = await screen.findByRole('heading', { level: 1, name: 'Kwame Mensah' });
    expect(heading).toBeVisible();
    expect(document.title).toBe('Kwame Mensah · Melarc Ops Portal');
    // A rider is named, not coded: the heading is the name in the heading face.
    expect(heading.querySelector('.ui-code')).toBeNull();
    // The record's header: the name, the administrative status as a badge beside it and one sentence of what that status means.
    const header = heading.closest('.ui-record-header');
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText('Active')).toBeVisible();
    expect(within(header as HTMLElement).getByText('This rider is active.')).toBeVisible();
    expect(factOf('Phone')).toBe('+233201234567');
    expect(factOf('Hub')).toBe('Accra Central');
    expect(factOf('PIN')).toBe('Set');
    expect(factOf('Device')).toBe('One active device');
    expect(factOf('Readiness')).toBe('Ready to sign in.');
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Riders',
      }),
    ).toHaveAttribute('href', '/admin/riders');
  });

  // Break caught (PRODUCT_DESIGN_DIRECTION section 6.2): the administrative status and the readiness told as one, in one badge. The status is the header's; the PIN, the device and the
  // readiness are facts, apart from it.
  it('tells the status apart from the readiness: the status in the header, the readiness as facts', async () => {
    open(READER, {
      [RECORD]: () =>
        json(200, riderDetailFixture(unboundRider({ status: 'SUSPENDED' }), []), etag('v1')),
    });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Kwame Mensah' });

    const header = heading.closest<HTMLElement>('.ui-record-header');
    if (header === null) throw new Error('The heading is not in a record header');
    expect(within(header).getByText('Suspended')).toBeVisible();
    expect(within(header).queryByText(/PIN|device|ready/i)).toBeNull();
    for (const label of ['PIN', 'Device', 'Readiness']) {
      const term = screen.getByText(label, { selector: 'dt' });
      expect(term.closest('.ui-record-header'), label).toBeNull();
    }
  });

  // Break caught (the PO's decision of 9 November 2026): paragraphs of rules above the content. What the device pages do is told on those pages.
  it('has no paragraph that explains the device acts', async () => {
    open(REVOKER);
    await screen.findByRole('heading', { level: 1, name: 'Kwame Mensah' });

    expect(screen.queryByText(/If the handset is lost or stolen/)).toBeNull();
    expect(screen.queryByText(/Register their first one in person/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What you can do' })).toBeNull();
  });

  // Break caught: a readiness that says "ready" for a rider who cannot sign in, or does not say what is missing.
  it.each([
    [
      riderFixture({ status: 'SUSPENDED' }),
      'Not ready: the rider is not active.',
      'This rider is suspended and cannot sign in.',
    ],
    [
      riderFixture({ status: 'OFFBOARDED' }),
      'Not ready: the rider is not active.',
      'This rider has left and cannot sign in.',
    ],
    [
      riderFixture({ status: 'INACTIVE' }),
      'Not ready: the rider is not active.',
      'This rider cannot sign in while they are inactive.',
    ],
    [
      riderFixture({ status: 'TEMPORARILY_UNAVAILABLE' }),
      'Not ready: the rider is not active.',
      'This rider cannot sign in while they are temporarily unavailable.',
    ],
    [
      unboundRider(),
      'Not ready: the rider has no device yet and has not set a PIN. Both come with the first device.',
      'This rider is active.',
    ],
    [
      riderFixture({ has_active_device: false }),
      'Not ready: the rider has no active device.',
      'This rider is active.',
    ],
    [
      riderFixture({ pin_established: false }),
      'Not ready: the rider has not set a PIN.',
      'This rider is active.',
    ],
  ])('says what stands between %# and a sign-in', async (rider, readiness, status) => {
    open(READER, { [RECORD]: () => json(200, riderDetailFixture(rider, []), etag('v1')) });

    await screen.findByRole('heading', { level: 1, name: 'Kwame Mensah' });

    expect(factOf('Readiness')).toBe(readiness);
    expect(screen.getByText(status)).toBeVisible();
  });

  it('lists every device the rider has held, newest first, and who registered each, never by an id', async () => {
    open(READER, {
      [RECORD]: () =>
        json(
          200,
          riderDetailFixture(riderFixture(), [
            riderDeviceFixture(),
            riderDeviceFixture({
              id: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
              status: 'REVOKED',
              registered_at: '2026-09-01T09:00:00Z',
              registered_by: null,
            }),
            riderDeviceFixture({
              id: '0d1e2f3a-4b5c-4d6e-9f7a-8b9c0d1e2f3a',
              status: 'REPLACED',
            }),
          ]),
          etag('v1'),
        ),
    });

    const table = await screen.findByRole('table', { name: 'Devices of the rider' });
    const rows = within(table).getAllByRole('row').slice(1);

    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Active',
      'Revoked',
      'Replaced',
    ]);
    const [active, revoked] = rows;
    if (active === undefined || revoked === undefined) throw new Error('The devices have no rows');
    expect(within(active).getByText('A Melarc officer, in person')).toBeVisible();
    expect(within(revoked).getByText('Not recorded')).toBeVisible();
    expect(document.body.textContent).not.toContain('8b9c0d1e');
  });

  it('draws the devices as cards with the same facts in a room too narrow for the columns', async () => {
    narrowRoom();
    open(READER, {
      [RECORD]: () =>
        json(
          200,
          riderDetailFixture(riderFixture(), [
            riderDeviceFixture(),
            riderDeviceFixture({
              id: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
              status: 'REVOKED',
              registered_at: '2026-09-01T09:00:00Z',
              registered_by: null,
            }),
          ]),
          etag('v1'),
        ),
    });

    const cards = await screen.findByRole('list', { name: 'Devices of the rider' });
    const [active, revoked] = within(cards).getAllByRole('listitem');
    if (active === undefined || revoked === undefined) throw new Error('The devices have no cards');
    expect(within(active).getByText('Active')).toBeVisible();
    expect(within(active).getByText('A Melarc officer, in person')).toBeVisible();
    expect(within(active).getByText('20 Oct, 09:00')).toBeVisible();
    expect(within(revoked).getByText('Revoked')).toBeVisible();
    expect(within(revoked).getByText('Not recorded', { selector: 'dd' })).toBeVisible();
    expect(document.body.textContent).not.toContain('8b9c0d1e');
  });

  // Break caught: a PIN, a hash, a key or an attestation that a server should never send drawn on the record.
  it('draws nothing of a PIN, a hash, a key or an attestation, even when an answer carries one', async () => {
    open(READER, {
      [RECORD]: () =>
        json(
          200,
          {
            rider: { ...riderFixture(), pin: '482913', pin_hash: '$argon2id$HASH' },
            devices: [
              {
                ...riderDeviceFixture(),
                public_key: 'MFkwKEY',
                attestation: { chain: ['ATTESTATION'] },
              },
            ],
          },
          etag('v1'),
        ),
    });

    await screen.findByRole('heading', { level: 1, name: 'Kwame Mensah' });

    expect(document.body.textContent).not.toMatch(/482913|HASH|KEY|ATTESTATION/);
  });

  // Break caught: the record of another rider than the one in the address being shown as this one's, with its acts.
  it('refuses the record of another rider than the one asked for', async () => {
    open(REVOKER, {
      [RECORD]: () =>
        json(200, riderDetailFixture(riderFixture({ id: OTHER_RIDER_ID })), etag('v1')),
    });

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1, name: 'Kwame Mensah' })).toBeNull();
    expect(screen.queryByRole('link', { name: /Revoke or replace/ })).toBeNull();
  });

  // Break caught: a record with no version offered for acts that need one.
  it('refuses a record that comes without its version', async () => {
    open(REVOKER, { [RECORD]: () => json(200, riderDetailFixture()) });

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Revoke or replace/ })).toBeNull();
  });
});

describe('the rider: the acts it offers', () => {
  // Break caught (ops-portal.md section 7): the first binding offered to a rider who already has a device, or to a session without its key.
  it('offers the first binding to a rider who has held no device, to a session that holds its key', async () => {
    open(REGISTERER, {
      [RECORD]: () => json(200, riderDetailFixture(unboundRider(), []), etag('v1')),
    });

    const link = await screen.findByRole('link', { name: 'Register the first device' });

    expect(link).toHaveAttribute('href', `/admin/riders/${RIDER_ID}/device/register`);
    expect(screen.queryByRole('link', { name: /Revoke or replace/ })).toBeNull();
    // The act is the header's, where the record says what can be done next.
    expect(link.closest('.ui-record-header')).not.toBeNull();
  });

  it('names the permission a first binding needs, and offers nothing, to a session without it', async () => {
    open(READER, {
      [RECORD]: () => json(200, riderDetailFixture(unboundRider(), []), etag('v1')),
    });

    expect(await screen.findByText(cannotText('staff.device.register'))).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Register the first device' })).toBeNull();
  });

  // Break caught: a binding offered to a rider whose access has ended, which the server refuses.
  it.each(['SUSPENDED', 'OFFBOARDED'] as const)(
    'offers no binding to a rider who is %s',
    async (status) => {
      open(REGISTERER, {
        [RECORD]: () => json(200, riderDetailFixture(unboundRider({ status }), []), etag('v1')),
      });

      expect(
        await screen.findByText(
          'A device cannot be registered while this rider’s access has ended.',
        ),
      ).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Register the first device' })).toBeNull();
    },
  );

  it.each(['INACTIVE', 'TEMPORARILY_UNAVAILABLE'] as const)(
    'offers a binding to a rider who is %s',
    async (status) => {
      open(REGISTERER, {
        [RECORD]: () => json(200, riderDetailFixture(unboundRider({ status }), []), etag('v1')),
      });

      expect(await screen.findByRole('link', { name: 'Register the first device' })).toBeVisible();
    },
  );

  // Break caught: revoking offered to a session without its key, or the first binding offered to a rider who has a device.
  it('offers revoking or replacing to a rider who has held a device, to a session that holds the key', async () => {
    open(REVOKER);

    const link = await screen.findByRole('link', { name: 'Revoke or replace the device' });

    expect(link).toHaveAttribute('href', `/admin/riders/${RIDER_ID}/device`);
    expect(screen.queryByRole('link', { name: 'Register the first device' })).toBeNull();
    expect(link.closest('.ui-record-header')).not.toBeNull();
  });

  it('names the permission revoking needs, and offers nothing, to a session without it', async () => {
    open(REGISTERER);

    expect(await screen.findByText(cannotText('staff.device.revoke'))).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Revoke or replace the device' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Register the first device' })).toBeNull();
  });

  // Break caught: a rider whose only device was revoked being offered a "first" binding, which the server refuses as STATE_CONFLICT.
  it('offers revoking or replacing, and not a first binding, to a rider whose devices were all revoked', async () => {
    open([...REVOKER, 'staff.device.register'], {
      [RECORD]: () =>
        json(
          200,
          riderDetailFixture(riderFixture({ has_active_device: false }), [
            riderDeviceFixture({ status: 'REVOKED' }),
          ]),
          etag('v1'),
        ),
    });

    expect(await screen.findByRole('link', { name: 'Revoke or replace the device' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Register the first device' })).toBeNull();
  });

  it('says there is no device yet, in words, when the rider has held none', async () => {
    open(READER, {
      [RECORD]: () => json(200, riderDetailFixture(unboundRider(), []), etag('v1')),
    });

    expect(await screen.findByText('No device has been registered for this rider.')).toBeVisible();
    expect(screen.queryByRole('table', { name: 'Devices of the rider' })).toBeNull();
  });
});

describe('the rider: the version an act takes', () => {
  // Break caught: a record kept after the screen let go of it, so that the next act takes the version of an earlier look and not the one just read.
  it('keeps nothing of the record once the page is left: coming back shows no record until it is read again', async () => {
    let reading = 0;
    let release: (response: Response) => void = () => undefined;
    const second = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const view = open(REVOKER, {
      'GET /ops/riders': () => json(200, { items: [], next_page_token: null }),
      [RECORD]: () => {
        reading += 1;
        return reading === 1 ? json(200, riderDetailFixture(), etag('v1')) : second;
      },
    });
    await screen.findByText('Ready to sign in.');
    expect(reads()).toHaveLength(1);

    await act(async () => {
      await view.router.navigate('/admin/riders');
    });
    await screen.findByRole('heading', { level: 1, name: 'Riders' });
    await act(async () => {
      await view.router.navigate(`/admin/riders/${RIDER_ID}`);
    });

    // The second read is on its way: the earlier look is not on the screen, so no act can take its version.
    expect(await screen.findByText('Loading the rider…')).toBeVisible();
    expect(screen.queryByText('Ready to sign in.')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Revoke or replace the device' })).toBeNull();
    await act(async () => {
      release(json(200, riderDetailFixture(), etag('v2')));
      await second;
    });
    expect(await screen.findByText('Ready to sign in.')).toBeVisible();
    expect(reads()).toHaveLength(2);
  });
});

describe('the rider: a record that cannot be shown', () => {
  it('is a page of its own for a rider outside the session’s hubs, and for one that does not exist', async () => {
    const view = open(READER, { [RECORD]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });
    expect(await screen.findByText(/hub your session does not act in/)).toBeVisible();
    view.unmount();
    api.restore();

    open(READER, { [RECORD]: () => refusal(404, 'NOT_FOUND') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Rider not found' })).toBeVisible();
    expect(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', {
        name: 'Riders',
      }),
    ).toBeVisible();
  });

  it('is a page of its own for a session whose key is refused by the server', async () => {
    open(READER, { [RECORD]: () => refusal(403, 'PERMISSION_DENIED') });

    expect(await screen.findByText(cannotText('dispatch.read'))).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  // Break caught: an address that is not a rider's being sent to the API.
  it('is not found, with no request, for an address that is not an id', async () => {
    api = installFakeApi(staffApi(sessionWith(READER)));
    renderApp('/admin/riders/not-an-id');

    expect(await screen.findByRole('heading', { level: 1, name: 'Rider not found' })).toBeVisible();
    expect(api.requests.some((request) => request.url.includes('/ops/riders/'))).toBe(false);
  });
});

describeInterfaceStates('The rider', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(READER, { [RECORD]: () => gate });
      expect(await screen.findByText('Loading the rider…')).toBeInTheDocument();
      await act(async () => {
        release(json(200, riderDetailFixture(), etag('v1')));
        await gate;
      });
      await screen.findByText('This rider is active.');
    },
  },
  empty: {
    test: async () => {
      open(READER, {
        [RECORD]: () => json(200, riderDetailFixture(unboundRider(), []), etag('v1')),
      });
      expect(
        await screen.findByText('No device has been registered for this rider.'),
      ).toBeVisible();
    },
  },
  'validation error': {
    inapplicable:
      'The page asks the person for nothing and sends no input of theirs; the address is judged as an id before anything is sent (the not-found page).',
  },
  error: {
    test: async () => {
      open(READER, { [RECORD]: () => refusal(500, 'INTERNAL') });
      expect(await screen.findByText('This rider could not be loaded.')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(READER, {
        [RECORD]: () => {
          attempts += 1;
          return attempts === 1
            ? refusal(503, 'SETTING_MISSING')
            : json(200, riderDetailFixture(), etag('v1'));
        },
      });
      await view.user.click(await screen.findByRole('button', { name: /Try again/ }));
      expect(await screen.findByText('This rider is active.')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The page changes nothing: the acts are on the two device pages, whose own tests show a record that moved and the way to read it again.',
  },
  success: {
    test: async () => {
      open(REVOKER);
      expect(await screen.findByText('Ready to sign in.')).toBeVisible();
      expect(screen.getByRole('link', { name: 'Revoke or replace the device' })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(['staff.read']);
      expect(await screen.findByText(cannotText('dispatch.read'))).toBeVisible();
      expect(screen.queryByRole('heading', { name: 'Kwame Mensah' })).toBeNull();
    },
  },
});
