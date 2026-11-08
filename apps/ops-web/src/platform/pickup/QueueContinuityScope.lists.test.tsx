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
 * What the application remembers of where each list was left (COMPONENT_PATTERNS section 22f), for the pickup queue and for the manifest list: one
 * place for each, given back on the browser's Back and on the record's own link back and on no other arrival, for one session, one set of hubs
 * and one visit, in memory and nowhere else. The two lists do not share a place: what is left for one is never offered to the other.
 */
const MANIFEST = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const OTHER_MANIFEST = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
const REQUEST = '2c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f';
// Both lists filter by the same two things, so the same filters make the same signature in each: only the list keeps the places apart.
const SIGNATURE = 'DRAFT|';
const LIST = '/manifests?state=DRAFT';
const RECORD = `/manifests/${MANIFEST}`;
const QUEUE = '/pickup-requests?state=DRAFT';
const QUEUE_RECORD = `/pickup-requests/${REQUEST}`;

const manifestPlace = (overrides: Partial<QueuePlace> = {}): QueuePlace => ({
  signature: SIGNATURE,
  search: '?state=DRAFT',
  tokens: ['token-two'],
  scrollY: 300,
  requestId: MANIFEST,
  ...overrides,
});
const requestPlace = (overrides: Partial<QueuePlace> = {}): QueuePlace =>
  manifestPlace({ tokens: ['token-nine'], scrollY: 90, requestId: REQUEST, ...overrides });

/** The handles a screen under the scope is given, as of its last render: one for each list. */
let manifests: QueueContinuityHandle;
let requests: QueueContinuityHandle;

function Probe() {
  manifests = useQueueContinuity('manifests');
  requests = useQueueContinuity();
  return <p>A screen</p>;
}

function mount(session: SessionView = sessionFixture(), initial = LIST) {
  const store = new SessionStore();
  store.signedIn(session);
  const routes: RouteObject[] = [
    {
      element: <QueueContinuityScope />,
      children: [
        { path: '/manifests', element: <Probe /> },
        { path: '/manifests/new', element: <Probe /> },
        { path: '/manifests/:id', element: <Probe /> },
        { path: '/manifests/:id/stops/:stop/skip', element: <Probe /> },
        { path: '/pickup-requests', element: <Probe /> },
        { path: '/pickup-requests/:id', element: <Probe /> },
        { path: '/elsewhere', element: <Probe /> },
      ],
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [initial] });
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

describe('the manifest list’s place: when it is given back', () => {
  it('brings the person back to where they left, on the browser’s Back', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    await go(router, -1);

    expect(manifests.returningTo(SIGNATURE)).toEqual(manifestPlace());
  });

  it('brings the person back by the manifest’s own link, which carries the filters and says it is a return', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    const back = manifests.backTo(MANIFEST);
    expect(back).toEqual({ search: '?state=DRAFT', state: { queueReturn: true } });
    await go(router, { pathname: '/manifests', search: back?.search ?? '' }, back?.state);

    expect(manifests.returningTo(SIGNATURE)).toEqual(manifestPlace());
  });

  // Break caught: a place given back to a person who came to the list by the menu, a typed address or a link, which asked for the list anew.
  it('gives nothing back to a person who comes to the list any other way', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    await go(router, LIST);

    expect(manifests.returningTo(SIGNATURE)).toBeUndefined();
  });

  it('gives nothing back for filters other than the ones the place was left under', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);
    await go(router, -1);

    expect(manifests.returningTo('CANCELLED|')).toBeUndefined();
  });

  it('offers a manifest the way back to its own place and to no other manifest’s', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    expect(manifests.backTo(OTHER_MANIFEST)).toBeUndefined();
    expect(manifests.backTo(MANIFEST.toUpperCase())).toBeDefined();
  });

  it('offers a manifest nothing when no place was left (a direct visit, a new tab, a reload)', async () => {
    const { router } = mount();
    await go(router, RECORD);

    expect(manifests.backTo(MANIFEST)).toBeUndefined();
  });

  it('keeps the place while the person is on a stop of the manifest, and gives it back from there', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);
    await go(router, `${RECORD}/stops/${OTHER_MANIFEST}/skip`);

    expect(manifests.backTo(MANIFEST)).toBeDefined();
    await go(router, -2);
    expect(manifests.returningTo(SIGNATURE)).toEqual(manifestPlace());
  });
});

