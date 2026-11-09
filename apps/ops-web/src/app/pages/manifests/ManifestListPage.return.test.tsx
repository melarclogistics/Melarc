import { act, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { byHand } from '../../../test-support/by-hand';
import { installFakeApi, json, type FakeApi, type Handler } from '../../../test-support/fake-api';
import {
  listedManifestFixture,
  manifestFixture,
  MANIFEST_ID,
  STOP_TWO_ID,
} from '../../../test-support/manifest-fixture';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { PICKUP_HUB_ID } from '../../../test-support/pickup-fixture';
import { renderApp } from '../../../test-support/render-app';
import { etag, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { SIGNED_IN_ROUTES } from '../../navigation/route-registry';
import { LIST_PERMISSION } from './WithManifest';

/**
 * Coming back to the manifest list from a manifest (COMPONENT_PATTERNS section 22f, the pattern of the pickup queue): the browser's Back and the
 * manifest's own link back bring the officer to the page they left, with its filters, read again from the server; focus goes to the manifest they
 * opened if it is still on the page, else to the results, and never from where the officer has put it; the position on the page is restored.
 * Any other way to the list starts at its first page. A later page that has come to hold nothing, and a page the server will not open, say so and
 * offer the first page. The memory is the one the pickup queue uses (`platform/pickup/queue-continuity.ts`), held for this list apart from that one.
 */
const LIST = 'GET /pickup-manifests';
const RECORD = `GET /pickup-manifests/${MANIFEST_ID}`;
const LISTED = '/manifests?state=DRAFT';
const RECORD_PATH = `/manifests/${MANIFEST_ID}`;

// Two draft manifests, one on each page: the second is the one the officer opens.
const first = listedManifestFixture({ id: STOP_TWO_ID, code: 'ACC-MF-K7M4PX' });
const late = listedManifestFixture();
const opened = manifestFixture({ stops: [] });

const page = (items: unknown[], next: string | null = null): Response =>
  json(200, { items, next_page_token: next });

/** Page one holds one manifest and points at a second, which holds the manifest the officer opens. */
const twoPages: Handler = (request) =>
  new URL(request.url).searchParams.get('page_token') === null
    ? page([first], 'next-1')
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
  restoreRoom();
});

function open(list: Handler = twoPages, path = LISTED, record?: Handler) {
  api = installFakeApi(
    staffApi(
      sessionWith(['pickup.read'], {
        authorized_hubs: [{ id: PICKUP_HUB_ID, display_name: 'Accra Central' }],
      }),
      { [LIST]: list, [RECORD]: record ?? (() => json(200, opened, etag('v1'))) },
    ),
  );
  return renderApp(path);
}

const listed = () =>
  api.requests.filter((request) => new URL(request.url).pathname === '/api/v1/pickup-manifests');
const queryOf = () => new URL(listed().at(-1)?.url ?? 'http://x/').searchParams;
/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const manifestTable = async (): Promise<HTMLElement> => {
  const table = await screen.findByRole('table', { name: 'Pickup runs' });
  await waitFor(() => {
    expect(table).not.toHaveAttribute('aria-busy', 'true');
  });
  return table;
};
const backLink = () => screen.findByRole('link', { name: 'Back to manifests' });
const stateTab = (name: string) => screen.getByRole('tab', { name });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};

type View = ReturnType<typeof open>;

