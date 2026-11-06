import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import {
  EARLIER_REQUEST_ID,
  exceptionFixture,
  PICKUP_HUB_ID,
  pickupRequestFixture,
  REQUEST_ID,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/pickup-requests` (`listPickupRequests`; S1.19). The queue of the requests at the session's hubs, filtered by state and service date, and
 * an empty queue told apart from a filter that hides everything.
 */
const LIST = 'GET /pickup-requests';
const READER = ['pickup.read'];
const DIAGNOSTIC = /Diagnostic text that must never reach a screen\./;

const pending = pickupRequestFixture();
const late = pickupRequestFixture({
  id: EARLIER_REQUEST_ID,
  code: 'ACC-PR-9WXH4T',
  state: 'CONFIRMED',
  pickup_intent: 'ADHOC_SENDER',
  declared_package_count: 1,
  one_package_exception_id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
  cutoff_exception_state: 'PENDING_OPS_REVIEW',
  resolved_pickup_location: { address: '2 Demo Close, Labone' },
  scheduled_service_date: '2026-11-07',
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  handler: Handler = () => page([pending, late]),
  keys: readonly string[] = READER,
  path = '/pickup-requests',
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

const listRequests = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-requests');
const queryOf = (index = -1) => new URL(listRequests().at(index)?.url ?? 'http://x/').searchParams;

/**
 * The queue draws every request twice, as a row of a table and as a card, and the stylesheet shows the one that fits the room (jsdom applies
 * no CSS, so both are here; the browser spec proves that only one is ever exposed). Each test therefore says which of the two it reads.
 */
const queueTable = () => screen.findByRole('table', { name: 'Pickup requests' });
const queueCards = () => screen.findByRole('list', { name: 'Pickup requests' });

async function rowOf(code: string): Promise<HTMLElement> {
  const row = within(await queueTable())
    .getByRole('link', { name: code })
    .closest('tr');
  if (row === null) throw new Error(`no row for ${code}`);
  return row;
}

async function cardOf(code: string): Promise<HTMLElement> {
  const card = within(await queueCards())
    .getByRole('link', { name: code })
    .closest('li');
  if (card === null) throw new Error(`no card for ${code}`);
  return card;
}

/** The value a card gives for a label ("Service date"): the definition that follows its term. */
function factOf(card: HTMLElement, label: string): HTMLElement {
  const value = within(card).getByText(label).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
  return value;
}

describe('the queue: what it shows', () => {
  it('shows each request by its code, state, date, kind, packages, place and hub, and links to it', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1, name: 'Pickup requests' })).toBeVisible();
    expect(document.title).toBe('Pickup requests · Melarc Ops Portal');
    const first = await rowOf('ACC-PR-7KQ2MZ');
    expect(within(first).getByText('Waiting for confirmation')).toBeVisible();
    expect(within(first).getByText('Tue 3 Nov 2026')).toBeVisible();
    expect(within(first).getByText('A vendor’s own packages')).toBeVisible();
    expect(within(first).getByText('3 packages')).toBeVisible();
    expect(within(first).getByText('14 Demo Lane, Osu')).toBeVisible();
    expect(within(first).getByText('Accra Central')).toBeVisible();
    expect(within(first).getByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ID}`,
    );
  });

  // The queue makes pending work visible (ops-portal.md section 4): a late booking waiting for a decision says so in words.
  it('says what a request needs, in words', async () => {
    open();

    const row = await rowOf('ACC-PR-9WXH4T');
    expect(within(row).getByText('Late booking to decide')).toBeVisible();
    expect(within(row).getByText('1 package')).toBeVisible();
    expect(within(row).getByText('A walk-in sender')).toBeVisible();
  });

  it('says a single package needs its exception, or that its exception waits for approval', async () => {
    open(() =>
      page([
        pickupRequestFixture({ declared_package_count: 1 }),
        pickupRequestFixture({
          id: EARLIER_REQUEST_ID,
          code: 'ACC-PR-9WXH4T',
          declared_package_count: 1,
          one_package_exception: exceptionFixture(),
        }),
      ]),
    );

    const asking = await rowOf('ACC-PR-7KQ2MZ');
    const waiting = await rowOf('ACC-PR-9WXH4T');
    expect(within(asking).getByText('One-package exception to request')).toBeVisible();
    expect(within(waiting).getByText('One-package exception waiting for approval')).toBeVisible();
  });

  it('names the sender of each request', async () => {
    open();

    const first = await rowOf('ACC-PR-7KQ2MZ');
    expect(within(first).getByText('Demo Fabrics Ltd')).toBeVisible();
  });

  // Break caught: an id shown where a person needs a code, or a hub the session does not act in named as if it were its own.
  it('never shows a request’s id, and names another hub as that', async () => {
    open(() =>
      page([pickupRequestFixture({ responsible_hub_id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' })]),
    );

    const row = await rowOf('ACC-PR-7KQ2MZ');
    expect(within(row).getByText('Another hub')).toBeVisible();
    expect(within(await cardOf('ACC-PR-7KQ2MZ')).getByText('Another hub')).toBeVisible();
    expect(document.body.textContent).not.toContain(REQUEST_ID);
    expect(document.body.textContent).not.toContain('9d0e1f2a');
  });

  // Break caught: a queue that shows part of a page when one request in it is not one.
  it('shows no queue at all when one request in it is not a request', async () => {
    open(() => page([pending, { ...late, code: 'not a code' }]));

    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Pickup requests' })).toBeNull();
  });

  // The menu offers the booking too; this is the page's own action, in its main content.
  it('offers a booking to a holder of pickup.request.create', async () => {
    open(undefined, ['pickup.read', 'pickup.request.create']);
    await screen.findByRole('table', { name: 'Pickup requests' });
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Book a pickup' }),
    ).toHaveAttribute('href', '/pickup-requests/new');
  });

  it('offers no booking to a session that may only read the queue', async () => {
    open();
    await screen.findByRole('table', { name: 'Pickup requests' });
    expect(screen.queryByRole('link', { name: 'Book a pickup' })).toBeNull();
  });
});

/**
 * Every fact the queue tells of the two demo requests, in the words the screen uses. A request is drawn twice (a row and a card) and neither
 * may tell less than the other: a phone is not a lesser queue.
 */
const FACTS_OF_PENDING = [
  'ACC-PR-7KQ2MZ',
  'Demo Fabrics Ltd',
  'Waiting for confirmation',
  'Tue 3 Nov 2026',
  '14 Demo Lane, Osu',
  'Accra Central',
  '3 packages',
  'A vendor’s own packages',
];
const FACTS_OF_LATE = [
  'ACC-PR-9WXH4T',
  'Demo Fabrics Ltd',
  'Confirmed',
  'Sat 7 Nov 2026',
  '2 Demo Close, Labone',
  'Accra Central',
  '1 package',
  'A walk-in sender',
  'Late booking to decide',
];

describe('the queue: six columns, and the same facts as cards', () => {
  it('says in one short sentence what the page lists, and keeps its one heading', async () => {
    open();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Pickup requests');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Requests at your authorized hubs.')).toBeVisible();
  });

  it('groups the facts into six columns, named for what each holds', async () => {
    open();

    expect(
      within(await queueTable())
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Request / sender',
      'State',
      'Service date',
      'Pickup address / hub',
      'Packages / booking type',
      'Needs',
    ]);
  });

  it('puts the sender with the code, the hub with the address and the booking type with the packages', async () => {
    open();

    const row = await rowOf('ACC-PR-9WXH4T');
    const cells = within(row).getAllByRole('cell');

    expect(within(row).getByRole('rowheader')).toHaveTextContent(
      /^ACC-PR-9WXH4T\s*Demo Fabrics Ltd$/,
    );
    expect(cells).toHaveLength(5);
    const [state, date, place, packages, needs] = cells;
    expect(state).toHaveTextContent(/^Confirmed$/);
    expect(date).toHaveTextContent(/^Sat 7 Nov 2026$/);
    expect(place).toHaveTextContent(/^2 Demo Close, Labone\s*Accra Central$/);
    expect(packages).toHaveTextContent(/^1 package\s*A walk-in sender$/);
    expect(needs).toHaveTextContent(/^Late booking to decide$/);
  });

  it('tells every fact of a request in its row and in its card', async () => {
    open();

    for (const facts of [FACTS_OF_PENDING, FACTS_OF_LATE]) {
      const code = facts[0] ?? '';
      const row = await rowOf(code);
      const card = await cardOf(code);
      for (const fact of facts) {
        expect(within(row).getByText(fact), `${fact} in the row of ${code}`).toBeInTheDocument();
        expect(within(card).getByText(fact), `${fact} in the card of ${code}`).toBeInTheDocument();
      }
    }
  });

  it('draws a card as the code over the state, then the sender, then the facts, in the order a person reads them', async () => {
    open();

    const card = await cardOf('ACC-PR-9WXH4T');

    const heading = within(card).getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('ACC-PR-9WXH4T');
    expect(within(heading).getByRole('link', { name: 'ACC-PR-9WXH4T' })).toHaveAttribute(
      'href',
      `/pickup-requests/${EARLIER_REQUEST_ID}`,
    );
    expect(factOf(card, 'Service date')).toHaveTextContent('Sat 7 Nov 2026');
    expect(factOf(card, 'Pickup address / hub')).toHaveTextContent(
      /^2 Demo Close, Labone\s*Accra Central$/,
    );
    expect(factOf(card, 'Packages / booking type')).toHaveTextContent(
      /^1 package\s*A walk-in sender$/,
    );
    expect(factOf(card, 'Needs')).toHaveTextContent('Late booking to decide');
    expect(card.textContent).toMatch(
      /ACC-PR-9WXH4T.*Confirmed.*Demo Fabrics Ltd.*Service date.*Pickup address \/ hub.*Packages \/ booking type.*Needs/s,
    );
  });

  // Break caught: a request opened by a click beside its code, which a keyboard cannot do and a modifier-click cannot send to a new tab.
  it('makes the code the one link of a request, and the row and the card no link at all', async () => {
    const { user, router } = open();
    const row = await rowOf('ACC-PR-7KQ2MZ');
    const card = await cardOf('ACC-PR-7KQ2MZ');

    expect(within(row).getAllByRole('link')).toHaveLength(1);
    expect(within(card).getAllByRole('link')).toHaveLength(1);
    await user.click(within(row).getByText('Demo Fabrics Ltd'));
    await user.click(within(card).getByText('Service date'));

    expect(router.state.location.pathname).toBe('/pickup-requests');
  });

  // Break caught: a fact the record lacks drawn as nothing, or as a made-up value, so that a missing count would pass for none.
  it('says a fact is not recorded where the record lacks it, in the row and in the card', async () => {
    open(() =>
      page([
        pickupRequestFixture({
          sender_name: null,
          pickup_intent: undefined,
          declared_package_count: undefined,
          resolved_pickup_location: undefined,
        }),
      ]),
    );

    const row = await rowOf('ACC-PR-7KQ2MZ');
    const card = await cardOf('ACC-PR-7KQ2MZ');

    // The sender, the address, the packages and the booking type: four facts, each told as missing and none as a count of zero.
    expect(within(row).getAllByText('Not recorded')).toHaveLength(4);
    expect(within(card).getAllByText('Not recorded')).toHaveLength(4);
    expect(within(row).queryByText(/^\d+ packages?$/)).toBeNull();
    expect(within(card).queryByText(/^\d+ packages?$/)).toBeNull();
  });

  // The pickup address is the server's resolved one, never another address on the record (a recipient's, here) in its place.
  it('shows the address the server resolved for the pickup, and no other address of the record', async () => {
    open(() => page([pickupRequestFixture({ one_package_exception: exceptionFixture() })]));

    const row = await rowOf('ACC-PR-7KQ2MZ');
    const card = await cardOf('ACC-PR-7KQ2MZ');

    for (const place of [row, card]) {
      expect(within(place).getByText('14 Demo Lane, Osu')).toBeVisible();
      expect(place).not.toHaveTextContent('9 Demo Street, Tema');
    }
  });

  // Break caught: a request that needs nothing drawn as an empty cell, which says nothing to a screen reader, or as a claim that nothing
  // blocks it (the dash is neutral: it does not say the request may be confirmed).
  it('draws a dash that a screen reader reads as "No additional note" when a request needs nothing', async () => {
    open();

    const row = await rowOf('ACC-PR-7KQ2MZ');
    const card = await cardOf('ACC-PR-7KQ2MZ');

    for (const place of [row, card]) {
      expect(within(place).getByText('No additional note')).toBeInTheDocument();
      expect(within(place).getByText('—')).toHaveAttribute('aria-hidden', 'true');
      expect(place).not.toHaveTextContent(/blocker|nothing to do|ready/i);
    }
  });

  it('keeps a long address and a long note whole, for the stylesheet to wrap', async () => {
    const address =
      'Plot 14, Block C, off the Independence Avenue service road beside the old demo bakery, Ridge, Accra, Greater Accra Region';
    const sender = 'Demo Fabrics and Household Linen Wholesale Trading Company Limited';
    open(() =>
      page([
        pickupRequestFixture({
          declared_package_count: 1,
          sender_name: sender,
          resolved_pickup_location: { address },
        }),
      ]),
    );

    for (const place of [await rowOf('ACC-PR-7KQ2MZ'), await cardOf('ACC-PR-7KQ2MZ')]) {
      expect(within(place).getByText(address)).toBeVisible();
      expect(within(place).getByText(sender)).toBeVisible();
      expect(within(place).getByText('One-package exception to request')).toBeVisible();
      expect(place.querySelector('[title]')).toBeNull();
    }
  });
});

