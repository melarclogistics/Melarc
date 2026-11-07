import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  json,
  signedInApi,
  type FakeApi,
} from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';
import { sessionFixture } from '../../../test-support/session-fixture';
import { KEYS, refusal, sessionWith, staffApi } from '../../../test-support/staff-api';
import { wcagViolations } from '../../../test-support/wcag';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const SUMMARY = 'GET /ops/queue-summary';

interface Counted {
  readonly queue: string;
  readonly count: number;
  readonly oldest_at?: string;
}

/** The summary as the server answers it for a session: the queues it may read, with their counts and the moment each oldest entered it. */
const summary = (queues: readonly Counted[]) => () => json(200, { queues });

/** An officer's queues: five of the six, at the moments given. */
const OFFICER: readonly Counted[] = [
  { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 5, oldest_at: '2026-11-03T08:00:00.000Z' },
  { queue: 'PICKUP_CUTOFF_REVIEW', count: 1, oldest_at: '2026-10-30T08:00:00.000Z' },
  { queue: 'PICKUP_EXCEPTION_APPROVAL', count: 3, oldest_at: '2026-11-01T14:30:00.000Z' },
  { queue: 'PICKUP_UNMANIFESTED_POOL', count: 4, oldest_at: '2026-10-31T09:05:00.000Z' },
  { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 2, oldest_at: '2026-11-05T07:00:00.000Z' },
];

/** My work as a person who holds `keys` opens it, and the server answers the summary as given. */
function open(
  keys: readonly string[],
  queues: readonly Counted[] = [],
  handlers: Parameters<typeof staffApi>[1] = {},
  name = 'Ama Mensah',
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { principal_display_name: name }), {
      [SUMMARY]: summary(queues),
      ...handlers,
    }),
  );
  return renderApp('/');
}

/** The cards of "Waiting for you", in the order drawn. */
async function cards() {
  const list = await screen.findByRole('list', { name: 'Waiting for you' });
  return within(list).getAllByRole('listitem');
}

const titleOf = (card: HTMLElement) => within(card).getByRole('link').textContent;

