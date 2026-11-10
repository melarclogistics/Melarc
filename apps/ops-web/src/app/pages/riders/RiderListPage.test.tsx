import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { pagerRegion } from '../../../test-support/queue-pager';
import {
  OTHER_RIDER_ID,
  RIDER_HUB_ID,
  RIDER_ID,
  riderFixture,
  unboundRider,
} from '../../../test-support/rider-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/admin/riders` (`listRiders`; S0.60a; AC-SLICE-000-113; redesign step R7b, drawn by the queue workspace template). The riders the session's grant reaches: name, phone,
 * status, hub, whether a PIN is set and whether a device is active. Never a PIN, a hash, a key or an attestation. The server filters (the status and the search, in the address and
 * in the request) and pages (by token); the screen draws what comes back, whole.
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
  restoreRoom();
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

/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Riders' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
/** In a room under 40rem the rows are cards (`narrowRoom`). */
const cards = () => screen.findByRole('list', { name: 'Riders' });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const viewTab = (name: string) => screen.getByRole('tab', { name });
const removeChip = (label: string) =>
  screen.getByRole('button', { name: `Remove filter: ${label}` });

/** The search lives in the popover of the filter row: opened with the Filter button, and its field is the page's own. */
async function openSearch(view: ReturnType<typeof open>): Promise<HTMLElement> {
  await view.user.click(screen.getByRole('button', { name: 'Filter' }));
  return screen.findByRole('searchbox', { name: 'Search by name or phone' });
}

