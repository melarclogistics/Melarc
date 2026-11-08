import { act, screen, within } from '@testing-library/react';
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
import { KEYS, refusal, sessionWith, staffApi, staffPage } from '../../test-support/staff-api';
import { staffIdentityFixture } from '../../test-support/staff-fixture';
import { wcagViolations } from '../../test-support/wcag';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const LIST = 'GET /staff-identities';
const waiting = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    staffIdentityFixture({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }),
  );

/** The landing as a person who holds `keys` opens it. */
function open(
  keys: readonly string[],
  handlers: Parameters<typeof staffApi>[1] = {},
  name = 'Ama Mensah',
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { principal_display_name: name }), {
      [LIST]: () => staffPage([]),
      ...handlers,
    }),
  );
  return renderApp('/');
}

describe('the landing: what is waiting', () => {
  // Break caught: a queue read for a person who may not decide on it, and a claim about it made without looking.
  it('looks at the approval queue only for a person who can read staff and approve', async () => {
    open(KEYS.reader);

    expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
    expect(api.requests.some((request) => request.url.includes('/staff-identities'))).toBe(false);
  });

  it('asks for the profiles that wait for approval, and counts them', async () => {
    open(KEYS.approver, { [LIST]: () => staffPage(waiting(3)) });

    expect(await screen.findByText('3 profiles are waiting for your approval.')).toBeVisible();
    const request = api.requests.find((candidate) => candidate.url.includes('/staff-identities'));
    expect(new URL(request?.url ?? 'http://x').searchParams.get('status')).toBe('PENDING_APPROVAL');
  });

  it('says it in the singular for one', async () => {
    open(KEYS.approver, { [LIST]: () => staffPage(waiting(1)) });

    expect(await screen.findByText('1 profile is waiting for your approval.')).toBeVisible();
  });

  // Break caught: "25 are waiting" for a queue that is longer than a page.
  it('does not claim to know the total when the queue runs past the page', async () => {
    open(KEYS.approver, { [LIST]: () => staffPage(waiting(25), 'next-1') });

    expect(
      await screen.findByText('25 or more profiles are waiting for your approval.'),
    ).toBeVisible();
  });

  it('links to the queue itself', async () => {
    open(KEYS.approver, { [LIST]: () => staffPage(waiting(2)) });

    expect(await screen.findByRole('link', { name: 'Review the queue' })).toHaveAttribute(
      'href',
      '/admin/staff?view=waiting',
    );
  });

  it('says nothing is waiting, as good news, when the queue is empty', async () => {
    open(KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(await screen.findByText('Nothing is waiting.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Review the queue' })).toBeNull();
  });

  // Break caught: "Nothing is waiting" while the first answer is still on its way, which would send an approver away from the queue.
  it('says nothing about the queue until it has been read', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open(KEYS.approver, {
      [LIST]: async () => {
        await held;
        return staffPage(waiting(2));
      },
    });

    expect(await screen.findByText('Checking what is waiting…')).toBeVisible();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    expect(screen.queryByText(/profiles? (is|are) waiting/)).toBeNull();
    await act(async () => {
      release();
      await held;
    });
    expect(await screen.findByText('2 profiles are waiting for your approval.')).toBeVisible();
  });

  // Break caught: a failed read of the queue taking the whole landing with it, or being read as "nothing is waiting".
  it('keeps the rest of the landing when the queue cannot be read, and does not say nothing is waiting', async () => {
    open(KEYS.approver, { [LIST]: () => refusal(500, 'INTERNAL_ERROR') });

    expect(await screen.findByText('The staff list could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(screen.queryByText('Nothing is waiting.')).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Your hubs' })).toBeVisible();
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
      api = installFakeApi(signedInApi(sessionFixture({ authorized_hubs: [] })));
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
      open(KEYS.approver, { [LIST]: () => staffPage(waiting(2)) }, 'Ama Mensah');

      expect(await within(screen.getByRole('main')).findByText('Ama Mensah')).toBeVisible();
      expect(screen.getByRole('list', { name: 'Your hubs' })).toBeVisible();
      expect(await screen.findByText('2 profiles are waiting for your approval.')).toBeVisible();
    },
  },
  'permission-restricted': {
    inapplicable:
      'Any signed-in staff session may see the landing, so it needs no permission key; the queue it shows is read only for a session that lists the keys, and the server refuses it again whatever the page shows. The refusal for a missing key is the route guard’s and is tested with it.',
  },
});

describe('the landing: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const view = open(KEYS.approver, { [LIST]: () => staffPage(waiting(2)) });
    await screen.findByText('2 profiles are waiting for your approval.');

    expect(await wcagViolations(view.container)).toEqual([]);
  });
});