/** The officer pages to the second page of the list and opens the manifest on it. */
async function toTheRecord(view: View = open()): Promise<View> {
  await manifestTable();
  await view.user.click(screen.getByRole('button', { name: 'Next page' }));
  await screen.findByText(/on page 2/);
  await view.user.click(within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' }));
  await backLink();
  return view;
}

const goBack = (view: View) =>
  act(async () => {
    await view.router.navigate(-1);
  });

describe('the manifests, coming back from a manifest: the browser’s Back', () => {
  it('brings the officer back to the page they left, with its filters', async () => {
    const view = await toTheRecord();

    await goBack(view);

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('DRAFT');
    expect(stateTab('Draft')).toHaveAttribute('aria-selected', 'true');
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(LISTED);
    expect(
      within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' }),
    ).toBeVisible();
  });

  it('keeps the cursor out of the address, the storage and the cookies', async () => {
    const view = await toTheRecord();
    await goBack(view);
    await screen.findByText(/on page 2/);

    expect(view.router.state.location.search).toBe('?state=DRAFT');
    expect(JSON.stringify(view.router.state.location)).not.toContain('next-1');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  // Break caught: the rows of the visit painted again at once from memory, which would show a list the server has not been asked about.
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

    expect(await screen.findByText('Loading pickup runs')).toBeVisible();
    expect(screen.queryByRole('link', { name: /^ACC-MF-/ })).toBeNull();
    expect(screen.queryByText('ACC-MF-Q92422')).toBeNull();
    expect(screen.queryByText('ACC-MF-K7M4PX')).toBeNull();
    expect(queryOf().get('page_token')).toBe('next-1');

    await act(async () => {
      release(page([late]));
      await Promise.resolve();
    });
    expect(await manifestTable()).toBeVisible();
    expect(listed()).toHaveLength(3);
  });

  it('shows no time of the earlier check until the page has been read again', async () => {
    const reads = byHand();
    const view = open((request) =>
      listed().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await toTheRecord(view);

    await goBack(view);

    expect(await screen.findByText('Loading pickup runs')).toBeVisible();
    expect(screen.queryByText(/^Updated /)).toBeNull();
    await reads.answer(page([late]));
    expect(await screen.findByText(/^Updated /)).toBeVisible();
  });
});

describe('the manifests, coming back from a manifest: the link back', () => {
  it('brings the officer to the same page, with the same filters, and to nothing in the address but the filters', async () => {
    const view = await toTheRecord();

    await view.user.click(await backLink());

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('DRAFT');
    expect(view.router.state.location.pathname + view.router.state.location.search).toBe(LISTED);
    expect(JSON.stringify(view.router.state.location)).not.toContain('next-1');
  });

  it('names the list with the filters it was left under, so that a new tab’s copy of the link is the same list', async () => {
    await toTheRecord();

    expect(await backLink()).toHaveAttribute('href', LISTED);
  });

  // Break caught: the card's link left without the mark of its manifest, so that opening a manifest from a card (a narrow screen) leaves no place.
  it('is the same when the manifest is opened from its card', async () => {
    narrowRoom();
    const view = open();
    await screen.findByRole('list', { name: 'Pickup runs' });
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    const cards = await screen.findByRole('list', { name: 'Pickup runs' });
    await view.user.click(within(cards).getByRole('link', { name: 'ACC-MF-Q92422' }));
    await backLink();

    await view.user.click(await backLink());

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
  });

  it('names both filters', async () => {
    const view = open(twoPages, '/manifests?state=DRAFT&date=2026-11-04');
    await toTheRecord(view);

    expect(await backLink()).toHaveAttribute('href', '/manifests?state=DRAFT&date=2026-11-04');
  });
});

describe('the manifests, coming back from a manifest: focus and position', () => {
  it('gives focus to the manifest the officer opened, once the page is drawn', async () => {
    const view = await toTheRecord();

    await goBack(view);

    const link = within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' });
    await waitFor(() => {
      expect(link).toHaveFocus();
    });
  });

  // Break caught: focus left on the page heading, so that a keyboard user must tab through the filters and every row to find their place.
  it('gives focus to the results when the manifest is no longer on the page', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? page([first], 'next-9') : twoPages(request);
      }),
    );

    await goBack(view);

    const results = (await manifestTable()).closest('.ui-data-table__scroller');
    await waitFor(() => {
      expect(results).toHaveFocus();
    });
    expect(screen.queryByRole('link', { name: 'ACC-MF-Q92422' })).toBeNull();
  });

  // Break caught: a page that comes back with nothing to draw, or with a failure, left with focus on the heading above it.
  it.each([
    [
      'a failure',
      () => refusal(500, 'INTERNAL_ERROR'),
      () => alertSaying('The pickup runs could not be loaded.'),
    ],
    [
      'nothing',
      () => page([]),
      () => screen.findByRole('heading', { name: 'No pickup runs on this page' }),
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
      const region = (await manifestTable()).closest('.ui-data-table__scroller');
      await waitFor(() => {
        expect(region).toHaveFocus();
      });
    },
  );

  // Break caught: focus pulled back to the manifest from the control the officer has already moved to while the page was being read.
  it('leaves focus where the officer put it while the page was being read', async () => {
    const reads = byHand();
    const view = open((request) =>
      listed().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await toTheRecord(view);
    await goBack(view);
    await screen.findByText('Loading pickup runs');
    const state = stateTab('Draft');

    act(() => {
      state.focus();
    });
    await reads.answer(page([late]));
    await manifestTable();

    expect(state).toHaveFocus();
    expect(
      within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' }),
    ).not.toHaveFocus();
  });

  // Break caught: the place given again at every later read of the page, which would pull the officer back from wherever they have scrolled to,
  // and take focus from wherever they have put it, each time they refresh.
  it('gives the place back once, and not again at the next read of the page', async () => {
    const refresh = byHand();
    const view = open((request) =>
      listed().length <= 3 ? twoPages(request) : refresh.handler(request),
    );
    await toTheRecord(view);
    await goBack(view);
    await manifestTable();
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    await view.user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('Loading pickup runs')).toBeVisible();
    await refresh.answer(page([late]));
    await manifestTable();
    await act(async () => {
      await Promise.resolve();
    });

    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  // Break caught: the position and the focus of the page the officer left given to the page they have moved to since.
  it('gives nothing back once the officer has changed the filter while the page was being read', async () => {
    const reads = byHand();
    const view = open((request) =>
      listed().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await toTheRecord(view);
    await goBack(view);
    await screen.findByText('Loading pickup runs');
    scrollTo.mockClear();
    act(() => {
      stateTab('Draft').focus();
    });

    await view.user.click(stateTab('Completed'));
    await reads.answer(page([late]));
    await reads.answer(page([first]));
    await manifestTable();

    expect(scrollTo).not.toHaveBeenCalled();
    expect(stateTab('Completed')).toHaveFocus();
  });

  it('restores the position on the page after the rows are drawn, and not before', async () => {
    const reads = byHand();
    const view = open((request) =>
      listed().length <= 2 ? twoPages(request) : reads.handler(request),
    );
    await manifestTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);
    await view.user.click(
      within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' }),
    );
    await backLink();
    scrollTo.mockClear();

    await goBack(view);
    await screen.findByText('Loading pickup runs');
    expect(scrollTo).not.toHaveBeenCalled();
    await reads.answer(page([late]));
    await manifestTable();

    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 640, left: 0, behavior: 'instant' });
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe('the manifests, coming to the list any other way', () => {
  it('starts at the first page for a visit that began at the manifest (a typed address, a new tab, a reload)', async () => {
    const view = open(twoPages, RECORD_PATH);

    await view.user.click(await backLink());

    expect(await manifestTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page/)).toBeNull();
    expect(view.router.state.location.search).toBe('');
  });

  // Break caught: the menu's link treated as a return, which would answer a request for the list with the position of the last visit.
  it('starts at the first page when the officer asks for the list from the menu', async () => {
    const view = await toTheRecord();

    await view.user.click(
      within(screen.getByRole('complementary', { name: 'Main menu' })).getByRole('link', {
        name: 'Pickup runs',
      }),
    );

    expect(await manifestTable()).toBeVisible();
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

    expect(await manifestTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page/)).toBeNull();
  });

  it('is used up by the return: coming to the list by Forward and Back again starts at the first page', async () => {
    const view = await toTheRecord();
    await goBack(view);
    await screen.findByText(/on page 2/);

    await act(async () => {
      await view.router.navigate(1);
    });
    await backLink();
    await goBack(view);

    expect(await manifestTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
  });
});

/**
 * A click on a manifest's link leaves a place; this one stops the navigation that follows, so that the officer is still on the list with a
 * place left, and what they do next shows whether it is let go of.
 */
async function leaveWithoutGoing(user: UserEvent): Promise<void> {
  const link = within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' });
  link.addEventListener(
    'click',
    (event) => {
      event.preventDefault();
    },
    { once: true },
  );
  await user.click(link);
}

describe('the manifests: a place left, and then the filters or the page change', () => {
  it('does not bring back a place left under a filter that was changed since, even if the filter is put back', async () => {
    const view = open();
    await manifestTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await leaveWithoutGoing(view.user);
    expect(view.router.state.location.pathname).toBe('/manifests');

    await view.user.click(stateTab('Completed'));
    await view.user.click(stateTab('Draft'));
    await manifestTable();
    await act(async () => {
      await view.router.navigate(RECORD_PATH);
    });
    await backLink();
    await goBack(view);

    expect(await manifestTable()).toBeVisible();
    expect(screen.queryByText(/on page 2/)).toBeNull();
    expect(queryOf().has('page_token')).toBe(false);
  });

  // Break caught: "Show every manifest" that takes the filter off and leaves the place, so that the officer who puts the same filter back by the
  // address is carried to a position they left before they cleared it.
  it('does not bring back a place left before the officer cleared the filters', async () => {
    let reads = 0;
    const view = open(() => {
      reads += 1;
      return reads === 2 ? page([]) : page([late]);
    }, LISTED);
    await manifestTable();
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);
    await leaveWithoutGoing(view.user);
    await view.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await view.user.click(await screen.findByRole('button', { name: 'Show every pickup run' }));
    await manifestTable();
    await act(async () => {
      await view.router.navigate(LISTED);
    });
    await manifestTable();
    await act(async () => {
      await view.router.navigate(RECORD_PATH);
    });
    await backLink();
    scrollTo.mockClear();

    await goBack(view);

    expect(await manifestTable()).toBeVisible();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does not bring back a place left on a page the officer has since left for the first', async () => {
    let reads = 0;
    const view = open((request) => {
      reads += 1;
      // The second page is read twice (on arrival, and by the refresh) and the second time it holds nothing.
      return reads === 3 ? page([]) : twoPages(request);
    });
    await manifestTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await leaveWithoutGoing(view.user);
    await view.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await view.user.click(await screen.findByRole('button', { name: 'Back to first page' }));
    await manifestTable();

    await act(async () => {
      await view.router.navigate(RECORD_PATH);
    });
    await backLink();
    await goBack(view);

    expect(await manifestTable()).toBeVisible();
    expect(screen.queryByText(/on page 2/)).toBeNull();
    expect(queryOf().has('page_token')).toBe(false);
  });
});

describe('the manifests: a later page that holds nothing', () => {
  const emptyLater: Handler = (request) =>
    new URL(request.url).searchParams.get('page_token') === null
      ? page([first], 'next-1')
      : page([]);

  it('is what the officer finds on coming back to a page that has emptied since', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? page([]) : twoPages(request);
      }),
    );

    await goBack(view);

    expect(
      await screen.findByRole('heading', { name: 'No pickup runs on this page' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
    expect(listed()).toHaveLength(3);
  });

  it('goes to the first page only when asked, and puts focus on its results', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? page([]) : twoPages(request);
      }),
    );
    await goBack(view);

    await view.user.click(await screen.findByRole('button', { name: 'Back to first page' }));

    const table = await manifestTable();
    expect(queryOf().has('page_token')).toBe(false);
    expect(within(table).getByRole('link', { name: 'ACC-MF-K7M4PX' })).toBeVisible();
    await waitFor(() => {
      expect(table.closest('.ui-data-table__scroller')).toHaveFocus();
    });
  });

  it('still tells an empty later page as before when the officer pages to it', async () => {
    const view = open(emptyLater);
    await manifestTable();

    await view.user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(
      await screen.findByRole('heading', { name: 'No pickup runs on this page' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No pickup runs yet' })).toBeNull();
  });
});

describe('the manifests: a page the server will not open', () => {
  const refusedCursor = () =>
    refusal(400, 'VALIDATION_FAILED', {
      violations: [{ in: 'query', pointer: '/page_token', rule: 'format' }],
    });

  it('says it of a place the officer comes back to, keeps the filters, and offers the first page', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? refusedCursor() : twoPages(request);
      }),
    );

    await goBack(view);

    await alertSaying('That page of the pickup runs could not be opened');
    expect(screen.queryByText(/That filter was not accepted/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^ACC-MF-/ })).toBeNull();
    expect(view.router.state.location.search).toBe('?state=DRAFT');
    expect(stateTab('Draft')).toHaveAttribute('aria-selected', 'true');
  });

  // Break caught: the first page offered by a refused page without letting go of the place, so that the next return carries the officer back to
  // the page the server would not open.
  it('lets go of a place left on a page the server then refused, once the officer asks for the first page', async () => {
    let reads = 0;
    const view = open((request) => {
      reads += 1;
      return reads === 3 ? refusedCursor() : twoPages(request);
    });
    await manifestTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await leaveWithoutGoing(view.user);
    await view.user.click(screen.getByRole('button', { name: 'Refresh' }));
    await view.user.click(await screen.findByRole('button', { name: 'Back to first page' }));
    await manifestTable();

    await act(async () => {
      await view.router.navigate(RECORD_PATH);
    });
    await backLink();
    await goBack(view);

    expect(await manifestTable()).toBeVisible();
    expect(screen.queryByText(/on page 2/)).toBeNull();
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('says it under the contract’s own spelling of the parameter as well', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3
          ? refusal(400, 'VALIDATION_FAILED', {
              violations: [{ in: 'query', pointer: 'page_token', rule: 'format' }],
            })
          : twoPages(request);
      }),
    );

    await goBack(view);

    await alertSaying('That page of the pickup runs could not be opened');
    expect(screen.getByRole('button', { name: 'Back to first page' })).toBeVisible();
  });

  it('goes to the first page only when asked', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3 ? refusedCursor() : twoPages(request);
      }),
    );
    await goBack(view);

    await view.user.click(await screen.findByRole('button', { name: 'Back to first page' }));

    expect(await manifestTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(queryOf().get('state')).toBe('DRAFT');
  });

  // Break caught: every refusal of a read told as a bad cursor, which would offer the first page for a filter the officer must change.
  it('keeps its own words for a filter the server refuses on the page the officer comes back to', async () => {
    let reads = 0;
    const view = await toTheRecord(
      open((request) => {
        reads += 1;
        return reads === 3
          ? refusal(400, 'VALIDATION_FAILED', {
              violations: [{ in: 'query', pointer: '/service_date', rule: 'format' }],
            })
          : twoPages(request);
      }),
    );

    await goBack(view);

    await alertSaying('That filter was not accepted. Choose a state and a whole date.');
    expect(screen.queryByRole('button', { name: 'Back to first page' })).toBeNull();
  });
});

