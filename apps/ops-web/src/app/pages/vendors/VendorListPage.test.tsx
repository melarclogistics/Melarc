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
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { VENDOR_HUB_ID, vendorAccountFixture } from '../../../test-support/vendor-fixture';
import { cannotText } from '../../../platform/problem/capability-words';

/**
 * `/admin/vendors` (`listVendorAccounts`; S0.52b; redesign step R7b, drawn by the queue workspace template). The vendor accounts the session's grant
 * reaches: identifier, organisation, status, whether a secret exists and how many browsers are active. Never a credential or a recovery address. The
 * server filters (the search, `q`, in the address and in the request) and pages (by token); the screen draws what comes back, whole.
 */
const LIST = 'GET /ops/vendors';
const READER = ['vendor.read'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

const second = vendorAccountFixture({
  id: '1f2a3b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  account_identifier: 'P4N8W2R6',
  legal_name: 'Boateng Textiles',
  status: 'SUSPENDED',
  credential_established: false,
  active_device_count: 0,
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
  handler: Handler = () => page([vendorAccountFixture(), second]),
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

/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Vendor accounts' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
/** In a room under 40rem the rows are cards (`narrowRoom`). */
const cards = () => screen.findByRole('list', { name: 'Vendor accounts' });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const asked = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/ops/vendors');
const queryOf = (index = -1) => new URL(asked().at(index)?.url ?? 'http://x/').searchParams;
const removeChip = (label: string) =>
  screen.getByRole('button', { name: `Remove filter: ${label}` });

/** The search is a field in the bar, always there: nothing is opened to find it. */
const searchField = (): Promise<HTMLElement> =>
  screen.findByRole('searchbox', { name: 'Search by organisation or account' });

async function rowOf(code: string): Promise<HTMLElement> {
  const row = within(await table())
    .getByRole('link', { name: code })
    .closest('tr');
  if (row === null) throw new Error(`no row for ${code}`);
  return row;
}

describe('the vendor list: what it shows', () => {
  it('shows each account by its identifier over its organisation, with its status, secret, browsers and hub, and links to it', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Vendors' })).toBeVisible();
    expect(document.title).toBe('Vendors · Melarc Ops Portal');
    const row = await rowOf('K7M2Q9X4');
    expect(within(row).getByRole('rowheader')).toHaveTextContent(/K7M2Q9X4\s*Asante Fabrics Ltd/);
    expect(within(row).getByText('Active')).toBeVisible();
    expect(within(row).getByText('Set')).toBeVisible();
    expect(within(row).getByText('1')).toBeVisible();
    expect(within(row).getByText('Accra Central')).toBeVisible();
    expect(within(row).getByRole('link', { name: 'K7M2Q9X4' })).toHaveAttribute(
      'href',
      `/admin/vendors/${vendorAccountFixture().id}`,
    );
    const other = await rowOf('P4N8W2R6');
    expect(within(other).getByText('Suspended')).toBeVisible();
    expect(within(other).getByText('Not set yet')).toBeVisible();
  });

  // Break caught: the state told by colour alone, or the raw enum shown where the words belong.
  it('tells the state in words, never as the raw value', async () => {
    open();
    await table();

    expect(screen.queryByText('SUSPENDED')).toBeNull();
    expect(screen.queryByText('ACTIVE')).toBeNull();
  });

  it('draws an account as a card with the same facts, in a room too narrow for the columns', async () => {
    narrowRoom();
    open();

    const card = within(await cards())
      .getByRole('link', { name: 'P4N8W2R6' })
      .closest('li');
    expect(card).not.toBeNull();
    const facts = within(card as HTMLElement);
    expect(facts.getByText('Suspended')).toBeVisible();
    expect(facts.getByText('Boateng Textiles')).toBeVisible();
    expect(facts.getByText('Not set yet')).toBeVisible();
    expect(facts.getByText('Accra Central')).toBeVisible();
    expect(facts.getByText('0')).toBeVisible();
    // Each fact beyond the status and the organisation is a label and its value (CardFacts), the labels the columns have.
    expect(facts.getAllByRole('term').map((term) => term.textContent)).toEqual([
      'Secret',
      'Active browsers',
      'Hub',
    ]);
  });

  // Break caught (the Product Owner, 10 November 2026: no table scrolls sideways): a list that marks no column lesser, so that a box that cannot hold the five scrolls sideways where the hub, the
  // browsers and the secret could have gone. The account and its status are never lesser; the hub is the most lesser.
  it('marks the secret, the browsers and the hub as the lesser columns, the hub the most lesser, and the account and the status not', async () => {
    open();

    const found = await table();
    const priorities = Object.fromEntries(
      within(found)
        .getAllByRole('columnheader')
        .map((cell) => [cell.textContent, cell.getAttribute('data-priority')]),
    );
    // A column that is not lesser carries no mark: it is always drawn.
    expect(priorities).toEqual({
      'Account / organisation': null,
      Status: null,
      Secret: '2',
      'Active browsers': '2',
      Hub: '3',
    });
  });

  // Break caught: an id shown where a person needs a name, or a hub the session does not act in named as if it were its own.
  it('never shows an id, and names another hub as that', async () => {
    open(() =>
      page([vendorAccountFixture({ responsible_hub_id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' })]),
    );

    const row = await rowOf('K7M2Q9X4');
    expect(within(row).getByText('Another hub')).toBeVisible();
    expect(document.body.textContent).not.toContain(vendorAccountFixture().id);
    expect(document.body.textContent).not.toContain('9d0e1f2a');
  });

  // Break caught: a credential or a recovery address that a server should never send drawn on the list, in the table or in the card.
  it.each([
    ['a table', false],
    ['cards', true],
  ])(
    'draws nothing of a credential or a recovery address in %s, even when an answer carries one',
    async (_name, narrow) => {
      if (narrow) narrowRoom();
      open(() =>
        page([
          {
            ...vendorAccountFixture(),
            secret_hash: 'SECRET-HASH',
            recovery_email: 'owner@asante.example',
          },
        ]),
      );
      await (narrow ? cards() : table());

      expect(screen.getByText('Asante Fabrics Ltd')).toBeVisible();
      expect(document.body.textContent).not.toMatch(/SECRET-HASH|owner@asante\.example/);
    },
  );

  // Break caught: a page shown in part when one entry in it is not an account.
  it('shows no list at all when one account in it is not an account', async () => {
    open(() => page([vendorAccountFixture(), { ...second, status: 'WITHDRAWN' }]));

    await alertSaying(/could not be loaded/);
    expect(screen.queryByRole('rowheader')).toBeNull();
  });
});

describe('the vendor list: paging and freshness', () => {
  it('moves by the server’s token, and back', async () => {
    const { user } = open((request) =>
      new URL(request.url).searchParams.get('page_token') === 'second'
        ? page([second])
        : page([vendorAccountFixture()], 'second'),
    );
    await rowOf('K7M2Q9X4');
    expect(screen.getByText(/More follow on the next page\./)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await rowOf('P4N8W2R6');
    expect(queryOf().get('page_token')).toBe('second');
    expect(screen.getByText(/on page 2/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Previous page/ }));
    await rowOf('K7M2Q9X4');
  });

  // Break caught (the review of 499399c): a pager taken out of the page while the next page is read and made anew with its words, which most screen readers do not announce.
  it('keeps the pager’s status region while the next page is read', async () => {
    const reads = byHand();
    let calls = 0;
    const { user } = open((request) => {
      calls += 1;
      return calls === 1 ? page([vendorAccountFixture()], 'second') : reads.handler(request);
    });
    await rowOf('K7M2Q9X4');
    const region = pagerRegion();

    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await waitFor(() => {
      expect(region).toBeEmptyDOMElement();
    });
    expect(pagerRegion()).toBe(region);

    await reads.answer(page([second]));
    await waitFor(() => {
      expect(region).toHaveTextContent('on page 2');
    });
    expect(pagerRegion()).toBe(region);
  });

  // Break caught: focus left on a pager button that is gone, which drops a keyboard user at the top of the document.
  it('puts focus on the results once the next page is read', async () => {
    const { user } = open((request) =>
      new URL(request.url).searchParams.has('page_token')
        ? page([second])
        : page([vendorAccountFixture()], 'second'),
    );
    await rowOf('K7M2Q9X4');

    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await rowOf('P4N8W2R6');

    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
    });
    expect(screen.getByRole('main').contains(document.activeElement)).toBe(true);
  });

  it('reads the page again on Refresh, and says when it was last checked', async () => {
    const { user } = open();
    await table();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    const before = asked().length;

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await rowOf('K7M2Q9X4');

    expect(asked().length).toBe(before + 1);
  });
});

describe('the vendor list: the search', () => {
  // Break caught (the Product Owner, 10 November 2026): a page after the first that holds nothing told as "No vendor accounts yet" or "No vendor accounts match", as if the list were empty; or with
  // no way back to the first page. A page past the end is only that.
  it('tells an empty page after the first as that, with the way back to the first page', async () => {
    let reads = 0;
    const view = open(() => {
      reads += 1;
      return reads === 2 ? page([]) : page([vendorAccountFixture()], 'next-1');
    });
    await table();
    await view.user.click(await screen.findByRole('button', { name: /Next page/ }));

    expect(
      await screen.findByRole('heading', { name: 'No vendor accounts on this page' }),
    ).toBeVisible();
    expect(
      screen.getByText('Page 2 has no vendor accounts now. Earlier pages may still have some.'),
    ).toBeVisible();
    expect(screen.queryByText('No vendor accounts yet')).toBeNull();

    await view.user.click(screen.getByRole('button', { name: 'Back to first page' }));
    expect(await screen.findByRole('link', { name: 'K7M2Q9X4' })).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
  });

  // Break caught (the Product Owner, 10 November 2026): a search that is behind the Filter button, so that the person opens something to find an account.
  it('has the search in the bar and no Filter button', async () => {
    open();
    await table();

    expect(await searchField()).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
  });

  // Break caught: a field that takes more than the server accepts, so that a long search is refused after it was typed.
  it('limits a search to what the server accepts, as it is typed', async () => {
    open();
    await table();

    expect(await searchField()).toHaveAttribute('maxlength', '128');
  });

  it('sends the search in the query, keeps it in the address, and shows it as a filter that can be taken off', async () => {
    const view = open();
    await table();

    await view.user.type(await searchField(), 'asante');
    await view.user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(queryOf().get('q')).toBe('asante');
    });
    expect(view.router.state.location.search).toBe('?q=asante');
    await rowOf('K7M2Q9X4');
    expect(removeChip('Search: asante')).toBeVisible();
  });

  it('asks for nothing when no search is set, and sends one search when the address has it', async () => {
    open(undefined, READER, '/admin/vendors?q=asante');
    await table();

    expect(asked()).toHaveLength(1);
    expect(queryOf(0).get('q')).toBe('asante');
    expect(removeChip('Search: asante')).toBeVisible();
  });

  it('takes the search off with its own chip', async () => {
    const { user, router } = open(undefined, READER, '/admin/vendors?q=asante');
    await table();

    await user.click(removeChip('Search: asante'));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    // An empty search is no search: the request carries no `q` at all.
    await waitFor(() => {
      expect(queryOf().has('q')).toBe(false);
    });
    expect(asked().length).toBeGreaterThan(1);
    expect(screen.queryByRole('button', { name: /^Remove filter: / })).toBeNull();
  });

  // Break caught: the next page of one search asked for under another.
  it('starts again at the first page when the search changes', async () => {
    const view = open(() => page([vendorAccountFixture()], 'next-1'));
    await table();
    await view.user.click(screen.getByRole('button', { name: /Next page/ }));
    await screen.findByText(/on page 2/);
    expect(queryOf().get('page_token')).toBe('next-1');

    await view.user.type(await searchField(), 'asante');
    await view.user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(queryOf().get('q')).toBe('asante');
    });
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page 2/)).toBeNull();
  });
});

