import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * `/pickup-requests` (`listPickupRequests`; S1.19). The queue of the requests at the session's hubs, filtered by state and service date, and
 * an empty queue told apart from a filter that hides everything.
 */
const LIST = 'GET /pickup-requests';
const RECORD = `GET /pickup-requests/${REQUEST_ID}`;
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
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
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
      // The panel beside the queue reads a request when it is opened.
      { [LIST]: handler, [RECORD]: () => json(200, pending, etag('v1')) },
    ),
  );
  return renderApp(path);
}

const listRequests = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-requests');
const queryOf = (index = -1) => new URL(listRequests().at(index)?.url ?? 'http://x/').searchParams;

/**
 * The queue draws every request as a row of a table or, in a room under 40rem, as a card: the table measures its own box, and jsdom measures nothing, so a test that reads cards tells
 * the table that the room is narrow (`narrowRoom`). Each test therefore says which of the two it reads.
 */
const queueTable = async (): Promise<HTMLElement> => {
  const table = await screen.findByRole('table', { name: 'Pickup requests' });
  // The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited.
  await waitFor(() => {
    expect(table).not.toHaveAttribute('aria-busy', 'true');
  });
  return table;
};
const queueCards = () => screen.findByRole('list', { name: 'Pickup requests' });

const LAYOUTS = ['row', 'card'] as const;
type Layout = (typeof LAYOUTS)[number];

/** The table is told that its room is narrow, which is how it comes to draw cards. Undone after each test. */
function narrowRoom(): void {
  class Observer {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void {
      this.callback([], this);
    }
    unobserve(): void {
      // Nothing is watched: the room was told, once, when the table began to observe.
    }
    disconnect(): void {
      // As above.
    }
  }
  vi.stubGlobal('ResizeObserver', Observer);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 300,
  });
}

/** The button that opens a request, named by its code and its sender: the table draws one in each row, and it is the row's one control that opens it. */
const openButton = (code: string) => new RegExp(`^Open ${code}, `);

async function rowOf(code: string): Promise<HTMLElement> {
  const row = within(await queueTable())
    .getByRole('button', { name: openButton(code) })
    .closest('tr');
  if (row === null) throw new Error(`no row for ${code}`);
  return row;
}

async function cardOf(code: string): Promise<HTMLElement> {
  const card = within(await queueCards())
    .getByRole('button', { name: openButton(code) })
    .closest('li');
  if (card === null) throw new Error(`no card for ${code}`);
  return card;
}

/** A request as the layout under test draws it. */
const placeOf = (layout: Layout, code: string): Promise<HTMLElement> =>
  layout === 'row' ? rowOf(code) : cardOf(code);

/** The value a card gives for a label ("Service date"): the definition that follows its term. */
function factOf(card: HTMLElement, label: string): HTMLElement {
  const value = within(card).getByText(label).nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
  return value;
}

