import { describe, expect, it } from 'vitest';

import {
  ANY_SIGNED_IN_SESSION,
  NAVIGATION_GROUPS,
  NAVIGATION_GROUP_LABELS,
  navigationFor,
  registryProblems,
  type MenuEntry,
  type NavigableRoute,
  type RouteAccess,
} from './navigation-model';

/**
 * The derivation of the menus: keys and routes in, the sidebar's groups, the New menu's actions and the account menu's pages out. The routes
 * here exist only in these tests; the real registry's own entries are held in `route-registry.test.tsx`.
 */
const route = (path: string, access: RouteAccess, menu: MenuEntry | null): NavigableRoute => ({
  path,
  access,
  menu,
});

const key = (permission: string): RouteAccess => ({ permission });

const ROUTES: readonly NavigableRoute[] = [
  // Deliberately out of the order of the menu: the order is the derivation's, not the registry's.
  route('/admin/staff', key('staff.read'), {
    place: 'sidebar',
    group: 'people',
    label: 'Staff',
    icon: 'staff',
    order: 0,
    queue: 'STAFF_AWAITING_APPROVAL',
  }),
  route('/messages', key('notification.read'), {
    place: 'sidebar',
    group: 'system',
    label: 'Message log',
    icon: 'messages',
    order: 0,
  }),
  route('/', ANY_SIGNED_IN_SESSION, {
    place: 'sidebar',
    group: 'today',
    label: 'My work',
    icon: 'my-work',
    order: 0,
  }),
  route('/approvals', key('pickup.exception.approve'), {
    place: 'sidebar',
    group: 'today',
    label: 'Decisions',
    icon: 'exception-approvals',
    order: 1,
    queue: 'PICKUP_EXCEPTION_APPROVAL',
  }),
  route('/manifests', key('pickup.read'), {
    place: 'sidebar',
    group: 'pickups',
    label: 'Pickup runs',
    icon: 'manifests',
    order: 1,
    queue: 'PICKUP_RUNS_IN_PROGRESS',
  }),
  route('/pickup-requests', key('pickup.read'), {
    place: 'sidebar',
    group: 'pickups',
    label: 'Requests',
    icon: 'pickup-requests',
    order: 0,
    queue: 'PICKUP_AWAITING_CONFIRMATION',
  }),
  route('/pickup-requests/new', key('pickup.request.create'), {
    place: 'create',
    label: 'Book a pickup',
    icon: 'book-pickup',
    order: 0,
  }),
  route('/manifests/new', key('pickup.manifest.create'), {
    place: 'create',
    label: 'Build a pickup run',
    icon: 'build-manifest',
    order: 1,
  }),
  route('/account/trusted-browsers', ANY_SIGNED_IN_SESSION, {
    place: 'account',
    label: 'Trusted browsers',
    icon: 'trusted-browsers',
    order: 0,
  }),
  // Reached from another page: in no menu, whatever the session holds.
  route('/pickup-requests/:id', key('pickup.read'), null),
];

const labelsOf = (permissions: readonly string[] | undefined) =>
  navigationFor(permissions, ROUTES).groups.map((group) => [
    group.label,
    group.entries.map((entry) => entry.label),
  ]);

