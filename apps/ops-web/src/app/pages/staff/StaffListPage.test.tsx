import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { renderApp } from '../../../test-support/render-app';
import {
  bundlesAnswer,
  KEYS,
  refusal,
  sessionWith,
  staffApi,
  staffPage,
} from '../../../test-support/staff-api';
import {
  BUNDLE_ID,
  HUB_ID,
  OTHER_STAFF_ID,
  PRIVILEGED_BUNDLE_ID,
  staffIdentityFixture,
} from '../../../test-support/staff-fixture';
import { wcagViolations } from '../../../test-support/wcag';
import { cannotText } from '../../../platform/problem/capability-words';

let api: FakeApi;

afterEach(() => {
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const LIST = 'GET /staff-identities';
const BUNDLES = 'GET /staff-role-bundles/assignable';
const DIAGNOSTIC = /Diagnostic text that must never reach a screen/;

const kofi = staffIdentityFixture();
const ama = staffIdentityFixture({
  id: OTHER_STAFF_ID,
  full_name: 'Ama Mensah',
  work_email: 'ama.mensah@example.test',
  status: 'ACTIVE',
  role_bundle_id: PRIVILEGED_BUNDLE_ID,
  primary_hub_id: null,
});

/** The staff list as a person who holds `keys` opens it. The list answers `items` for every request unless a handler is given. */
function open(
  path: string,
  keys: readonly string[],
  handlers: Record<string, () => Response | Promise<Response>> = {},
  hubs = [{ id: HUB_ID, display_name: 'Accra Central' }],
) {
  api = installFakeApi(
    staffApi(sessionWith(keys, { authorized_hubs: hubs }), {
      [LIST]: () => staffPage([kofi, ama]),
      [BUNDLES]: bundlesAnswer,
      ...handlers,
    }),
  );
  return renderApp(path);
}

const queryOf = (index = -1): URLSearchParams => {
  const requests = api.requests.filter((request) => request.url.includes('/staff-identities'));
  return new URL(requests.at(index)?.url ?? 'http://x').searchParams;
};

const listRequests = () =>
  api.requests.filter((request) => request.url.includes('/staff-identities'));

describe('the staff list: what it shows', () => {
  it('names the page and the title, and describes what is on it', async () => {
    open('/admin/staff', KEYS.approver);

    expect(await screen.findByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
    expect(document.title).toBe('Staff · Melarc Ops Portal');
    expect(screen.getByText('Everyone with a staff profile at your hubs.')).toBeVisible();
  });

  it('lists each person with a link to their profile, their email, status, role and hub', async () => {
    open('/admin/staff?view=all', KEYS.approver);

    const table = await screen.findByRole('table', { name: 'Staff profiles' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);

    const first = within(rows[1] ?? table);
    expect(first.getByRole('link', { name: 'Kofi Boateng' })).toHaveAttribute(
      'href',
      `/admin/staff/${kofi.id}`,
    );
    expect(first.getByText('kofi.boateng@example.test')).toBeVisible();
    expect(first.getByText('Waiting for approval')).toBeVisible();
    expect(first.getByText('Ops Staff')).toBeVisible();
    expect(first.getByText('Accra Central')).toBeVisible();

    const second = within(rows[2] ?? table);
    expect(second.getByText('Active')).toBeVisible();
    expect(second.getByText('Senior Ops')).toBeVisible();
    expect(second.getByText('No hub')).toBeVisible();
  });

  // Break caught: an id shown where a name was owed, or a hub the session does not act in named from nothing.
  it('says "Another hub" for a hub the session does not act in, and never shows an id', async () => {
    open('/admin/staff?view=all', KEYS.approver, {}, []);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(screen.getByText('Another hub')).toBeVisible();
    expect(document.body.textContent).not.toContain(HUB_ID);
    expect(document.body.textContent).not.toContain(BUNDLE_ID);
  });

  // Break caught: a role column of "Another role" on every row for a person who may not read the roles, which tells them nothing.
  it('leaves the role column out when the session cannot read the roles', async () => {
    open('/admin/staff?view=all', KEYS.reader);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(screen.queryByRole('columnheader', { name: 'Role' })).toBeNull();
    expect(screen.queryByText('Another role')).toBeNull();
    expect(api.requests.some((request) => request.url.includes('/staff-role-bundles'))).toBe(false);
  });

  it('shows the role column when the roles can be read', async () => {
    open('/admin/staff?view=all', KEYS.approver);

    expect(await screen.findByRole('columnheader', { name: 'Role' })).toBeVisible();
  });

  // Break caught: a status shown in the words the database stores.
  it('shows a status in plain words, never the stored value', async () => {
    open('/admin/staff?view=all', KEYS.approver);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(document.body.textContent).not.toMatch(/PENDING_APPROVAL|OFFBOARDED/);
  });

  it('offers to add a staff profile to a person who can, and not to one who cannot', async () => {
    const approver = open('/admin/staff', KEYS.approver);
    await screen.findByRole('table', { name: 'Staff profiles' });
    // The menu has an entry of the same name; the one the page offers is in the page.
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Add a staff profile' }),
    ).toHaveAttribute('href', '/admin/staff/new');
    approver.unmount();
    api.restore();

    open('/admin/staff', KEYS.reader);
    await screen.findByRole('table', { name: 'Staff profiles' });
    expect(
      within(screen.getByRole('main')).queryByRole('link', { name: 'Add a staff profile' }),
    ).toBeNull();
  });
});

describe('the staff list: the views', () => {
  // Break caught: an approver opening a long list when what they came for is the queue.
  it('opens on the approval queue for a person who can approve, and asks the server for exactly that', async () => {
    open('/admin/staff', KEYS.approver);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(queryOf(0).get('status')).toBe('PENDING_APPROVAL');
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('waiting');
  });

  // Break caught: a person who cannot decide opening a queue that is empty to them.
  it('opens on everyone for a person who cannot approve, with no status asked for', async () => {
    open('/admin/staff', KEYS.reader);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(queryOf(0).has('status')).toBe(false);
    expect(screen.getByRole('combobox', { name: 'Show' })).toHaveValue('all');
  });

  it.each([
    ['active', 'ACTIVE'],
    ['rejected', 'REJECTED'],
    ['suspended', 'SUSPENDED'],
    ['offboarded', 'OFFBOARDED'],
    ['waiting', 'PENDING_APPROVAL'],
  ])('asks for the status of the view %s', async (view, status) => {
    open(`/admin/staff?view=${view}`, KEYS.approver);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(queryOf(0).get('status')).toBe(status);
  });

  // Break caught: a made-up view in the address being sent to the server as a made-up filter.
  it('takes a view that is not one for the default', async () => {
    open('/admin/staff?view=everything-please', KEYS.approver);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(queryOf(0).get('status')).toBe('PENDING_APPROVAL');
  });

  it('changes the list and the address when another view is chosen', async () => {
    const { user, router } = open('/admin/staff', KEYS.approver);
    await screen.findByRole('table', { name: 'Staff profiles' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'active');

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('ACTIVE');
    });
    expect(router.state.location.search).toBe('?view=active');
  });

  it('shows everyone when "Everyone" is chosen, with no status asked for', async () => {
    const { user } = open('/admin/staff', KEYS.approver);
    await screen.findByRole('table', { name: 'Staff profiles' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'all');

    await waitFor(() => {
      expect(listRequests()).toHaveLength(2);
    });
    expect(queryOf().has('status')).toBe(false);
  });
});

describe('the staff list: searching', () => {
  it('searches by name or email when the form is sent, and puts the search in the address', async () => {
    const { user, router } = open('/admin/staff?view=all', KEYS.approver);
    await screen.findByRole('table', { name: 'Staff profiles' });

    await user.type(
      screen.getByRole('searchbox', { name: 'Search by name or email' }),
      'kofi{Enter}',
    );

    await waitFor(() => {
      expect(queryOf().get('q')).toBe('kofi');
    });
    expect(router.state.location.search).toBe('?view=all&q=kofi');
  });

  it('reads a search out of the address and shows it in the field', async () => {
    open('/admin/staff?view=all&q=mensah', KEYS.approver);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(queryOf(0).get('q')).toBe('mensah');
    expect(screen.getByRole('searchbox', { name: 'Search by name or email' })).toHaveValue(
      'mensah',
    );
  });

  // Break caught: spaces around a search sent as part of it, which would find nobody.
  it('sends a search without the spaces around it, and a blank search as none', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver);
    await screen.findByRole('table', { name: 'Staff profiles' });
    const field = screen.getByRole('searchbox', { name: 'Search by name or email' });

    await user.type(field, '   kofi   {Enter}');
    await waitFor(() => {
      expect(queryOf().get('q')).toBe('kofi');
    });
    await user.clear(field);
    await user.type(field, '    {Enter}');

    await waitFor(() => {
      expect(listRequests()).toHaveLength(3);
    });
    expect(queryOf().has('q')).toBe(false);
  });

  // Break caught: a search read out of the address with its spaces, which would find nobody.
  it('sends a search from the address without the spaces around it', async () => {
    open('/admin/staff?view=all&q=%20%20kofi%20', KEYS.approver);

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(queryOf(0).get('q')).toBe('kofi');
  });

  it('limits a search to what the server accepts, as it is typed', async () => {
    open('/admin/staff?view=all', KEYS.approver);
    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(screen.getByRole('searchbox', { name: 'Search by name or email' })).toHaveAttribute(
      'maxlength',
      '128',
    );
  });

  it('clears the search and the filter in one move', async () => {
    const { user, router } = open('/admin/staff?view=active&q=nobody', KEYS.approver, {
      [LIST]: () => staffPage([]),
    });
    await screen.findByText('No profiles match');

    await user.click(screen.getByRole('button', { name: 'Show everyone' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?view=all');
    });
    expect(screen.getByRole('searchbox', { name: 'Search by name or email' })).toHaveValue('');
  });
});

describe('the staff list: counting and paging', () => {
  it('counts what is waiting, exactly, when the whole queue is on the page', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => staffPage([kofi, ama]) });

    expect(await screen.findByText('2 profiles are waiting for approval.')).toBeVisible();
  });

  // Break caught: "2 are waiting" for a queue that runs on to a next page, or for a later page of it.
  it('does not claim an exact count for a queue that runs past the page, or for a later page of it', async () => {
    const { user } = open('/admin/staff?view=waiting', KEYS.approver, {
      [LIST]: () => staffPage([kofi, ama], 'next-1'),
    });

    expect(
      await screen.findByText('Showing 2 profiles. More follow on the next page.'),
    ).toBeVisible();
    expect(screen.queryByText(/are waiting for approval/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText(/Showing 2 profiles on page 2\./)).toBeVisible();
  });

  it('says it in the singular for one', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => staffPage([kofi]) });

    expect(await screen.findByText('1 profile is waiting for approval.')).toBeVisible();
  });

  it('counts a page without claiming to know the total', async () => {
    open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi, ama], 'next-1'),
    });

    expect(
      await screen.findByText('Showing 2 profiles. More follow on the next page.'),
    ).toBeVisible();
  });

  // Break caught: "0 profiles" shown while the first answer is on its way.
  it('shows no count while the list is loading', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    open('/admin/staff', KEYS.approver, {
      [LIST]: async () => {
        await held;
        return staffPage([kofi]);
      },
    });

    expect(await screen.findByText('Loading staff…')).toBeVisible();
    expect(screen.queryByText(/profiles? (is|are) waiting|Showing/)).toBeNull();
    release();
    expect(await screen.findByText('1 profile is waiting for approval.')).toBeVisible();
  });

  it('goes to the next page with the token the server gave, and back to the first', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi], 'next-1'),
    });
    await screen.findByRole('table', { name: 'Staff profiles' });
    expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => {
      expect(queryOf().get('page_token')).toBe('next-1');
    });
    expect(await screen.findByText(/on page 2/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Previous page' }));

    await waitFor(() => {
      expect(listRequests()).toHaveLength(3);
    });
    expect(queryOf().has('page_token')).toBe(false);
  });

  it('offers no next page on the last page', async () => {
    open('/admin/staff?view=all', KEYS.approver, { [LIST]: () => staffPage([kofi], null) });

    await screen.findByRole('table', { name: 'Staff profiles' });

    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  // Break caught: the next page of one filter shown for another, because the page position outlived the change.
  it('starts again at the first page when the view or the search changes', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi], 'next-1'),
    });
    await screen.findByRole('table', { name: 'Staff profiles' });
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'active');

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('ACTIVE');
    });
    expect(queryOf().has('page_token')).toBe(false);
    expect(screen.queryByText(/on page 2/)).toBeNull();
  });
});

