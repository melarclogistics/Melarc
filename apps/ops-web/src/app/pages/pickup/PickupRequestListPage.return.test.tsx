import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  EARLIER_REQUEST_ID,
  PICKUP_HUB_ID,
  pickupRequestFixture,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { SIGNED_IN_ROUTES } from '../../navigation/route-registry';
import { QUEUE_PERMISSION } from './WithPickupRequest';

/**
 * Coming back to the pickup queue from a request (COMPONENT_PATTERNS section 22f; the reference of 1 November 2026, section 4): the browser's
 * Back and the request's own link back bring the officer to the page they left, with its filters, read again from the server; focus goes to the
 * request they opened if it is still on the page, else to the results, and never from where the officer has put it; the position on the page
 * is restored. Any other way to the queue starts at its first page. A later page that has come to hold nothing, and a page the server will not
 * open, say so and offer the first page.
 */
const LIST = 'GET /pickup-requests';
const RECORD = `GET /pickup-requests/${EARLIER_REQUEST_ID}`;
const QUEUE = '/pickup-requests?state=PENDING';
/** The late bookings, as the landing links to them (`AC-QSUM-11`). */
const LATE_QUEUE = '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW';
const RECORD_PATH = `/pickup-requests/${EARLIER_REQUEST_ID}`;