describe('the groups of the sidebar', () => {
  // Break caught: groups drawn in the order the registry lists them (or by the order a page happens to have), which would put Pickups under
  // System for the next page someone adds. The order is the hub's day, and it is fixed.
  it('come in the order of the hub’s day, whatever order the routes are listed in', () => {
    const all = [
      'staff.read',
      'notification.read',
      'pickup.exception.approve',
      'pickup.read',
      'pickup.request.create',
      'pickup.manifest.create',
    ];

    expect(labelsOf(all)).toEqual([
      ['Today', ['My work', 'Decisions']],
      ['Pickups', ['Requests', 'Pickup runs']],
      ['People and access', ['Staff']],
      ['System', ['Message log']],
    ]);
  });

  // Break caught: a group drawn for a session that holds no key of any of its pages (an empty heading, or one that tells a person that a part of
  // the product exists that they have no use of), or a page offered to a session that does not hold its key.
  it('show a group only when the session holds the key of one of its pages', () => {
    expect(labelsOf(['pickup.read'])).toEqual([
      ['Today', ['My work']],
      ['Pickups', ['Requests', 'Pickup runs']],
    ]);
    expect(labelsOf(['staff.read'])).toEqual([
      ['Today', ['My work']],
      ['People and access', ['Staff']],
    ]);
    expect(labelsOf(['notification.read'])).toEqual([
      ['Today', ['My work']],
      ['System', ['Message log']],
    ]);
  });

  // Break caught: Decisions shown to somebody who cannot decide, or hidden from somebody who can: it is the approver's page, behind its own key.
  it('put Decisions in Today for the holders of its key and for no one else', () => {
    expect(labelsOf(['pickup.exception.approve'])).toEqual([['Today', ['My work', 'Decisions']]]);
    expect(labelsOf(['pickup.read'])[0]).toEqual(['Today', ['My work']]);
  });

  // Break caught: a key matched by what it starts with, or contains: a session that holds `staff.read.extra` or `staff` would see the staff page.
  it('match a key exactly', () => {
    expect(labelsOf(['staff', 'staff.reader', 'xstaff.read', 'STAFF.READ'])).toEqual([
      ['Today', ['My work']],
    ]);
  });

  // Break caught: a session that lists no permissions given a menu of everything (or of nothing, with no way home).
  it('give a session that lists no permissions the entries that need none, and a session that lists an empty set the same', () => {
    expect(labelsOf(undefined)).toEqual([['Today', ['My work']]]);
    expect(labelsOf([])).toEqual([['Today', ['My work']]]);
  });

  // Break caught: a group in the list of seven that has no page yet drawn all the same (Hub, Dispatch and Money have none), which would
  // put placeholders into the menu (DESIGN_SYSTEM section 22).
  it('never draw a group that has no page, though it is one of the seven', () => {
    const drawn = navigationFor(
      ['staff.read', 'notification.read', 'pickup.read', 'pickup.exception.approve'],
      ROUTES,
    ).groups.map((group) => group.id);

    expect(NAVIGATION_GROUPS).toEqual([
      'today',
      'pickups',
      'hub',
      'dispatch',
      'money',
      'people',
      'system',
    ]);
    expect(drawn).not.toContain('hub');
    expect(drawn).not.toContain('dispatch');
    expect(drawn).not.toContain('money');
  });

  it('are named in the words of the Product Owner’s decision of 5 November 2026', () => {
    expect(NAVIGATION_GROUP_LABELS).toEqual({
      today: 'Today',
      pickups: 'Pickups',
      hub: 'Hub',
      dispatch: 'Dispatch',
      money: 'Money',
      people: 'People and access',
      system: 'System',
    });
  });

  // Break caught: entries left in the order the registry lists them, so that the order of a menu is the order a file happens to be written in.
  it('order the entries of a group by their place, and not by the order the routes are listed in', () => {
    const listed: readonly NavigableRoute[] = [
      route('/b', ANY_SIGNED_IN_SESSION, {
        place: 'sidebar',
        group: 'today',
        label: 'Beta',
        icon: 'staff',
        order: 2,
      }),
      route('/a', ANY_SIGNED_IN_SESSION, {
        place: 'sidebar',
        group: 'today',
        label: 'Alpha',
        icon: 'riders',
        order: 1,
      }),
      route('/z', ANY_SIGNED_IN_SESSION, {
        place: 'sidebar',
        group: 'today',
        label: 'Zeta',
        icon: 'vendors',
        order: 0,
      }),
    ];

    expect(navigationFor([], listed).groups[0]?.entries.map((entry) => entry.label)).toEqual([
      'Zeta',
      'Alpha',
      'Beta',
    ]);
  });

  // Break caught: the queue of an entry lost on the way to the menu, so that a count has no entry to be drawn beside; or a count on an entry that
  // has none of its own.
  it('carry the queue of an entry, and only the entries that have one', () => {
    const { groups } = navigationFor(
      ['pickup.read', 'pickup.exception.approve', 'staff.read'],
      ROUTES,
    );
    const queues = Object.fromEntries(
      groups.flatMap((group) => group.entries.map((entry) => [entry.label, entry.queue])),
    );

    expect(queues).toEqual({
      'My work': undefined,
      Decisions: 'PICKUP_EXCEPTION_APPROVAL',
      Requests: 'PICKUP_AWAITING_CONFIRMATION',
      'Pickup runs': 'PICKUP_RUNS_IN_PROGRESS',
      Staff: 'STAFF_AWAITING_APPROVAL',
    });
  });

  it('give the entry its address and its icon', () => {
    const [today] = navigationFor([], ROUTES).groups;

    expect(today?.entries[0]).toEqual({ to: '/', label: 'My work', icon: 'my-work' });
  });
});