describe('the manifest list’s place: when it is let go of', () => {
  // Break caught: a place that outlives the visit, so that the list opens at a page and a scroll position the person left days of work ago.
  it('lets go of the place when the person goes anywhere out of the visit to the manifest', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    await go(router, '/elsewhere');
    await go(router, -1);
    await go(router, -1);

    expect(manifests.returningTo(SIGNATURE)).toBeUndefined();
    expect(manifests.backTo(MANIFEST)).toBeUndefined();
  });

  it('lets go of the place for the building of a new manifest and for another manifest', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, '/manifests/new');
    expect(manifests.backTo(MANIFEST)).toBeUndefined();

    manifests.leave(manifestPlace());
    await go(router, `/manifests/${OTHER_MANIFEST}`);
    expect(manifests.backTo(MANIFEST)).toBeUndefined();
    expect(manifests.backTo(OTHER_MANIFEST)).toBeUndefined();
  });

  it('lets go of the place on request', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    manifests.discard();

    expect(manifests.backTo(MANIFEST)).toBeUndefined();
  });

  // Break caught: a place left under one session shown to the next, which would carry one person's working position to another.
  it('lets go of the place when another session replaces this one', async () => {
    const { router, store } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    act(() => {
      store.signedIn(sessionFixture({ id: 'a1b2c3d4-0000-4000-8000-000000000009' }));
    });

    expect(manifests.backTo(MANIFEST)).toBeUndefined();
    await go(router, -1);
    expect(manifests.returningTo(SIGNATURE)).toBeUndefined();
  });

  it('lets go of the place when the hubs the session acts in change', async () => {
    const { router, store } = mount();
    manifests.leave(manifestPlace());
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

    expect(manifests.backTo(MANIFEST)).toBeUndefined();
  });

  // Break caught: a session that ends and comes back as the same one, finding the place it left.
  it('lets go of the place when the session ends, and does not find it when the same person signs in again', async () => {
    const { router, store } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    act(() => {
      store.end();
    });
    manifests.leave(manifestPlace());
    act(() => {
      store.signedIn(sessionFixture());
    });

    expect(manifests.backTo(MANIFEST)).toBeUndefined();
    await go(router, -1);
    expect(manifests.returningTo(SIGNATURE)).toBeUndefined();
  });
});

describe('the two lists’ places: each its own', () => {
  // Break caught: one store for both lists, so that the same filters in the other list are taken for the place that was left in this one.
  it('never offers the manifest list a place left in the pickup queue', async () => {
    const { router } = mount(sessionFixture(), QUEUE);
    requests.leave(requestPlace());
    await go(router, QUEUE_RECORD);

    await go(router, -1);

    expect(requests.returningTo(SIGNATURE)).toEqual(requestPlace());
    expect(manifests.returningTo(SIGNATURE)).toBeUndefined();
    expect(manifests.backTo(REQUEST)).toBeUndefined();
  });

  it('never offers the pickup queue a place left in the manifest list', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    await go(router, RECORD);

    await go(router, -1);

    expect(manifests.returningTo(SIGNATURE)).toEqual(manifestPlace());
    expect(requests.returningTo(SIGNATURE)).toBeUndefined();
    expect(requests.backTo(MANIFEST)).toBeUndefined();
  });

  it('keeps a place for each list at once, and letting go of one leaves the other', () => {
    mount();
    manifests.leave(manifestPlace());
    requests.leave(requestPlace());

    manifests.discard();
    expect(manifests.backTo(MANIFEST)).toBeUndefined();
    expect(requests.backTo(REQUEST)).toBeDefined();

    manifests.leave(manifestPlace());
    requests.discard();
    expect(requests.backTo(REQUEST)).toBeUndefined();
    expect(manifests.backTo(MANIFEST)).toBeDefined();
  });

  // Break caught: the visit of one list ending the place of the other, or failing to end its own.
  it('ends each place with its own list’s visit', async () => {
    const { router } = mount();
    manifests.leave(manifestPlace());
    requests.leave(requestPlace());

    await go(router, QUEUE_RECORD);

    expect(manifests.backTo(MANIFEST)).toBeUndefined();
    expect(requests.backTo(REQUEST)).toBeDefined();

    await go(router, RECORD);
    expect(requests.backTo(REQUEST)).toBeUndefined();
  });

  // Break caught: one of the two stores left out of the clearing, so that what one person left is found by the next.
  it('lets go of both places whenever whose they are changes, even if the same person comes back', () => {
    const { store } = mount();
    manifests.leave(manifestPlace());
    requests.leave(requestPlace());

    act(() => {
      store.signedIn(sessionFixture({ id: 'a1b2c3d4-0000-4000-8000-000000000009' }));
    });
    act(() => {
      store.signedIn(sessionFixture());
    });

    expect(manifests.backTo(MANIFEST)).toBeUndefined();
    expect(requests.backTo(REQUEST)).toBeUndefined();
  });
});

describe('the manifest list’s place: where it is kept', () => {
  // Break caught: a place written to a storage or to the address, which would outlive the page and could be read by another script or person.
  it('writes it to no storage, no cookie and no address', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = document.cookie;
    const { router } = mount();

    manifests.leave(manifestPlace());
    await go(router, RECORD);
    const back = manifests.backTo(MANIFEST);
    await go(router, { pathname: '/manifests', search: back?.search ?? '' }, back?.state);

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe(cookie);
    expect(router.state.location.search).toBe('?state=DRAFT');
    expect(router.state.location.hash).toBe('');
    expect(JSON.stringify(router.state.location)).not.toContain('token-two');
  });
});

describe('the manifest list’s place: a screen outside the scope', () => {
  it('is given an inert handle: it leaves nothing, finds nothing and offers no way back', () => {
    const router = createMemoryRouter([{ path: '*', element: <Probe /> }], {
      initialEntries: [LIST],
    });
    render(<RouterProvider router={router} />);

    manifests.leave(manifestPlace());
    manifests.discard();

    expect(manifests.returningTo(SIGNATURE)).toBeUndefined();
    expect(manifests.backTo(MANIFEST)).toBeUndefined();
  });
});