async function rowOf(name: string): Promise<HTMLElement> {
  const row = within(await table())
    .getByRole('link', { name })
    .closest('tr');
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

describe('the rider list: what it shows', () => {
  it('shows each rider by name over phone, with status, PIN, device and hub, and links to the rider', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Riders' })).toBeVisible();
    expect(document.title).toBe('Riders · Melarc Ops Portal');
    const first = await rowOf('Kwame Mensah');
    expect(within(first).getByRole('rowheader')).toHaveTextContent(/Kwame Mensah\s*\+233201234567/);
    expect(within(first).getByText('Active')).toBeVisible();
    expect(within(first).getByText('Set')).toBeVisible();
    expect(within(first).getByText('One active device')).toBeVisible();
    expect(within(first).getByText('Accra Central')).toBeVisible();
    expect(within(first).getByRole('link', { name: 'Kwame Mensah' })).toHaveAttribute(
      'href',
      `/admin/riders/${RIDER_ID}`,
    );

    const second = await rowOf('Ama Boateng');
    expect(within(second).getByText('Suspended')).toBeVisible();
    expect(within(second).getByText('Not set yet')).toBeVisible();
    expect(within(second).getByText('No active device')).toBeVisible();
  });

  // Break caught: the status told by colour alone, or the raw enum shown where the words belong.
  it('tells the status in words, never as the raw value', async () => {
    open();
    await table();

    expect(screen.queryByText('SUSPENDED')).toBeNull();
    expect(screen.queryByText('ACTIVE')).toBeNull();
  });

  it('draws a rider as a card with the same facts, in a room too narrow for the columns', async () => {
    narrowRoom();
    open();

    const card = within(await cards())
      .getByRole('link', { name: 'Ama Boateng' })
      .closest('li');
    expect(card).not.toBeNull();
    const facts = within(card as HTMLElement);
    expect(facts.getByText('Suspended')).toBeVisible();
    expect(facts.getByText('+233241112222')).toBeVisible();
    expect(facts.getByText('Not set yet')).toBeVisible();
    expect(facts.getByText('No active device')).toBeVisible();
    expect(facts.getByText('Accra Central')).toBeVisible();
    // Each fact beyond the name, the status and the phone is a label and its value (CardFacts), the labels the columns have.
    expect(facts.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'PIN',
      'Device',
      'Hub',
    ]);
  });

  // Break caught (the Product Owner, 10 November 2026: no table scrolls sideways): a list that marks no column lesser, so that a box that cannot hold the five scrolls sideways where the hub and
  // then the PIN could have gone. The name, the status and the device, which an officer acts on, are never lesser; the hub is the most lesser.
  it('marks the PIN and the hub as the lesser columns, the hub the most lesser, and the name, the status and the device not', async () => {
    open();

    const found = await table();
    const priorities = Object.fromEntries(
      within(found)
        .getAllByRole('columnheader')
        .map((cell) => [cell.textContent, cell.getAttribute('data-priority')]),
    );
    // A column that is not lesser carries no mark: it is always drawn.
    expect(priorities).toEqual({
      'Rider / phone': null,
      Status: null,
      PIN: '2',
      Device: null,
      Hub: '3',
    });
  });

  // Break caught: a hub the session does not act in named by its id, or as if it were the officer's own.
  it('names a hub by its name when the session acts in it, and as another hub when it does not', async () => {
    open(() => page([riderFixture({ primary_hub_id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' })]));

    const row = await rowOf('Kwame Mensah');

    expect(within(row).getByText('Another hub')).toBeVisible();
    expect(document.body.textContent).not.toContain('9d0e1f2a');
  });

  // Break caught: a PIN, a hash, a key or an attestation that a server should never send drawn on the roster, in the table or in the card.
  it.each([
    ['a table', false],
    ['cards', true],
  ])(
    'draws nothing of a PIN, a hash, a key or an attestation in %s, even when an answer carries one',
    async (_name, narrow) => {
      if (narrow) narrowRoom();
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

      await (narrow ? cards() : table());

      expect(screen.getByText('Kwame Mensah')).toBeVisible();
      expect(document.body.textContent).not.toMatch(/482913|HASH|KEY|ATTESTATION|failed/);
    },
  );

  // Break caught: a roster that shows part of a page when one rider in it is not a rider: the page is the API's or it is not.
  it('shows no roster at all when one rider in it is not a rider', async () => {
    open(() => page([kwame, { ...ama, phone: 'not a phone' }]));

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('rowheader')).toBeNull();
    expect(screen.queryByText('Kwame Mensah')).toBeNull();
  });
});

describe('the rider list: the status', () => {
  it('asks for every status by default, and offers each status the contract has as a view', async () => {
    open();
    await table();

    expect(queryOf(0).has('status')).toBe(false);
    const views = screen.getByRole('tablist', { name: 'Views of the riders' });
    expect(
      within(views)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['All', 'Active', 'Inactive', 'Temporarily unavailable', 'Suspended', 'Offboarded']);
    expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
  });

  it('asks for the status that is chosen, and puts it in the address', async () => {
    const { user, router } = open();
    await table();

    await user.click(viewTab('Suspended'));

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('SUSPENDED');
    });
    expect(router.state.location.search).toBe('?status=SUSPENDED');
  });

  it('reads the status out of the address and shows it as the chosen view', async () => {
    open(undefined, READER, '/admin/riders?status=OFFBOARDED');

    await table();

    expect(queryOf(0).get('status')).toBe('OFFBOARDED');
    expect(viewTab('Offboarded')).toHaveAttribute('aria-selected', 'true');
  });

  // Break caught: a made-up status in the address being sent to the server as a made-up filter.
  it.each(['everything', 'active', 'ACTIVE%20', '%3Cscript%3E'])(
    'takes a status that is not one (%s) for no filter',
    async (value) => {
      open(undefined, READER, `/admin/riders?status=${value}`);

      await table();

      expect(queryOf(0).has('status')).toBe(false);
      expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
    },
  );
});

describe('the rider list: searching', () => {
  it('searches by name or phone when the form is sent, puts the search in the address and shows it as a filter', async () => {
    const view = open();
    await table();

    await view.user.type(await openSearch(view), 'kwame{Enter}');

    await waitFor(() => {
      expect(queryOf().get('q')).toBe('kwame');
    });
    expect(view.router.state.location.search).toBe('?q=kwame');
    expect(removeChip('Search: kwame')).toBeVisible();
  });

  it('keeps the status when the search changes, and the search when the status changes', async () => {
    const view = open(undefined, READER, '/admin/riders?status=ACTIVE');
    const { user, router } = view;
    await table();

    await user.type(await openSearch(view), 'ama{Enter}');
    await waitFor(() => {
      expect(queryOf().get('q')).toBe('ama');
    });
    expect(router.state.location.search).toBe('?status=ACTIVE&q=ama');

    await user.click(viewTab('Inactive'));
    await waitFor(() => {
      expect(queryOf().get('status')).toBe('INACTIVE');
    });
    expect(queryOf().get('q')).toBe('ama');
  });

  it('takes the search off with its own chip, and keeps the status', async () => {
    const { user, router } = open(undefined, READER, '/admin/riders?status=ACTIVE&q=ama');
    await table();

    await user.click(removeChip('Search: ama'));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?status=ACTIVE');
    });
    expect(queryOf().has('q')).toBe(false);
    expect(queryOf().get('status')).toBe('ACTIVE');
  });

  // Break caught: spaces around a search sent as part of it, which would find nobody.
  it('sends a search without the spaces around it, and a blank search as none', async () => {
    const view = open();
    const { user } = view;
    await table();
    const field = await openSearch(view);

    await user.type(field, '   +233   {Enter}');
    await waitFor(() => {
      expect(queryOf().get('q')).toBe('+233');
    });
    const field2 = await openSearch(view);
    await user.clear(field2);
    await user.type(field2, '    {Enter}');

    await waitFor(() => {
      expect(listRequests()).toHaveLength(3);
    });
    expect(queryOf().has('q')).toBe(false);
  });

  // Break caught: a search read out of the address with its spaces, which would find nobody.
  it('sends a search from the address without the spaces around it', async () => {
    const view = open(undefined, READER, '/admin/riders?q=%20%20kwame%20');

    await table();

    expect(queryOf(0).get('q')).toBe('kwame');
    expect(removeChip('Search: kwame')).toBeVisible();
    expect(await openSearch(view)).toHaveValue('kwame');
  });

  it('limits a search to what the server accepts, as it is typed', async () => {
    const view = open();
    await table();

    expect(await openSearch(view)).toHaveAttribute('maxlength', '128');
  });
});