/**
 * The filters, the count, the rows and the pager of the queue sit in one panel, and so does whatever stands in the place of the rows: the
 * loading, the empty state, a failure and a refusal. The stylesheet draws the surface (jsdom applies no CSS; the browser spec holds how it looks),
 * so the person never meets a state outside the surface the rows would have been drawn on.
 */
describe('the queue: one panel', () => {
  const filters = () => screen.getByRole('group', { name: 'Filter the pickup requests' });
  const panelOf = (element: HTMLElement) => element.closest('.ui-queue-panel');

  it('holds the filters, the count, the rows as a table and as cards, and the pager', async () => {
    open(() => page([pending, late], 'next-1'));

    const panel = panelOf(await queueTable());

    expect(panel).not.toBeNull();
    expect(panel).toContainElement(filters());
    // The count is found by its words: the refresh keeps a status of its own, for its announcement, in the same panel.
    expect(panel).toContainElement(screen.getByText(/^Showing 2 requests/));
    expect(panel).toContainElement(await queueCards());
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Next page' }));
    expect(document.querySelectorAll('.ui-queue-panel')).toHaveLength(1);
  });

  it('holds the filters and the loading', async () => {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    open(() => gate);

    const loading = await screen.findByText('Loading the pickup requests…');

    expect(panelOf(loading)).toContainElement(filters());
    await act(async () => {
      release(page([pending]));
      await gate;
    });
    await queueTable();
  });

  it('holds the filters and the empty state of a queue with no requests', async () => {
    open(() => page([]));

    const empty = await screen.findByRole('heading', { name: 'No pickup requests yet' });

    expect(panelOf(empty)).toContainElement(filters());
  });

  it('holds the filters and the empty state of a filter that hides everything', async () => {
    open(() => page([]), READER, '/pickup-requests?state=DECLINED');

    const empty = await screen.findByRole('heading', { name: 'No pickup requests match' });

    expect(panelOf(empty)).toContainElement(filters());
  });

  it('holds the filters, the failure and its retry', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'));

    const failure = await screen.findByText('The pickup requests could not be loaded.');

    expect(panelOf(failure)).toContainElement(filters());
    expect(panelOf(failure)).toContainElement(screen.getByRole('button', { name: 'Try again' }));
  });

  // The server's refusal of the read. A session that does not hold the key at all never reaches the page: the route's guard names the key instead.
  it('holds the filters and the refusal that names the permission', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    const refused = await screen.findByText(/pickup\.read/);

    expect(panelOf(refused)).toContainElement(filters());
  });
});