const pending = pickupRequestFixture();
const late = pickupRequestFixture({ id: EARLIER_REQUEST_ID, code: 'ACC-PR-9WXH4T' });
/** The same request as the queue of the late bookings lists it: confirmed, with its cut-off decision waiting. */
const lateBooking = pickupRequestFixture({
  id: EARLIER_REQUEST_ID,
  code: 'ACC-PR-9WXH4T',
  state: 'CONFIRMED',
  cutoff_exception_state: 'PENDING_OPS_REVIEW',
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

/** Page one holds one request and points at a second, which holds the request the officer opens. */
const twoPages: Handler = (request) =>
  new URL(request.url).searchParams.get('page_token') === null
    ? page([pending], 'next-1')
    : page([late]);

let api: FakeApi;

// jsdom does not scroll: the position the screen asks for is what a test can see.
const spyOnScroll = () => vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
let scrollTo: ReturnType<typeof spyOnScroll>;

beforeEach(() => {
  scrollTo = spyOnScroll();
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(
  list: Handler = twoPages,
  path = QUEUE,
  record?: Handler,
  keys: readonly string[] = ['pickup.read'],
) {
  api = installFakeApi(
    staffApi(
      sessionWith(keys, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: list, [RECORD]: record ?? (() => json(200, late, etag('v1'))) },
    ),
  );
  return renderApp(path);
}

const listRequests = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-requests');
const queryOf = () => new URL(listRequests().at(-1)?.url ?? 'http://x/').searchParams;
const queueTable = async (): Promise<HTMLElement> => {
  const table = await screen.findByRole('table', { name: 'Pickup requests' });
  // The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited.
  await waitFor(() => {
    expect(table).not.toHaveAttribute('aria-busy', 'true');
  });
  return table;
};
const backLink = () => screen.findByRole('link', { name: 'Back to pickup requests' });
const viewTab = (name: string) => screen.getByRole('tab', { name });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string | RegExp): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const filterButton = () => screen.getByRole('button', { name: 'Filter' });
const openButton = (code: string) => new RegExp(`^Open ${code}, `);

/**
 * The officer opens a request from its row, in the panel beside the queue, and goes to its own page by the panel's "Open full page": that click is what leaves a place. A test that
 * must not go (it stops the navigation) says so.
 */
async function openFullPage(user: UserEvent, code = 'ACC-PR-9WXH4T', stop = false): Promise<void> {
  await user.click(within(await queueTable()).getByRole('button', { name: openButton(code) }));
  const panel = await screen.findByRole('dialog', { name: code });
  const link = await within(panel).findByRole('link', { name: 'Open full page' });
  if (stop) {
    link.addEventListener(
      'click',
      (event) => {
        event.preventDefault();
      },
      { once: true },
    );
  }
  await user.click(link);
}

type View = ReturnType<typeof open>;

/** The officer pages to the second page of the queue and opens the request on it. */
async function toTheRecord(view: View = open()): Promise<View> {
  await queueTable();
  await view.user.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText(/on page 2/);
  await openFullPage(view.user);
  await backLink();
  return view;
}

const goBack = (view: View) =>
  act(async () => {
    await view.router.navigate(-1);
  });

describe('the queue, coming back from a request: the browser’s Back', () => {
  it('brings the officer back to the page they left, with its filters', async () => {
    const view = await toTheRecord();

    await goBack(view);

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('PENDING');
    expect(viewTab('Waiting for confirmation')).toHaveAttribute('aria-selected', 'true');
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(QUEUE);
    expect(
      within(await queueTable()).getByRole('button', { name: openButton('ACC-PR-9WXH4T') }),
    ).toBeVisible();
  });

  it('keeps the cursor out of the address, the storage and the cookies', async () => {
    const view = await toTheRecord();
    await goBack(view);
    await screen.findByText(/on page 2/);

    expect(view.router.state.location.search).toBe('?state=PENDING');
    expect(JSON.stringify(view.router.state.location)).not.toContain('next-1');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  // Break caught: the rows of the visit painted again at once from memory, which would show a queue the server has not been asked about.
  it('reads the page again and draws none of the earlier rows while it does', async () => {
    let reads = 0;
    let release: (response: Response) => void = () => undefined;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        if (reads === 3) {
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        }
        return twoPages(request);
      }),
    );

    await goBack(view);

    expect(await screen.findByText('Loading pickup requests')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(screen.queryByText('ACC-PR-9WXH4T')).toBeNull();
    expect(screen.queryByText('ACC-PR-7KQ2MZ')).toBeNull();
    expect(queryOf().get('page_token')).toBe('next-1');

    await act(async () => {
      release(page([late]));
      await Promise.resolve();
    });
    expect(await queueTable()).toBeVisible();
    expect(listRequests()).toHaveLength(3);
  });

  it('shows no time of the earlier check until the page has been read again', async () => {
    const reads = byHand();
    const view = open((request) =>
      listRequests().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await toTheRecord(view);

    await goBack(view);

    expect(await screen.findByText('Checking…')).toBeVisible();
    expect(screen.queryByText(/Updated/)).toBeNull();
    await reads.answer(page([late]));
    expect(await screen.findByText(/^Updated /)).toBeVisible();
  });
});

describe('the queue, coming back from a request: the link back', () => {
  it('brings the officer to the same page, with the same filters, and to nothing in the address but the filters', async () => {
    const view = await toTheRecord();

    await view.user.click(await backLink());

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('PENDING');
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(QUEUE);
    expect(JSON.stringify(view.router.state.location)).not.toContain('next-1');
  });

  it('names the queue with the filters it was left under, so that a new tab’s copy of the link is the same queue', async () => {
    await toTheRecord();

    expect(await backLink()).toHaveAttribute('href', QUEUE);
  });

  // Task C1.1, AC-QSUM-11: the late bookings come back with the officer. The review of 5 November 2026 found no test of it. Break caught: the
  // late-bookings filter left out of the place that is left (the link back then names the whole confirmed list, and the place held no longer
  // matches the address, so nothing of it is restored).
  it('names the late bookings in the link back, and brings the officer to them, in their words, with focus on the request', async () => {
    const view = open(() => page([lateBooking]), LATE_QUEUE);
    await openFullPage(view.user);

    expect(await backLink()).toHaveAttribute('href', LATE_QUEUE);
    await view.user.click(await backLink());

    const link = within(await queueTable()).getByRole('button', {
      name: openButton('ACC-PR-9WXH4T'),
    });
    expect(queryOf().get('state')).toBe('CONFIRMED');
    expect(queryOf().get('cutoff_exception_state')).toBe('PENDING_OPS_REVIEW');
    expect(screen.getByText('Only late bookings waiting for a cut-off decision')).toBeVisible();
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(
      LATE_QUEUE,
    );
    await waitFor(() => {
      expect(link).toHaveFocus();
    });
  });

  it('brings the late bookings back by the browser’s Back too, read again, with focus on the request', async () => {
    const view = open(() => page([lateBooking]), LATE_QUEUE);
    await openFullPage(view.user);
    await backLink();

    await goBack(view);

    const link = within(await queueTable()).getByRole('button', {
      name: openButton('ACC-PR-9WXH4T'),
    });
    expect(listRequests()).toHaveLength(2);
    expect(queryOf().get('cutoff_exception_state')).toBe('PENDING_OPS_REVIEW');
    expect(screen.getByText('Only late bookings waiting for a cut-off decision')).toBeVisible();
    await waitFor(() => {
      expect(link).toHaveFocus();
    });
  });
});

describe('the queue, coming back from a request: focus and position', () => {
  it('gives focus to the request the officer opened, once the page is drawn', async () => {
    const view = await toTheRecord();

    await goBack(view);

    const link = within(await queueTable()).getByRole('button', {
      name: openButton('ACC-PR-9WXH4T'),
    });
    await waitFor(() => {
      expect(link).toHaveFocus();
    });
  });

  // Break caught: focus left on the page heading, so that a keyboard user must tab through the filters and every row to find their place.
  it('gives focus to the results when the request is no longer on the page', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? page([pending], 'next-9') : twoPages(request);
      }),
    );

    await goBack(view);

    const results = (await queueTable()).closest('.ui-data-table__scroller');
    await waitFor(() => {
      expect(results).toHaveFocus();
    });
    expect(screen.queryByRole('button', { name: openButton('ACC-PR-9WXH4T') })).toBeNull();
  });

  // Break caught: a page that comes back with nothing to draw, or with a failure, left with focus on the heading above it.
  it.each([
    ['a failure', () => refusal(500, 'INTERNAL_ERROR'), () => screen.findByRole('alert')],
    [
      'nothing',
      () => page([]),
      () => screen.findByRole('heading', { name: 'No requests on this page' }),
    ],
  ])(
    'gives focus to the message when the page the officer comes back to comes back with %s',
    async (_what, answer, message) => {
      let reads = 0;
      const view = await toTheRecord(
        open((request) => {
          reads += 1;
          return reads === 3 ? answer() : twoPages(request);
        }),
      );

      await goBack(view);

      await message();
      const region = (await queueTable()).closest('.ui-data-table__scroller');
      await waitFor(() => {
        expect(region).toHaveFocus();
      });
    },
  );

  // Break caught: focus pulled back to the request from the control the officer has already moved to while the page was being read.
  it('leaves focus where the officer put it while the page was being read', async () => {
    const reads = byHand();
    const view = open((request) =>
      listRequests().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await toTheRecord(view);
    await goBack(view);
    await screen.findByText('Loading pickup requests');
    const filter = filterButton();

    act(() => {
      filter.focus();
    });
    await reads.answer(page([late]));
    await queueTable();

    expect(filter).toHaveFocus();
    expect(
      within(await queueTable()).getByRole('button', { name: openButton('ACC-PR-9WXH4T') }),
    ).not.toHaveFocus();
  });

  // Break caught: the position and the focus of the page the officer left given to the page they have moved to since.
  it('gives nothing back once the officer has changed the filter while the page was being read', async () => {
    const reads = byHand();
    const view = open((request) =>
      listRequests().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await toTheRecord(view);
    await goBack(view);
    await screen.findByText('Loading pickup requests');
    scrollTo.mockClear();
    act(() => {
      filterButton().focus();
    });

    await view.user.click(viewTab('Confirmed'));
    await reads.answer(page([late]));
    await reads.answer(page([pending]));
    await queueTable();

    expect(scrollTo).not.toHaveBeenCalled();
    // Focus is on the control the officer pressed (the view they chose), and not given back to anything.
    expect(viewTab('Confirmed')).toHaveFocus();
  });

  it('restores the position on the page after the rows are drawn, and not before', async () => {
    const reads = byHand();
    const view = open((request) =>
      listRequests().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);
    await openFullPage(view.user);
    await backLink();
    scrollTo.mockClear();

    await goBack(view);
    await screen.findByText('Loading pickup requests');
    expect(scrollTo).not.toHaveBeenCalled();
    await reads.answer(page([late]));
    await queueTable();

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' });
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe('the queue, coming to it any other way', () => {
  it('starts at the first page for a visit that began at the request (a typed address, a new tab, a reload)', async () => {
    const view = open(twoPages, RECORD_PATH);

    await view.user.click(await backLink());

    expect(await queueTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page/)).toBeNull();
    expect(view.router.state.location.search).toBe('');
  });

  // Break caught: the menu's link treated as a return, which would answer a request for the queue with the position of the last visit.
  it('starts at the first page when the officer asks for the queue from the menu', async () => {
    const view = await toTheRecord();

    await view.user.click(
      within(screen.getByRole('complementary', { name: 'Main menu' })).getByRole('link', {
        name: 'Requests',
      }),
    );

    expect(await queueTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page/)).toBeNull();
  });

  it('starts at the first page once the officer has been somewhere else since the visit', async () => {
    const view = await toTheRecord();

    await act(async () => {
      await view.router.navigate('/');
    });
    await goBack(view);
    await backLink();
    await goBack(view);

    expect(await queueTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page/)).toBeNull();
  });

  it('is used up by the return: coming to the queue by Forward and Back again starts at the first page', async () => {
    const view = await toTheRecord();
    await goBack(view);
    await screen.findByText(/on page 2/);

    await act(async () => {
      await view.router.navigate(1);
    });
    await backLink();
    await goBack(view);

    expect(await queueTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
  });
});

/**
 * A click on a request's link leaves a place; this one stops the navigation that follows, so that the officer is still on the queue with a
 * place left, and what they do next shows whether it is let go of.
 */
async function leaveWithoutGoing(user: UserEvent): Promise<void> {
  await openFullPage(user, 'ACC-PR-9WXH4T', true);
}

describe('the queue: a place left, and then the filters or the page change', () => {
  it('does not bring back a place left under a filter that was changed since, even if the filter is put back', async () => {
    const view = open();
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await leaveWithoutGoing(view.user);
    expect(view.router.state.location.pathname).toBe('/pickup-requests');

    await view.user.click(viewTab('Confirmed'));
    await view.user.click(viewTab('Waiting for confirmation'));
    await queueTable();
    await act(async () => {
      await view.router.navigate(RECORD_PATH);
    });
    await backLink();
    await goBack(view);

    expect(await queueTable()).toBeVisible();
    expect(screen.queryByText(/on page 2/)).toBeNull();
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('does not bring back a place left on a page the officer has since left for the first', async () => {
    let reads = 0;
    const view = open((request) => {
      reads += 1;
      // The second page is read twice (on arrival, and by the refresh) and the second time it holds nothing.
      return reads === 3 ? page([]) : twoPages(request);
    });
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await leaveWithoutGoing(view.user);
    await view.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await view.user.click(await screen.findByRole('button', { name: 'Back to first page' }));
    await queueTable();

    await act(async () => {
      await view.router.navigate(RECORD_PATH);
    });
    await backLink();
    await goBack(view);

    expect(await queueTable()).toBeVisible();
    expect(screen.queryByText(/on page 2/)).toBeNull();
    expect(queryOf().has('page_token')).toBe(false);
  });
});

describe('the queue: a later page that holds nothing', () => {
  const emptyLater: Handler = (request) =>
    new URL(request.url).searchParams.get('page_token') === null
      ? page([pending], 'next-1')
      : page([]);

  it('says there are no requests on the page, not that the queue is empty, and offers the first page', async () => {
    const view = open(emptyLater);
    await queueTable();

    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByRole('heading', { name: 'No requests on this page' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No pickup requests yet' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'No pickup requests match' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    // It does not go looking for the earlier pages on its own.
    expect(listRequests()).toHaveLength(2);
  });

  it('goes to the first page only when asked, and puts focus on its results', async () => {
    const view = open(emptyLater);
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    await view.user.click(await screen.findByRole('button', { name: 'Back to first page' }));

    const table = await queueTable();
    expect(queryOf().has('page_token')).toBe(false);
    expect(within(table).getByRole('button', { name: openButton('ACC-PR-7KQ2MZ') })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No requests on this page' })).toBeNull();
    await waitFor(() => {
      expect(table.closest('.ui-data-table__scroller')).toHaveFocus();
    });
  });

  it('puts focus on the message when the officer pages to a page that holds nothing', async () => {
    const view = open(emptyLater);
    await queueTable();

    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    const message = await screen.findByRole('heading', { name: 'No requests on this page' });
    await waitFor(() => {
      expect(message.closest('.ui-data-table__scroller')).toHaveFocus();
    });
  });

  it('puts focus on the failure of a page the officer moved to and the server could not give', async () => {
    const view = open((request) =>
      new URL(request.url).searchParams.get('page_token') === null
        ? page([pending], 'next-1')
        : refusal(500, 'INTERNAL_ERROR'),
    );
    await queueTable();

    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    await alertSaying('The pickup requests could not be loaded.');
    await waitFor(() => {
      expect(
        screen.getByRole('table', { name: 'Pickup requests' }).closest('.ui-data-table__scroller'),
      ).toHaveFocus();
    });
  });

  // Break caught: the wish for focus kept past an empty page and spent on the next rows drawn, which would take focus from the control the
  // officer was using when they came.
  it('does not take focus later, from a filter the officer changed after that page', async () => {
    const view = open(emptyLater);
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByRole('heading', { name: 'No requests on this page' });

    act(() => {
      filterButton().focus();
    });
    await view.user.click(viewTab('Confirmed'));
    const table = await queueTable();

    // Focus is on the control the officer pressed (the view they chose), and not given back to anything.
    expect(viewTab('Confirmed')).toHaveFocus();
    expect(table.closest('.ui-data-table__scroller')).not.toHaveFocus();
  });

  it('says the same of a filtered queue, and keeps the filters', async () => {
    const view = open(emptyLater, '/pickup-requests?state=PENDING&date=2026-11-03');
    await queueTable();

    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByRole('heading', { name: 'No requests on this page' })).toBeVisible();
    expect(view.router.state.location.search).toBe('?state=PENDING&date=2026-11-03');
    expect(viewTab('Waiting for confirmation')).toHaveAttribute('aria-selected', 'true');
  });

  it('is what the officer finds on coming back to a page that has emptied since', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? page([]) : twoPages(request);
      }),
    );

    await goBack(view);

    expect(await screen.findByRole('heading', { name: 'No requests on this page' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
  });

  it('still tells an empty first page as before', async () => {
    open(() => page([]), '/pickup-requests?state=DECLINED');

    expect(await screen.findByRole('heading', { name: 'No pickup requests match' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Back to first page' })).toBeNull();
  });
});

describe('the queue: a page the server will not open', () => {
  const refusedCursor = () =>
    refusal(400, 'VALIDATION_FAILED', {
      violations: [{ in: 'query', pointer: 'page_token', rule: 'format' }],
    });
  const refusingLater: Handler = (request) =>
    new URL(request.url).searchParams.get('page_token') === null
      ? page([pending], 'next-1')
      : refusedCursor();

  it('says the page could not be opened, keeps the filters, and offers the first page', async () => {
    const view = open(refusingLater);
    await queueTable();

    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    await alertSaying(/That page of the queue could not be opened/);
    expect(screen.queryByText(/That filter was not accepted/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull();
    expect(view.router.state.location.search).toBe('?state=PENDING');
    expect(viewTab('Waiting for confirmation')).toHaveAttribute('aria-selected', 'true');
    expect(document.body.textContent).not.toMatch(/Diagnostic text that must never reach a screen/);
  });

  it('goes to the first page only when asked', async () => {
    const view = open(refusingLater);
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    await view.user.click(await screen.findByRole('button', { name: 'Back to first page' }));

    expect(await queueTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(queryOf().get('state')).toBe('PENDING');
  });

  // Break caught: every refusal of a read told as a bad cursor, which would offer the first page for a filter the officer must change.
  it('keeps its own words for a filter the server refuses', async () => {
    open(
      () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: 'service_date', rule: 'format' }],
        }),
      '/pickup-requests?date=2026-11-03',
    );

    await alertSaying(
      'That filter was not accepted. Choose a state from the list and a whole date.',
    );
    expect(screen.queryByRole('button', { name: 'Back to first page' })).toBeNull();
  });

  // Break caught: a refused page recognised under one spelling only. The contract's validation names a parameter it refuses by its bare name; the
  // service alone can judge an opaque position and names it `/page_token`, which is what the real API sends (apps/api pickup-request-reads-routes).
  it('recognises a page the real API refuses, which it names /page_token', async () => {
    const view = open((request) =>
      new URL(request.url).searchParams.get('page_token') === null
        ? page([pending], 'next-1')
        : refusal(400, 'VALIDATION_FAILED', {
            violations: [{ in: 'query', pointer: '/page_token', rule: 'format' }],
          }),
    );
    await queueTable();

    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    await alertSaying(/That page of the queue could not be opened/);
    expect(screen.queryByText(/That filter was not accepted/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
  });

  // Break caught: any parameter named in the service's spelling taken for the page, which would offer the first page for a filter to change.
  it('keeps its own words for a filter refused in the service’s spelling, /service_date', async () => {
    open(
      () =>
        refusal(400, 'VALIDATION_FAILED', {
          violations: [{ in: 'query', pointer: '/service_date', rule: 'format' }],
        }),
      '/pickup-requests?date=2026-11-03',
    );

    await alertSaying(
      'That filter was not accepted. Choose a state from the list and a whole date.',
    );
    expect(screen.queryByRole('button', { name: 'Back to first page' })).toBeNull();
  });

  it('says it of a place the officer comes back to, and offers the first page', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? refusedCursor() : twoPages(request);
      }),
    );

    await goBack(view);

    await alertSaying(/That page of the queue could not be opened/);
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
    expect(view.router.state.location.search).toBe('?state=PENDING');
  });
});

/**
 * A request the officer opened from the queue, and the server says is not there (`NOT_FOUND`: it was removed between the reading of the queue and
 * the opening of the request): its page keeps the way back to the page they left, as any request's does. A request reached with nothing left behind,
 * and an address that is not a request's at all, have the plain queue.
 */
describe('the queue, coming back from a request that is not there', () => {
  const gone = () => refusal(404, 'NOT_FOUND');
  const notFound = () =>
    screen.findByRole('heading', { level: 1, name: 'Pickup request not found' });

  /** The officer pages to the second page of the queue and opens a request on it that the server then says is not there. */
  async function toTheMissingRequest() {
    const view = open(twoPages, QUEUE, gone);
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await openFullPage(view.user);
    await notFound();
    return view;
  }

  // Break caught: the not-found page given no memory of the request it was opened for, so that its link back lost the page and the filters.
  it('brings the officer back to the page they left, read again, by the link back of the not-found page', async () => {
    const view = await toTheMissingRequest();
    const back = await backLink();
    expect(back).toHaveAttribute('href', QUEUE);
    const reads = listRequests().length;

    await view.user.click(back);

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(listRequests()).toHaveLength(reads + 1);
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('PENDING');
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(QUEUE);
    const link = within(await queueTable()).getByRole('button', {
      name: openButton('ACC-PR-9WXH4T'),
    });
    await waitFor(() => {
      expect(link).toHaveFocus();
    });
  });

  it('brings the officer back to the same page by the browser’s Back from the not-found page', async () => {
    const view = await toTheMissingRequest();

    await goBack(view);

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('PENDING');
  });

  it('gives the plain queue behind the link back of a request that was reached with nothing left behind', async () => {
    const view = open(twoPages, RECORD_PATH, gone);
    await notFound();

    const back = await backLink();
    expect(back).toHaveAttribute('href', '/pickup-requests');
    await view.user.click(back);

    expect(await queueTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page/)).toBeNull();
    expect(view.router.state.location.search).toBe('');
  });

  it('gives the plain queue behind the link back of an address that is not a request’s', async () => {
    open(twoPages, '/pickup-requests/not-a-request');
    await notFound();

    expect(await backLink()).toHaveAttribute('href', '/pickup-requests');
    expect(listRequests()).toHaveLength(0);
  });
});

/**
 * A request the officer opened from the queue, and the server refuses them (they may not read it: `PERMISSION_DENIED`; it is in a hub they do not
 * act in: `HUB_SCOPE_VIOLATION`): the page that says so keeps the way back to the page they left, as any request's does, for an officer who can read
 * the queue. The link grants nothing and says nothing of the request: it names the filters they left, and the queue is read again, under its own
 * permission, when they arrive. A session that cannot read the queue is given the refusal as every forbidden page is, with no link to another one.
 */
describe('the queue, coming back from a request the officer may not read', () => {
  const REFUSALS = [
    [
      'outside the officer’s hubs',
      () => refusal(403, 'HUB_SCOPE_VIOLATION'),
      'This is outside your hubs',
    ],
    [
      'for want of the permission',
      () => refusal(403, 'PERMISSION_DENIED'),
      'You do not have access to this page',
    ],
  ] as const;

  /** The officer pages to the second page of the queue and opens a request on it that the server then refuses them. */
  async function toTheRefusedRequest(refused: Handler, heading: string) {
    const view = open(twoPages, QUEUE, refused);
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await openFullPage(view.user);
    await screen.findByRole('heading', { level: 1, name: heading });
    return view;
  }

  describe.each(REFUSALS)('a request %s', (_why, refused, heading) => {
    // Break caught: a refusal page with no way back, or one that forgot where the officer came from and gave the plain queue.
    it('brings the officer back to the page they left, read again, by the link back of the refusal', async () => {
      const view = await toTheRefusedRequest(refused, heading);
      const back = await backLink();
      expect(back).toHaveAttribute('href', QUEUE);
      const reads = listRequests().length;

      await view.user.click(back);

      expect(await screen.findByText(/on page 2/)).toBeVisible();
      expect(listRequests()).toHaveLength(reads + 1);
      expect(queryOf().get('page_token')).toBe('next-1');
      expect(queryOf().get('state')).toBe('PENDING');
      expect(view.router.state.location.pathname + view.router.state.location.search).toBe(QUEUE);
      const link = within(await queueTable()).getByRole('button', {
        name: openButton('ACC-PR-9WXH4T'),
      });
      await waitFor(() => {
        expect(link).toHaveFocus();
      });
    });

    it('brings the officer back to the same page by the browser’s Back from the refusal', async () => {
      const view = await toTheRefusedRequest(refused, heading);

      await goBack(view);

      expect(await screen.findByText(/on page 2/)).toBeVisible();
      expect(queryOf().get('page_token')).toBe('next-1');
    });

    it('gives the plain queue behind the link back when the request was reached with nothing left behind', async () => {
      const view = open(twoPages, RECORD_PATH, refused);
      await screen.findByRole('heading', { level: 1, name: heading });

      const back = await backLink();
      expect(back).toHaveAttribute('href', '/pickup-requests');
      await view.user.click(back);

      expect(await queueTable()).toBeVisible();
      expect(queryOf().has('page_token')).toBe(false);
      expect(view.router.state.location.search).toBe('');
    });

    it('says nothing of the request in the link: the filters of the queue and no more', async () => {
      await toTheRefusedRequest(refused, heading);

      const href = (await backLink()).getAttribute('href') ?? '';

      expect(href).not.toContain(EARLIER_REQUEST_ID);
      expect(href).not.toContain('ACC-PR');
      expect(document.body.textContent).not.toContain('ACC-PR-9WXH4T');
    });

    // Break caught: a link to a queue the session cannot read, which would lead from one refusal to another and leave nowhere to go.
    it('gives a session that cannot read the queue the refusal as it always was, with no link to another refusal', async () => {
      // The exception page is the one the key of asking for an exception opens: a session may hold it and not `pickup.read`.
      open(twoPages, `${RECORD_PATH}/exception`, refused, ['pickup.exception.request']);

      expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeVisible();
      expect(screen.queryByRole('link', { name: 'Back to pickup requests' })).toBeNull();
      // The menu is the way on, as it is from every forbidden page.
      expect(screen.getByRole('complementary', { name: 'Main menu' })).toBeVisible();
      expect(listRequests()).toHaveLength(0);
    });
  });

  // Break caught: a link offered by a key the queue's own route does not ask for, so that the two drift apart and a session is led to a refusal.
  it('offers the link by the key of the queue’s own route', () => {
    const queue = SIGNED_IN_ROUTES.find((route) => route.path === '/pickup-requests');

    expect(queue?.access).toEqual({ permission: QUEUE_PERMISSION });
  });
});