describe('My work: what is waiting', () => {
  // Break caught: a page that lists what its keys suggest and not what the server counted, or that leaves a queue out.
  it('has a card for each queue that has something in it, with its name as a link to the set that was counted', async () => {
    open(KEYS.approver, OFFICER);

    const links = await screen.findAllByRole('link', {
      name: /waiting for|not yet on a run|runs in progress/,
    });
    const asked = Object.fromEntries(
      links.map((link) => [link.textContent, link.getAttribute('href')]),
    );

    expect(asked).toEqual({
      'Pickup requests waiting for confirmation': '/pickup-requests?state=PENDING',
      'Late bookings waiting for a cut-off decision':
        '/pickup-requests?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
      'One-package exceptions waiting for approval': '/approvals',
      'Confirmed pickups not yet on a run': '/pickup-requests?state=CONFIRMED',
      'Pickup runs in progress': '/manifests?state=IN_PROGRESS',
    });
  });

  // Break caught: the queue that has waited longest drawn below one that has waited a day.
  it('puts the queue whose oldest record has waited longest first', async () => {
    open(KEYS.approver, OFFICER);

    const items = await cards();

    expect(items.map(titleOf)).toEqual([
      'Late bookings waiting for a cut-off decision',
      'Confirmed pickups not yet on a run',
      'One-package exceptions waiting for approval',
      'Pickup requests waiting for confirmation',
      'Pickup runs in progress',
    ]);
  });

  // Break caught: the count of a queue drawn with the wrong queue, a number that is not the server's, or one a screen reader says twice.
  it('draws the count the server gave for each queue, large, and tells it once to a screen reader with what it counts', async () => {
    open(KEYS.approver, OFFICER);

    const items = await cards();
    const figures = Object.fromEntries(
      items.map((item) => [
        titleOf(item),
        [
          item.querySelector('.my-work-card__figure > [aria-hidden="true"]')?.textContent,
          item.querySelector('.my-work-card__meaning')?.textContent,
        ],
      ]),
    );

    expect(figures).toEqual({
      'Pickup requests waiting for confirmation': ['5', '5 waiting for confirmation'],
      'Late bookings waiting for a cut-off decision': [
        '1',
        '1 late bookings waiting for a decision',
      ],
      'One-package exceptions waiting for approval': ['3', '3 waiting for approval'],
      'Confirmed pickups not yet on a run': ['4', '4 confirmed and not yet on a run'],
      'Pickup runs in progress': ['2', '2 in progress'],
    });
  });

  // Break caught: "since when" shown as a number of days (no bucket or target is defined), in the machine's zone, or not at all.
  it('says since when the oldest has waited, as a moment in the portal’s time and never as a number of days', async () => {
    open(KEYS.approver, OFFICER);

    const items = await cards();

    expect(items[0]).toHaveTextContent('Oldest since 30 Oct, 08:00');
    expect(items[3]).toHaveTextContent('Oldest since 3 Nov, 08:00');
    for (const item of items) expect(item.textContent).not.toMatch(/\bday|ago\b/i);
  });

  // Break caught: a queue with nothing in it given a card (a figure of 0 that reads as work), or left out (the person cannot tell it was read).
  it('puts the queues that are clear in one quiet line and gives them no card', async () => {
    open(KEYS.approver, [
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 2, oldest_at: '2026-11-02T10:00:00.000Z' },
      { queue: 'PICKUP_RUNS_IN_PROGRESS', count: 0 },
    ]);

    const items = await cards();

    expect(items.map(titleOf)).toEqual(['Staff profiles waiting for approval']);
    expect(
      screen.getByText(
        'Also clear: Late bookings waiting for a cut-off decision, Pickup runs in progress.',
      ),
    ).toBeVisible();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
  });

  it('draws no line of clear queues when none is clear', async () => {
    open(KEYS.approver, [
      { queue: 'STAFF_AWAITING_APPROVAL', count: 2, oldest_at: '2026-11-02T10:00:00.000Z' },
    ]);

    await cards();

    expect(screen.queryByText(/Also clear/)).toBeNull();
  });

  // Break caught: the pool sending a person to a page that refuses them.
  it('sends the pool to the run builder for a session that may build a run', async () => {
    open(
      ['pickup.read', 'pickup.manifest.create'],
      [{ queue: 'PICKUP_UNMANIFESTED_POOL', count: 2, oldest_at: '2026-11-02T10:00:00.000Z' }],
    );

    expect(
      await screen.findByRole('link', { name: 'Confirmed pickups not yet on a run' }),
    ).toHaveAttribute('href', '/manifests/new');
  });

  it('sends the pool to the confirmed pickups for a session that may not build a run', async () => {
    open(
      ['pickup.read'],
      [{ queue: 'PICKUP_UNMANIFESTED_POOL', count: 2, oldest_at: '2026-11-02T10:00:00.000Z' }],
    );

    expect(
      await screen.findByRole('link', { name: 'Confirmed pickups not yet on a run' }),
    ).toHaveAttribute('href', '/pickup-requests?state=CONFIRMED');
  });

  // Break caught: the approver's queue read through the staff list instead of the summary (a second source of truth for the same number).
  it('reads the summary and nothing else for what is waiting', async () => {
    open(KEYS.approver, [
      { queue: 'STAFF_AWAITING_APPROVAL', count: 3, oldest_at: '2026-11-02T10:00:00.000Z' },
    ]);

    await screen.findByRole('link', { name: 'Staff profiles waiting for approval' });

    expect(api.requests.some((request) => request.url.includes('/staff-identities'))).toBe(false);
    expect(api.requests.some((request) => request.url.includes('/ops/queue-summary'))).toBe(true);
  });

  // Break caught: "Nothing is waiting" for a session the page never looked at, because its keys do not suggest a queue.
  it('says nothing is waiting only when the summary was read and every count it returned is 0', async () => {
    open(KEYS.reader, [
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
    ]);

    expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
    expect(screen.queryByRole('link', { name: /waiting for/ })).toBeNull();
    expect(screen.queryByText(/Also clear/)).toBeNull();
  });

  // Break caught: "Nothing is waiting" said from zeros when the server also named a queue this page has no words for, which holds seven.
  it('does not say nothing is waiting when the server named a queue the page cannot show', async () => {
    open(KEYS.reader, [
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 },
      { queue: 'A_QUEUE_FROM_THE_FUTURE', count: 7, oldest_at: '2026-11-03T08:00:00.000Z' },
    ]);

    expect(await screen.findByText('Some queues cannot be shown on this page.')).toBeVisible();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
  });

  // Break caught: the same, when every queue named is one the page cannot show.
  it('says that queues are not shown when every queue the server named is one it cannot show', async () => {
    open(KEYS.reader, [
      { queue: 'A_QUEUE_FROM_THE_FUTURE', count: 7, oldest_at: '2026-11-03T08:00:00.000Z' },
    ]);

    expect(await screen.findByText('Some queues cannot be shown on this page.')).toBeVisible();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
  });

  // Break caught: "Nothing is waiting" for a session the server gave no queue to, which tells it something the page does not know.
  it('says nothing of waiting to a session the summary gave no queue, and still says who is signed in', async () => {
    open(KEYS.reader, []);

    // The heading stands while the summary is being read and goes when it was read and held no queue: wait for that, and for nothing less.
    await waitFor(() => {
      expect(api.requests.some((request) => request.url.includes('/ops/queue-summary'))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 2, name: 'Waiting for you' })).toBeNull();
    });

    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    expect(within(screen.getByRole('main')).getByText('Ama Mensah')).toBeVisible();
  });

  // Break caught: a count drawn as a zero while it is still being read, or a claim made before the answer.
  it('draws skeletons and no figure, and claims nothing, until the summary has been read', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open(KEYS.approver, undefined, {
      [SUMMARY]: async () => {
        await held;
        return json(200, { queues: OFFICER });
      },
    });

    expect(await screen.findByText('Checking what is waiting…')).toBeVisible();
    const main = screen.getByRole('main');
    expect(main.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(0);
    expect(main.querySelector('.my-work__cards--loading')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    expect(screen.queryByRole('link', { name: /waiting for/ })).toBeNull();
    expect(main.textContent).not.toMatch(/\b0\b/);
    await act(async () => {
      release();
      await held;
    });
    expect(
      await screen.findByRole('link', { name: 'Pickup requests waiting for confirmation' }),
    ).toBeVisible();
    expect(main.querySelector('.my-work__cards--loading')).toBeNull();
  });

  // Break caught: a failed read taking the page with it, or being read as "nothing is waiting".
  it('says the summary could not be read and offers to try again, keeping the rest of the page', async () => {
    let answers = 0;
    const { user } = open(KEYS.approver, undefined, {
      [SUMMARY]: () => {
        answers += 1;
        return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : json(200, { queues: OFFICER });
      },
    });

    expect(
      await screen.findByText('The summary of what is waiting could not be read.'),
    ).toBeVisible();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/INTERNAL_ERROR|Diagnostic text/);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('link', { name: 'Pickup requests waiting for confirmation' }),
    ).toBeVisible();
    expect(answers).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('The summary of what is waiting could not be read.')).toBeNull();
  });

  // Break caught: an answer that is not a summary drawn as one (a proxy's `{}`), or taken for "nothing is waiting".
  it('treats an answer that is not a summary as a failed read', async () => {
    open(KEYS.approver, undefined, { [SUMMARY]: () => json(200, {}) });

    expect(
      await screen.findByText('The summary of what is waiting could not be read.'),
    ).toBeVisible();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
  });

  // Break caught: a permission key, a queue identifier or a role leaking into the words of the page.
  it('uses plain words: no permission key, no identifier of a queue, no role', async () => {
    open(KEYS.approver, OFFICER);
    await screen.findAllByRole('link', { name: /waiting for/ });

    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(
      /PICKUP_|STAFF_AWAITING|\b[a-z]+\.[a-z_]+(\.[a-z_]+)?\b|Platform Admin|Senior Ops|Ops Staff/,
    );
  });

  // Break caught: the old landing's list of every page and of the hubs, which the menus are and which this page is not.
  it('is not a list of the pages: no sitemap and no list of hubs', async () => {
    open(KEYS.approver, OFFICER);
    await screen.findAllByRole('link', { name: /waiting for/ });

    expect(screen.queryByRole('heading', { name: 'Where to go' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your hubs' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Where to go' })).toBeNull();
  });
});