/**
 * A manifest the officer opened from the list, and the server says is not there (`NOT_FOUND`: it was removed between the reading of the list and
 * the opening of the manifest): its page keeps the way back to the page they left, as any manifest's does. A manifest reached with nothing left
 * behind, and an address that is not a manifest's at all, have the plain list.
 */
describe('the manifests, coming back from a manifest that is not there', () => {
  const gone = () => refusal(404, 'NOT_FOUND');
  const notFound = () => screen.findByRole('heading', { level: 1, name: 'Manifest not found' });

  /** The officer pages to the second page of the list and opens a manifest on it that the server then says is not there. */
  async function toTheMissingRecord() {
    const view = open(twoPages, LISTED, gone);
    await manifestTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await view.user.click(
      within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' }),
    );
    await notFound();
    return view;
  }

  // Break caught: the not-found page given no memory of the manifest it was opened for, so that its link back lost the page and the filters.
  it('brings the officer back to the page they left, read again, by the link back of the not-found page', async () => {
    const view = await toTheMissingRecord();
    const back = await backLink();
    expect(back).toHaveAttribute('href', LISTED);
    const reads = listed().length;

    await view.user.click(back);

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(listed()).toHaveLength(reads + 1);
    expect(queryOf().get('page_token')).toBe('next-1');
    expect(queryOf().get('state')).toBe('DRAFT');
    const link = within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' });
    await waitFor(() => {
      expect(link).toHaveFocus();
    });
  });

  it('brings the officer back to the same page by the browser’s Back from the not-found page', async () => {
    const view = await toTheMissingRecord();

    await goBack(view);

    expect(await screen.findByText(/on page 2/)).toBeVisible();
    expect(queryOf().get('page_token')).toBe('next-1');
  });

  it('gives the plain list behind the link back of a manifest that was reached with nothing left behind', async () => {
    const view = open(twoPages, RECORD_PATH, gone);
    await notFound();

    const back = await backLink();
    expect(back).toHaveAttribute('href', '/manifests');
    await view.user.click(back);

    expect(await manifestTable()).toBeVisible();
    expect(queryOf().has('page_token')).toBe(false);
    expect(view.router.state.location.search).toBe('');
  });

  it('gives the plain list behind the link back of an address that is not a manifest’s', async () => {
    open(twoPages, '/manifests/not-a-manifest');
    await notFound();

    expect(await backLink()).toHaveAttribute('href', '/manifests');
    expect(listed()).toHaveLength(0);
  });
});