describe('the staff list: nothing to show', () => {
  // Break caught: "none waiting" and "the filter hides everything" told as one, which sends people hunting for a bug (ops-portal.md section 7).
  it('tells nothing waiting as good news, and leaves the one way to add a profile where it always is', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(
      await screen.findByRole('heading', { name: 'Nothing is waiting for approval' }),
    ).toBeVisible();
    expect(
      screen.getByText('New profiles appear here as soon as someone creates them.'),
    ).toBeVisible();
    expect(
      within(screen.getByRole('main')).getAllByRole('link', { name: 'Add a staff profile' }),
    ).toHaveLength(1);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('tells a filter that hides everything differently, and offers the way out', async () => {
    open('/admin/staff?view=suspended', KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(await screen.findByRole('heading', { name: 'No profiles match' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show everyone' })).toBeVisible();
    expect(screen.queryByText('Nothing is waiting for approval')).toBeNull();
  });

  // Break caught: a blank search in the address taken for a search, so that an empty queue reads "no profiles match".
  it('takes a blank search in the address for none, and tells an empty queue as nothing waiting', async () => {
    open('/admin/staff?view=waiting&q=%20%20', KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(
      await screen.findByRole('heading', { name: 'Nothing is waiting for approval' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No profiles match' })).toBeNull();
  });

  it('tells a search that finds nobody as a filter, even in the queue', async () => {
    open('/admin/staff?view=waiting&q=nobody', KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(await screen.findByRole('heading', { name: 'No profiles match' })).toBeVisible();
  });

  it('tells a list with no one on it', async () => {
    open('/admin/staff?view=all', KEYS.reader, { [LIST]: () => staffPage([]) });

    expect(await screen.findByRole('heading', { name: 'No staff profiles yet' })).toBeVisible();
  });

  // Break caught: an empty search echoing what was typed back as markup or as a claim about the person.
  it('does not repeat the search in the words', async () => {
    open('/admin/staff?view=all&q=%3Cb%3Ex%3C%2Fb%3E', KEYS.approver, {
      [LIST]: () => staffPage([]),
    });

    await screen.findByRole('heading', { name: 'No profiles match' });

    expect(document.body.textContent).not.toContain('<b>');
  });
});

describe('the staff list: when it cannot be had', () => {
  it('says so in approved words with a retry, and never the server’s text', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(500, 'INTERNAL_ERROR') });

    expect(await screen.findByText('The staff list could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('names staff.read when the server refuses the key', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(403, 'PERMISSION_DENIED') });

    expect(await screen.findByText(cannotText('staff.read'))).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  // Break caught: an answer that is not a list believed, and shown as an empty queue.
  it('treats an answer that is not a list as an answer that is not the API’s', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => json(200, { surprise: true }) });

    expect(await screen.findByText('The staff list could not be loaded.')).toBeVisible();
    expect(screen.queryByText('Nothing is waiting for approval')).toBeNull();
  });

  it('words a refused search for the search', async () => {
    open('/admin/staff?view=all&q=x', KEYS.approver, {
      [LIST]: () => refusal(400, 'VALIDATION_FAILED'),
    });

    expect(
      await screen.findByText('That search was not accepted. Use at most 128 characters.'),
    ).toBeVisible();
  });
});

describe('the staff list: the guard', () => {
  // Break caught: a page that draws for a session that does not hold the key, or a refusal that names a role.
  it('names staff.read for a session that does not hold it, and reads nothing', async () => {
    open('/admin/staff', KEYS.maker);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'You do not have access to this page' }),
    ).toBeVisible();
    expect(screen.getByText(cannotText('staff.read'))).toBeVisible();
    expect(listRequests()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
  });

  it('has no entry in the menu for a session that does not hold the key', async () => {
    open('/', KEYS.maker);

    await screen.findByRole('heading', { level: 1, name: 'My work' });

    expect(
      within(screen.getByRole('navigation', { name: 'Primary' })).queryByRole('link', {
        name: 'Staff',
      }),
    ).toBeNull();
  });
});

describeInterfaceStates('The staff list', {
  loading: {
    test: async () => {
      open('/admin/staff', KEYS.approver, { [LIST]: () => new Promise<Response>(() => undefined) });

      expect(await screen.findByText('Loading staff…')).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
    },
  },
  empty: {
    test: async () => {
      open('/admin/staff', KEYS.approver, { [LIST]: () => staffPage([]) });

      expect(
        await screen.findByRole('heading', { name: 'Nothing is waiting for approval' }),
      ).toBeVisible();
    },
  },
  'validation error': {
    test: async () => {
      open('/admin/staff?view=all&q=x', KEYS.approver, {
        [LIST]: () => refusal(400, 'VALIDATION_FAILED'),
      });

      expect(await screen.findByText(/That search was not accepted/)).toBeVisible();
      expect(screen.getByRole('searchbox', { name: 'Search by name or email' })).toHaveAttribute(
        'maxlength',
        '128',
      );
    },
  },
  error: {
    test: async () => {
      open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(500, 'INTERNAL_ERROR') });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'The staff list could not be loaded.',
      );
    },
  },
  retry: {
    test: async () => {
      let answers = 0;
      const { user } = open('/admin/staff', KEYS.approver, {
        [LIST]: () => {
          answers += 1;
          return answers === 1 ? refusal(500, 'INTERNAL_ERROR') : staffPage([kofi]);
        },
      });

      await user.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByRole('table', { name: 'Staff profiles' })).toBeVisible();
    },
  },
  offline: { inapplicable: OFFLINE_NOT_APPLICABLE },
  'stale / conflict': {
    inapplicable:
      'The list reads and changes no record, so it has no version to conflict on; a profile’s own version is the profile page’s.',
  },
  success: {
    test: async () => {
      open('/admin/staff?view=all', KEYS.approver);

      expect(await screen.findByRole('link', { name: 'Kofi Boateng' })).toBeVisible();
    },
  },
  'permission-restricted': {
    test: async () => {
      open('/admin/staff', KEYS.maker);

      expect(await screen.findByText(cannotText('staff.read'))).toBeVisible();
    },
  },
});

describe('the staff list: accessibility', () => {
  it('has no WCAG violations that can be checked without a layout engine, in its states', async () => {
    const full = open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi, ama], 'next-1'),
    });
    await screen.findByRole('table', { name: 'Staff profiles' });
    expect(await wcagViolations(full.container)).toEqual([]);
    full.unmount();
    api.restore();

    const empty = open('/admin/staff', KEYS.approver, { [LIST]: () => staffPage([]) });
    await screen.findByRole('heading', { name: 'Nothing is waiting for approval' });
    expect(await wcagViolations(empty.container)).toEqual([]);
    empty.unmount();
    api.restore();

    const failed = open('/admin/staff', KEYS.approver, {
      [LIST]: () => refusal(500, 'INTERNAL_ERROR'),
    });
    await screen.findByRole('alert');
    expect(await wcagViolations(failed.container)).toEqual([]);
  });
});
