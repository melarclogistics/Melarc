import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { installFakeApi, json, type FakeApi } from '../../../test-support/fake-api';
import {
  describeInterfaceStates,
  OFFLINE_NOT_APPLICABLE,
} from '../../../test-support/interface-states';
import { narrowRoom, restoreRoom } from '../../../test-support/narrow-room';
import { pagerRegion } from '../../../test-support/queue-pager';
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
  restoreRoom();
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

/** The table is drawn while the rows are on their way, as rows of its own shape and `aria-busy`: it is the rows that are awaited. */
const table = async (): Promise<HTMLElement> => {
  const found = await screen.findByRole('table', { name: 'Staff profiles' });
  await waitFor(() => {
    expect(found).not.toHaveAttribute('aria-busy', 'true');
  });
  return found;
};
/** In a room under 40rem the rows are cards (`narrowRoom`). */
const cards = () => screen.findByRole('list', { name: 'Staff profiles' });
/** The table's region of failures is in the page before it has anything to say, so it is the words that are awaited, and not the region. */
const alertSaying = async (text: string): Promise<HTMLElement> => {
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(text);
  });
  return screen.getByRole('alert');
};
const viewTab = (name: string) => screen.getByRole('tab', { name });
/** A profile's row header is its name (a link). The table's own message (nothing yet, a failure) sits in a cell and is not one. */
const profileRows = () => screen.queryAllByRole('rowheader');
/** The search is in the popover of the filter row, opened with the Filter button. */
async function openSearch(user: ReturnType<typeof open>['user']): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Filter' }));
  return screen.findByRole('searchbox', { name: 'Search by name or email' });
}

const queryOf = (index = -1): URLSearchParams => {
  const requests = api.requests.filter((request) => request.url.includes('/staff-identities'));
  return new URL(requests.at(index)?.url ?? 'http://x').searchParams;
};

const listRequests = () =>
  api.requests.filter((request) => request.url.includes('/staff-identities'));
/** The reads of the counts beside the menu (`getQueueSummary`), which the shell makes and a queue's refresh asks for again. */
const summaryRequests = () =>
  api.requests.filter((request) => new URL(request.url).pathname.endsWith('/ops/queue-summary'));

// Break caught (the security review of run 5, Stage 5.1): a credential drawn in the cards, or in an attribute, which no check of the list made at all. A password hash, a token or a setup
// link that the server sent anyway has no place in either drawing, in any text or any attribute of the page (the whole markup is read).
describe('the staff list: nothing that could sign anyone in, in either drawing', () => {
  it.each([
    ['the table', false],
    ['the cards', true],
  ] as const)('draws no credential in %s, in any text or attribute', async (_name, narrow) => {
    if (narrow) narrowRoom();
    // A variable and not a literal in the call: a server's answer can be wider than the type the helper takes, and the helper's type would refuse the extra fields written in place.
    const planted = {
      ...kofi,
      password_hash: 'SENTINEL-PASSWORD-HASH',
      token: 'SENTINEL-TOKEN',
      setup_token: 'SENTINEL-SETUP',
      link: 'https://example.test/setup/credential#token=SENTINEL-SETUP',
    };
    open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([planted, ama]),
    });
    await (narrow ? cards() : table());

    expect(document.body.innerHTML).not.toContain('SENTINEL');
  });
});

