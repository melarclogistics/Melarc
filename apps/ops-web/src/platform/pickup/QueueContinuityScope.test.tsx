import { act, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject, type To } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionFixture } from '../../test-support/session-fixture';
import { SessionProvider } from '../session/SessionProvider';
import { SessionStore, type SessionView } from '../session/session-store';
import type { QueuePlace } from './queue-continuity';
import { useQueueContinuity, type QueueContinuityHandle } from './queue-continuity-context';
import { QueueContinuityScope } from './QueueContinuityScope';

/**
 * What the application remembers of where the pickup queue was left (COMPONENT_PATTERNS section 22f), as the screens meet it: given back on the
 * browser's Back and on the record's own link back, and on no other arrival; for one session, one set of hubs and one visit; in memory and
 * nowhere else.
 */
const REQUEST = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const OTHER_REQUEST = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
const SIGNATURE = 'PENDING|';
const QUEUE = '/pickup-requests?state=PENDING';
const RECORD = `/pickup-requests/${REQUEST}`;

const place = (overrides: Partial<QueuePlace> = {}): QueuePlace => ({
  signature: SIGNATURE,
  search: '?state=PENDING',
  tokens: ['token-two'],
  scrollY: 300,
  requestId: REQUEST,
  ...overrides,
});

/** The handle a screen under the scope is given, as of its last render. */
let handle: QueueContinuityHandle;

function Probe() {
  handle = useQueueContinuity();
  return <p>A screen</p>;
}