describe('the New menu and the account menu', () => {
  // Break caught: a create page offered for a key the session does not hold, or left in the sidebar (the brief moved every create action out
  // of it), or the page without its own entry.
  it('list the create pages whose key the session holds, in their order, and not in the sidebar', () => {
    const both = navigationFor(['pickup.request.create', 'pickup.manifest.create'], ROUTES);
    expect(both.create.map((entry) => [entry.label, entry.to])).toEqual([
      ['Book a pickup', '/pickup-requests/new'],
      ['Build a pickup run', '/manifests/new'],
    ]);
    expect(both.groups.flatMap((group) => group.entries.map((entry) => entry.to))).not.toContain(
      '/pickup-requests/new',
    );

    expect(
      navigationFor(['pickup.manifest.create'], ROUTES).create.map((entry) => entry.label),
    ).toEqual(['Build a pickup run']);
    expect(navigationFor([], ROUTES).create).toEqual([]);
  });

  // Break caught: the trusted browsers left in the sidebar, or offered by a key (any signed-in session may open it).
  it('list the personal pages to every signed-in session and keep them out of the sidebar', () => {
    const none = navigationFor([], ROUTES);

    expect(none.account.map((entry) => entry.label)).toEqual(['Trusted browsers']);
    expect(none.groups.flatMap((group) => group.entries.map((entry) => entry.to))).not.toContain(
      '/account/trusted-browsers',
    );
  });

  // Break caught: a count drawn beside a create action (the New menu draws none: a count is of a queue, and a queue is worked in its own entry).
  it('carry no queue', () => {
    const { create } = navigationFor(['pickup.manifest.create'], ROUTES);

    expect(create.every((entry) => entry.queue === undefined)).toBe(true);
  });
});