describe('the rider list: counting, paging and freshness', () => {
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
    await table();
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
    await table();
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  // Break caught (the review of 499399c): a pager taken out of the page while the next page is read and made anew with its words, which most screen readers do not announce.
  it('keeps the pager’s status region while the next page is read', async () => {
    const reads = byHand();
    let calls = 0;
    const { user } = open((request) => {
      calls += 1;
      return calls === 1 ? page([kwame], 'second') : reads.handler(request);
    });
    await rowOf('Kwame Mensah');
    const region = pagerRegion();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(region).toBeEmptyDOMElement();
    });
    expect(pagerRegion()).toBe(region);

    await reads.answer(page([ama]));
    await waitFor(() => {
      expect(region).toHaveTextContent('on page 2');
    });
    expect(pagerRegion()).toBe(region);
  });

  // Break caught: the next page of one filter shown for another, because the page position outlived the change.
  it('starts again at the first page when the status or the search changes', async () => {
    const view = open(() => page([kwame], 'next-1'));
    const { user } = view;
    await table();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    await user.click(viewTab('Active'));

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('ACTIVE');
    });
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page 2/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await user.type(await openSearch(view), 'kwame{Enter}');

    await waitFor(() => {
      expect(queryOf().get('q')).toBe('kwame');
    });
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('reads the page again on Refresh, and says when it was last checked', async () => {
    const { user } = open();
    await table();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    const before = listRequests().length;

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await rowOf('Kwame Mensah');

    expect(listRequests().length).toBe(before + 1);
  });
});

describe('the rider list: nothing to show', () => {
  it('tells a roster with no one on it', async () => {
    open(() => page([]));

    expect(await screen.findByRole('heading', { name: 'No riders yet' })).toBeVisible();
    // The nothing is told in the table's own place, and no rider is listed.
    expect(screen.queryByRole('rowheader')).toBeNull();
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
    expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: /^Remove filter: / })).toBeNull();
  });

  // Break caught: a blank search in the address taken for a search, so that an empty roster reads "no riders match".
  it('takes a blank search in the address for none', async () => {
    open(() => page([]), READER, '/admin/riders?q=%20%20');

    expect(await screen.findByRole('heading', { name: 'No riders yet' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No riders match' })).toBeNull();
  });

  // Break caught: a search echoed back as markup, in the words of an empty roster or in the filter that shows it.
  it('draws the search as text and never as markup', async () => {
    open(() => page([]), READER, '/admin/riders?q=%3Cb%3Ex%3C%2Fb%3E');

    await screen.findByRole('heading', { name: 'No riders match' });

    expect(document.querySelector('main b')).toBeNull();
    expect(removeChip('Search: <b>x</b>')).toBeVisible();
  });
});

describe('the rider list: when it cannot be had', () => {
  it('says so in approved words with a retry, and never the server’s text', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'));

    await alertSaying('The riders could not be loaded.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('says that a session without the key lacks it, by key and not by role', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    await alertSaying(cannotText('dispatch.read'));
    expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    expect(document.body.textContent).not.toMatch(/dispatch\.read/);
  });

  // Break caught: a failed read told as "nothing matches", with the filters lost.
  it('keeps a failed read as a failure, with the status and the search in place', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'), READER, '/admin/riders?status=ACTIVE&q=ama');

    await alertSaying('The riders could not be loaded.');
    expect(screen.queryByRole('heading', { name: 'No riders match' })).toBeNull();
    expect(viewTab('Active')).toHaveAttribute('aria-selected', 'true');
    expect(removeChip('Search: ama')).toBeVisible();
  });
});

describeInterfaceStates('The rider list', {
  loading: {
    test: async () => {
      const reads = byHand();
      open(reads.handler);
      expect(await screen.findByText('Loading riders')).toBeVisible();
      await reads.answer(page([kwame]));
      await rowOf('Kwame Mensah');
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
      await alertSaying('That search was not accepted. Use at most 128 characters.');
      expect(removeChip('Search: x')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      await alertSaying(/could not be loaded/);
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
      await view.user.click(await screen.findByRole('button', { name: /try again|retry/i }));
      await rowOf('Kwame Mensah');
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
      expect(await screen.findByText(cannotText('dispatch.read'))).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    },
  },
});
