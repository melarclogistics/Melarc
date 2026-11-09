import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  EARLIER_REQUEST_ID,
  exceptionFixture,
  PICKUP_HUB_ID,
  pickupRequestFixture,
} from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, sessionWith, staffApi } from '../../../test-support/staff-api';

/**
 * Coming back to the approver's queue from a request (COMPONENT_PATTERNS section 22f, the pattern of the pickup queue and the pickup run list; the review of 499399c): the browser's Back brings
 * the officer to the page they left, read again from the server; focus goes to the request they opened if it is still on the page, else to the results, and never from where the officer has
 * put it; the position on the page is given back. Any other way to the queue starts at its first page. The memory is the one the pickup queue uses (`platform/pickup/queue-continuity.ts`),
 * held for this queue apart from that one.
 */
const LIST = 'GET /pickup-requests';
const RECORD = `GET /pickup-requests/${EARLIER_REQUEST_ID}`;
const APPROVER = ['pickup.read', 'pickup.exception.approve'];
const TABLE = 'One-package exceptions waiting for approval';

// Two requests with an exception waiting, one on each page: the second is the one the officer opens.
const first = pickupRequestFixture({
  declared_package_count: 1,
  one_package_exception: exceptionFixture(),
});
const second = pickupRequestFixture({
  id: EARLIER_REQUEST_ID,
  code: 'ACC-PR-9WXH4T',
  declared_package_count: 1,
  one_package_exception: exceptionFixture(),
});

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

/** Page one holds the first request and points at a second page, which holds the request the officer opens. */
const twoPages: Handler = (request) =>
  new URL(request.url).searchParams.get('page_token') === null
    ? page([first], 'next-1')
    : page([second]);

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

function open(list: Handler = twoPages) {
  api = installFakeApi(
    staffApi(
      sessionWith(APPROVER, {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: list, [RECORD]: () => json(200, second, etag('v1')) },
    ),
  );
  return renderApp('/approvals');
}

const listed = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-requests');
const queryOf = () => new URL(listed().at(-1)?.url ?? 'http://x/').searchParams;

/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const queueTable = async (): Promise<HTMLElement> => {
  const table = await screen.findByRole('table', { name: TABLE });
  await waitFor(() => {
    expect(table).not.toHaveAttribute('aria-busy', 'true');
  });
  return table;
};

type View = ReturnType<typeof open>;

/** The officer pages to the second page of the queue and opens the request on it, by the link of its code. */
async function toTheRequest(view: View = open()): Promise<View> {
  await queueTable();
  await view.user.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText(/on page 2/);
  await view.user.click(within(await queueTable()).getByRole('link', { name: 'ACC-PR-9WXH4T' }));
  await screen.findByRole('heading', { level: 1, name: 'ACC-PR-9WXH4T' });
  return view;
}

const goBack = (view: View) =>
  act(async () => {
    await view.router.navigate(-1);
  });

describe('the approver’s queue, coming back from a request: the browser’s Back', () => {
  it('brings the officer back to the page they left, read again, with focus on the request they opened', async () => {
    const view = await toTheRequest();

    await goBack(view);

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('one_package_exception_state')).toBe('REQUESTED');
    const code = within(await queueTable()).getByRole('link', { name: 'ACC-PR-9WXH4T' });
    await waitFor(() => {
      expect(code).toHaveFocus();
    });
    expect(view.router.state.location.pathname).toBe('/approvals');
  });

  // Break caught: the rows of the visit painted again at once from memory, which would show a queue the server has not been asked about.
  it('reads the page again and draws none of the earlier rows while it does', async () => {
    let reads = 0;
    let release: (response: Response) => void = () => undefined;
    const view = await toTheRequest(
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

    expect(await screen.findByText('Loading exceptions waiting for approval')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'ACC-PR-9WXH4T' })).toBeNull();
    expect(queryOf().get('page_token')).toBe('next-1');

    await act(async () => {
      release(page([second]));
      await Promise.resolve();
    });
    expect(await queueTable()).toBeVisible();
    expect(listed()).toHaveLength(3);
  });

  it('gives the position on the page back, after the rows are drawn and not before', async () => {
    const view = open();
    await queueTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(480);
    await view.user.click(within(await queueTable()).getByRole('link', { name: 'ACC-PR-9WXH4T' }));
    await screen.findByRole('heading', { level: 1, name: 'ACC-PR-9WXH4T' });
    scrollTo.mockClear();

    await goBack(view);

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 480, left: 0, behavior: 'instant' });
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('keeps the cursor out of the address, the storage and the cookies', async () => {
    const view = await toTheRequest();
    await goBack(view);
    await screen.findByText(/on page 2/);

    expect(view.router.state.location.search).toBe('');
    expect(JSON.stringify(view.router.state.location)).not.toContain('next-1');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

describe('the approver’s queue, coming back from a request: any other way', () => {
  // Break caught: a place given back to a person who came to the queue by the menu, a typed address or a link, which asked for the queue anew.
  it('starts at the first page when the queue is reached by a link of the application and not by going back', async () => {
    const view = await toTheRequest();

    await act(async () => {
      await view.router.navigate('/approvals');
    });

    expect(await screen.findByText(/More follow on the next page/)).toBeVisible();
    expect(screen.queryByText(/on page 2/)).toBeNull();
    expect(queryOf().has('page_token')).toBe(false);
  });
});