describe('the queue: what it shows', () => {
  it('shows each request by its code, state, date, kind, packages, place and hub, and opens it from its row', async () => {
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
    // The row opens the request in the panel beside the queue (below); the link to its own page is the panel's.
    expect(
      within(first).getByRole('button', { name: 'Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd' }),
    ).toBeVisible();
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
  it.each(LAYOUTS)(
    'never shows a request’s id, and names another hub as that, in the %s',
    async (layout) => {
      if (layout === 'card') narrowRoom();
      open(() =>
        page([
          pickupRequestFixture({ responsible_hub_id: '9d0e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a' }),
        ]),
      );

      expect(within(await placeOf(layout, 'ACC-PR-7KQ2MZ')).getByText('Another hub')).toBeVisible();
      expect(document.body.textContent).not.toContain(REQUEST_ID);
      expect(document.body.textContent).not.toContain('9d0e1f2a');
    },
  );

  // Break caught: a queue that shows part of a page when one request in it is not one.
  it('shows no request at all when one request in the page is not a request', async () => {
    open(() => page([pending, { ...late, code: 'not a code' }]));

    expect(await screen.findAllByText('The pickup requests could not be loaded.')).not.toHaveLength(
      0,
    );
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(screen.queryByText('ACC-PR-7KQ2MZ')).toBeNull();
  });

  // The menu offers the booking too; this is the page's own action, in its main content.
  it('offers a booking to a holder of pickup.request.create', async () => {
    open(undefined, ['pickup.read', 'pickup.request.create']);
    await queueTable();
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Book a pickup' }),
    ).toHaveAttribute('href', '/pickup-requests/new');
  });

  it('offers no booking to a session that may only read the queue', async () => {
    open();
    await queueTable();
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

  it.each(LAYOUTS)('tells every fact of a request in its %s', async (layout) => {
    if (layout === 'card') narrowRoom();
    open();

    for (const facts of [FACTS_OF_PENDING, FACTS_OF_LATE]) {
      const code = facts[0] ?? '';
      const place = await placeOf(layout, code);
      for (const fact of facts) {
        expect(
          within(place).getByText(fact),
          `${fact} in the ${layout} of ${code}`,
        ).toBeInTheDocument();
      }
    }
  });

  it('draws a card as the code over the state, then the sender, then the facts, in the order a person reads them', async () => {
    narrowRoom();
    open();

    const card = await placeOf('card', 'ACC-PR-9WXH4T');

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

  // Break caught: a request opened by a click beside its code, which a keyboard cannot do. The row and the card have one control that opens the request, the button the table
  // draws over the whole of it, and no link: the link to the request's own page is the panel's.
  it.each(LAYOUTS)(
    'gives a request one button that opens it, and no link, in its %s',
    async (layout) => {
      if (layout === 'card') narrowRoom();
      const { user, router } = open();
      const place = await placeOf(layout, 'ACC-PR-7KQ2MZ');

      expect(within(place).queryAllByRole('link')).toHaveLength(0);
      expect(within(place).getAllByRole('button')).toHaveLength(1);
      await user.click(within(place).getByText('Demo Fabrics Ltd'));

      // The press opened the request in the panel beside the queue, and the page stayed where it was.
      expect(router.state.location.pathname).toBe('/pickup-requests');
      expect(await screen.findByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeInTheDocument();
    },
  );

  // Break caught: a fact the record lacks drawn as nothing, or as a made-up value, so that a missing count would pass for none.
  it.each(LAYOUTS)(
    'says a fact is not recorded where the record lacks it, in the %s',
    async (layout) => {
      if (layout === 'card') narrowRoom();
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

      const place = await placeOf(layout, 'ACC-PR-7KQ2MZ');

      // The sender, the address, the packages and the booking type: four facts, each told as missing and none as a count of zero.
      expect(within(place).getAllByText('Not recorded')).toHaveLength(4);
      expect(within(place).queryByText(/^\d+ packages?$/)).toBeNull();
    },
  );

  // The pickup address is the server's resolved one, never another address on the record (a recipient's, here) in its place.
  it.each(LAYOUTS)(
    'shows the address the server resolved for the pickup, and no other address of the record, in the %s',
    async (layout) => {
      if (layout === 'card') narrowRoom();
      open(() => page([pickupRequestFixture({ one_package_exception: exceptionFixture() })]));

      const place = await placeOf(layout, 'ACC-PR-7KQ2MZ');

      expect(within(place).getByText('14 Demo Lane, Osu')).toBeVisible();
      expect(place).not.toHaveTextContent('9 Demo Street, Tema');
    },
  );

  // Break caught: a request that needs nothing drawn as an empty cell, which says nothing to a screen reader, or as a claim that nothing
  // blocks it (the dash is neutral: it does not say the request may be confirmed).
  it.each(LAYOUTS)(
    'draws a dash that a screen reader reads as "No additional note" when a request needs nothing, in the %s',
    async (layout) => {
      if (layout === 'card') narrowRoom();
      open();

      const place = await placeOf(layout, 'ACC-PR-7KQ2MZ');

      expect(within(place).getByText('No additional note')).toBeInTheDocument();
      expect(within(place).getByText('—')).toHaveAttribute('aria-hidden', 'true');
      expect(place).not.toHaveTextContent(/blocker|nothing to do|ready/i);
    },
  );

  it.each(LAYOUTS)(
    'keeps a long address and a long note whole, for the stylesheet to wrap, in the %s',
    async (layout) => {
      if (layout === 'card') narrowRoom();
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

      const place = await placeOf(layout, 'ACC-PR-7KQ2MZ');

      expect(within(place).getByText(address)).toBeVisible();
      expect(within(place).getByText(sender)).toBeVisible();
      expect(within(place).getByText('One-package exception to request')).toBeVisible();
      expect(place.querySelector('[title]')).toBeNull();
    },
  );
});

/**
 * The views, the filters, the count, the rows and the pager of the queue sit in one page card, and so does whatever stands in the place of the rows: the loading, the empty
 * state, a failure and a refusal. The stylesheet draws the surface (jsdom applies no CSS; the browser spec holds how it looks), so the person never meets a state outside the
 * surface the rows would have been drawn on.
 */
describe('the queue: one panel', () => {
  const filters = () => screen.getByRole('group', { name: 'Filter the pickup requests' });
  const panelOf = (element: HTMLElement) => element.closest('.ui-queue-workspace__main');

  it('holds the views, the filters, the count, the rows and the pager', async () => {
    open(() => page([pending, late], 'next-1'));

    const panel = panelOf(await queueTable());

    expect(panel).not.toBeNull();
    expect(panel).toContainElement(
      screen.getByRole('tablist', { name: 'Views of the pickup requests' }),
    );
    expect(panel).toContainElement(filters());
    // The count is found by its words: the header keeps a status of its own, for the time of the check.
    expect(panel).toContainElement(screen.getByText(/^Showing 2 requests/));
    expect(panel).toContainElement(screen.getByRole('button', { name: 'Next page' }));
    expect(document.querySelectorAll('.ui-queue-workspace__main')).toHaveLength(1);
  });

  it('holds the filters and the loading', async () => {
    let release: (response: Response) => void = () => undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    open(() => gate);

    const loading = await screen.findByText('Loading pickup requests');

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

    const failure = await alertSaying('The pickup requests could not be loaded.');
    expect(panelOf(failure)).toContainElement(filters());
    expect(panelOf(failure)).toContainElement(screen.getByRole('button', { name: 'Retry' }));
  });

  // The server's refusal of the read, in the words of the screen: a session that does not hold the key at all never reaches the page (the route's guard answers), and the
  // refusal here names what the person lacks as a capability and never as a key or a role (PRODUCT_DESIGN_DIRECTION section 6.5).
  it('holds the filters and the refusal, in plain words', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    const refused = await alertSaying('Your account cannot read pickup requests.');
    expect(panelOf(refused)).toContainElement(filters());
    expect(within(screen.getByRole('main')).queryByText(/pickup\.read/)).toBeNull();
  });
});

/** The date filter lives in the popover of the filter row: opened with the Filter button, and its field is the date field of the kit. */
async function openDateFilter(view: ReturnType<typeof open>): Promise<HTMLElement> {
  await view.user.click(screen.getByRole('button', { name: 'Filter' }));
  return screen.findByRole('group', { name: 'Service date' });
}
const viewTab = (name: string) => screen.getByRole('tab', { name });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const LATE_CHIP = 'Only late bookings waiting for a cut-off decision';
const removeChip = (label: string) =>
  screen.getByRole('button', { name: `Remove filter: ${label}` });

describe('the queue: filtering', () => {
  it('asks for every state and date by default, and offers each state the contract has', async () => {
    open();
    await queueTable();

    expect(queryOf(0).has('state')).toBe(false);
    expect(queryOf(0).has('service_date')).toBe(false);
    const views = screen.getByRole('tablist', { name: 'Views of the pickup requests' });
    expect(
      within(views)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['All', 'Waiting for confirmation', 'Confirmed', 'Declined', 'Cancelled']);
    expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
  });

  it('asks for the state that is chosen, and puts it in the address', async () => {
    const { user, router } = open();
    await queueTable();

    await user.click(viewTab('Confirmed'));

    await waitFor(() => {
      expect(queryOf().get('state')).toBe('CONFIRMED');
    });
    expect(router.state.location.search).toBe('?state=CONFIRMED');
  });

  it('reads the state and the date out of the address', async () => {
    open(undefined, READER, '/pickup-requests?state=PENDING&date=2026-11-03');

    await queueTable();

    expect(queryOf(0).get('state')).toBe('PENDING');
    expect(queryOf(0).get('service_date')).toBe('2026-11-03');
    expect(viewTab('Waiting for confirmation')).toHaveAttribute('aria-selected', 'true');
    expect(removeChip('Service date: Tue 3 Nov 2026')).toBeVisible();
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

    await queueTable();

    expect(queryOf(0).has('state')).toBe(false);
    expect(queryOf(0).has('service_date')).toBe(false);
    expect(queryOf(0).has('cutoff_exception_state')).toBe(false);
  });

  // Task C1.1, AC-QSUM-11: the landing's link for the late bookings opens this page with the cut-off decision as a filter. Break caught: the
  // address read and not sent (the officer sees every confirmed request under a link that said "late bookings"), or sent and not said (a
  // filter the page applies without telling).
  it('reads the late bookings out of the address, asks for them, says so in words, and takes them off with their own chip', async () => {
    const { user, router } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    await queueTable();

    expect(queryOf(0).get('state')).toBe('CONFIRMED');
    expect(queryOf(0).get('cutoff_exception_state')).toBe('PENDING_OPS_REVIEW');
    expect(screen.getByText(LATE_CHIP)).toBeVisible();

    await user.click(removeChip(LATE_CHIP));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?state=CONFIRMED');
    });
    expect(queryOf().has('cutoff_exception_state')).toBe(false);
    expect(queryOf().get('state')).toBe('CONFIRMED');
    expect(screen.queryByText(LATE_CHIP)).not.toBeInTheDocument();
  });

  // The review of C1.1 (5 November 2026): the late bookings are the confirmed requests waiting for a cut-off decision, which is what the landing
  // counted. A request cancelled after it was raised keeps the decision it had, so the filter alone would list it under "Every state", beneath
  // words that do not fit it. The filter is therefore a refinement of the Confirmed state: another state takes it off. Break caught: the
  // filter kept under another state, with its chip.
  it('takes the late bookings off when the state is changed, which they are a refinement of', async () => {
    const { user, router } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    await queueTable();

    await user.click(viewTab('Waiting for confirmation'));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?state=PENDING');
    });
    expect(queryOf().get('state')).toBe('PENDING');
    expect(queryOf().has('cutoff_exception_state')).toBe(false);
    expect(screen.queryByText(LATE_CHIP)).not.toBeInTheDocument();
  });

  it('keeps the late bookings when only the service date changes', async () => {
    const { user, router } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW&date=2026-11-07',
    );
    await queueTable();

    await user.click(removeChip('Service date: Sat 7 Nov 2026'));

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
    await queueTable();

    expect(queryOf(0).has('cutoff_exception_state')).toBe(false);
    expect(screen.queryByText(LATE_CHIP)).not.toBeInTheDocument();
  });

  // A chip that takes a filter off is gone once it has: focus goes to what stays in the filter row (the next chip's remove button, else the Filter button), and not to the top
  // of the page where it would fall.
  it('puts focus on the Filter button once the late bookings are taken off', async () => {
    const { user } = open(
      () => page([late]),
      READER,
      '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    await queueTable();

    await user.click(removeChip(LATE_CHIP));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter' })).toHaveFocus();
    });
  });

  it('puts focus on the Filter button once the date is taken off', async () => {
    const { user } = open(() => page([pending]), READER, '/pickup-requests?date=2026-11-03');
    await queueTable();

    await user.click(removeChip('Service date: Tue 3 Nov 2026'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter' })).toHaveFocus();
    });
  });

  // The review of C1.1: a request cancelled after its late booking was raised keeps the cut-off decision it had, and nothing is left to decide
  // on it. Break caught: the row of a cancelled request asking the officer to decide.
  it.each(LAYOUTS)(
    'does not ask for a decision on a late booking that was cancelled since, in the %s',
    async (layout) => {
      if (layout === 'card') narrowRoom();
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

      const place = await placeOf(layout, 'ACC-PR-9WXH4T');

      expect(within(place).getByText('Cancelled')).toBeVisible();
      expect(within(place).queryByText('Late booking to decide')).toBeNull();
    },
  );

  it('asks for the date that is typed, once it is a whole date, and keeps the state', async () => {
    const view = open(undefined, READER, '/pickup-requests?state=PENDING');
    await queueTable();
    const group = await openDateFilter(view);

    await view.user.click(within(group).getByRole('textbox'));
    await view.user.keyboard('04112026');

    await waitFor(() => {
      expect(queryOf().get('service_date')).toBe('2026-11-04');
    });
    expect(queryOf().get('state')).toBe('PENDING');
    expect(view.router.state.location.search).toBe('?state=PENDING&date=2026-11-04');
    // A year still being typed (2, 20, 202) is never asked of the server.
    for (const request of listRequests()) {
      const date = new URL(request.url).searchParams.get('service_date');
      if (date !== null) expect(Number(date.slice(0, 4))).toBeGreaterThanOrEqual(1000);
    }
  });

  it('takes the date off with its own chip', async () => {
    const { user, router } = open(undefined, READER, '/pickup-requests?date=2026-11-03');
    await queueTable();

    await user.click(removeChip('Service date: Tue 3 Nov 2026'));

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
    await queueTable();

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
    await queueTable();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    await user.click(viewTab('Waiting for confirmation'));

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
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
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
    expect(viewTab('All')).toHaveAttribute('aria-selected', 'true');
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

    await alertSaying('The pickup requests could not be loaded.');
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(removeChip(LATE_CHIP)).toBeVisible();
  });

  it('says so in approved words with a retry, and never the server’s text', async () => {
    open(() => refusal(500, 'INTERNAL_ERROR'));

    await alertSaying('The pickup requests could not be loaded.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('says what a session without access lacks in plain words, and names no key and no role', async () => {
    open(() => refusal(403, 'PERMISSION_DENIED'));

    await alertSaying(
      'Your account cannot read pickup requests. Ask an administrator to give you access.',
    );
    expect(within(screen.getByRole('main')).queryByText(/pickup\.read/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
  });
});

/**
 * What the panel beside the queue holds (redesign step R6): a request opens in it from its row, with its summary read as the request's own page reads it, its state in words, the
 * link to its own page, and, for a session that may confirm it, the one act the queue offers. The panel never takes the queue's place: the rows stay.
 */
describe('the queue: the request beside it', () => {
  const CONFIRMER = ['pickup.read', 'pickup.request.confirm'];

  it('opens a request in a panel beside the queue, with its summary and the link to its page', async () => {
    const { user } = open();
    await queueTable();

    await user.click(screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd' }));

    const panel = await screen.findByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
    // The panel fades in (it is drawn at once, with its opacity on its way): what it holds is in it, whether or not the first frames are over.
    expect(
      await within(panel).findByText('It waits for an Ops officer to confirm it.'),
    ).toBeInTheDocument();
    expect(within(panel).getByText('14 Demo Lane, Osu')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Open full page' })).toHaveAttribute(
      'href',
      `/pickup-requests/${REQUEST_ID}`,
    );
    // The queue stays beside it.
    expect(screen.getByRole('table', { name: 'Pickup requests' })).toBeVisible();
    // A session that may only read offers no act in it.
    expect(within(panel).queryByRole('button', { name: 'Confirm pickup' })).toBeNull();
  });

  it('closes with Escape and gives focus back to the row it came from', async () => {
    const { user } = open();
    await queueTable();
    const opener = screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd' });
    await user.click(opener);
    await screen.findByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeNull();
    });
    expect(opener).toHaveFocus();
  });

  it('says in the panel that the request could not be read, and leaves the queue as it was', async () => {
    api = installFakeApi(
      staffApi(
        sessionWith(READER, {
          authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
        }),
        { [LIST]: () => page([pending]), [RECORD]: () => refusal(404, 'NOT_FOUND') },
      ),
    );
    const { user } = renderApp('/pickup-requests');
    await queueTable();

    await user.click(await screen.findByRole('button', { name: /^Open ACC-PR-7KQ2MZ, / }));

    const panel = await screen.findByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });
    expect(await within(panel).findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Pickup requests' })).toBeVisible();
  });

  describe('confirming', () => {
    const CONFIRM = `POST /pickup-requests/${REQUEST_ID}/confirm`;

    /** A session that may confirm, with the read of the request and the act it takes: the queue only ever reads the version of the request it confirms. */
    function openConfirmer(
      confirm: Handler = () => json(200, { ...pending, state: 'CONFIRMED' }, etag('v2')),
    ) {
      api = installFakeApi(
        staffApi(
          sessionWith(CONFIRMER, {
            authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
          }),
          {
            [LIST]: () => page([pending, late]),
            [RECORD]: () => json(200, pending, etag('v1')),
            [CONFIRM]: confirm,
          },
        ),
      );
      return renderApp('/pickup-requests');
    }

    it('offers the act on the row of a request that waits, and not on one that is confirmed already', async () => {
      openConfirmer();

      expect(
        await screen.findByRole('button', { name: 'Confirm ACC-PR-7KQ2MZ' }),
      ).toBeInTheDocument();
      await queueTable();
      expect(screen.queryByRole('button', { name: 'Confirm ACC-PR-9WXH4T' })).toBeNull();
    });

    it('offers it to a session that holds the key and to no other', async () => {
      open();
      await queueTable();

      expect(screen.queryByRole('button', { name: /^Confirm ACC-PR/ })).toBeNull();
    });

    it('does not offer the act on a single package whose exception is not approved', async () => {
      api = installFakeApi(
        staffApi(
          sessionWith(CONFIRMER, {
            authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
          }),
          { [LIST]: () => page([pickupRequestFixture({ declared_package_count: 1 })]) },
        ),
      );
      renderApp('/pickup-requests');
      await queueTable();

      expect(screen.queryByRole('button', { name: /^Confirm ACC-PR/ })).toBeNull();
    });

    it('asks first, reads the version of that one request, confirms it with that version, and says so', async () => {
      const view = openConfirmer();
      await view.user.click(await screen.findByRole('button', { name: 'Confirm ACC-PR-7KQ2MZ' }));

      const question = await screen.findByRole('alertdialog', { name: 'Confirm ACC-PR-7KQ2MZ?' });
      // Nothing was sent by pressing the row's act: the question comes first, with the safe answer.
      expect(api.requests.some((request) => request.method === 'POST')).toBe(false);
      await view.user.click(within(question).getByRole('button', { name: 'Confirm the pickup' }));

      await waitFor(() => {
        expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
      });
      const confirmation = api.requests.find((request) => request.method === 'POST');
      expect(confirmation?.headers.get('If-Match')).toBe('"v1"');
      expect(await screen.findByText(/ACC-PR-7KQ2MZ is confirmed/)).toBeVisible();
    });

    it('tells a refusal in the question, in approved words, and keeps the question', async () => {
      const view = openConfirmer(() => refusal(409, 'STATE_CONFLICT'));
      await view.user.click(await screen.findByRole('button', { name: 'Confirm ACC-PR-7KQ2MZ' }));
      const question = await screen.findByRole('alertdialog', { name: 'Confirm ACC-PR-7KQ2MZ?' });

      await view.user.click(within(question).getByRole('button', { name: 'Confirm the pickup' }));

      expect(await within(question).findByRole('alert')).toBeVisible();
      expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
    });

    it('confirms from the panel as well, with the same question', async () => {
      const view = openConfirmer();
      await queueTable();
      await view.user.click(
        await screen.findByRole('button', { name: 'Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd' }),
      );
      const panel = await screen.findByRole('dialog', { name: 'ACC-PR-7KQ2MZ' });

      await view.user.click(await within(panel).findByRole('button', { name: 'Confirm pickup' }));
      const question = await screen.findByRole('alertdialog', { name: 'Confirm ACC-PR-7KQ2MZ?' });
      await view.user.click(within(question).getByRole('button', { name: 'Confirm the pickup' }));

      expect(await screen.findByText(/ACC-PR-7KQ2MZ is confirmed/)).toBeVisible();
    });
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
      expect(await screen.findByText('Loading pickup requests')).toBeInTheDocument();
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
      await alertSaying(
        'That filter was not accepted. Choose a state from the list and a whole date.',
      );
    },
  },
  error: {
    test: async () => {
      open(() => refusal(500, 'INTERNAL'));
      await alertSaying('The pickup requests could not be loaded.');
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
      await view.user.click(await screen.findByRole('button', { name: 'Retry' }));
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