/**
 * A manifest the officer opened from the list, and the server refuses them (they may not read it: `PERMISSION_DENIED`; it is in a hub they do not
 * act in: `HUB_SCOPE_VIOLATION`): the page that says so keeps the way back to the page they left, as any manifest's does, for an officer who can
 * read the list. The link grants nothing and says nothing of the manifest: it names the filters they left, and the list is read again, under its
 * own permission, when they arrive.
 */
describe('the manifests, coming back from a manifest the officer may not read', () => {
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

  async function toTheRefusedRecord(refused: Handler, heading: string) {
    const view = open(twoPages, LISTED, refused);
    await manifestTable();
    await view.user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);
    await view.user.click(
      within(await manifestTable()).getByRole('link', { name: 'ACC-MF-Q92422' }),
    );
    await screen.findByRole('heading', { level: 1, name: heading });
    return view;
  }

  describe.each(REFUSALS)('a manifest %s', (_why, refused, heading) => {
    // Break caught: a refusal page with no way back, or one that forgot where the officer came from and gave the plain list.
    it('brings the officer back to the page they left, read again, by the link back of the refusal', async () => {
      const view = await toTheRefusedRecord(refused, heading);
      const back = await backLink();
      expect(back).toHaveAttribute('href', LISTED);
      const reads = listed().length;

      await view.user.click(back);

      expect(await screen.findByText(/on page 2/)).toBeVisible();
      expect(listed()).toHaveLength(reads + 1);
      expect(queryOf().get('page_token')).toBe('next-1');
      expect(queryOf().get('state')).toBe('DRAFT');
    });

    it('brings the officer back to the same page by the browser’s Back from the refusal', async () => {
      const view = await toTheRefusedRecord(refused, heading);

      await goBack(view);

      expect(await screen.findByText(/on page 2/)).toBeVisible();
      expect(queryOf().get('page_token')).toBe('next-1');
    });

    it('gives the plain list behind the link back when the manifest was reached with nothing left behind', async () => {
      const view = open(twoPages, RECORD_PATH, refused);
      await screen.findByRole('heading', { level: 1, name: heading });

      const back = await backLink();
      expect(back).toHaveAttribute('href', '/manifests');
      await view.user.click(back);

      expect(await manifestTable()).toBeVisible();
      expect(queryOf().has('page_token')).toBe(false);
    });

    it('says nothing of the manifest in the link: the filters of the list and no more', async () => {
      await toTheRefusedRecord(refused, heading);

      const href = (await backLink()).getAttribute('href') ?? '';

      expect(href).not.toContain(MANIFEST_ID);
      expect(href).not.toContain('ACC-MF');
      expect(document.body.textContent).not.toContain('ACC-MF-Q92422');
    });
  });

  // Break caught: a link offered by a key the list's own route does not ask for, so that the two drift apart and a session is led to a refusal.
  it('offers the link by the key of the list’s own route', () => {
    const list = SIGNED_IN_ROUTES.find((route) => route.path === '/manifests');

    expect(list?.access).toEqual({ permission: LIST_PERMISSION });
  });
});
