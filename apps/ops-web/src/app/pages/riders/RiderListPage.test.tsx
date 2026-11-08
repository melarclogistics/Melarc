import { act, screen, waitFor, within } from '@testing-library/react';
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
  riderFixture,
  unboundRider,
} from '../../../test-support/rider-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/admin/riders` (`listRiders`; S0.60a; AC-SLICE-000-113). The riders the session's grant reaches: name, phone, status, hub, whether a PIN is set and whether a
 * device is active. Never a PIN, a hash, a key or an attestation.
 */
const LIST = 'GET /ops/riders';
const READER = ['dispatch.read'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

const kwame = riderFixture();
const ama = riderFixture({
  id: OTHER_RIDER_ID,
  full_name: 'Ama Boateng',
  phone: '+233241112222',
  status: 'SUSPENDED',
  pin_established: false,
  has_active_device: false,
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => page([kwame, ama]),
  keys: readonly string[] = READER,
  path = '/admin/riders',
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: RIDER_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler },
    ),
  );
  return renderApp(path);
}

const listRequests = () => api.requests.filter((request) => request.url.includes('/ops/riders'));
const queryOf = (index = -1) => new URL(listRequests().at(index)?.url ?? 'http://x/').searchParams;

describe('the rider list: what it shows', () => {
  it('shows each rider by name, phone, status, PIN, device and hub, and links to the rider', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Riders' })).toBeVisible();
    expect(document.title).toBe('Riders · Melarc Ops Portal');
    const first = (await screen.findByRole('rowheader', { name: 'Kwame Mensah' })).closest('tr');
    if (first === null) throw new Error('no row');
    expect(within(first).getByText('+233201234567')).toBeVisible();
    expect(within(first).getByText('Active')).toBeVisible();
    expect(within(first).getByText('Set')).toBeVisible();
    expect(within(first).getByText('One active device')).toBeVisible();
    expect(within(first).getByText('Accra Central')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Kwame Mensah' })).toHaveAttribute(
      'href',
      `/admin/riders/${RIDER_ID}`,
    );

    const second = screen.getByRole('rowheader', { name: 'Ama Boateng' }).closest('tr');
    if (second === null) throw new Error('no row');
    expect(within(second).getByText('Suspended')).toBeVisible();
    expect(within(second).getByText('Not set yet')).toBeVisible();
    expect(within(second).getByText('No active device')).toBeVisible();
  });

  // Break caught: a hub the session does not act in named by its id, or as if it were the officer's own.
  it('names a hub by its name when the session acts in it, and as another hub when it does not', async () => {
    open(() => page([riderFixture({ primary_hub_id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' })]));

    const row = (await screen.findByRole('rowheader', { name: 'Kwame Mensah' })).closest('tr');
    if (row === null) throw new Error('no row');

    expect(within(row).getByText('Another hub')).toBeVisible();
    expect(document.body.textContent).not.toContain('9d0e1f2a');
  });

  // Break caught: a PIN, a hash, a key or an attestation that a server should never send drawn on the roster.
  it('draws nothing of a PIN, a hash, a key or an attestation, even when an answer carries one', async () => {
    open(() =>
      page([
        {
          ...kwame,
          pin: '482913',
          pin_hash: '$argon2id$HASH',
          public_key: 'MFkwKEY',
          attestation: { chain: ['ATTESTATION'] },
          failed_attempts: 4,
        },
      ]),
    );

    await screen.findByRole('rowheader', { name: 'Kwame Mensah' });

    expect(document.body.textContent).not.toMatch(/482913|HASH|KEY|ATTESTATION|failed/);
  });

  // Break caught: a roster that shows part of a page when one rider in it is not a rider: the page is the API's or it is not.
  it('shows no roster at all when one rider in it is not a rider', async () => {
    open(() => page([kwame, { ...ama, phone: 'not a phone' }]));

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Kwame Mensah')).toBeNull();
  });
});

describe('the rider list: filtering', () => {
  it('asks for every status by default, and offers each status the contract has', async () => {
    open();
    await screen.findByRole('table', { name: 'Riders' });

    expect(queryOf(0).has('status')).toBe(false);
    const filter = screen.getByRole('combobox', { name: 'Status' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Every status',
      'Active',
      'Inactive',
      'Temporarily unavailable',
      'Suspended',
      'Offboarded',
    ]);
  });

  it('asks for the status that is chosen, and puts it in the address', async () => {
    const { user, router } = open();
    await screen.findByRole('table', { name: 'Riders' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'SUSPENDED');

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('SUSPENDED');
    });
    expect(router.state.location.search).toBe('?status=SUSPENDED');
  });

  it('reads the status out of the address and shows it in the filter', async () => {
    open(undefined, READER, '/admin/riders?status=OFFBOARDED');

    await screen.findByRole('table', { name: 'Riders' });

    expect(queryOf(0).get('status')).toBe('OFFBOARDED');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('OFFBOARDED');
  });

  // Break caught: a made-up status in the address being sent to the server as a made-up filter.
  it.each(['everything', 'active', 'ACTIVE%20', '%3Cscript%3E'])(
    'takes a status that is not one (%s) for no filter',
    async (value) => {
      open(undefined, READER, `/admin/riders?status=${value}`);

      await screen.findByRole('table', { name: 'Riders' });

      expect(queryOf(0).has('status')).toBe(false);
    },
  );
});

describe('the rider list: searching', () => {
  it('searches by name or phone when the form is sent, and puts the search in the address', async () => {
    const { user, router } = open();
    await screen.findByRole('table', { name: 'Riders' });

    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name or phone' }),
      'kwame{Enter}',
    );

    await waitFor(() => {
      expect(queryOf().get('q')).toBe('kwame');
    });
    expect(router.state.location.search).toBe('?q=kwame');
  });

  it('keeps the status when the search changes, and the search when the status changes', async () => {
    const { user, router } = open(undefined, READER, '/admin/riders?status=ACTIVE');
    await screen.findByRole('table', { name: 'Riders' });

    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name or phone' }),
      'ama{Enter}',
    );
    await waitFor(() => {
      expect(queryOf().get('q')).toBe('ama');
    });
    expect(router.state.location.search).toBe('?status=ACTIVE&q=ama');

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'INACTIVE');
    await waitFor(() => {
      expect(queryOf().get('status')).toBe('INACTIVE');
    });
    expect(queryOf().get('q')).toBe('ama');
  });

  // Break caught: spaces around a search sent as part of it, which would find nobody.
  it('sends a search without the spaces around it, and a blank search as none', async () => {
    const { user } = open();
    await screen.findByRole('table', { name: 'Riders' });
    const field = screen.getByRole('searchbox', { name: 'Search by name or phone' });

    await user.type(field, '   +233   {Enter}');
    await waitFor(() => {
      expect(queryOf().get('q')).toBe('+233');
    });
    await user.clear(field);
    await user.type(field, '    {Enter}');

    await waitFor(() => {
      expect(listRequests()).toHaveLength(3);
    });
    expect(queryOf().has('q')).toBe(false);
  });

  // Break caught: a search read out of the address with its spaces, which would find nobody.
  it('sends a search from the address without the spaces around it', async () => {
    open(undefined, READER, '/admin/riders?q=%20%20kwame%20');

    await screen.findByRole('table', { name: 'Riders' });

    expect(queryOf(0).get('q')).toBe('kwame');
    expect(screen.getByRole('searchbox', { name: 'Search by name or phone' })).toHaveValue('kwame');
  });

  it('limits a search to what the server accepts, as it is typed', async () => {
    open();
    await screen.findByRole('table', { name: 'Riders' });

    expect(screen.getByRole('searchbox', { name: 'Search by name or phone' })).toHaveAttribute(
      'maxlength',
      '128',
    );
  });
});