describe('the vendor list: nothing to show', () => {
  it('tells a list with no accounts at all as that', async () => {
    open(() => page([]));

    expect(await screen.findByRole('heading', { name: 'No vendor accounts yet' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No vendor accounts match' })).toBeNull();
  });

  // Break caught: "no accounts" and "a search that hides everything" told as one, which sends Ops hunting for a bug.
  it('tells a search that hides everything differently, and takes it off in one move', async () => {
    const { user, router } = open(() => page([]), READER, '/admin/vendors?q=zzz');

    expect(await screen.findByRole('heading', { name: 'No vendor accounts match' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No vendor accounts yet' })).toBeNull();
    expect(
      screen.getByText('Nothing fits this search. Clear it to see every account.'),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Clear the search' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
  });

  // Break caught: a failed read told as "nothing matches", which would hide a fault behind a search.
  it('keeps a failed read as a failure, with the search in place and a way to try again', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'), READER, '/admin/vendors?q=asante');

    await alertSaying(/could not be loaded/);
    expect(screen.queryByRole('heading', { name: 'No vendor accounts match' })).toBeNull();
    expect(removeChip('Search: asante')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });
});

describeInterfaceStates('The vendor list', {
  loading: {
    test: async () => {
      const reads = byHand();
      open(reads.handler);
      expect(await screen.findByText('Loading vendor accounts')).toBeVisible();
      await reads.answer(page([vendorAccountFixture()]));
      await rowOf('K7M2Q9X4');
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
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
      await alertSaying('That search was not accepted. Use at most 128 characters.');
      expect(removeChip('Search: x')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      await alertSaying(/could not be loaded/);
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
      expect(document.body.textContent).not.toContain('Diagnostic text');
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SETTING_MISSING') : page([vendorAccountFixture()]);
      });
      await view.user.click(await screen.findByRole('button', { name: /try again|retry/i }));
      await rowOf('K7M2Q9X4');
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list changes nothing and carries no version; an account that moved is read again from its own page.',
  },
  success: {
    test: async () => {
      open(() => page([vendorAccountFixture()]));
      expect(await screen.findByText('Showing 1 account.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      // The route's guard refuses a session that does not list the key; the server refuses a session that lists it and is refused (the read is the server's).
      open(undefined, ['staff.read']);
      expect(await screen.findByText(cannotText('vendor.read'))).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    },
  },
});

describe('the vendor list: a refusal of the read', () => {
  it('tells what the account cannot do, in plain words and never by a key', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    const alert = await alertSaying(cannotText('vendor.read'));
    expect(alert).not.toHaveTextContent(/vendor\.read/);
  });
});