describe('the soundness of a registry', () => {
  const sidebar = (
    overrides: Partial<Extract<MenuEntry, { place: 'sidebar' }>> = {},
  ): MenuEntry => ({
    place: 'sidebar',
    group: 'pickups',
    label: 'Requests',
    icon: 'pickup-requests',
    order: 0,
    ...overrides,
  });

  it('has no problem in a sound registry', () => {
    expect(registryProblems(ROUTES)).toEqual([]);
  });

  it('reports a path twice, and builds nothing from it', () => {
    const twice = [
      route('/a', ANY_SIGNED_IN_SESSION, null),
      route('/a', ANY_SIGNED_IN_SESSION, null),
    ];

    expect(registryProblems(twice).join(' ')).toMatch(/"\/a" is in the registry twice/);
    expect(() => navigationFor([], twice)).toThrow(/in the registry twice/);
  });

  it('reports a path that is not absolute, or has a query, a fragment or an empty segment', () => {
    for (const path of ['a', '/a/', '/a//b', '/a?x=1', '/a#x']) {
      expect(registryProblems([route(path, ANY_SIGNED_IN_SESSION, null)]).join(' '), path).toMatch(
        /is not an absolute path/,
      );
    }
  });

  it('reports a permission that is not shaped like a key of the catalogue', () => {
    expect(registryProblems([route('/a', key('Staff Read'), null)]).join(' ')).toMatch(
      /not a key of the catalogue's shape/,
    );
    expect(
      registryProblems([route('/a', { permission: 'staff.read', decidedBy: 'nope' }, null)]).join(
        ' ',
      ),
    ).toMatch(/deciding permission/);
  });

  it('reports an entry with no label, a description that says nothing, or an order that is not a whole number', () => {
    const problems = registryProblems([
      route('/a', ANY_SIGNED_IN_SESSION, sidebar({ label: '  ' })),
      route('/b', ANY_SIGNED_IN_SESSION, sidebar({ description: '', order: 1 })),
      route('/c', ANY_SIGNED_IN_SESSION, sidebar({ order: -1 })),
      route('/d', ANY_SIGNED_IN_SESSION, sidebar({ order: 1.5 })),
    ]).join(' ');

    expect(problems).toMatch(/"\/a" has no label/);
    expect(problems).toMatch(/"\/b" has a description that says nothing/);
    expect(problems).toMatch(/"\/c" has an order/);
    expect(problems).toMatch(/"\/d" has an order/);
  });

  // Break caught: a menu entry for a path with a parameter, which links to a page that is not there.
  it('reports a menu entry for a pattern', () => {
    expect(registryProblems([route('/a/:id', ANY_SIGNED_IN_SESSION, sidebar())]).join(' ')).toMatch(
      /is a pattern/,
    );
    expect(registryProblems([route('/a/:id', ANY_SIGNED_IN_SESSION, null)])).toEqual([]);
  });

  // Break caught: two entries drawn in one place, one hiding the other by the order of the list.
  it('reports two entries in one place of the same menu, and none for two in different menus', () => {
    expect(
      registryProblems([
        route('/a', ANY_SIGNED_IN_SESSION, sidebar()),
        route('/b', ANY_SIGNED_IN_SESSION, sidebar({ label: 'Other', icon: 'riders' })),
      ]).join(' '),
    ).toMatch(/Two menu entries have the place sidebar\/pickups\/0/);

    expect(
      registryProblems([
        route('/a', ANY_SIGNED_IN_SESSION, sidebar()),
        route('/b', ANY_SIGNED_IN_SESSION, sidebar({ group: 'system' })),
        route('/c', ANY_SIGNED_IN_SESSION, {
          place: 'create',
          label: 'New',
          icon: 'staff',
          order: 0,
        }),
        route('/d', ANY_SIGNED_IN_SESSION, {
          place: 'account',
          label: 'Mine',
          icon: 'account',
          order: 0,
        }),
      ]),
    ).toEqual([]);
  });

  // Break caught: one queue's count drawn beside two entries, which would say the same figure twice as if it were two queues'.
  it('reports one queue drawn beside two entries', () => {
    expect(
      registryProblems([
        route('/a', ANY_SIGNED_IN_SESSION, sidebar({ queue: 'PICKUP_RUNS_IN_PROGRESS' })),
        route(
          '/b',
          ANY_SIGNED_IN_SESSION,
          sidebar({ order: 1, queue: 'PICKUP_RUNS_IN_PROGRESS', icon: 'riders' }),
        ),
      ]).join(' '),
    ).toMatch(/PICKUP_RUNS_IN_PROGRESS is drawn beside two menu entries/);
  });

  it('reports an entry in a group that is not one of the seven', () => {
    expect(
      registryProblems([
        route('/a', ANY_SIGNED_IN_SESSION, sidebar({ group: 'elsewhere' as never })),
      ]).join(' '),
    ).toMatch(/not one/);
  });
});
