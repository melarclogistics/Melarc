import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { BUNDLE_KEY_SETS } from '../../test-support/bundle-key-sets';
import { installFakeApi, json, signedInApi, type FakeApi } from '../../test-support/fake-api';
import { listedManifestFixture } from '../../test-support/manifest-fixture';
import {
  NOTIFICATION_REQUEST_ID,
  notificationFixture,
} from '../../test-support/notification-fixture';
import { exceptionFixture, pickupRequestFixture } from '../../test-support/pickup-fixture';
import { riderFixture } from '../../test-support/rider-fixture';
import { bundlesAnswer, staffPage } from '../../test-support/staff-api';
import { staffIdentityFixture } from '../../test-support/staff-fixture';
import { renderApp } from '../../test-support/render-app';
import { sessionFixture } from '../../test-support/session-fixture';
import { vendorAccountFixture } from '../../test-support/vendor-fixture';

/**
 * What the hub switcher of the top bar does to the screens (the Product Owner, 5 November 2026; surfaces/ops-portal.md section 3): **the lists
 * that have a hub filter in the contract send it when one hub is chosen and send nothing for All hubs** (the staff, riders and vendors lists, and,
 * since task C3, the pickup requests, the pickup runs, the message log and the queue summary), **a list starts again at its first page when the
 * hub changes**, and **a create form starts with the chosen hub**. An act on a record is not tested here because it does not read the switcher: it
 * uses the record's own hub. (The queue summary is tested where it is drawn: `use-queue-summary.test.tsx`, `AuthenticatedOpsShell.counts.test.tsx`
 * and `MyWorkPage.test.tsx`.) These are the tests of `AC-HUBF-09` for the lists, with the exception it names (the message log of one record).
 */
let api: FakeApi;

afterEach(() => {
  // Every request a screen makes is one the test has answered: a read that nobody stubbed would be answered by nothing (review of 7 November 2026).
  expect(api.unhandled).toEqual([]);
  api.restore();
});

