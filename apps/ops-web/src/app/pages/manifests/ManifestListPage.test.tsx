import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  listedManifestFixture,
  MANIFEST_ID,
  STOP_TWO_ID,
} from '../../../test-support/manifest-fixture';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { PICKUP_HUB_ID } from '../../../test-support/pickup-fixture';
import { pagerRegion } from '../../../test-support/queue-pager';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/manifests` (`listPickupManifests`; S1.25; R7a). The pickup runs of the session's hubs, as the server lists them: oldest first, never filtered by
 * vendor. Two filters, `state` (the views of the page) and `service_date` (OB-S1-25), are the server's: the screen asks, in the address and in the request, and
 * filters nothing itself. A pickup run is named by its code, its state is a labelled badge, and an empty list is told as no pickup runs, or as
 * a filter that hides everything.
 */
const LIST = 'GET /pickup-manifests';
const READER = ['pickup.read'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

const draft = listedManifestFixture();
const started = listedManifestFixture({
  id: STOP_TWO_ID,
  code: 'ACC-MF-K7M4PX',
  state: 'IN_PROGRESS',
  service_date: '2026-11-03',
  assigned_rider_id: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
  assigned_at: '2026-11-02T08:00:00Z',
  dispatched_at: '2026-11-02T09:00:00Z',
  started_at: '2026-11-03T07:30:00Z',
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
  handler: Handler = () => page([draft, started]),
  keys: readonly string[] = READER,
  path = '/manifests',
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

/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Pickup runs' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
/** In a room under 40rem the rows are cards (`narrowRoom`). */
const cards = () => screen.findByRole('list', { name: 'Pickup runs' });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const viewTab = (name: string) => screen.getByRole('tab', { name });
const removeChip = (label: string) =>
  screen.getByRole('button', { name: `Remove filter: ${label}` });
/** The date filter lives in the popover of the filter row: opened with the Filter button, and its field is the date field of the kit. */
async function openDateFilter(view: ReturnType<typeof open>): Promise<HTMLElement> {
  await view.user.click(screen.getByRole('button', { name: 'Filter' }));
  return screen.findByRole('group', { name: 'Service date' });
}
/** The rows of pickup runs the table draws: a run's row header is its code. The table's own message (nothing yet, a failure) sits in a cell and is not one. */
const runRows = () => screen.queryAllByRole('rowheader');
const asked = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-manifests');
const queryOf = (index = -1) => new URL(asked().at(index)?.url ?? 'http://x/').searchParams;

async function rowOf(code: string): Promise<HTMLElement> {
  const row = within(await table())
    .getByRole('link', { name: code })
    .closest('tr');
  if (row === null) throw new Error(`no row for ${code}`);
  return row;
}

describe('the manifests: what the list shows', () => {
  it('shows each manifest by its code, state, day, hub and rider, and links to it', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Pickup runs' })).toBeVisible();
    expect(document.title).toBe('Pickup runs · Melarc Ops Portal');
    const first = await rowOf('ACC-MF-Q92422');
    expect(within(first).getByText('Draft')).toBeVisible();
    expect(within(first).getByText('Wed 4 Nov 2026')).toBeVisible();
    expect(within(first).getByText('Accra Central')).toBeVisible();
    expect(within(first).getByText('No rider yet')).toBeVisible();
    expect(within(first).getByText('Not dispatched')).toBeVisible();
    expect(within(first).getByRole('link', { name: 'ACC-MF-Q92422' })).toHaveAttribute(
      'href',
      `/manifests/${MANIFEST_ID}`,
    );
    const second = await rowOf('ACC-MF-K7M4PX');
    expect(within(second).getByText('In progress')).toBeVisible();
    expect(within(second).getByText('A rider is assigned')).toBeVisible();
    expect(within(second).getByText(/^Started /)).toBeVisible();
  });

  // Break caught: the state told by colour alone, or the raw enum shown where the words belong.
  it('tells the state in words, never as the raw value', async () => {
    open();
    await table();

    expect(screen.queryByText('IN_PROGRESS')).toBeNull();
    expect(screen.queryByText('DRAFT')).toBeNull();
  });

  it('draws a pickup run as a card with the same facts, in a room too narrow for the columns', async () => {
    narrowRoom();
    open();

    const card = within(await cards())
      .getByRole('link', { name: 'ACC-MF-K7M4PX' })
      .closest('li');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('In progress')).toBeVisible();
    expect(within(card as HTMLElement).getByText('Accra Central')).toBeVisible();
    expect(within(card as HTMLElement).getByText('A rider is assigned')).toBeVisible();
  });

  // Break caught: an id shown where a person needs a code, or a hub the session does not act in named as if it were its own.
  it('never shows an id, and names another hub as that', async () => {
    open(() =>
      page([listedManifestFixture({ responsible_hub_id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' })]),
    );

    const row = await rowOf('ACC-MF-Q92422');
    expect(within(row).getByText('Another hub')).toBeVisible();
    expect(document.body.textContent).not.toContain(MANIFEST_ID);
    expect(document.body.textContent).not.toContain('9d0e1f2a');
  });

  it('says it is oldest first, as the server lists it, and asks for no filter until one is chosen', async () => {
    open();
    await table();

    expect(screen.getByText('Oldest first, as the server lists them')).toBeVisible();
    expect(screen.queryByText(/There is no filter yet/)).toBeNull();
    expect(asked()).toHaveLength(1);
    expect([...queryOf(0).keys()]).toEqual([]);
  });

  it('offers a new manifest to a holder of pickup.manifest.create', async () => {
    open(undefined, ['pickup.read', 'pickup.manifest.create']);
    await table();
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Build a pickup run' }),
    ).toHaveAttribute('href', '/manifests/new');
  });

  it('offers no new manifest to a session that may only read the list', async () => {
    open();
    await table();
    expect(
      within(screen.getByRole('main')).queryByRole('link', { name: 'Build a pickup run' }),
    ).toBeNull();
  });

  // Break caught: a page shown in part when one entry in it is not a manifest.
  it('shows no list at all when one manifest in it is not a manifest', async () => {
    open(() => page([draft, { ...started, code: 'not a code' }]));

    await alertSaying('The pickup runs could not be loaded.');
    expect(runRows()).toHaveLength(0);
  });
});

describe('the manifests: paging and freshness', () => {
  it('moves by the server’s token, and back', async () => {
    open((request) =>
      new URL(request.url).searchParams.get('page_token') === 'second'
        ? page([started])
        : page([draft], 'second'),
    );
    await rowOf('ACC-MF-Q92422');
    expect(screen.getByText(/More follow on the next page\./)).toBeVisible();

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await rowOf('ACC-MF-K7M4PX');
    expect(new URL(asked().at(-1)?.url ?? 'http://x/').searchParams.get('page_token')).toBe(
      'second',
    );
    expect(screen.getByText(/on page 2/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Previous page/ }));
    await rowOf('ACC-MF-Q92422');
  });

  // Break caught (the review of 499399c): a pager taken out of the page while the next page is read and made anew with its words, which most screen readers do not announce: the status
  // region is the same element through the read, empty while the page is read.
  it('keeps the pager’s status region while the next page is read', async () => {
    const reads = byHand();
    let calls = 0;
    open((request) => {
      calls += 1;
      return calls === 1 ? page([draft], 'second') : reads.handler(request);
    });
    await rowOf('ACC-MF-Q92422');
    const region = pagerRegion();

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByRole('button', { name: /Next page/ }));
    await waitFor(() => {
      expect(region).toBeEmptyDOMElement();
    });
    expect(pagerRegion()).toBe(region);

    await reads.answer(page([started]));
    await waitFor(() => {
      expect(region).toHaveTextContent('on page 2');
    });
    expect(pagerRegion()).toBe(region);
  });

  it('reads the page again on Refresh, and says when it was last checked', async () => {
    open();
    await table();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    const before = asked().length;

    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }));
    await rowOf('ACC-MF-Q92422');

    expect(asked().length).toBe(before + 1);
  });
});

describe('the manifests: filtering', () => {
  it('asks for every state and day by default, and offers each state the contract has', async () => {
    const view = open();
    await table();

    expect(queryOf(0).has('state')).toBe(false);
    expect(queryOf(0).has('service_date')).toBe(false);
    const views = screen.getByRole('tablist', { name: 'Views of the pickup runs' });
    expect(
      within(views)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['All', 'Draft', 'Dispatched', 'In progress', 'Completed', 'Cancelled']);
    expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('group', { name: 'Filter the pickup runs' })).toBeVisible();
    expect(await openDateFilter(view)).toBeVisible();
  });

  it('asks for the state that is chosen, and puts it in the address', async () => {
    const { user, router } = open();
    await table();

    await user.click(viewTab('In progress'));

    await waitFor(() => {
      expect(queryOf().get('state')).toBe('IN_PROGRESS');
    });
    expect(router.state.location.search).toBe('?state=IN_PROGRESS');
  });

  it('reads the state and the day out of the address', async () => {
    open(undefined, READER, '/manifests?state=DRAFT&date=2026-11-04');

    await table();

    expect(queryOf(0).get('state')).toBe('DRAFT');
    expect(queryOf(0).get('service_date')).toBe('2026-11-04');
    expect(viewTab('Draft')).toHaveAttribute('aria-selected', 'true');
    expect(removeChip('Service date: Wed 4 Nov 2026')).toBeVisible();
  });

  // Break caught: a made-up value in the address sent to the server as a made-up filter, which it answers with a 400.
  it.each([
    'state=everything',
    'state=draft',
    'state=',
    'state=DRAFT%20',
    'date=2026-02-30',
    'date=tomorrow',
    'date=',
    'date=2026-11-03T00:00:00Z',
    'date=04/11/2026',
  ])('takes %s for no filter', async (query) => {
    open(undefined, READER, `/manifests?${query}`);

    await table();

    expect(queryOf(0).has('state')).toBe(false);
    expect(queryOf(0).has('service_date')).toBe(false);
    // And the screen shows no filter either: it does not hold a value it would never send.
    expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: /^Remove filter: / })).toBeNull();
  });

  // Break caught: a repeated parameter sent as it stands in the address, which the contract refuses.
  it('sends one state and one day when the address repeats them', async () => {
    open(
      undefined,
      READER,
      '/manifests?state=DRAFT&state=COMPLETED&date=2026-11-04&date=2026-11-05',
    );

    await table();

    expect(queryOf(0).getAll('state')).toEqual(['DRAFT']);
    expect(queryOf(0).getAll('service_date')).toEqual(['2026-11-04']);
  });

  it('asks for the day that is typed, once it is a whole date, and keeps the state', async () => {
    const view = open(undefined, READER, '/manifests?state=DRAFT');
    const { user, router } = view;
    await table();
    const group = await openDateFilter(view);

    await user.click(within(group).getByRole('textbox'));
    await user.keyboard('04112026');

    await waitFor(() => {
      expect(queryOf().get('service_date')).toBe('2026-11-04');
    });
    expect(queryOf().get('state')).toBe('DRAFT');
    expect(router.state.location.search).toBe('?state=DRAFT&date=2026-11-04');
    // A year still being typed (2, 20, 202) is never asked of the server.
    for (const request of asked()) {
      const date = new URL(request.url).searchParams.get('service_date');
      if (date !== null) expect(Number(date.slice(0, 4))).toBeGreaterThanOrEqual(1000);
    }
  });

  it('takes the day off with its own chip, and keeps the state', async () => {
    const { user, router } = open(undefined, READER, '/manifests?state=DRAFT&date=2026-11-04');
    await table();

    await user.click(removeChip('Service date: Wed 4 Nov 2026'));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?state=DRAFT');
    });
    expect(queryOf().has('service_date')).toBe(false);
    expect(queryOf().get('state')).toBe('DRAFT');
  });

  // Break caught: a screen that sends a parameter the contract refuses (an empty one, a repeated one, a state of another case, a day that does not
  // exist) after a person has chosen, cleared and typed in every order.
  it('sends only parameters the contract accepts, whatever the person does', async () => {
    const view = open();
    const { user } = view;
    await table();

    await user.click(viewTab('Dispatched'));
    await user.click(viewTab('All'));
    await user.click(viewTab('Completed'));
    await user.click(within(await openDateFilter(view)).getByRole('textbox'));
    await user.keyboard('04112026');
    await waitFor(() => {
      expect(queryOf().get('service_date')).toBe('2026-11-04');
    });
    await user.click(removeChip('Service date: Wed 4 Nov 2026'));
    await waitFor(() => {
      expect(queryOf().has('service_date')).toBe(false);
    });

    expect(asked().length).toBeGreaterThan(4);
    for (const request of asked()) {
      const query = new URL(request.url).searchParams;
      const names = [...query.keys()];
      expect(new Set(names).size, request.url).toBe(names.length);
      for (const [name, value] of query) {
        expect(['state', 'service_date', 'page_token'], request.url).toContain(name);
        expect(value, request.url).not.toBe('');
      }
      const state = query.get('state');
      if (state !== null) {
        expect(['DRAFT', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).toContain(state);
      }
      const date = query.get('service_date');
      if (date !== null) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  // Break caught: a page filtered in the browser, which would pass a part of the page for the whole and hide what the server returned.
  it('draws what the server returned, whole, and filters nothing itself', async () => {
    open(() => page([draft, started]), READER, '/manifests?state=DRAFT');

    await rowOf('ACC-MF-Q92422');
    await rowOf('ACC-MF-K7M4PX');
    expect(within(await table()).getAllByRole('row')).toHaveLength(3);
  });
});

describe('the manifests: paging under a filter', () => {
  // Break caught: the next page of one filter asked for under another.
  it('starts again at the first page when the state changes', async () => {
    const { user } = open(() => page([draft], 'next-1'));
    await table();
    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await screen.findByText(/on page 2/);
    expect(queryOf().get('page_token')).toBe('next-1');

    await user.click(viewTab('Draft'));

    await waitFor(() => {
      expect(queryOf().get('state')).toBe('DRAFT');
    });
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page 2/)).toBeNull();
  });

  it('starts again at the first page when the day changes', async () => {
    const view = open(() => page([draft], 'next-1'));
    const { user } = view;
    await table();
    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await screen.findByText(/on page 2/);

    await user.click(within(await openDateFilter(view)).getByRole('textbox'));
    await user.keyboard('04112026');

    await waitFor(() => {
      expect(queryOf().get('service_date')).toBe('2026-11-04');
    });
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('sends the page token with the filters it was made with', async () => {
    const { user } = open(() => page([draft], 'next-1'), READER, '/manifests?state=DRAFT');
    await table();

    await user.click(screen.getByRole('button', { name: /Next page/ }));
    await screen.findByText(/on page 2/);

    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('DRAFT');
  });
});

describe('the manifests: nothing to show', () => {
  it('tells a list with no manifests at all as that', async () => {
    open(() => page([]));

    expect(await screen.findByRole('heading', { name: 'No pickup runs yet' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No pickup runs match' })).toBeNull();
  });

  // Break caught (ops-portal.md section 7): "no manifests" and "filtered to nothing" told as one, which sends Ops hunting for a bug.
  it('tells a filter that hides everything differently, naming what was filtered, and takes every filter off in one move', async () => {
    const { user, router } = open(
      () => page([]),
      READER,
      '/manifests?state=IN_PROGRESS&date=2026-11-04',
    );

    expect(await screen.findByRole('heading', { name: 'No pickup runs match' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No pickup runs yet' })).toBeNull();
    expect(
      screen.getByText(/Nothing fits the state In progress and the service date Wed 4 Nov 2026\./),
    ).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Show every pickup run' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
    expect(queryOf().has('state')).toBe(false);
    expect(queryOf().has('service_date')).toBe(false);
  });

  it('names a single filter by itself', async () => {
    open(() => page([]), READER, '/manifests?state=COMPLETED');

    expect(await screen.findByText(/Nothing fits the state Completed\./)).toBeVisible();
    expect(screen.queryByText(/the service date/)).toBeNull();
  });

  it('tells a later page with nothing on it, under a filter, as a page and not as a filter', async () => {
    const { user } = open(
      (request) =>
        new URL(request.url).searchParams.has('page_token') ? page([]) : page([draft], 'next-1'),
      READER,
      '/manifests?state=DRAFT',
    );
    await table();

    await user.click(screen.getByRole('button', { name: /Next page/ }));

    expect(
      await screen.findByRole('heading', { name: 'No pickup runs on this page' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No pickup runs match' })).toBeNull();
  });
});

describe('the manifests: when the list cannot be had under a filter', () => {
  // Break caught: a failed read told as "nothing matches", which would hide a fault behind a filter.
  it('keeps a failed read as a failure, with the filters in place and a way to try again', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'), READER, '/manifests?state=DRAFT');

    await alertSaying('The pickup runs could not be loaded.');
    expect(screen.queryByRole('heading', { name: 'No pickup runs match' })).toBeNull();
    expect(viewTab('Draft')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  // Break caught: a refused filter told as a refused page, or as an empty list that hides the mistake.
  it('tells a filter the server refused as that, and not as an empty list', async () => {
    open(
      () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/state', rule: 'enum' }],
        }),
      READER,
      '/manifests?state=DRAFT',
    );

    await alertSaying('That filter was not accepted. Choose a state and a whole date.');
    expect(screen.queryByRole('heading', { name: 'No pickup runs match' })).toBeNull();
    expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
  });

  it('tells a page the server will not open, as the real API names it, and goes back to the first page', async () => {
    const { user } = open((request) =>
      new URL(request.url).searchParams.has('page_token')
        ? refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: '/page_token', rule: 'format' }],
          })
        : page([draft], 'next-1'),
    );
    await table();
    await user.click(screen.getByRole('button', { name: /Next page/ }));

    await alertSaying('That page of the pickup runs could not be opened');
    await user.click(screen.getByRole('button', { name: 'Back to first page' }));

    await rowOf('ACC-MF-Q92422');
    expect(queryOf().has('page_token')).toBe(false);
  });
});

describeInterfaceStates('the manifest list', {
  loading: {
    test: async () => {
      open(() => new Promise<Response>(() => undefined));
      expect(await screen.findByText('Loading pickup runs')).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      open(() => page([]));
      expect(await screen.findByRole('heading', { name: 'No pickup runs yet' })).toBeVisible();
      expect(screen.queryByText(/filtered|match/i)).toBeNull();
      // And a filter that hides everything is another state (the filtering tests above).
      expect(screen.queryByRole('heading', { name: 'No pickup runs match' })).toBeNull();
    },
  },
  'validation error': {
    test: async () => {
      open(
        () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: '/service_date', rule: 'format' }],
          }),
        READER,
        '/manifests?date=2026-11-04',
      );
      await alertSaying('That filter was not accepted. Choose a state and a whole date.');
      expect(removeChip('Service date: Wed 4 Nov 2026')).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL_ERROR'));
      await alertSaying('The pickup runs could not be loaded.');
      expect(screen.queryByText(DIAGNOSTIC)).toBeNull();
    },
  },
  retry: {
    test: async () => {
      let calls = 0;
      open(() => (calls++ === 0 ? refusal(500, 'INTERNAL_ERROR') : page([draft])));
      const { default: userEvent } = await import('@testing-library/user-event');
      await userEvent
        .setup()
        .click(await screen.findByRole('button', { name: /try again|retry/i }));
      await rowOf('ACC-MF-Q92422');
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list is read-only and sends no version: how current it is told by the time of its last check and by Refresh page, not by a conflict.',
  },
  success: {
    test: async () => {
      open();
      await rowOf('ACC-MF-Q92422');
    },
  },
  'permission-restricted': {
    test: async () => {
      open(() => refusal(403, 'PERMISSION_DENIED'));
      await alertSaying('Your account can’t see pickup runs. Ask an administrator for access.');
    },
  },
});