describe('the queue: filtering', () => {
  it('asks for every state and date by default, and offers each state the contract has', async () => {
    open();
    await screen.findByRole('table', { name: 'Pickup requests' });

    expect(queryOf(0).has('state')).toBe(false);
    expect(queryOf(0).has('service_date')).toBe(false);
    const filter = screen.getByRole('combobox', { name: 'State' });
    expect(
      within(filter)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Every state', 'Waiting for confirmation', 'Confirmed', 'Declined', 'Cancelled']);
  });

  it('asks for the state that is chosen, and puts it in the address', async () => {
    const { user, router } = open();
    await screen.findByRole('table', { name: 'Pickup requests' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'CONFIRMED');

    await waitFor(() => {
      expect(queryOf().get('state')).toBe('CONFIRMED');
    });
    expect(router.state.location.search).toBe('?state=CONFIRMED');
  });

  it('reads the state and the date out of the address', async () => {
    open(undefined, READER, '/pickup-requests?state=PENDING&date=2026-11-03');

    await screen.findByRole('table', { name: 'Pickup requests' });

    expect(queryOf(0).get('state')).toBe('PENDING');
    expect(queryOf(0).get('service_date')).toBe('2026-11-03');
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('PENDING');
    expect(screen.getByRole('button', { name: 'Every service date' })).toBeVisible();
  });

  // Break caught: a made-up value in the address sent to the server as a made-up filter.
  it.each([
    'state=everything',
    'state=pending',
    'date=2026-02-30',
    'date=tomorrow',
    'date=2026-11-03T00:00:00Z',
    'cutoff=everything',
    'cutoff=pending_ops_review',
  ])('takes %s for no filter', async (query) => {
    open(undefined, READER, `/pickup-requests?${query}`);

    await screen.findByRole('table', { name: 'Pickup requests' });

    expect(queryOf(0).has('state')).toBe(false);
    expect(queryOf(0).has('service_date')).toBe(false);
    expect(queryOf(0).has('cutoff_exception_state')).toBe(false);
  });

  // Task C1.1, AC-QSUM-11: the landing's link for the late bookings opens this page with the cut-off decision as a filter. Break caught: the
  // address read and not sent (the officer sees every confirmed request under a link that said "late bookings"), or sent and not said (a
  // filter the page applies without telling).
  it('reads the late bookings out of the address, asks for them, says so in words, and takes them off with their own button', async () => {
    const { user, router } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    await screen.findByRole('table', { name: 'Pickup requests' });

    expect(queryOf(0).get('state')).toBe('CONFIRMED');
    expect(queryOf(0).get('cutoff_exception_state')).toBe('PENDING_OPS_REVIEW');
    expect(screen.getByText('Only late bookings waiting for a cut-off decision.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Every cut-off decision' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?state=CONFIRMED');
    });
    expect(queryOf().has('cutoff_exception_state')).toBe(false);
    expect(queryOf().get('state')).toBe('CONFIRMED');
    expect(
      screen.queryByText('Only late bookings waiting for a cut-off decision.'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Every cut-off decision' }),
    ).not.toBeInTheDocument();
  });

  // The review of C1.1 (5 November 2026): the late bookings are the confirmed requests waiting for a cut-off decision, which is what the landing
  // counted. A request cancelled after it was raised keeps the decision it had, so the filter alone would list it under "Every state", beneath
  // words that do not fit it. The filter is therefore a refinement of the Confirmed state: another state takes it off. Break caught: the
  // filter kept under another state, with its banner.
  it('takes the late bookings off when the state is changed, which they are a refinement of', async () => {
    const { user, router } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    await screen.findByRole('table', { name: 'Pickup requests' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'PENDING');

    await waitFor(() => {
      expect(router.state.location.search).toBe('?state=PENDING');
    });
    expect(queryOf().get('state')).toBe('PENDING');
    expect(queryOf().has('cutoff_exception_state')).toBe(false);
    expect(
      screen.queryByText('Only late bookings waiting for a cut-off decision.'),
    ).not.toBeInTheDocument();
  });

  it('keeps the late bookings when only the service date changes', async () => {
    const { user, router } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW&date=2026-11-07',
    );
    await screen.findByRole('table', { name: 'Pickup requests' });

    await user.click(screen.getByRole('button', { name: 'Every service date' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW');
    });
    expect(queryOf().get('cutoff_exception_state')).toBe('PENDING_OPS_REVIEW');
  });

  // An address is the person's to edit: a late-bookings filter without the Confirmed state is not one the page offers, and is no filter, as a
  // value that is no cut-off decision is none. Break caught: the filter sent for a state it does not fit.
  it.each([
    ['names no state', '/pickup-requests?cutoff=PENDING_OPS_REVIEW'],
    ['names another state', '/pickup-requests?state=CANCELLED&cutoff=PENDING_OPS_REVIEW'],
  ])('applies no late-bookings filter to an address that %s', async (_why, path) => {
    open(() => page([pending]), READER, path);
    await screen.findByRole('table', { name: 'Pickup requests' });

    expect(queryOf(0).has('cutoff_exception_state')).toBe(false);
    expect(
      screen.queryByText('Only late bookings waiting for a cut-off decision.'),
    ).not.toBeInTheDocument();
  });

  // A button that takes a filter off is gone once it has: focus goes to the filter row, and not to the top of the page where it would fall.
  it('puts focus on the State filter once the late bookings are taken off', async () => {
    const { user } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    await screen.findByRole('table', { name: 'Pickup requests' });

    await user.click(screen.getByRole('button', { name: 'Every cut-off decision' }));

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'State' })).toHaveFocus();
    });
  });

  it('puts focus on the service date once the date is taken off', async () => {
    const { user } = open(() => page([pending]), READER, '/pickup-requests?date=2026-11-03');
    await screen.findByRole('table', { name: 'Pickup requests' });

    await user.click(screen.getByRole('button', { name: 'Every service date' }));

    await waitFor(() => {
      expect(
        within(screen.getByRole('group', { name: 'Service date' })).getAllByRole('spinbutton')[0],
      ).toHaveFocus();
    });
  });

  // The review of C1.1: a request cancelled after its late booking was raised keeps the cut-off decision it had, and nothing is left to decide
  // on it. Break caught: the row of a cancelled request asking the officer to decide.
  it('does not ask for a decision on a late booking that was cancelled since', async () => {
    open(() =>
      page([
        pickupRequestFixture({
          id: EARLIER_REQUEST_ID,
          code: 'ACC-PR-9WXH4T',
          state: 'CANCELLED',
          cutoff_exception_state: 'PENDING_OPS_REVIEW',
        }),
      ]),
    );

    const row = await rowOf('ACC-PR-9WXH4T');
    const card = await cardOf('ACC-PR-9WXH4T');

    expect(within(row).getByText('Cancelled')).toBeVisible();
    expect(within(row).queryByText('Late booking to decide')).toBeNull();
    expect(within(card).queryByText('Late booking to decide')).toBeNull();
  });

  it('asks for the date that is typed, once it is a whole date, and keeps the state', async () => {
    const { user, router } = open(undefined, READER, '/pickup-requests?state=PENDING');
    await screen.findByRole('table', { name: 'Pickup requests' });
    const group = screen.getByRole('group', { name: 'Service date' });
    const [day] = within(group).getAllByRole('spinbutton');
    if (day === undefined) throw new Error('no day');

    await user.click(day);
    await user.keyboard('04112026');

    await waitFor(() => {
      expect(queryOf().get('service_date')).toBe('2026-11-04');
    });
    expect(queryOf().get('state')).toBe('PENDING');
    expect(router.state.location.search).toBe('?state=PENDING&date=2026-11-04');
    // A year still being typed (2, 20, 202) is never asked of the server.
    for (const request of listRequests()) {
      const date = new URL(request.url).searchParams.get('service_date');
      if (date !== null) expect(Number(date.slice(0, 4))).toBeGreaterThanOrEqual(1000);
    }
  });

  it('takes the date off with its own button', async () => {
    const { user, router } = open(undefined, READER, '/pickup-requests?date=2026-11-03');
    await screen.findByRole('table', { name: 'Pickup requests' });

    await user.click(screen.getByRole('button', { name: 'Every service date' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(queryOf().has('service_date')).toBe(false);
  });
});

describe('the queue: counting and paging', () => {
  it('counts a page without claiming to know the total', async () => {
    open(() => page([pending, late], 'next-1'));
    expect(
      await screen.findByText('Showing 2 requests. More follow on the next page.'),
    ).toBeVisible();
  });

  it('goes to the next page with the token the server gave, and back', async () => {
    const { user } = open(() => page([pending], 'next-1'));
    await screen.findByRole('table', { name: 'Pickup requests' });

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(queryOf().get('page_token')).toBe('next-1');
    });
    expect(await screen.findByText(/on page 2/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => {
      expect(queryOf().has('page_token')).toBe(false);
    });
  });

  // Break caught: the next page of one filter asked for under another.
  it('starts again at the first page when the filter changes', async () => {
    const { user } = open(() => page([pending], 'next-1'));
    await screen.findByRole('table', { name: 'Pickup requests' });
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'PENDING');

    await waitFor(() => {
      expect(queryOf().get('state')).toBe('PENDING');
    });
    expect(queryOf().has('page_token')).toBe(false);
  });
});