describe('the rider list: counting and paging', () => {
  it('counts a page without claiming to know the total, in the singular for one', async () => {
    open(() => page([kwame, ama], 'next-1'));
    expect(
      await screen.findByText('Showing 2 riders. More follow on the next page.'),
    ).toBeVisible();
  });

  it('says it in the singular for one rider', async () => {
    open(() => page([kwame]));
    expect(await screen.findByText('Showing 1 rider.')).toBeVisible();
  });

  it('goes to the next page with the token the server gave, and back to the first', async () => {
    const { user } = open(() => page([kwame], 'next-1'));
    await screen.findByRole('table', { name: 'Riders' });
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(queryOf().get('page_token')).toBe('next-1');
    });
    expect(await screen.findByText(/on page 2/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));

    await waitFor(() => {
      expect(listRequests()).toHaveLength(3);
    });
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('offers no next page on the last page', async () => {
    open(() => page([kwame], null));
    await screen.findByRole('table', { name: 'Riders' });
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  // Break caught: the next page of one filter shown for another, because the page position outlived the change.
  it('starts again at the first page when the status or the search changes', async () => {
    const { user } = open(() => page([kwame], 'next-1'));
    await screen.findByRole('table', { name: 'Riders' });
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'ACTIVE');

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('ACTIVE');
    });
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page 2/)).toBeNull();
  });
});