describe('the staff list: what it shows', () => {
  it('names the page and the title, and describes what is on it', async () => {
    open('/admin/staff', KEYS.approver);

    expect(await screen.findByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
    expect(document.title).toBe('Staff · Melarc Ops Portal');
    expect(screen.getByText('Everyone with a staff profile at your hubs.')).toBeVisible();
  });

  it('lists each person with a link to their profile, their email, status, role and hub', async () => {
    open('/admin/staff?view=all', KEYS.approver);

    const found = await table();
    const rows = within(found).getAllByRole('row');
    expect(rows).toHaveLength(3);

    const first = within(rows[1] ?? found);
    expect(first.getByRole('link', { name: 'Kofi Boateng' })).toHaveAttribute(
      'href',
      `/admin/staff/${kofi.id}`,
    );
    expect(first.getByText('kofi.boateng@example.test')).toBeVisible();
    expect(first.getByText('Waiting for approval')).toBeVisible();
    expect(first.getByText('Ops Staff')).toBeVisible();
    expect(first.getByText('Accra Central')).toBeVisible();

    const second = within(rows[2] ?? found);
    expect(second.getByText('Active')).toBeVisible();
    expect(second.getByText('Senior Ops')).toBeVisible();
    expect(second.getByText('No hub')).toBeVisible();
  });

  it('draws a person as a card with the same facts, in a room too narrow for the columns', async () => {
    narrowRoom();
    open('/admin/staff?view=all', KEYS.approver);

    const card = within(await cards())
      .getByRole('link', { name: 'Kofi Boateng' })
      .closest('li');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('Waiting for approval')).toBeVisible();
    expect(within(card as HTMLElement).getByText('kofi.boateng@example.test')).toBeVisible();
    expect(within(card as HTMLElement).getByText('Ops Staff')).toBeVisible();
    expect(within(card as HTMLElement).getByText('Accra Central')).toBeVisible();
  });

  // Break caught: an id shown where a name was owed, or a hub the session does not act in named from nothing.
  it('says "Another hub" for a hub the session does not act in, and never shows an id', async () => {
    open('/admin/staff?view=all', KEYS.approver, {}, []);

    await table();

    expect(screen.getByText('Another hub')).toBeVisible();
    expect(document.body.textContent).not.toContain(HUB_ID);
    expect(document.body.textContent).not.toContain(BUNDLE_ID);
  });

  // Break caught: a role column of "Another role" on every row for a person who may not read the roles, which tells them nothing.
  it('leaves the role column out when the session cannot read the roles', async () => {
    open('/admin/staff?view=all', KEYS.reader);

    await table();

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

    await table();

    expect(document.body.textContent).not.toMatch(/PENDING_APPROVAL|OFFBOARDED/);
  });

  it('offers to add a staff profile to a person who can, and not to one who cannot', async () => {
    const approver = open('/admin/staff', KEYS.approver);
    await table();
    // The menu has an entry of the same name; the one the page offers is in the page.
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Add a staff profile' }),
    ).toHaveAttribute('href', '/admin/staff/new');
    approver.unmount();
    api.restore();

    open('/admin/staff', KEYS.reader);
    await table();
    expect(
      within(screen.getByRole('main')).queryByRole('link', { name: 'Add a staff profile' }),
    ).toBeNull();
  });

  // The order is the server's and the contract states none, so the page says none (the queue workspace says the order only where one is known).
  it('claims no order for the rows', async () => {
    open('/admin/staff?view=all', KEYS.approver);
    await table();

    expect(screen.queryByText(/first, as the server lists them/i)).toBeNull();
  });

  // Break caught: a refresh that reads nothing, or one that reads the list and leaves the count beside the menu as it was (AC-QSUM-09: the counts are read again with the queue).
  it('says when the list was last checked, and Refresh reads the list and the count beside the menu again', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver);
    await table();
    expect(screen.getByText(/^Updated /)).toBeVisible();
    const lists = listRequests().length;
    const counts = summaryRequests().length;

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      expect(listRequests()).toHaveLength(lists + 1);
    });
    await waitFor(() => {
      expect(summaryRequests()).toHaveLength(counts + 1);
    });
    await table();
    expect(queryOf().has('page_token')).toBe(false);
  });
});