describe('the queue: nothing to show', () => {
  it('tells a queue with no requests as good news', async () => {
    open(() => page([]));

    expect(await screen.findByRole('heading', { name: 'No pickup requests yet' })).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // Break caught (ops-portal.md section 7): "no requests" and "filtered to nothing" told as one, which sends Ops hunting for a bug.
  it('tells a filter that hides everything differently, and takes every filter off in one move', async () => {
    const { user, router } = open(
      () => page([]),
      READER,
      '/pickup-requests?state=DECLINED&date=2026-11-03',
    );
    expect(await screen.findByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No pickup requests yet' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Show every request' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('');
  });

  // Task C1.1: when the late bookings are the only filter and none waits, the page says the filter hid them, and "Show every request" takes
  // that filter off too. Break caught: "every request" leaving the cut-off decision set, so that the button shows the same empty page again.
  it('tells the late bookings that hide everything, in words that fit, and takes them off with every other filter', async () => {
    const { user, router } = open(
      () => page([]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    expect(await screen.findByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    expect(screen.getByText(/Nothing fits these filters/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Show every request' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(queryOf().has('cutoff_exception_state')).toBe(false);
  });
});

describe('the queue: when it cannot be had', () => {
  // Filtered by the cut-off decision, every request of the page carries it: a page that does not is not this query's answer (the server ignored
  // the filter, or answered another). Break caught: a page drawn under "late bookings" that holds requests which are not, which would ask the
  // officer to decide what is not theirs to decide. The filters stay on the page, so the officer can take them off.
  it('refuses a page whose requests are not all the late bookings that were asked for', async () => {
    open(
      () => page([late, pending]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );

    expect(await screen.findByText('The pickup requests could not be loaded.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Every cut-off decision' })).toBeVisible();
  });

  it('says so in approved words with a retry, and never the server’s text', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'));

    expect(await screen.findByText('The pickup requests could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('names the key a session without it lacks, and no role', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    expect(await screen.findByText(/pickup\.read/)).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
  });
});

describeInterfaceStates('The pickup queue', {
  loading: {
    test: async () => {
      let release: (response: Response) => void = () => undefined;
      const gate = new Promise<Response>((resolve) => {
        release = resolve;
      });
      open(() => gate);
      expect(await screen.findByText('Loading the pickup requests…')).toBeInTheDocument();
      // A count is never shown while the queue loads (ops-portal.md section 8).
      expect(screen.queryByText(/Showing/)).toBeNull();
      await act(async () => {
        release(page([pending]));
        await gate;
      });
      await rowOf('ACC-PR-7KQ2MZ');
    },
  },
  empty: {
    test: async () => {
      open(() => page([]), READER, '/pickup-requests?state=CANCELLED');
      expect(
        await screen.findByRole('heading', { name: 'No pickup requests match' }),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open(
        () =>
          refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: 'service_date', rule: 'format' }],
          }),
        READER,
        '/pickup-requests?date=2026-11-03',
      );
      expect(
        await screen.findByText(
          'That filter was not accepted. Choose a state from the list and a whole date.',
        ),
      ).toBeVisible();
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      expect(await screen.findByRole('alert')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    },
  },
  retry: {
    test: async () => {
      let attempts = 0;
      const view = open(() => {
        attempts += 1;
        return attempts === 1 ? refusal(503, 'SETTING_MISSING') : page([pending]);
      });
      await view.user.click(await screen.findByRole('button', { name: /Try again/ }));
      expect(await rowOf('ACC-PR-7KQ2MZ')).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The queue changes nothing and carries no version; a request that moved is read again from its own page, where every act sends the version it read.',
  },
  success: {
    test: async () => {
      open();
      expect(await screen.findByText('Showing 2 requests.')).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open(undefined, ['staff.read']);
      expect(await screen.findByText(/pickup\.read/)).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByRole('list', { name: 'Pickup requests' })).toBeNull();
      expect(listRequests()).toHaveLength(0);
    },
  },
});