describe('the rider list: nothing to show', () => {
  it('tells a roster with no one on it', async () => {
    open(() => page([]));

    expect(await screen.findByRole('heading', { name: 'No riders yet' })).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // Break caught: "no riders yet" and "the filter hides everything" told as one, which sends people hunting for a bug.
  it('tells a filter that hides everything differently, and clears the status and the search in one move', async () => {
    const { user, router } = open(
      () => page([]),
      READER,
      '/admin/riders?status=SUSPENDED&q=nobody',
    );
    expect(await screen.findByRole('heading', { name: 'No riders match' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No riders yet' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show every rider' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(screen.getByRole('searchbox', { name: 'Search by name or phone' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('');
  });

  // Break caught: a blank search in the address taken for a search, so that an empty roster reads "no riders match".
  it('takes a blank search in the address for none', async () => {
    open(() => page([]), READER, '/admin/riders?q=%20%20');

    expect(await screen.findByRole('heading', { name: 'No riders yet' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No riders match' })).toBeNull();
  });

  // Break caught: an empty search echoing what was typed back as markup.
  it('does not repeat the search in the words', async () => {
    open(() => page([]), READER, '/admin/riders?q=%3Cb%3Ex%3C%2Fb%3E');

    await screen.findByRole('heading', { name: 'No riders match' });

    expect(document.body.textContent).not.toContain('<b>');
  });
});

describe('the rider list: when it cannot be had', () => {
  it('says so in approved words with a retry, and never the server’s text', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'));

    expect(await screen.findByText('The riders could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('says that a session without the key lacks it, by key and not by role', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    expect(await screen.findByText(/dispatch\.read/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });
});

describeInterfaceStates('The rider list', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(() => gate);
      expect(await screen.findByText('Loading riders…')).toBeInTheDocument();
      await act(async () => {
        release(page([kwame]));
        await gate;
      });
      await screen.findByRole('rowheader', { name: 'Kwame Mensah' });
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(await screen.findByRole('heading', { name: 'No riders yet' })).toBeVisible();
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
        '/admin/riders?q=x',
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
        return attempts === 1 ? refusal(503, 'SETTING_MISSING') : page([kwame]);
      });
      await view.user.click(await screen.findByRole('button', { name: /Try again/ }));
      expect(await screen.findByRole('rowheader', { name: 'Kwame Mensah' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list changes nothing and carries no version; a rider that moved is read again from the rider’s own page.',
  },
  success: {
    test: async () => {
      open(() => page([kwame, unboundRider({ id: OTHER_RIDER_ID, full_name: 'Esi Owusu' })]));
      expect(await screen.findByText('Showing 2 riders.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(undefined, ['staff.read']);
      expect(await screen.findByText(/dispatch\.read/)).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    },
  },
});
