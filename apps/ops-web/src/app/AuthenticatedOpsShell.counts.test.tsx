import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  json,
  signedInApi,
  type FakeApi,
} from '../test-support/fake-api';
import { renderApp } from '../test-support/render-app';
import { sessionFixture } from '../test-support/session-fixture';
import { wcagViolations } from '../test-support/wcag';
import { ANY_SIGNED_IN_SESSION, type SignedInRoute } from './navigation/route-registry';

/**
 * The counts beside the menu's entries (task C1; `AC-QSUM-07`, `AC-QSUM-09`): the shell reads the queue summary and draws the count of a queue
 * beside the entry of that queue, and nothing beside any other. A count that is loading, missing or failed is not drawn, and is never `0`; the
 * menu works whatever the summary does.
 */
let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const page = (name: string) => (
  <>
    <h1 tabIndex={-1}>{name}</h1>
    <p>The {name} page</p>
  </>
);

/** Routes that exist only in these tests: three entries that carry a queue and one that does not. None is a route of the product. */
const REGISTRY: readonly SignedInRoute[] = [
  {
    path: '/',
    element: page('Melarc Ops Portal'),
    access: ANY_SIGNED_IN_SESSION,
    menu: { place: 'sidebar', group: 'today', label: 'Home', icon: 'my-work', order: 0 },
  },
  {
    path: '/pickup-requests',
    element: page('Pickup requests'),
    access: { permission: 'pickup.read' },
    menu: {
      place: 'sidebar',
      group: 'pickups',
      label: 'Pickup requests',
      icon: 'pickup-requests',
      order: 0,
      queue: 'PICKUP_AWAITING_CONFIRMATION',
    },
  },
  {
    path: '/manifests',
    element: page('Manifests'),
    access: { permission: 'pickup.read' },
    menu: {
      place: 'sidebar',
      group: 'pickups',
      label: 'Manifests',
      icon: 'manifests',
      order: 1,
      queue: 'PICKUP_RUNS_IN_PROGRESS',
    },
  },
  {
    path: '/admin/staff',
    element: page('Staff'),
    access: { permission: 'staff.read' },
    menu: {
      place: 'sidebar',
      group: 'people',
      label: 'Staff',
      icon: 'staff',
      order: 0,
      queue: 'STAFF_AWAITING_APPROVAL',
    },
  },
  {
    path: '/admin/vendors',
    element: page('Vendors'),
    access: { permission: 'vendor.read' },
    menu: { place: 'sidebar', group: 'people', label: 'Vendors', icon: 'vendors', order: 1 },
  },
];

const KEYS = ['pickup.read', 'staff.read', 'vendor.read'];
const signInStandIn = [{ path: 'sign-in', element: <h1 tabIndex={-1}>Sign-in stand-in</h1> }];
const SUMMARY = 'GET /ops/queue-summary';

interface Counted {
  readonly queue: string;
  readonly count: number;
  readonly oldest_at?: string;
}
const WHEN = '2026-11-02T09:00:00.000Z';

function open(
  handler: (request: Request) => Response | Promise<Response>,
  path = '/',
  hubs?: readonly { id: string; display_name: string }[],
) {
  api = installFakeApi({
    ...signedInApi(
      sessionFixture({
        permissions: [...KEYS],
        ...(hubs === undefined ? {} : { authorized_hubs: [...hubs] }),
      }),
    ),
    [SUMMARY]: handler,
  });
  return renderApp(path, signInStandIn, REGISTRY);
}

const navigation = () => screen.getByRole('navigation', { name: 'Primary' });
const link = (name: string | RegExp) => within(navigation()).getByRole('link', { name });
const badges = () => navigation().querySelectorAll('.ui-count-badge');
const summaryReads = () =>
  api.requests.filter((request) => request.url.includes('/ops/queue-summary')).length;

const answer = (queues: readonly Counted[]) => () => json(200, { queues });