describe('My work: who is signed in', () => {
  // Break caught: a page that does not say who is signed in and where they act.
  it('greets the person by name and says where they act', async () => {
    api = installFakeApi(
      signedInApi(
        sessionFixture({
          principal_display_name: 'Ama Mensah',
          authorized_hubs: [
            { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' },
          ],
          permissions: [...KEYS.reader],
        }),
      ),
    );
    renderApp('/');

    const main = screen.getByRole('main');
    expect(await within(main).findByText('Ama Mensah')).toBeVisible();
    expect(main.querySelector('.my-work__who')?.textContent).toBe('Hello, Ama Mensah · Accra Hub');
  });

  it('says how many hubs when the session lists several', async () => {
    api = installFakeApi(
      signedInApi(
        sessionFixture({
          authorized_hubs: [
            { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' },
            { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Kumasi Hub' },
          ],
        }),
      ),
    );
    renderApp('/');

    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(screen.getByRole('main').querySelector('.my-work__who')?.textContent).toMatch(
      /· 2 hubs$/,
    );
  });

  // Break caught: "null" for a person with no name, or a hub invented for a session that lists none.
  it('says so plainly when the session has no name, and names no hub when it lists none', async () => {
    api = installFakeApi(
      signedInApi(sessionFixture({ principal_display_name: null, authorized_hubs: [] })),
    );
    renderApp('/');

    await screen.findByRole('heading', { level: 1, name: 'My work' });

    const who = screen.getByRole('main').querySelector('.my-work__who');
    expect(who?.textContent).toBe('You are signed in.');
  });

  // Break caught: the title of the page or of the tab not saying where the person is.
  it('is titled My work, in the page and in the tab', async () => {
    open(KEYS.reader);

    expect(await screen.findByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    await waitFor(() => {
      expect(document.title).toBe('My work · Melarc Ops Portal');
    });
  });
});

// My work is behind the session guard, so the guard's states are its loading and its error. The test says, for each state, which test shows it or
// why it does not apply.
describeInterfaceStates('My work', {
  loading: {
    test: async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      api = installFakeApi({
        'GET /auth/session': async () => {
          await held;
          return json(200, sessionFixture());
        },
        [SUMMARY]: summary([]),
      });
      renderApp('/');

      expect(screen.getByRole('status')).toHaveTextContent('Checking your session…');
      expect(screen.queryByText('Nothing is waiting.')).toBeNull();

      await act(async () => {
        release();
        await held;
      });
      expect(await screen.findByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      api = installFakeApi({
        ...signedInApi(sessionFixture({ authorized_hubs: [] })),
        [SUMMARY]: summary([{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 }]),
      });
      renderApp('/');

      // Nothing waiting is a success message, never a blank.
      expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
    },
  },
  'validation error': {
    inapplicable:
      'My work has no form or input of its own, so there is nothing for it to validate.',
  },
  error: {
    test: async () => {
      api = installFakeApi({ 'GET /auth/session': () => errorResponse(503, 'SETTING_MISSING') });
      renderApp('/');

      const heading = await screen.findByRole('heading', {
        level: 1,
        name: 'We could not check your session',
      });
      expect(heading).toBeVisible();
      expect(screen.getByRole('alert')).toBeVisible();
      expect(document.body.textContent).not.toMatch(/SETTING_MISSING|Diagnostic text/);
    },
  },
  retry: {
    test: async () => {
      let answers = 0;
      api = installFakeApi({
        'GET /auth/session': () => {
          answers += 1;
          return answers === 1
            ? errorResponse(503, 'SETTING_MISSING')
            : json(200, sessionFixture());
        },
        [SUMMARY]: summary([]),
      });
      const { user } = renderApp('/');

      await user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('heading', { level: 1, name: 'My work' })).toBeVisible();
      expect(answers).toBe(2);
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'My work only shows what the API read and changes no record, so it has no version to conflict on.',
  },
  success: {
    test: async () => {
      open(KEYS.approver, OFFICER, {}, 'Ama Mensah');

      expect(await within(screen.getByRole('main')).findByText('Ama Mensah')).toBeVisible();
      expect(
        await screen.findByRole('link', { name: 'Pickup requests waiting for confirmation' }),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'Any signed-in staff session may see My work, so it needs no permission key; the queues it lists are the ones the server counted for the session, by the key of each queue’s own list, and the server refuses each queue’s page again whatever My work shows. The refusal for a missing key is the route guard’s and is tested with it.',
  },
});

describe('My work: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const view = open(KEYS.approver, OFFICER);
    await screen.findByRole('link', { name: 'Pickup requests waiting for confirmation' });

    expect(await wcagViolations(view.container)).toEqual([]);
  });

  it('has no WCAG violations when the summary could not be read', async () => {
    const view = open(KEYS.approver, undefined, {
      [SUMMARY]: () => refusal(500, 'INTERNAL_ERROR'),
    });
    await screen.findByText('The summary of what is waiting could not be read.');

    expect(await wcagViolations(view.container)).toEqual([]);
  });

  it('has no WCAG violations with clear queues and with nothing waiting', async () => {
    const some = open(KEYS.approver, [
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 2, oldest_at: '2026-11-02T10:00:00.000Z' },
    ]);
    await screen.findByText(/Also clear/);
    expect(await wcagViolations(some.container)).toEqual([]);
    some.unmount();
    api.restore();

    const none = open(KEYS.approver, [{ queue: 'PICKUP_CUTOFF_REVIEW', count: 0 }]);
    await screen.findByText('Nothing is waiting.');
    expect(await wcagViolations(none.container)).toEqual([]);
  });
});

describe('My work follows the hub switcher (task C3)', () => {
  const ACCRA = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' };
  const KUMASI = { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Kumasi Hub' };

  /** The cards of one queue: five waiting for every hub, three at Kumasi, as a server that filters by hub answers. */
  const byHub = (request: Request) => {
    const hub = new URL(request.url).searchParams.get('hub_id');
    return json(200, {
      queues: [
        {
          queue: 'PICKUP_AWAITING_CONFIRMATION',
          count: hub === KUMASI.id ? 3 : 5,
          oldest_at: '2026-11-03T08:00:00.000Z',
        },
      ],
    });
  };

  // Break caught: a landing that keeps the figures of every hub after the person chose one, or that draws the figures of the hub that was left while
  // the other is read (a figure under the wrong name, or a zero).
  it('shows what is waiting at the hub chosen, and nothing of the hub that was left while it is read', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    api = installFakeApi(
      staffApi(
        sessionWith(KEYS.approver, {
          principal_display_name: 'Ama Mensah',
          authorized_hubs: [ACCRA, KUMASI],
        }),
        {
          [SUMMARY]: async (request) => {
            if (new URL(request.url).searchParams.has('hub_id')) await gate;
            return byHub(request);
          },
        },
      ),
    );
    const { user } = renderApp('/');
    await screen.findByText('5 waiting for confirmation');

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Hub: All hubs' }),
    );
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Checking what is waiting…');
    expect(screen.queryByText('5 waiting for confirmation')).toBeNull();
    release();
    expect(await screen.findByText('3 waiting for confirmation')).toBeVisible();
    expect(screen.queryByText('5 waiting for confirmation')).toBeNull();
  });

  // Break caught (audit B9): the figures of one hub under a heading that says nothing of the hub, which reads as the figures of every hub the
  // session reaches; or the hub left in the heading after the person went back to All hubs.
  it('names the hub in the heading of what is waiting when a hub is chosen, and not for All hubs', async () => {
    api = installFakeApi(
      staffApi(
        sessionWith(KEYS.approver, {
          principal_display_name: 'Ama Mensah',
          authorized_hubs: [ACCRA, KUMASI],
        }),
        { [SUMMARY]: byHub },
      ),
    );
    const { user } = renderApp('/');
    expect(await screen.findByRole('heading', { level: 2, name: 'Waiting for you' })).toBeVisible();

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Hub: All hubs' }),
    );
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Waiting for you at Kumasi Hub' }),
    ).toBeVisible();
    expect(await screen.findByText('3 waiting for confirmation')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Waiting for you at Kumasi Hub' })).toBeVisible();

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Hub: Kumasi Hub' }),
    );
    await user.click(await screen.findByRole('menuitemradio', { name: 'All hubs' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Waiting for you' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: /at Kumasi Hub/ })).toBeNull();
  });

  it('says nothing is waiting at the hub chosen, when the summary of that hub is clear', async () => {
    api = installFakeApi(
      staffApi(
        sessionWith(KEYS.approver, {
          principal_display_name: 'Ama Mensah',
          authorized_hubs: [ACCRA, KUMASI],
        }),
        {
          [SUMMARY]: (request) =>
            new URL(request.url).searchParams.has('hub_id')
              ? json(200, {
                  queues: [{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 }],
                })
              : byHub(request),
        },
      ),
    );
    const { user } = renderApp('/');
    await screen.findByText('5 waiting for confirmation');

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', { name: 'Hub: All hubs' }),
    );
    await user.click(await screen.findByRole('menuitemradio', { name: 'Accra Hub' }));

    expect(await screen.findByText('Nothing is waiting at Accra Hub.')).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Waiting for you at Accra Hub' }),
    ).toBeVisible();
  });
});