const ACCRA = { id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d', display_name: 'Accra Hub' };
const KUMASI = { id: '6c7d8e9f-0a12-4b3c-9d4e-5f6a7b8c9d0e', display_name: 'Kumasi Hub' };

const EMPTY_PAGE = () => json(200, { items: [], next_page_token: null });

function open(
  path: string,
  hubs = [ACCRA, KUMASI],
  handlers: Parameters<typeof installFakeApi>[0] = {},
) {
  api = installFakeApi({
    ...signedInApi(
      sessionFixture({
        permissions: [...BUNDLE_KEY_SETS['Platform Admin']],
        authorized_hubs: hubs,
      }),
    ),
    'GET /staff-identities': EMPTY_PAGE,
    'GET /ops/riders': EMPTY_PAGE,
    'GET /ops/vendors': EMPTY_PAGE,
    'GET /pickup-requests': EMPTY_PAGE,
    'GET /pickup-manifests': EMPTY_PAGE,
    'GET /notifications': EMPTY_PAGE,
    'GET /ops/queue-summary': () => json(200, { queues: [] }),
    'GET /staff-role-bundles/assignable': bundlesAnswer,
    ...handlers,
  });
  return renderApp(path);
}

const reads = (path: string) =>
  api.requests
    .filter(
      (request) => request.method === 'GET' && new URL(request.url).pathname === `/api/v1${path}`,
    )
    .map((request) => new URL(request.url).searchParams);

const switcher = (name: string) =>
  within(screen.getByRole('banner')).getByRole('button', { name: `Hub: ${name}` });

describe('the lists that have a hub filter follow the switcher', () => {
  it.each([
    ['staff', '/admin/staff', '/staff-identities', 'Staff'],
    ['riders', '/admin/riders', '/ops/riders', 'Riders'],
    ['vendors', '/admin/vendors', '/ops/vendors', 'Vendors'],
  ])(
    'sends hub_id for the %s list when one hub is chosen and nothing for All hubs',
    async (_name, route, path, title) => {
      const { user } = open(route);
      await screen.findByRole('heading', { level: 1, name: title });
      await waitFor(() => {
        expect(reads(path)).toHaveLength(1);
      });
      // Break caught: a list that sends a hub for All hubs, which narrows it to nothing the person asked for.
      expect(reads(path)[0]?.has('hub_id')).toBe(false);

      await user.click(switcher('All hubs'));
      await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

      // Break caught: a list that does not follow the switcher, so that the screen says Kumasi Hub and shows every hub.
      await waitFor(() => {
        expect(reads(path)).toHaveLength(2);
      });
      expect(reads(path)[1]?.get('hub_id')).toBe(KUMASI.id);

      await user.click(switcher('Kumasi Hub'));
      await user.click(await screen.findByRole('menuitemradio', { name: 'All hubs' }));

      await waitFor(() => {
        expect(reads(path)).toHaveLength(3);
      });
      expect(reads(path)[2]?.has('hub_id')).toBe(false);
    },
  );

  // Break caught: a hub sent for a session that has one (every request of the list would carry a parameter that narrows nothing).
  it.each([
    ['/admin/staff', '/staff-identities', 'Staff'],
    ['/admin/riders', '/ops/riders', 'Riders'],
    ['/admin/vendors', '/ops/vendors', 'Vendors'],
  ])('sends no hub_id for %s to a session that has one hub', async (route, path, title) => {
    open(route, [ACCRA]);
    await screen.findByRole('heading', { level: 1, name: title });
    await waitFor(() => {
      expect(reads(path)).toHaveLength(1);
    });

    expect(reads(path)[0]?.has('hub_id')).toBe(false);
  });

  // Break caught: the page of results of one hub asked for under another's filter: a token the server gave is good for the list it was given for.
  // Each of the three lists keeps the tokens of the pages it visited under a signature of its own filters, and each has the hub in it separately
  // (review of 7 November 2026: only the staff list was proved, and removing the hub from the riders' or the vendors' signature went unseen).
  it.each([
    {
      name: 'staff',
      route: '/admin/staff',
      handler: 'GET /staff-identities',
      path: '/staff-identities',
      text: 'Ama Mensah',
      page: (next: string | null): Response =>
        staffPage(next === null ? [] : [staffIdentityFixture({ full_name: 'Ama Mensah' })], next),
    },
    {
      name: 'riders',
      route: '/admin/riders',
      handler: 'GET /ops/riders',
      path: '/ops/riders',
      text: 'Kwame Mensah',
      page: (next: string | null): Response =>
        json(200, {
          items: next === null ? [] : [riderFixture({ full_name: 'Kwame Mensah' })],
          next_page_token: next,
        }),
    },
    {
      name: 'vendors',
      route: '/admin/vendors',
      handler: 'GET /ops/vendors',
      path: '/ops/vendors',
      text: 'Asante Fabrics Ltd',
      page: (next: string | null): Response =>
        json(200, {
          items: next === null ? [] : [vendorAccountFixture({ legal_name: 'Asante Fabrics Ltd' })],
          next_page_token: next,
        }),
    },
  ])(
    'starts the $name list again at its first page when the hub changes',
    async ({ route, handler, path, text, page }) => {
      const { user } = open(route, [ACCRA, KUMASI], {
        [handler]: (request: Request) =>
          new URL(request.url).searchParams.has('page_token') ? page(null) : page('second-page'),
      });
      await screen.findByText(text);
      await user.click(screen.getByRole('button', { name: /next/i }));
      await waitFor(() => {
        expect(reads(path).some((search) => search.get('page_token') === 'second-page')).toBe(true);
      });

      await user.click(switcher('All hubs'));
      await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

      await waitFor(() => {
        expect(reads(path).some((search) => search.get('hub_id') === KUMASI.id)).toBe(true);
      });
      const forKumasi = reads(path).filter((search) => search.get('hub_id') === KUMASI.id);
      expect(forKumasi.every((search) => !search.has('page_token'))).toBe(true);
    },
  );
});

/**
 * The screens of the four reads that task C3 gave a hub: where each is, what it reads, how it is titled and one row of it (for a page that has
 * a next page to go to). The queue summary is not among them: it has no page of its own. **The pool of the run builder is not among them either**
 * (audit R4-12, 7 November 2026): a run is for one hub, so the builder never reads for All hubs, asks which hub first, and reads the pool of the
 * run's hub also for a session of one hub; its own tests are `ManifestBuilderPage.test.tsx` ("a run is for one hub").
 */
const PAGES_OF_C3 = [
  {
    name: 'the pickup requests',
    route: '/pickup-requests',
    path: '/pickup-requests',
    title: 'Pickup requests',
    row: pickupRequestFixture(),
  },
  {
    name: 'the one-package exceptions to approve',
    route: '/approvals',
    path: '/pickup-requests',
    title: 'One-package exceptions to approve',
    row: pickupRequestFixture({
      declared_package_count: 1,
      one_package_exception: exceptionFixture(),
    }),
  },
  {
    name: 'the pickup runs',
    route: '/manifests',
    path: '/pickup-manifests',
    title: 'Pickup runs',
    row: listedManifestFixture(),
  },
  {
    name: 'the message log',
    route: '/messages',
    path: '/notifications',
    title: 'Messages',
    row: notificationFixture(),
  },
] as const;

describe('the pickup screens, the runs and the messages follow the switcher (task C3)', () => {
  it.each(PAGES_OF_C3)(
    'sends hub_id for $name when one hub is chosen and nothing for All hubs',
    async ({ route, path, title }) => {
      const { user } = open(route);
      await screen.findByRole('heading', { level: 1, name: title });
      await waitFor(() => {
        expect(reads(path)).toHaveLength(1);
      });
      // Break caught: a read that sends a hub for All hubs, which narrows it to nothing the person asked for.
      expect(reads(path)[0]?.has('hub_id')).toBe(false);

      await user.click(switcher('All hubs'));
      await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

      // Break caught: a read that does not follow the switcher, so that the screen says Kumasi Hub and shows every hub.
      await waitFor(() => {
        expect(reads(path)).toHaveLength(2);
      });
      expect(reads(path)[1]?.get('hub_id')).toBe(KUMASI.id);

      await user.click(switcher('Kumasi Hub'));
      await user.click(await screen.findByRole('menuitemradio', { name: 'All hubs' }));

      await waitFor(() => {
        expect(reads(path)).toHaveLength(3);
      });
      expect(reads(path)[2]?.has('hub_id')).toBe(false);
    },
  );

  // Break caught: a hub sent for a session that has one (every read would carry a parameter that narrows nothing).
  it.each(PAGES_OF_C3)(
    'sends no hub_id for $name to a session that has one hub',
    async ({ route, path, title }) => {
      open(route, [ACCRA]);
      await screen.findByRole('heading', { level: 1, name: title });
      await waitFor(() => {
        expect(reads(path)).toHaveLength(1);
      });

      expect(reads(path)[0]?.has('hub_id')).toBe(false);
    },
  );

  // Break caught: the page of results of one hub asked for under another's filter: a token the server gave is good for the list it was given for.
  it.each(PAGES_OF_C3)(
    'starts $name again at its first page when the hub changes',
    async ({ route, path, row }) => {
      const { user } = open(route, [ACCRA, KUMASI], {
        [`GET ${path}`]: (request) =>
          new URL(request.url).searchParams.has('page_token')
            ? json(200, { items: [], next_page_token: null })
            : json(200, { items: [row], next_page_token: 'second-page' }),
      });
      await user.click(await screen.findByRole('button', { name: /Next page/ }));
      await waitFor(() => {
        expect(reads(path).some((search) => search.get('page_token') === 'second-page')).toBe(true);
      });

      await user.click(switcher('All hubs'));
      await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

      await waitFor(() => {
        expect(reads(path).some((search) => search.get('hub_id') === KUMASI.id)).toBe(true);
      });
      const forKumasi = reads(path).filter((search) => search.get('hub_id') === KUMASI.id);
      expect(forKumasi.every((search) => !search.has('page_token'))).toBe(true);
    },
  );

  // Break caught: the messages about one request hidden by a switcher left on another hub: the log of a record is that record's, and the links
  // "Messages about this request" and "Messages about this run" lead to it from a record that a search can find in any hub. This is the exception
  // of AC-HUBF-09 (decided by the Product Owner, 7 November 2026): only the message log without a record takes the hub.
  it('does not narrow the messages about one record by the hub, whichever hub is chosen (AC-HUBF-09)', async () => {
    const { user } = open(
      `/messages?subject=${NOTIFICATION_REQUEST_ID}&subject_type=PICKUP_REQUEST`,
      [ACCRA, KUMASI],
      {
        'GET /notifications': () =>
          json(200, { items: [notificationFixture()], next_page_token: null }),
      },
    );
    await screen.findByRole('heading', { level: 1, name: 'Messages' });
    await waitFor(() => {
      expect(reads('/notifications')).toHaveLength(1);
    });

    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The choice neither narrowed the read of the record nor read it again.
    expect(reads('/notifications')).toHaveLength(1);
    expect(reads('/notifications')[0]?.get('subject_id')).toBe(NOTIFICATION_REQUEST_ID);
    expect(reads('/notifications')[0]?.has('hub_id')).toBe(false);
  });
});

/**
 * The lists that a hub narrows, with the plain words each has for being empty: **a chosen hub is a filter** (audit B1, 7 November 2026), so a list
 * with nothing in it while a hub is chosen says "Nothing at <hub>" and offers *Show all hubs*, and does not say "No <things> yet" as if nothing existed
 * anywhere. (The run builder is the one list that does not offer All hubs, because a run is for one hub: `ManifestBuilderPage.test.tsx`.)
 */
const EMPTY_LISTS = [
  { name: 'the pickup requests', route: '/pickup-requests', plain: 'No pickup requests yet' },
  {
    name: 'the one-package exceptions',
    route: '/approvals',
    plain: 'No exceptions waiting for approval yet',
  },
  { name: 'the pickup runs', route: '/manifests', plain: 'No pickup runs yet' },
  { name: 'the message log', route: '/messages', plain: 'No messages yet' },
  { name: 'the staff', route: '/admin/staff?view=all', plain: 'No staff profiles yet' },
  { name: 'the riders', route: '/admin/riders', plain: 'No riders yet' },
  { name: 'the vendors', route: '/admin/vendors', plain: 'No vendor accounts yet' },
] as const;

describe('an empty list counts the chosen hub as a filter (audit B1)', () => {
  // Break caught: a list that says "No riders yet" for a hub that has none while another has some, so that a person at one hub believes there is
  // nothing anywhere; or one that offers no way back to the hubs.
  it.each(EMPTY_LISTS)(
    '$name: says Nothing at the hub, and Show all hubs takes the hub off',
    async ({ route, plain }) => {
      const { user } = open(route);
      expect(await screen.findByRole('heading', { name: plain })).toBeVisible();

      await user.click(switcher('All hubs'));
      await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

      expect(await screen.findByRole('heading', { name: 'Nothing at Kumasi Hub' })).toBeVisible();
      expect(screen.queryByRole('heading', { name: plain })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Show all hubs' }));

      expect(await screen.findByRole('heading', { name: plain })).toBeVisible();
      expect(screen.queryByRole('heading', { name: /^Nothing at / })).toBeNull();
      expect(switcher('All hubs')).toBeVisible();
    },
  );

  // Break caught: a hub named for a session that has none to choose (the plain words are the true ones when there is only one hub).
  it.each(EMPTY_LISTS)(
    '$name: keeps the plain words for a session of one hub, which has no hub to choose',
    async ({ route, plain }) => {
      open(route, [ACCRA]);

      expect(await screen.findByRole('heading', { name: plain })).toBeVisible();
      expect(screen.queryByRole('heading', { name: /^Nothing at / })).toBeNull();
    },
  );

  // Break caught: the other filters forgotten once a hub is chosen (the page says it is the hub alone, and the person cannot take the search off).
  it('offers the other filters beside Show all hubs when a search is set as well', async () => {
    const { user } = open('/admin/riders?q=zzz');
    await screen.findByRole('heading', { name: 'No riders match' });
    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

    expect(await screen.findByRole('heading', { name: 'Nothing at Kumasi Hub' })).toBeVisible();
    expect(
      screen.getByText(
        'No riders at Kumasi Hub fit these filters. Show all hubs, or take the other filters off.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Show all hubs' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Show every rider' }));

    // The search is off and the hub is still chosen: the words are the hub's alone.
    expect(
      await screen.findByText(
        'No riders at Kumasi Hub. Show all hubs to see those of every hub your session reaches.',
      ),
    ).toBeVisible();
    expect(switcher('Kumasi Hub')).toBeVisible();
  });

  // The exception of AC-HUBF-09: the log of one record is the record's whatever hub is chosen, so an empty one is not the hub's to explain.
  it('does not blame the hub for an empty log of one record (AC-HUBF-09)', async () => {
    const { user } = open(
      `/messages?subject=${NOTIFICATION_REQUEST_ID}&subject_type=PICKUP_REQUEST`,
    );
    expect(await screen.findByRole('heading', { name: 'No messages match' })).toBeVisible();

    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));

    expect(screen.getByRole('heading', { name: 'No messages match' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: /^Nothing at / })).toBeNull();
  });
});

describe('the choice of hub lasts as long as the session (audit B6)', () => {
  // Break caught: the choice held by the shell, which is unmounted by a page outside it (the neutral page of an address that matches no route), so that
  // Back from that page finds the hub gone and the screens showing every hub again, under a switcher that says All hubs.
  it('keeps the hub chosen when the person goes to a page outside the shell and comes back', async () => {
    const { user, router } = open('/admin/riders');
    await screen.findByRole('heading', { level: 1, name: 'Riders' });
    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));
    await waitFor(() => {
      expect(reads('/ops/riders').some((search) => search.get('hub_id') === KUMASI.id)).toBe(true);
    });

    await act(async () => {
      await router.navigate('/nowhere/at/all');
    });
    await screen.findByRole('heading', { level: 1, name: 'Page not found' });
    // The shell is not on the screen (its switcher is gone with it): the choice was not kept by it.
    expect(screen.queryByRole('button', { name: /^Hub:/ })).toBeNull();
    await act(async () => {
      await router.navigate(-1);
    });

    await screen.findByRole('heading', { level: 1, name: 'Riders' });
    expect(
      await within(screen.getByRole('banner')).findByRole('button', { name: 'Hub: Kumasi Hub' }),
    ).toBeVisible();
    // The list that is asked for on the way back is the hub's, not every hub's.
    await waitFor(() => {
      expect(reads('/ops/riders').at(-1)?.get('hub_id')).toBe(KUMASI.id);
    });
  });
});