function mount(session: SessionView = sessionFixture()) {
  const store = new SessionStore();
  store.signedIn(session);
  const routes: RouteObject[] = [
    {
      element: <QueueContinuityScope />,
      children: [
        { path: '/pickup-requests', element: <Probe /> },
        { path: '/pickup-requests/:id', element: <Probe /> },
        { path: '/elsewhere', element: <Probe /> },
      ],
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [QUEUE] });
  render(
    <SessionProvider store={store}>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return { store, router };
}

const go = (router: ReturnType<typeof mount>['router'], to: To | number, state?: unknown) =>
  act(async () => {
    await (typeof to === 'number'
      ? router.navigate(to)
      : router.navigate(to, state === undefined ? undefined : { state }));
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the queue’s place: when it is given back', () => {
  it('brings the person back to where they left, on the browser’s Back', async () => {
    const { router } = mount();
    handle.leave(place());
    await go(router, RECORD);

    await go(router, -1);

    expect(handle.returningTo(SIGNATURE)).toEqual(place());
  });

  it('brings the person back by the record’s own link, which carries the filters and says it is a return', async () => {
    const { router } = mount();
    handle.leave(place());
    await go(router, RECORD);

    const back = handle.backTo(REQUEST);
    expect(back).toEqual({ search: '?state=PENDING', state: { queueReturn: true } });
    await go(router, { pathname: '/pickup-requests', search: back?.search ?? '' }, back?.state);

    expect(handle.returningTo(SIGNATURE)).toEqual(place());
  });

  // Break caught: a place given back to a person who came to the queue by the menu, a typed address or a link, which asked for the queue anew.
  it('gives nothing back to a person who comes to the queue any other way', async () => {
    const { router } = mount();
    handle.leave(place());
    await go(router, RECORD);

    await go(router, '/pickup-requests?state=PENDING');

    expect(handle.returningTo(SIGNATURE)).toBeUndefined();
  });

  it('gives nothing back for filters other than the ones the place was left under', async () => {
    const { router } = mount();
    handle.leave(place());
    await go(router, RECORD);
    await go(router, -1);

    expect(handle.returningTo('CONFIRMED|')).toBeUndefined();
  });

  it('offers a record the way back to its own place and to no other request’s', async () => {
    const { router } = mount();
    handle.leave(place());
    await go(router, RECORD);

    expect(handle.backTo(OTHER_REQUEST)).toBeUndefined();
    expect(handle.backTo(REQUEST.toUpperCase())).toBeDefined();
  });

  it('offers a record nothing when no place was left (a direct visit, a new tab, a reload)', async () => {
    const { router } = mount();
    await go(router, RECORD);

    expect(handle.backTo(REQUEST)).toBeUndefined();
  });
});

describe('the queue’s place: when it is let go of', () => {
  // Break caught: a place that outlives the visit, so that the queue opens at a page and a scroll position the person left days of work ago.
  it('lets go of the place when the person goes anywhere out of the visit to the request', async () => {
    const { router } = mount();
    handle.leave(place());
    await go(router, RECORD);

    await go(router, '/elsewhere');
    await go(router, -1);
    await go(router, -1);

    expect(handle.returningTo(SIGNATURE)).toBeUndefined();
    expect(handle.backTo(REQUEST)).toBeUndefined();
  });

  it('lets go of the place for another request: the visit is to one', async () => {
    const { router } = mount();
    handle.leave(place());

    await go(router, `/pickup-requests/${OTHER_REQUEST}`);

    expect(handle.backTo(REQUEST)).toBeUndefined();
    expect(handle.backTo(OTHER_REQUEST)).toBeUndefined();
  });

  it('lets go of the place on request', async () => {
    const { router } = mount();
    handle.leave(place());
    await go(router, RECORD);

    handle.discard();

    expect(handle.backTo(REQUEST)).toBeUndefined();
  });

  // Break caught: a place left under one session shown to the next, which would carry one person's working position to another.
  it('lets go of the place when another session replaces this one', async () => {
    const { router, store } = mount();
    handle.leave(place());
    await go(router, RECORD);

    act(() => {
      store.signedIn(sessionFixture({ id: 'a1b2c3d4-0000-4000-8000-000000000009' }));
    });

    expect(handle.backTo(REQUEST)).toBeUndefined();
    await go(router, -1);
    expect(handle.returningTo(SIGNATURE)).toBeUndefined();
  });

  it('lets go of the place when the hubs the session acts in change', async () => {
    const { router, store } = mount();
    handle.leave(place());
    await go(router, RECORD);

    act(() => {
      store.signedIn(
        sessionFixture({
          authorized_hubs: [
            { id: 'a1b2c3d4-0000-4000-8000-0000000000b9', display_name: 'Another Hub' },
          ],
        }),
      );
    });

    expect(handle.backTo(REQUEST)).toBeUndefined();
  });

  // Break caught: a session that ends and comes back as the same one, finding the place it left.
  it('lets go of the place when the session ends, and does not find it when the same person signs in again', async () => {
    const { router, store } = mount();
    handle.leave(place());
    await go(router, RECORD);

    act(() => {
      store.end();
    });
    handle.leave(place());
    act(() => {
      store.signedIn(sessionFixture());
    });

    expect(handle.backTo(REQUEST)).toBeUndefined();
    await go(router, -1);
    expect(handle.returningTo(SIGNATURE)).toBeUndefined();
  });
});

describe('the queue’s place: where it is kept', () => {
  // Break caught: a place written to a storage or to the address, which would outlive the page and could be read by another script or person.
  it('writes it to no storage, no cookie and no address', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = document.cookie;
    const { router } = mount();

    handle.leave(place());
    await go(router, RECORD);
    const back = handle.backTo(REQUEST);
    await go(router, { pathname: '/pickup-requests', search: back?.search ?? '' }, back?.state);

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe(cookie);
    expect(router.state.location.search).toBe('?state=PENDING');
    expect(router.state.location.hash).toBe('');
    expect(JSON.stringify(router.state.location)).not.toContain('token-two');
  });
});

describe('the queue’s place: a screen outside the scope', () => {
  it('is given an inert handle: it leaves nothing, finds nothing and offers no way back', () => {
    const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
      initialEntries: [QUEUE],
    });
    render(<RouterProvider router={router} />);

    handle.leave(place());
    handle.discard();

    expect(handle.returningTo(SIGNATURE)).toBeUndefined();
    expect(handle.backTo(REQUEST)).toBeUndefined();
  });
});