describe('the staff list: the views', () => {
  // Break caught: an approver opening a long list when what they came for is the queue.
  it('opens on the approval queue for a person who can approve, and asks the server for exactly that', async () => {
    open('/admin/staff', KEYS.approver);

    await table();

    expect(queryOf(0).get('status')).toBe('PENDING_APPROVAL');
    expect(viewTab('Waiting for approval')).toHaveAttribute('aria-selected', 'true');
  });

  // Break caught: a person who cannot decide opening a queue that is empty to them.
  it('opens on everyone for a person who cannot approve, with no status asked for', async () => {
    open('/admin/staff', KEYS.reader);

    await table();

    expect(queryOf(0).has('status')).toBe(false);
    expect(viewTab('Everyone')).toHaveAttribute('aria-selected', 'true');
  });

  it('offers the views in the order the people of the list are worked through', async () => {
    open('/admin/staff', KEYS.approver);
    await table();

    expect(
      within(screen.getByRole('tablist', { name: 'Views of the staff' }))
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual([
      'Waiting for approval',
      'Active',
      'Rejected',
      'Suspended',
      'Offboarded',
      'Everyone',
    ]);
  });

  it.each([
    ['active', 'ACTIVE'],
    ['rejected', 'REJECTED'],
    ['suspended', 'SUSPENDED'],
    ['offboarded', 'OFFBOARDED'],
    ['waiting', 'PENDING_APPROVAL'],
  ])('asks for the status of the view %s', async (view, status) => {
    open(`/admin/staff?view=${view}`, KEYS.approver);

    await table();

    expect(queryOf(0).get('status')).toBe(status);
  });

  // Break caught: a made-up view in the address being sent to the server as a made-up filter.
  it('takes a view that is not one for the default', async () => {
    open('/admin/staff?view=everything-please', KEYS.approver);

    await table();

    expect(queryOf(0).get('status')).toBe('PENDING_APPROVAL');
  });

  it('changes the list and the address when another view is chosen', async () => {
    const { user, router } = open('/admin/staff', KEYS.approver);
    await table();

    await user.click(viewTab('Active'));

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('ACTIVE');
    });
    expect(router.state.location.search).toBe('?view=active');
    expect(viewTab('Active')).toHaveAttribute('aria-selected', 'true');
  });

  it('shows everyone when "Everyone" is chosen, with no status asked for', async () => {
    const { user } = open('/admin/staff', KEYS.approver);
    await table();

    await user.click(viewTab('Everyone'));

    await waitFor(() => {
      expect(listRequests()).toHaveLength(2);
    });
    expect(queryOf().has('status')).toBe(false);
  });
});

describe('the staff list: searching', () => {
  it('searches by name or email when the form is sent, and puts the search in the address', async () => {
    const { user, router } = open('/admin/staff?view=all', KEYS.approver);
    await table();

    await user.type(await openSearch(user), 'kofi{Enter}');

    await waitFor(() => {
      expect(queryOf().get('q')).toBe('kofi');
    });
    expect(router.state.location.search).toBe('?view=all&q=kofi');
    // What is applied is a chip that can be taken off on its own.
    expect(screen.getByText('Search: kofi')).toBeVisible();
  });

  it('reads a search out of the address and shows it in the field and as a chip', async () => {
    const { user } = open('/admin/staff?view=all&q=mensah', KEYS.approver);

    await table();

    expect(queryOf(0).get('q')).toBe('mensah');
    expect(screen.getByText('Search: mensah')).toBeVisible();
    expect(await openSearch(user)).toHaveValue('mensah');
  });

  // Break caught: spaces around a search sent as part of it, which would find nobody.
  it('sends a search without the spaces around it, and a blank search as none', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver);
    await table();

    await user.type(await openSearch(user), '   kofi   {Enter}');
    await waitFor(() => {
      expect(queryOf().get('q')).toBe('kofi');
    });
    const field = await openSearch(user);
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

    await table();

    expect(queryOf(0).get('q')).toBe('kofi');
  });

  it('limits a search to what the server accepts, as it is typed', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver);
    await table();

    expect(await openSearch(user)).toHaveAttribute('maxlength', '128');
  });

  it('closes the search once it is sent, and gives focus back to the Filter button', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver);
    await table();

    await user.type(await openSearch(user), 'kofi{Enter}');

    await waitFor(() => {
      expect(screen.queryByRole('searchbox', { name: 'Search by name or email' })).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter' })).toHaveFocus();
    });
  });

  it('takes the search off with its chip and keeps the view', async () => {
    const { user, router } = open('/admin/staff?view=active&q=kofi', KEYS.approver);
    await table();

    await user.click(screen.getByRole('button', { name: 'Remove filter: Search: kofi' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?view=active');
    });
    await waitFor(() => {
      expect(queryOf().has('q')).toBe(false);
    });
    expect(screen.queryByText('Search: kofi')).toBeNull();
  });

  it('clears the search and the filter in one move', async () => {
    const { user, router } = open('/admin/staff?view=active&q=nobody', KEYS.approver, {
      [LIST]: () => staffPage([]),
    });
    await screen.findByText('No staff profiles match');

    await user.click(screen.getByRole('button', { name: 'Show everyone' }));

    await waitFor(() => {
      expect(router.state.location.search).toBe('?view=all');
    });
    expect(screen.queryByText('Search: nobody')).toBeNull();
    expect(await openSearch(user)).toHaveValue('');
  });
});