describe('the create forms start with the chosen hub', () => {
  // Break caught: a form that ignores the switcher (the Product Owner: "a create form starts with the chosen hub filled in"), or one that starts
  // with a hub the person did not choose when they chose All hubs.
  it('books a walk-in into the chosen hub, and starts empty for All hubs', async () => {
    const first = open('/pickup-requests/new');
    await first.user.click(await screen.findByRole('radio', { name: 'A walk-in sender' }));
    expect(screen.getByRole('combobox', { name: /^Hub/ })).toHaveValue('');
    first.unmount();
    api.restore();

    const { user } = open('/');
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Kumasi Hub' }));
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Book a pickup' }));

    await user.click(await screen.findByRole('radio', { name: 'A walk-in sender' }));
    expect(screen.getByRole('combobox', { name: /^Hub/ })).toHaveValue(KUMASI.id);
  });

  it('places a staff profile in the chosen hub, and starts empty for All hubs', async () => {
    const first = open('/admin/staff/new');
    await screen.findByRole('heading', { level: 1, name: 'Add a staff profile' });
    expect(await screen.findByRole('combobox', { name: 'Primary hub' })).toHaveValue('');
    first.unmount();
    api.restore();

    const { user } = open('/');
    await screen.findByRole('heading', { level: 1, name: 'My work' });
    await user.click(switcher('All hubs'));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Accra Hub' }));
    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add a staff profile' }));

    await screen.findByRole('heading', { level: 1, name: 'Add a staff profile' });
    expect(await screen.findByRole('combobox', { name: 'Primary hub' })).toHaveValue(ACCRA.id);
  });

  // Break caught: the one hub of a session lost to the switcher's rule: a person who acts in one hub books into it without choosing.
  it('keeps a session of one hub booking into it without choosing', async () => {
    const { user } = open('/pickup-requests/new', [ACCRA]);
    await user.click(await screen.findByRole('radio', { name: 'A walk-in sender' }));

    expect(screen.getByRole('combobox', { name: /^Hub/ })).toHaveValue(ACCRA.id);
  });
});
