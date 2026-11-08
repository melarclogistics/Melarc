import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  EARLIER_REQUEST_ID,
  PICKUP_HUB_ID,
  pickupRequestFixture,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { refusal, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * The queue's manual refresh (COMPONENT_PATTERNS section 22f; the reference of 1 November 2026, section 3): a **Refresh page** button that reads
 * the page now shown again, and the time of the last successful check of that page. The queue changes by no clock of its own, so every read
 * here is answered by hand, and the clock is the test's.
 */
const LIST = 'GET /pickup-requests';
const FIRST_CHECK = new Date('2026-11-03T14:30:00Z');
const SECOND_CHECK = new Date('2026-11-03T14:41:00Z');

const pending = pickupRequestFixture();
const late = pickupRequestFixture({ id: EARLIER_REQUEST_ID, code: 'ACC-PR-9WXH4T' });

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

let api: FakeApi;

// Only the date is the test's: the timers stay real, so that the screen's own waits (and the user's keystrokes) run as they do.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(FIRST_CHECK);
});

afterEach(() => {
  vi.useRealTimers();
  expect(api.unhandled).toEqual([]);
  api.restore();
});

function open(handler: Handler, path = '/pickup-requests') {
  api = installFakeApi(
    staffApi(
      sessionWith(['pickup.read'], {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: handler },
    ),
  );
  return renderApp(path);
}

const listRequests = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-requests');
const queryOf = () => new URL(listRequests().at(-1)?.url ?? 'http://x/').searchParams;
const refresh = () => screen.getByRole('button', { name: 'Refresh page' });
const queueTable = () => screen.findByRole('table', { name: 'Pickup requests' });

/** Opens the queue and answers its first read. */
async function openRead(items: unknown[] = [pending], next: string | null = null, path?: string) {
  const reads = byHand();
  const view = open(reads.handler, path);
  await reads.answer(page(items, next));
  await queueTable();
  return { ...view, reads };
}

describe('the queue: Refresh page, and the time of the check', () => {
  it('keeps the button in place from the first read, busy until it is answered, with no time yet', async () => {
    const reads = byHand();
    open(reads.handler);

    const button = await screen.findByRole('button', { name: 'Refresh page' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Checking this page…')).toBeVisible();
    expect(screen.queryByText(/Last checked/)).toBeNull();

    await reads.answer(page([pending]));

    expect(await screen.findByText('Last checked 3 Nov, 14:30')).toBeVisible();
    expect(refresh()).toBe(button);
    expect(button).not.toHaveAttribute('aria-busy');
  });

  // Break caught: a time taken from the server's snapshot, or from the render, in place of the moment this page's read was answered.
  it('says the time the page was read, in Accra, with no seconds and no claim about the queue', async () => {
    const reads = byHand();
    open(reads.handler);
    vi.setSystemTime(new Date('2026-11-03T09:05:59Z'));

    await reads.answer(page([pending]));

    const text = await screen.findByText(/^Last checked /);
    expect(text).toHaveTextContent('Last checked 3 Nov, 09:05');
    expect(text.textContent).not.toMatch(/queue is|up to date|current|all pages/i);
  });

  it('reads the page it is on again, with its filters and its cursor, and stays on that page', async () => {
    const { user, router, reads } = await openRead(
      [pending],
      'next-1',
      '/pickup-requests?state=PENDING',
    );
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await reads.answer(page([late]));
    expect(await screen.findByText(/on page 2/)).toBeVisible();

    await user.click(refresh());
    await reads.answer(page([late, pending]));

    expect(await screen.findByText(/Showing 2 requests on page 2/)).toBeVisible();
    expect(listRequests()).toHaveLength(3);
    expect(queryOf().get('state')).toBe('PENDING');
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(router.state.location.search).toBe('?state=PENDING');
    expect(screen.getByRole('combobox', { name: 'State' })).toHaveValue('PENDING');
  });

  // Break caught: the old rows drawn as the answer to a read that is still under way, or beside the failure of one.
  it('takes the rows off while it reads, and draws the new page when it is read', async () => {
    const { user, reads } = await openRead();

    await user.click(refresh());

    expect(await screen.findByText('Loading the pickup requests…')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Pickup requests' })).toBeNull();
    expect(screen.queryByText('ACC-PR-7KQ2MZ')).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(refresh()).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Checking this page…')).toBeVisible();

    vi.setSystemTime(SECOND_CHECK);
    await reads.answer(page([late]));

    const table = await queueTable();
    expect(within(table).getByRole('link', { name: 'ACC-PR-9WXH4T' })).toBeVisible();
    expect(within(table).queryByRole('link', { name: 'ACC-PR-7KQ2MZ' })).toBeNull();
    expect(screen.getByText('Last checked 3 Nov, 14:41')).toBeVisible();
    expect(screen.queryByText('Checking this page…')).toBeNull();
  });

  it('keeps focus on the button, and says once that the page was refreshed', async () => {
    const { user, reads } = await openRead();
    expect(screen.queryByText('Page refreshed.')).toBeNull();

    await user.click(refresh());
    expect(screen.queryByText('Page refreshed.')).toBeNull();
    await reads.answer(page([late]));
    await queueTable();

    expect(refresh()).toHaveFocus();
    const done = screen.getAllByText('Page refreshed.');
    expect(done).toHaveLength(1);
    expect(done[0]).toHaveAttribute('role', 'status');

    // The next refresh is announced afresh, and not before it is done.
    await user.click(refresh());
    expect(screen.queryByText('Page refreshed.')).toBeNull();
    await reads.answer(page([late]));
    expect(await screen.findByText('Page refreshed.')).toBeInTheDocument();
  });

  // Break caught: the completion of one page’s refresh still said when the officer is looking at another page.
  it('says nothing of the refresh once the officer has moved to another filter', async () => {
    const { user, reads } = await openRead([pending], 'next-1');
    await user.click(refresh());
    await reads.answer(page([late], 'next-1'));
    expect(await screen.findByText('Page refreshed.')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'CONFIRMED');
    await reads.answer(page([late]));
    await queueTable();

    expect(screen.queryByText('Page refreshed.')).toBeNull();
  });

  // Break caught: a refresh that tells itself done while the officer is somewhere else, and a focus taken back to a control they left.
  it('leaves focus where the officer moved it during the read', async () => {
    const { user, reads } = await openRead();
    await user.click(refresh());
    const state = screen.getByRole('combobox', { name: 'State' });

    act(() => {
      state.focus();
    });
    await reads.answer(page([late]));
    await queueTable();

    expect(state).toHaveFocus();
  });

  it('counts a read that found nothing as a check, and says the page is empty', async () => {
    const { user, reads } = await openRead();

    vi.setSystemTime(SECOND_CHECK);
    await user.click(refresh());
    await reads.answer(page([]));

    expect(await screen.findByRole('heading', { name: 'No pickup requests yet' })).toBeVisible();
    expect(screen.getByText('Last checked 3 Nov, 14:41')).toBeVisible();
    expect(screen.getByText('Page refreshed.')).toBeInTheDocument();
  });

  // Break caught: rows of the earlier read left on the screen beside the failure, which would pass for the queue as it is.
  it('shows the failure and no rows when the refresh fails, and says when the last check that worked was', async () => {
    const { user, reads } = await openRead();

    vi.setSystemTime(SECOND_CHECK);
    await user.click(refresh());
    await reads.answer(refusal(500, 'INTERNAL_ERROR'));

    expect(await screen.findByText('The pickup requests could not be loaded.')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Pickup requests' })).toBeNull();
    expect(screen.queryByText('ACC-PR-7KQ2MZ')).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(screen.getByText('Refresh failed. Last successful check: 3 Nov, 14:30')).toBeVisible();
    expect(screen.queryByText(/^Last checked/)).toBeNull();
    expect(screen.queryByText('Page refreshed.')).toBeNull();
    // The control is still there and ready, and so is the ordinary retry.
    expect(refresh()).not.toHaveAttribute('aria-busy');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('reads again from a failure, with the button or with Try again, and shows the new page', async () => {
    const { user, reads } = await openRead();
    await user.click(refresh());
    await reads.answer(refusal(500, 'INTERNAL_ERROR'));
    await screen.findByText('Refresh failed. Last successful check: 3 Nov, 14:30');

    vi.setSystemTime(SECOND_CHECK);
    await user.click(refresh());
    await reads.answer(page([late]));

    expect(await queueTable()).toBeVisible();
    expect(screen.getByText('Last checked 3 Nov, 14:41')).toBeVisible();
    expect(screen.queryByText(/Refresh failed/)).toBeNull();
  });

  // Break caught: a second click that starts a second read (or cancels the first and starts again) while one is under way.
  it('starts one read however many times it is pressed while one is under way', async () => {
    const { user, reads } = await openRead();
    const button = refresh();

    // Two presses before the screen has drawn the first one's busy state, then a third after.
    act(() => {
      button.click();
      button.click();
    });
    await waitFor(() => {
      expect(listRequests()).toHaveLength(2);
    });
    await user.click(button);
    await user.keyboard('{Enter}');

    expect(listRequests()).toHaveLength(2);
    await reads.answer(page([late]));
    await queueTable();
    expect(listRequests()).toHaveLength(2);
  });

  // Break caught: the time of the page before shown beside the page after, which would claim a check nobody made.
  it('shows no time for a filter, or for a page, until that read has been answered', async () => {
    const { user, reads } = await openRead([pending], 'next-1');
    expect(screen.getByText('Last checked 3 Nov, 14:30')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'CONFIRMED');
    await waitFor(() => {
      expect(listRequests()).toHaveLength(2);
    });
    expect(screen.queryByText(/Last checked/)).toBeNull();
    vi.setSystemTime(SECOND_CHECK);
    await reads.answer(page([late], 'next-2'));
    expect(await screen.findByText('Last checked 3 Nov, 14:41')).toBeVisible();

    vi.setSystemTime(new Date('2026-11-03T14:52:00Z'));
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => {
      expect(listRequests()).toHaveLength(3);
    });
    expect(screen.queryByText(/Last checked/)).toBeNull();
    await reads.answer(page([pending]));
    expect(await screen.findByText('Last checked 3 Nov, 14:52')).toBeVisible();
  });

  it('names no earlier check when the page that failed was never read', async () => {
    const { user, reads } = await openRead([pending], 'next-1');

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await reads.answer(refusal(500, 'INTERNAL_ERROR'));

    expect(await screen.findByText('The pickup requests could not be loaded.')).toBeVisible();
    expect(screen.queryByText(/Last checked/)).toBeNull();
    expect(screen.queryByText(/Last successful check/)).toBeNull();
  });

  it('announces nothing for a read the officer did not ask for by the button', async () => {
    const { user, reads } = await openRead([pending], 'next-1');

    await user.selectOptions(screen.getByRole('combobox', { name: 'State' }), 'CONFIRMED');
    await reads.answer(page([late]));
    await queueTable();

    expect(screen.queryByText('Page refreshed.')).toBeNull();
  });

  // Break caught: a page that reads again on its own (on focus, on reconnection, on a timer), which every accepted request is activity for
  // the session's idle limit and the reference leaves out on purpose.
  it('reads nothing on its own: not on focus, not on reconnection, not as the time goes by', async () => {
    await openRead();
    const reads = listRequests().length;

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('offline'));
      window.dispatchEvent(new Event('online'));
    });
    vi.setSystemTime(new Date('2026-11-03T16:30:00Z'));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(listRequests()).toHaveLength(reads);
    expect(screen.getByText('Last checked 3 Nov, 14:30')).toBeVisible();
  });
});

/**
 * "Page refreshed." is said of one **visit** to a page: the filters and the cursor the officer is on, counted anew each time they change, so that
 * coming back to a filter they were on is a visit of its own and not the old one again. A refresh asked for in one visit is never said done in
 * another, whenever its answer arrives.
 */
describe('the queue: Refresh page, and the visit it is said done for', () => {
  const stateSelect = () => screen.getByRole('combobox', { name: 'State' });
  /** Time enough for what an answer sets going (a refresh's word is set a few turns after the answer) to have been set, if it is going to be. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  // Break caught: the word tied to the filter and not to the visit, so that going to another filter and back said it again over a read that was
  // not a refresh.
  it('does not say it again when the officer comes back to the filter it was said for', async () => {
    const { user, reads } = await openRead();
    await user.click(refresh());
    await reads.answer(page([late]));
    expect(await screen.findByText('Page refreshed.')).toBeInTheDocument();

    await user.selectOptions(stateSelect(), 'CONFIRMED');
    await reads.answer(page([late]));
    await queueTable();
    await user.selectOptions(stateSelect(), '');
    await waitFor(() => {
      expect(listRequests()).toHaveLength(4);
    });

    // While the new read is under way, and after it, which nobody asked for as a refresh.
    expect(screen.queryByText('Page refreshed.')).toBeNull();
    await reads.answer(page([pending]));
    await queueTable();
    await settle();
    expect(screen.queryByText('Page refreshed.')).toBeNull();
  });

  /**
   * The queue with its first read answered at once and its second, the refresh of that filter, held until the test says (`finish`). Any read of
   * another filter, and any later read of this one, is answered at once.
   */
  async function withARefreshUnderWay() {
    let answerRefresh: (response: Response) => void = () => undefined;
    let readsOfFirst = 0;
    const view = open((request) => {
      if (new URL(request.url).searchParams.has('state')) return page([late]);
      readsOfFirst += 1;
      if (readsOfFirst !== 2) return page([pending]);
      return new Promise<Response>((resolve) => {
        answerRefresh = resolve;
      });
    });
    await queueTable();
    await view.user.click(refresh());
    await waitFor(() => {
      expect(listRequests()).toHaveLength(2);
    });
    return {
      ...view,
      finish: (response: Response) =>
        act(async () => {
          answerRefresh(response);
          await Promise.resolve();
        }),
    };
  }

  // Break caught: a refresh that completes late, after the officer has been to another filter and come back, said done over the newer read.
  it('says nothing when a refresh completes after the officer has been to another filter and come back', async () => {
    const view = await withARefreshUnderWay();
    await view.user.selectOptions(stateSelect(), 'CONFIRMED');
    await queueTable();
    await view.user.selectOptions(stateSelect(), '');
    expect(screen.queryByText('Page refreshed.')).toBeNull();

    await view.finish(page([pending, late]));
    await queueTable();
    await settle();

    expect(screen.queryByText('Page refreshed.')).toBeNull();
  });

  // Break caught: a refresh that completes while the officer is on another filter, kept to be said when they come back to the one it was for.
  it('says nothing of a refresh that completes while the officer is on another filter, nor when they come back', async () => {
    const view = await withARefreshUnderWay();
    await view.user.selectOptions(stateSelect(), 'CONFIRMED');
    await queueTable();

    await view.finish(page([pending, late]));
    await settle();
    expect(screen.queryByText('Page refreshed.')).toBeNull();
    await view.user.selectOptions(stateSelect(), '');
    await queueTable();
    await settle();

    expect(screen.queryByText('Page refreshed.')).toBeNull();
  });

  it('says nothing over a failure that is the answer to the refresh the officer came back to', async () => {
    const view = await withARefreshUnderWay();
    await view.user.selectOptions(stateSelect(), 'CONFIRMED');
    await queueTable();
    await view.user.selectOptions(stateSelect(), '');

    await view.finish(refusal(500, 'INTERNAL_ERROR'));

    expect(await screen.findByText('The pickup requests could not be loaded.')).toBeVisible();
    await settle();
    expect(screen.queryByText('Page refreshed.')).toBeNull();
  });

  it('still says it, once, for the visit the refresh was asked in', async () => {
    const view = await withARefreshUnderWay();

    await view.finish(page([pending, late]));

    expect(await screen.findByText('Page refreshed.')).toBeInTheDocument();
    expect(screen.getAllByText('Page refreshed.')).toHaveLength(1);
  });
});