describe('the counts beside the entries of the menu', () => {
  // Break caught: a count beside the wrong entry, a count beside an entry of no queue, or a queue the summary holds drawn nowhere.
  it('draws the count of a queue beside the entry of that queue and beside no other', async () => {
    open(
      answer([
        { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 5, oldest_at: WHEN },
        { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 2, oldest_at: WHEN },
        { queue: 'STAFF_AWAITING_APPROVAL', count: 12, oldest_at: WHEN },
      ]),
    );

    await waitFor(() => {
      expect(badges()).toHaveLength(3);
    });
    expect(
      within(link(/^Pickup requests/)).getByText('5', { selector: '[aria-hidden]' }),
    ).toBeVisible();
    expect(within(link(/^Manifests/)).getByText('2', { selector: '[aria-hidden]' })).toBeVisible();
    expect(within(link(/^Staff/)).getByText('12', { selector: '[aria-hidden]' })).toBeVisible();
    expect(link('Vendors').querySelector('.ui-count-badge')).toBeNull();
    expect(link('Home').querySelector('.ui-count-badge')).toBeNull();
  });

  // Break caught: the count and the words of what it counts not reaching a screen reader, which would hear "Manifests" and nothing of the 2.
  it('says what each number counts, in the name of the entry', async () => {
    open(
      answer([
        { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 5, oldest_at: WHEN },
        { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 2, oldest_at: WHEN },
        { queue: 'STAFF_AWAITING_APPROVAL', count: 12, oldest_at: WHEN },
      ]),
    );

    expect(
      await screen.findByRole('link', { name: 'Pickup requests 5 waiting for confirmation' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Manifests 2 in progress' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Staff 12 waiting for approval' })).toBeVisible();
  });

  // Break caught: a queue the session was not given drawn as a 0 (an absence told as "nothing waiting").
  it('draws nothing beside an entry whose queue the summary does not hold, and not a 0', async () => {
    open(answer([{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 3, oldest_at: WHEN }]));

    await waitFor(() => {
      expect(badges()).toHaveLength(1);
    });
    expect(link(/^Manifests/).textContent).toBe('Manifests');
    expect(link(/^Staff/).textContent).toBe('Staff');
  });

  // Break caught: the count of a real 0 hidden as though it were missing, or drawn as work.
  it('draws a count of 0 that was read, quietly', async () => {
    open(answer([{ queue: 'STAFF_AWAITING_APPROVAL', count: 0 }]));

    await waitFor(() => {
      expect(badges()).toHaveLength(1);
    });
    expect(badges()[0]).toHaveAttribute('data-quiet', 'true');
    expect(screen.getByRole('link', { name: 'Staff 0 waiting for approval' })).toBeVisible();
  });

  // Break caught: a 0 drawn while the first read is on its way.
  it('draws nothing while the summary is being read', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open(async () => {
      await held;
      return json(200, {
        queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 4, oldest_at: WHEN }],
      });
    });

    await screen.findByRole('navigation', { name: 'Primary' });
    expect(badges()).toHaveLength(0);
    expect(navigation().textContent).not.toMatch(/\b0\b/);

    await act(async () => {
      release();
      await held;
    });
    await waitFor(() => {
      expect(badges()).toHaveLength(1);
    });
  });

  // Break caught: a failed read breaking the menu, drawing a stand-in figure, or taking the entries away.
  it('draws nothing when the summary could not be read, and leaves the menu as it is', async () => {
    open(() => errorResponse(500, 'INTERNAL_ERROR'));

    await screen.findByRole('navigation', { name: 'Primary' });
    await waitFor(() => {
      expect(summaryReads()).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(badges()).toHaveLength(0);
    expect(
      within(navigation())
        .getAllByRole('link')
        .map((each) => each.textContent),
    ).toEqual(['Home', 'Pickup requests', 'Manifests', 'Staff', 'Vendors']);
    expect(document.body.textContent).not.toMatch(/INTERNAL_ERROR|Diagnostic text/);
  });

  // Break caught (the review of C1): a read that fails after one that worked leaving the counts of the first on every page, which then say what
  // was true before the failure (TanStack Query keeps the last answer beside the error). A count that failed is not drawn.
  it('draws nothing once a later read fails, and the counts come back with the next read that works', async () => {
    let reads = 0;
    const { user } = open(() => {
      reads += 1;
      if (reads === 2) return errorResponse(500, 'INTERNAL_ERROR');
      return json(200, {
        queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: reads * 10, oldest_at: WHEN }],
      });
    });
    expect(
      await screen.findByRole('link', { name: 'Pickup requests 10 waiting for confirmation' }),
    ).toBeVisible();

    await user.click(link(/^Manifests/));

    await waitFor(() => {
      expect(reads).toBe(2);
    });
    await waitFor(() => {
      expect(badges()).toHaveLength(0);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Manifests' })).toBeVisible();
    expect(link(/^Pickup requests/).textContent).toBe('Pickup requests');

    await user.click(link(/^Staff/));

    expect(
      await screen.findByRole('link', { name: 'Pickup requests 30 waiting for confirmation' }),
    ).toBeVisible();
  });

  // Break caught: an answer that is not a summary drawn as counts.
  it('draws nothing for an answer that is not a summary', async () => {
    open(() => json(200, { queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 'many' }] }));

    await screen.findByRole('navigation', { name: 'Primary' });
    await waitFor(() => {
      expect(summaryReads()).toBe(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(badges()).toHaveLength(0);
  });

  // Break caught: a queue of a newer server drawn with an identifier, or taking the other counts away.
  it('keeps the counts it has words for when the server names a queue it has none for', async () => {
    open(
      answer([
        { queue: 'A_QUEUE_FROM_THE_FUTURE', count: 9, oldest_at: WHEN },
        { queue: 'STAFF_AWAITING_APPROVAL', count: 2, oldest_at: WHEN },
      ]),
    );

    await waitFor(() => {
      expect(badges()).toHaveLength(1);
    });
    expect(navigation().textContent).not.toMatch(/FUTURE|9/);
  });
});

describe('when the counts are read (AC-QSUM-09)', () => {
  // Break caught: the counts of the moment the shell opened shown beside every page the person goes to afterwards.
  it('are read again when the person goes to another page, and the figures follow', async () => {
    let reads = 0;
    const { user } = open(() => {
      reads += 1;
      return json(200, {
        queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: reads * 10, oldest_at: WHEN }],
      });
    });
    expect(
      await screen.findByRole('link', { name: 'Pickup requests 10 waiting for confirmation' }),
    ).toBeVisible();

    await user.click(link(/^Manifests/));

    expect(
      await screen.findByRole('link', { name: 'Pickup requests 20 waiting for confirmation' }),
    ).toBeVisible();
    expect(reads).toBe(2);
    expect(await screen.findByRole('heading', { level: 1, name: 'Manifests' })).toBeVisible();
  });

  // Break caught: the page it starts at read twice, once for the shell and once for a "return" that is not one.
  it('is read once for the page the shell starts at', async () => {
    open(answer([{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 1, oldest_at: WHEN }]));

    await waitFor(() => {
      expect(badges()).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(summaryReads()).toBe(1);
  });

  // Break caught: a filter on the page a person is on counted as returning to a page.
  it('is not read again for a change of the query string alone', async () => {
    const { router } = open(
      answer([{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 1, oldest_at: WHEN }]),
      '/pickup-requests',
    );
    await waitFor(() => {
      expect(badges()).toHaveLength(1);
    });

    await act(async () => {
      await router.navigate('/pickup-requests?state=PENDING');
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(summaryReads()).toBe(1);
  });
});

describe('the counts follow the hub switcher (task C3)', () => {
  const ACCRA = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' };
  const KUMASI = { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Kumasi Hub' };
  const countsOf = (request: Request) => {
    const hub = new URL(request.url).searchParams.get('hub_id');
    const count = hub === ACCRA.id ? 2 : hub === KUMASI.id ? 3 : 5;
    return json(200, {
      queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count, oldest_at: WHEN }],
    });
  };
  const switcher = (name: string) =>
    within(screen.getByRole('banner')).getByRole('button', { name: `Hub: ${name}` });

  // Break caught: counts that do not follow the switcher: the menu says Kumasi Hub and draws the figures of every hub, or the figures of the hub
  // that was left.
  it('draws the counts of the hub chosen beside the entries, and those of every hub for All hubs', async () => {
    const { user } = open(countsOf, '/', [ACCRA, KUMASI]);
    expect(
      await screen.findByRole('link', { name: 'Pickup requests 5 waiting for confirmation' }),
    ).toBeVisible();

    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));
    expect(
      await screen.findByRole('link', { name: 'Pickup requests 3 waiting for confirmation' }),
    ).toBeVisible();

    await user.click(switcher('Kumasi Hub'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'All hubs' }));
    expect(
      await screen.findByRole('link', { name: 'Pickup requests 5 waiting for confirmation' }),
    ).toBeVisible();
  });

  // Break caught: the count of the hub that was left kept beside the entry while the count of the hub chosen is read, which is one hub's figure
  // under another's name.
  it('draws no count while the counts of the hub chosen are read, and not those of the hub that was left', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { user } = open(
      async (request) => {
        if (new URL(request.url).searchParams.has('hub_id')) await gate;
        return countsOf(request);
      },
      '/',
      [ACCRA, KUMASI],
    );
    await screen.findByRole('link', { name: 'Pickup requests 5 waiting for confirmation' });

    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

    await waitFor(() => {
      expect(badges()).toHaveLength(0);
    });
    expect(screen.queryByRole('link', { name: /waiting for confirmation/ })).toBeNull();
    release();
    expect(
      await screen.findByRole('link', { name: 'Pickup requests 3 waiting for confirmation' }),
    ).toBeVisible();
  });
});

describe('the menu with counts', () => {
  // Break caught: the badge costing the menu its accessibility.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const view = open(
      answer([
        { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 5, oldest_at: WHEN },
        { queue: 'STAFF_AWAITING_APPROVAL', count: 0 },
      ]),
    );
    await waitFor(() => {
      expect(badges()).toHaveLength(2);
    });

    expect(await wcagViolations(view.container)).toEqual([]);
  });
});
