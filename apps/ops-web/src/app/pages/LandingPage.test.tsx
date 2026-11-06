import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  errorResponse,
  installFakeApi,
  json,
  signedInApi,
  type FakeApi,
} from '../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../test-support/interface-states';
import { renderApp } from '../../test-support/render-app';
import { sessionFixture } from '../../test-support/session-fixture';
import { KEYS, refusal, sessionWith, staffApi } from '../../test-support/staff-api';
import { wcagViolations } from '../../test-support/wcag';

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

/** The landing as a person who holds `keys` opens it, and the server answers the summary as given. */
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

/** The lines of "Waiting for you", in the order drawn. */
async function lines() {
  const list = await screen.findByRole('list', { name: 'Waiting for you' });
  return within(list).getAllByRole('listitem');
}

describe('the landing: what is waiting', () => {
  // Break caught: a landing that lists what its keys suggest and not what the server counted, or that leaves a queue out.
  it('lists each queue the summary returned, with its count and a link to the queue', async () => {
    open(KEYS.approver, OFFICER);

    await screen.findByRole('heading', { level: 2, name: 'Waiting for you' });
    const links = await screen.findAllByRole('link', {
      name: /waiting for|not yet on a run|runs in progress/,
    });
    const asked = Object.fromEntries(
      links.map((link) => [link.textContent, link.getAttribute('href')]),
    );

    expect(asked).toEqual({
      'Pickup requests waiting for confirmation': '/pickup-requests?state=PENDING',
      'Late bookings waiting for a cut-off decision': '/pickup-requests?state=CONFIRMED',
      'One-package exceptions waiting for approval': '/approvals',
      'Confirmed pickups not yet on a run': '/pickup-requests?state=CONFIRMED',
      'Pickup runs in progress': '/manifests?state=IN_PROGRESS',
    });
  });

  // Break caught: the queue that has waited longest drawn below one that has waited a day.
  it('puts the queue whose oldest record has waited longest first', async () => {
    open(KEYS.approver, OFFICER);

    const items = await lines();

    expect(items.map((item) => within(item).getByRole('link').textContent)).toEqual([
      'Late bookings waiting for a cut-off decision',
      'Confirmed pickups not yet on a run',
      'One-package exceptions waiting for approval',
      'Pickup requests waiting for confirmation',
      'Pickup runs in progress',
    ]);
    expect(items[0]).toHaveTextContent('1');
    expect(items[0]).toHaveTextContent('Oldest since 30 Oct, 08:00');
    expect(items[3]).toHaveTextContent('5');
  });

  // Break caught: the count of a queue drawn with the wrong queue, or a number that is not the server's.
  it('draws the count the server gave for each queue', async () => {
    open(KEYS.approver, OFFICER);

    const items = await lines();
    const counts = Object.fromEntries(
      items.map((item) => [
        within(item).getByRole('link').textContent,
        item.querySelector('.ui-count-badge')?.textContent,
      ]),
    );

    expect(counts).toEqual({
      'Pickup requests waiting for confirmation': '5',
      'Late bookings waiting for a cut-off decision': '1',
      'One-package exceptions waiting for approval': '3',
      'Confirmed pickups not yet on a run': '4',
      'Pickup runs in progress': '2',
    });
  });

  // Break caught: an empty queue hidden (the person cannot tell it was read), or made to look like work.
  it('lists a queue with nothing in it after the ones that have work, and keeps it', async () => {
    open(KEYS.approver, [
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
      { queue: 'STAFF_AWAITING_APPROVAL', count: 2, oldest_at: '2026-11-02T10:00:00.000Z' },
    ]);

    const items = await lines();

    expect(items.map((item) => within(item).getByRole('link').textContent)).toEqual([
      'Staff profiles waiting for approval',
      'Late bookings waiting for a cut-off decision',
    ]);
    expect(items[1]).toHaveAttribute('data-empty', 'true');
    expect(items[1]).not.toHaveTextContent('Oldest since');
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
  });

  // Break caught: the pool sending a person to a page that refuses them.
  it('sends the pool to the manifest builder for a session that may build a manifest', async () => {
    open(
      ['pickup.read', 'pickup.manifest.create'],
      [{ queue: 'PICKUP_UNMANIFESTED_POOL', count: 2, oldest_at: '2026-11-02T10:00:00.000Z' }],
    );

    expect(
      await screen.findByRole('link', { name: 'Confirmed pickups not yet on a run' }),
    ).toHaveAttribute('href', '/manifests/new');
  });

  it('sends the pool to the confirmed pickups for a session that may not build a manifest', async () => {
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

  // Break caught: the defect this task fixes: "Nothing is waiting" for a session the page never looked at, because its keys do not suggest a queue.
  it('says nothing is waiting only when the summary was read and every count it returned is 0', async () => {
    open(KEYS.reader, [
      { queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 },
      { queue: 'PICKUP_CUTOFF_REVIEW', count: 0 },
    ]);

    expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
    expect(screen.queryByRole('link', { name: /waiting for/ })).toBeNull();
  });

  // Break caught: "Nothing is waiting" for a session the server gave no queue to, which tells it something the page does not know.
  it('says nothing of waiting to a session the summary gave no queue', async () => {
    open(KEYS.reader, []);

    await screen.findByRole('heading', { level: 2, name: 'Your hubs' });
    // The heading stands while the summary is being read and goes when it was read and held no queue: wait for that, and for nothing less.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { level: 2, name: 'Waiting for you' })).toBeNull();
    });

    expect(api.requests.some((request) => request.url.includes('/ops/queue-summary'))).toBe(true);
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
  });

  // Break caught: a claim made before the answer: "Nothing is waiting" while the first read is still on its way.
  it('says nothing about what is waiting until the summary has been read', async () => {
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
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    expect(screen.queryByRole('link', { name: /waiting for/ })).toBeNull();
    await act(async () => {
      release();
      await held;
    });
    expect(
      await screen.findByRole('link', { name: 'Pickup requests waiting for confirmation' }),
    ).toBeVisible();
  });

  // Break caught: a failed read taking the landing with it, or being read as "nothing is waiting".
  it('says the summary could not be read, and offers to try again, keeping the rest of the landing', async () => {
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
    expect(screen.getByRole('heading', { level: 2, name: 'Your hubs' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/INTERNAL_ERROR|Diagnostic text/);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('link', { name: 'Pickup requests waiting for confirmation' }),
    ).toBeVisible();
    expect(answers).toBe(2);
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

  // Break caught: a permission key, a queue identifier or a role leaking into the words of the landing.
  it('uses plain words: no permission key, no identifier of a queue, no role', async () => {
    open(KEYS.approver, OFFICER);
    await screen.findAllByRole('link', { name: /waiting for/ });

    const list = screen.getByRole('list', { name: 'Waiting for you' });
    expect(list.textContent).not.toMatch(
      /PICKUP_|STAFF_AWAITING|\b[a-z]+\.[a-z_]+(\.[a-z_]+)?\b|Platform Admin|Senior Ops|Ops Staff/,
    );
  });
});

describe('the landing: where to go', () => {
  it('lists the screens the session’s keys allow, with what each is for, and not the landing itself', async () => {
    open(KEYS.approver);

    const list = await screen.findByRole('list', { name: 'Where to go' });
    const items = within(list).getAllByRole('listitem');

    expect(items).toHaveLength(4);
    expect(within(items[0] ?? list).getByRole('link', { name: 'Staff' })).toHaveAttribute(
      'href',
      '/admin/staff',
    );
    expect(items[0]).toHaveTextContent(
      'Find a staff profile, and approve the ones that are waiting.',
    );
    expect(
      within(items[1] ?? list).getByRole('link', { name: 'Add a staff profile' }),
    ).toHaveAttribute('href', '/admin/staff/new');
    expect(within(items[2] ?? list).getByRole('link', { name: 'Sessions' })).toHaveAttribute(
      'href',
      '/admin/sessions',
    );
    expect(items[2]).toHaveTextContent('See where a person is signed in, and end a session.');
    expect(
      within(items[3] ?? list).getByRole('link', { name: 'Trusted browsers' }),
    ).toHaveAttribute('href', '/account/trusted-browsers');
    expect(within(list).queryByRole('link', { name: 'Overview' })).toBeNull();
  });

  // Break caught: a list of places for a session that can go nowhere, or entries the keys do not allow. A session with no key can go to
  // one place besides the overview: its own trusted browsers, which are open to every signed-in session.
  it('offers a session with no key only the place that needs none', async () => {
    open([]);

    const list = await screen.findByRole('list', { name: 'Where to go' });

    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Trusted browsers']);
  });

  it('offers a maker only what a maker may do', async () => {
    open(KEYS.maker);

    const list = await screen.findByRole('list', { name: 'Where to go' });

    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Add a staff profile', 'Trusted browsers']);
  });
});

describe('the landing: who is signed in', () => {
  it('names the person', async () => {
    open(KEYS.reader);

    expect(await within(screen.getByRole('main')).findByText('Ama Mensah')).toBeVisible();
  });

  it('says so plainly when the session has no name', async () => {
    api = installFakeApi(signedInApi(sessionFixture({ principal_display_name: null })));
    renderApp('/');

    expect(await screen.findByText('You are signed in.')).toBeVisible();
  });
});

// The landing is behind the session guard, so the guard's states are its loading and its error. The test says, for each state, which test
// shows it or why it does not apply.
describeInterfaceStates('The signed-in landing', {
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
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' }),
      ).toBeVisible();
    },
  },
  empty: {
    test: async () => {
      api = installFakeApi({
        ...signedInApi(sessionFixture({ authorized_hubs: [] })),
        [SUMMARY]: summary([{ queue: 'PICKUP_AWAITING_CONFIRMATION', count: 0 }]),
      });
      renderApp('/');

      // Nothing waiting is a success message, never a blank; no hub is said in words and not by an empty list. A session whose grants
      // reach every hub lists them all (the owner's decision of 25 October 2026), so an empty list means there is no hub to name.
      expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
      expect(screen.getByText('No hub is listed for your session.')).toBeVisible();
      expect(screen.queryByRole('list', { name: 'Your hubs' })).toBeNull();
    },
  },
  'validation error': {
    inapplicable:
      'The landing has no form or input of its own, so there is nothing for it to validate.',
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

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Melarc Ops Portal' }),
      ).toBeVisible();
      expect(answers).toBe(2);
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The landing only shows what the API read and changes no record, so it has no version to conflict on.',
  },
  success: {
    test: async () => {
      open(KEYS.approver, OFFICER, {}, 'Ama Mensah');

      expect(await within(screen.getByRole('main')).findByText('Ama Mensah')).toBeVisible();
      expect(screen.getByRole('list', { name: 'Your hubs' })).toBeVisible();
      expect(
        await screen.findByRole('link', { name: 'Pickup requests waiting for confirmation' }),
      ).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'Any signed-in staff session may see the landing, so it needs no permission key; the queues it lists are the ones the server counted for the session, by the key of each queue’s own list, and the server refuses each queue’s page again whatever the landing shows. The refusal for a missing key is the route guard’s and is tested with it.',
  },
});

describe('the landing: accessibility', () => {
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
});