describe('the staff list: counting and paging', () => {
  it('counts what is waiting, exactly, when the whole queue is on the page', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => staffPage([kofi, ama]) });

    expect(await screen.findByText('2 profiles waiting for approval')).toBeInTheDocument();
    expect(await screen.findByText('Showing 2 profiles.')).toBeVisible();
  });

  // Break caught: "2 are waiting" for a queue that runs on to a next page, or for a later page of it.
  it('does not claim an exact count for a queue that runs past the page, or for a later page of it', async () => {
    const { user } = open('/admin/staff?view=waiting', KEYS.approver, {
      [LIST]: () => staffPage([kofi, ama], 'next-1'),
    });

    expect(
      await screen.findByText('Showing 2 profiles. More follow on the next page.'),
    ).toBeVisible();
    expect(screen.queryByText(/profiles? waiting for approval/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText(/Showing 2 profiles on page 2\./)).toBeVisible();
    expect(screen.queryByText(/profiles? waiting for approval/)).toBeNull();
  });

  // Break caught: the queue's count drawn for a search of it, which is some of the queue and not all.
  it('does not claim an exact count for a search of the queue', async () => {
    open('/admin/staff?view=waiting&q=kofi', KEYS.approver, {
      [LIST]: () => staffPage([kofi]),
    });

    expect(await screen.findByText('Showing 1 profile.')).toBeVisible();
    expect(screen.queryByText(/profiles? waiting for approval/)).toBeNull();
  });

  it('says it in the singular for one', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => staffPage([kofi]) });

    expect(await screen.findByText('1 profile waiting for approval')).toBeInTheDocument();
  });

  it('counts a page without claiming to know the total', async () => {
    open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi, ama], 'next-1'),
    });

    expect(
      await screen.findByText('Showing 2 profiles. More follow on the next page.'),
    ).toBeVisible();
    expect(screen.queryByText(/profiles? waiting for approval/)).toBeNull();
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

    expect(await screen.findByText('Loading staff profiles')).toBeVisible();
    expect(screen.queryByText(/profiles? waiting|Showing/)).toBeNull();
    release();
    expect(await screen.findByText('1 profile waiting for approval')).toBeInTheDocument();
  });

  it('goes to the next page with the token the server gave, and back to the first', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi], 'next-1'),
    });
    await table();
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

    await table();

    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  // Break caught: the next page of one filter shown for another, because the page position outlived the change.
  it('starts again at the first page when the view or the search changes', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi], 'next-1'),
    });
    await table();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    await user.click(viewTab('Active'));

    await waitFor(() => {
      expect(queryOf().get('status')).toBe('ACTIVE');
    });
    expect(queryOf().has('page_token')).toBe(false);
    await waitFor(() => {
      expect(screen.queryByText(/on page 2/)).toBeNull();
    });
  });

  // The pager's words are the same element through a read (the review of 499399c), and once a page is read focus is on the results.
  it('keeps the pager’s status region through a read of the next page, and puts focus on the results', async () => {
    const { user } = open('/admin/staff?view=all', KEYS.approver, {
      [LIST]: () => staffPage([kofi], 'next-1'),
    });
    await table();
    await screen.findByText(/Showing 1 profile\./);
    const before = pagerRegion();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText(/on page 2/);

    expect(pagerRegion()).toBe(before);
    await waitFor(() => {
      const results = within(screen.getByRole('main')).getByRole('region', {
        name: 'Staff profiles',
      });
      expect(results).toHaveFocus();
    });
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
    expect(profileRows()).toHaveLength(0);
  });

  it('tells a filter that hides everything differently, and offers the way out', async () => {
    open('/admin/staff?view=suspended', KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(await screen.findByRole('heading', { name: 'No staff profiles match' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show everyone' })).toBeVisible();
    expect(
      screen.getByText('Nothing fits this view and search. Show everyone to start again.'),
    ).toBeVisible();
    expect(screen.queryByText('Nothing is waiting for approval')).toBeNull();
  });

  // Break caught: a blank search in the address taken for a search, so that an empty queue reads "no profiles match".
  it('takes a blank search in the address for none, and tells an empty queue as nothing waiting', async () => {
    open('/admin/staff?view=waiting&q=%20%20', KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(
      await screen.findByRole('heading', { name: 'Nothing is waiting for approval' }),
    ).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No staff profiles match' })).toBeNull();
    expect(screen.queryByText(/^Search: /)).toBeNull();
  });

  it('tells a search that finds nobody as a filter, even in the queue', async () => {
    open('/admin/staff?view=waiting&q=nobody', KEYS.approver, { [LIST]: () => staffPage([]) });

    expect(await screen.findByRole('heading', { name: 'No staff profiles match' })).toBeVisible();
  });

  it('tells a list with no one on it', async () => {
    open('/admin/staff?view=all', KEYS.reader, { [LIST]: () => staffPage([]) });

    expect(await screen.findByRole('heading', { name: 'No staff profiles yet' })).toBeVisible();
    expect(screen.getByText('Profiles that are created at your hubs appear here.')).toBeVisible();
  });

  // Break caught: an empty search echoing what was typed back as markup or as a claim about the person. The chip shows the search as text, the way every chip does,
  // and the words of the empty state never repeat it.
  it('shows the search as text and never as markup, and does not repeat it in the words', async () => {
    open('/admin/staff?view=all&q=%3Cb%3Ex%3C%2Fb%3E', KEYS.approver, {
      [LIST]: () => staffPage([]),
    });

    await screen.findByRole('heading', { name: 'No staff profiles match' });

    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByText('Search: <b>x</b>')).toBeVisible();
    // The heading and its line are the empty state's own words, in one block.
    const words = screen.getByRole('heading', { name: 'No staff profiles match' }).parentElement;
    expect(words?.textContent).toContain('Nothing fits this view and search.');
    expect(words?.textContent).not.toContain('<b>');
  });
});

describe('the staff list: when it cannot be had', () => {
  it('says so in approved words with a retry, and never the server’s text', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(500, 'INTERNAL_ERROR') });

    await alertSaying('The staff list could not be loaded.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(DIAGNOSTIC);
  });

  it('names what the account cannot do when the server refuses the key', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(403, 'PERMISSION_DENIED') });

    await alertSaying(cannotText('staff.read'));
    expect(profileRows()).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/staff\.read/);
  });

  // Break caught (the review of f6cf02b): every kind of refusal of authority told as a missing key (`cannotText('staff.read')`), so a person who needs a higher authority, or whose list is
  // of a hub their account does not work in, was told to ask for access they may hold. Each kind has its own words, the table's, as the refusal components give them.
  it('tells a refusal for a higher authority in its own words, and not as a missing key', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(403, 'INSUFFICIENT_AUTHORITY') });

    const alert = await alertSaying('This needs a higher authority than your session has.');
    expect(alert).not.toHaveTextContent('Ask an administrator for access');
    expect(profileRows()).toHaveLength(0);
  });

  it('tells a refusal for a hub in its own words, and not as a missing key', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(403, 'HUB_SCOPE_VIOLATION') });

    const alert = await alertSaying(
      'These staff profiles are at a hub your account does not work in.',
    );
    expect(alert).not.toHaveTextContent('Ask an administrator for access');
    expect(profileRows()).toHaveLength(0);
  });

  // Break caught: an answer that is not a list believed, and shown as an empty queue.
  it('treats an answer that is not a list as an answer that is not the API’s', async () => {
    open('/admin/staff', KEYS.approver, { [LIST]: () => json(200, { surprise: true }) });

    await alertSaying('The staff list could not be loaded.');
    expect(screen.queryByText('Nothing is waiting for approval')).toBeNull();
  });

  it('words a refused search for the search', async () => {
    open('/admin/staff?view=all&q=x', KEYS.approver, {
      [LIST]: () => refusal(400, 'VALIDATION_FAILED'),
    });

    await alertSaying('That search was not accepted. Use at most 128 characters.');
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

      expect(await screen.findByText('Loading staff profiles')).toBeVisible();
      expect(profileRows()).toHaveLength(0);
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
      const { user } = open('/admin/staff?view=all&q=x', KEYS.approver, {
        [LIST]: () => refusal(400, 'VALIDATION_FAILED'),
      });

      await alertSaying('That search was not accepted. Use at most 128 characters.');
      expect(await openSearch(user)).toHaveAttribute('maxlength', '128');
    },
  },
  error: {
    test: async () => {
      open('/admin/staff', KEYS.approver, { [LIST]: () => refusal(500, 'INTERNAL_ERROR') });

      await alertSaying('The staff list could not be loaded.');
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

      await user.click(await screen.findByRole('button', { name: 'Retry' }));

      expect(await screen.findByRole('link', { name: 'Kofi Boateng' })).toBeVisible();
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
    await table();
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
    await alertSaying('The staff list could not be loaded.');
    expect(await wcagViolations(failed.container)).toEqual([]);
  });
});
