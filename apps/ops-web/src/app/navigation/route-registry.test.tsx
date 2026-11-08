import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isValidElement } from 'react';
import { matchRoutes } from 'react-router';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { ICON_NAMES } from '../../components/ui/icon/icons';
import { QueueContinuityScope } from '../../platform/pickup/QueueContinuityScope';
import { BUNDLE_KEY_SETS, type BundleName } from '../../test-support/bundle-key-sets';
import { createAppRoutes } from '../routes';
import {
  ANY_SIGNED_IN_SESSION,
  destinationsFor,
  entriesFor,
  NAVIGATION_AREAS,
  registryProblems,
  SIGNED_IN_ROUTES,
  signedInRouteObjects,
  type SignedInRoute,
} from './route-registry';

/**
 * Routes that exist only in these tests. They are shaped like the identity administration routes of surfaces/ops-portal.md section 7, so
 * that "what would this kind of person see" has something to filter, but none of them is a route of the product: S0.44 adds those to
 * the real registry and to nothing else.
 */
const page = (name: string) => <p>{name}</p>;

const FIXTURE_ROUTES: readonly SignedInRoute[] = [
  {
    path: '/',
    element: page('Home'),
    access: ANY_SIGNED_IN_SESSION,
    menu: { label: 'Home', icon: 'staff', area: 'overview', order: 0 },
  },
  {
    path: '/admin/staff',
    element: page('Staff'),
    access: { permission: 'staff.read' },
    menu: {
      label: 'Staff identities',
      icon: 'staff',
      area: 'administration',
      order: 10,
      description: 'Find a profile.',
    },
  },
  {
    path: '/admin/staff/new',
    element: page('New staff'),
    access: { permission: 'staff.identity.create' },
    menu: { label: 'New staff identity', icon: 'staff', area: 'administration', order: 20 },
  },
  {
    path: '/admin/staff/:id',
    element: page('A staff identity'),
    access: { permission: 'staff.read' },
    menu: null,
  },
  {
    path: '/admin/vendors',
    element: page('Vendors'),
    access: { permission: 'vendor.read' },
    menu: { label: 'Vendor accounts', icon: 'staff', area: 'administration', order: 30 },
  },
  {
    path: '/admin/riders',
    element: page('Riders'),
    access: { permission: 'dispatch.read' },
    menu: { label: 'Riders', icon: 'staff', area: 'administration', order: 40 },
  },
  {
    path: '/admin/sessions',
    element: page('Sessions'),
    access: { permission: 'staff.read' },
    menu: { label: 'Live sessions', icon: 'staff', area: 'administration', order: 50 },
  },
];

const labels = (permissions: readonly string[] | undefined, routes = FIXTURE_ROUTES): string[] =>
  entriesFor(permissions, routes).map((item) => item.label);

describe('the navigation of each kind of person, from the keys their session holds', () => {
  // The expectations are written out by hand from the route table of surfaces/ops-portal.md section 7: who holds which key is the
  // seed's (BUNDLE_KEY_SETS, held to the seed by scripts/shell-bundles.test.ts), and no production code here names a role.
  const EXPECTED: Record<BundleName, string[]> = {
    // Ops Staff do not hold staff.read: "they see no menu entry" for the staff list, and none for the sessions page it also gates.
    'Ops Staff': ['Home', 'New staff identity', 'Vendor accounts', 'Riders'],
    'Senior Ops': [
      'Home',
      'Staff identities',
      'New staff identity',
      'Vendor accounts',
      'Riders',
      'Live sessions',
    ],
    'Platform Admin': [
      'Home',
      'Staff identities',
      'New staff identity',
      'Vendor accounts',
      'Riders',
      'Live sessions',
    ],
    // Finance holds one key of this slice: it reads vendor accounts.
    'Finance/Reconciliation': ['Home', 'Vendor accounts'],
  };

  it.each(Object.keys(BUNDLE_KEY_SETS) as BundleName[])(
    'shows %s what its keys allow',
    (bundle) => {
      expect(labels(BUNDLE_KEY_SETS[bundle])).toEqual(EXPECTED[bundle]);
    },
  );

  // Break caught: a menu that grows for somebody with an extra key it has no screen for, or that offers an entry for a key the
  // person does not hold.
  it('gives each kind of person the entries of exactly the keys they hold', () => {
    const everything = new Set(FIXTURE_ROUTES.map((route) => route.path));

    for (const bundle of Object.keys(BUNDLE_KEY_SETS) as BundleName[]) {
      const held = new Set<string>(BUNDLE_KEY_SETS[bundle]);
      const offered = entriesFor(BUNDLE_KEY_SETS[bundle], FIXTURE_ROUTES).map((item) => item.to);
      for (const route of FIXTURE_ROUTES) {
        const allowed = route.access === ANY_SIGNED_IN_SESSION || held.has(route.access.permission);
        const shouldBeOffered = allowed && route.menu !== null;
        expect(offered.includes(route.path), `${bundle}: ${route.path}`).toBe(shouldBeOffered);
        expect(everything.has(route.path)).toBe(true);
      }
    }
  });

  it('shows a session that holds nothing the entries that need nothing', () => {
    expect(labels([])).toEqual(['Home']);
  });

  // Break caught: a session whose answer carried no list at all being shown the keyed entries. `permissions` is optional in the
  // answer, and no list means no key.
  it('shows a session that lists no permissions only the entries that need none', () => {
    expect(labels(undefined)).toEqual(['Home']);
  });

  // Break caught: a key matched as a prefix or a substring, or without regard to case, which would open an entry the key does not.
  it.each([
    ['a longer key', ['staff.read.all']],
    ['a shorter key', ['staff']],
    ['another case', ['STAFF.READ']],
    ['a key with a space', ['staff.read ']],
  ])('does not take %s for staff.read', (_label, held) => {
    expect(labels(held)).toEqual(['Home']);
  });

  // Break caught: the order of the menu following the order the keys were granted in, or the order the routes were declared in.
  it('orders the entries by area and then by their place in it, whatever order they were declared in', () => {
    const reversed = [...FIXTURE_ROUTES].reverse();

    expect(labels(BUNDLE_KEY_SETS['Platform Admin'], reversed)).toEqual(
      labels(BUNDLE_KEY_SETS['Platform Admin']),
    );
    expect(labels(BUNDLE_KEY_SETS['Platform Admin'])[0]).toBe('Home');
  });

  it('gives a plain list of where to go, what to call it and its picture, and nothing about why', () => {
    const items = entriesFor(BUNDLE_KEY_SETS['Senior Ops'], FIXTURE_ROUTES);

    for (const item of items) expect(Object.keys(item).toSorted()).toEqual(['icon', 'label', 'to']);
  });

  it('never offers the way to a screen that is reached from another screen', () => {
    expect(
      entriesFor(BUNDLE_KEY_SETS['Platform Admin'], FIXTURE_ROUTES).map((item) => item.to),
    ).not.toContain('/admin/staff/:id');
  });
});

describe('the places to go from the landing', () => {
  const destinations = (permissions: readonly string[] | undefined, routes = FIXTURE_ROUTES) =>
    destinationsFor(permissions, routes);

  // Break caught: the landing offering itself, a place the keys do not allow, or a screen that is only reached from another.
  it('lists what the keys allow, in the menu’s order, and not the overview', () => {
    expect(destinations(BUNDLE_KEY_SETS['Senior Ops']).map((item) => item.label)).toEqual([
      'Staff identities',
      'New staff identity',
      'Vendor accounts',
      'Riders',
      'Live sessions',
    ]);
    expect(destinations([])).toEqual([]);
    expect(destinations(undefined)).toEqual([]);
  });

  it('says where each goes and, where the screen has one, what it is for', () => {
    expect(destinations(['staff.read', 'staff.identity.create'])).toEqual([
      {
        to: '/admin/staff',
        label: 'Staff identities',
        icon: 'staff',
        description: 'Find a profile.',
      },
      { to: '/admin/staff/new', label: 'New staff identity', icon: 'staff' },
      { to: '/admin/sessions', label: 'Live sessions', icon: 'staff' },
    ]);
  });

  // Break caught: the list and the menu drifting apart, so the landing offers a place the menu does not or the other way round.
  it('is the menu without the overview, whoever asks', () => {
    for (const keys of Object.values(BUNDLE_KEY_SETS)) {
      expect(destinations(keys).map((item) => item.to)).toEqual(
        entriesFor(keys, FIXTURE_ROUTES)
          .map((item) => item.to)
          .filter((to) => to !== '/'),
      );
    }
  });
});

describe('the real registry', () => {
  /**
   * The keys of the pickup screens (S1.19). The seed grants none of them to a bundle yet (its grants follow with the API of the slice, and
   * `BUNDLE_KEY_SETS` is held to the seed), so they are named here, beside the bundles' keys, for the questions that need every key held.
   */
  const PICKUP_KEYS = [
    'pickup.read',
    'pickup.manifest.create',
    'pickup.request.create',
    'pickup.request.confirm',
    'pickup.request.cancel',
    'pickup.exception.request',
    'pickup.exception.approve',
  ];

  // Break caught: an entry for a feature that is not built (surfaces/ops-portal.md section 4: "a permission that exists in the catalogue
  // exposes no entry for a feature that is not built"). Every key of every bundle, held at once, shows the screens that exist and no more:
  // the keys of the catalogue that have no screen yet (a vendor's, a rider's, the recovery of a credential) add nothing.
  it('offers the screens that exist, and no more, to a person who holds every key of every bundle', () => {
    const everyKey = [...Object.values(BUNDLE_KEY_SETS).flat(), ...PICKUP_KEYS];

    expect(entriesFor(everyKey).map((item) => item.to)).toEqual(
      SIGNED_IN_ROUTES.filter((route) => route.menu !== null).map((route) => route.path),
    );
    expect(entriesFor(everyKey).map((item) => item.to)).toEqual([
      '/',
      '/pickup-requests',
      '/pickup-requests/new',
      '/approvals',
      '/messages',
      '/manifests',
      '/manifests/new',
      '/admin/staff',
      '/admin/staff/new',
      '/admin/sessions',
      '/admin/vendors',
      '/admin/riders',
      '/account/trusted-browsers',
    ]);
  });

  // Break caught: the pickup entries offered to a session without their keys, or the booking offered to one that may only read the queue.
  it('offers the pickup queue to a holder of pickup.read and the booking to a holder of pickup.request.create', () => {
    expect(entriesFor(['pickup.read']).map((item) => item.to)).toEqual([
      '/',
      '/pickup-requests',
      '/manifests',
      '/account/trusted-browsers',
    ]);
    expect(entriesFor(['pickup.read', 'pickup.request.create']).map((item) => item.label)).toEqual([
      'Overview',
      'Pickup requests',
      'Book a pickup',
      'Manifests',
      'Trusted browsers',
    ]);
  });

  // Break caught: the approver's queue offered to a session that cannot approve, or hidden from one that can (ops-portal.md section 7).
  it('offers the exceptions to approve to a holder of pickup.exception.approve, and to no one else', () => {
    expect(entriesFor(['pickup.read']).map((item) => item.to)).not.toContain('/approvals');
    expect(
      entriesFor(['pickup.read', 'pickup.exception.request']).map((item) => item.to),
    ).not.toContain('/approvals');
    expect(
      entriesFor(['pickup.read', 'pickup.exception.approve']).map((item) => item.label),
    ).toEqual([
      'Overview',
      'Pickup requests',
      'Exceptions to approve',
      'Manifests',
      'Trusted browsers',
    ]);
  });

  // Break caught (ops-portal.md section 7, `/messages`): the message log offered to a session without notification.read, or withheld from one
  // that holds it, or gated by a pickup key because it is about pickups. Its menu entry is the key's alone.
  it('offers the message log to a holder of notification.read, and to no one else', () => {
    expect(entriesFor(['pickup.read']).map((item) => item.to)).not.toContain('/messages');
    expect(
      entriesFor(['pickup.read', 'pickup.request.create', 'staff.read']).map((item) => item.to),
    ).not.toContain('/messages');
    expect(entriesFor(['notification.read'])).toEqual([
      { to: '/', label: 'Overview', icon: 'overview' },
      { to: '/messages', label: 'Messages', icon: 'messages' },
      { to: '/account/trusted-browsers', label: 'Trusted browsers', icon: 'trusted-browsers' },
    ]);
    expect(destinationsFor(['notification.read']).map((item) => item.to)).toEqual([
      '/messages',
      '/account/trusted-browsers',
    ]);
  });

  // The expectations are written out by hand from the route table of surfaces/ops-portal.md section 7, as for the fixture above.
  it.each([
    // The person's own trusted browsers are open to every signed-in session (staff-authentication.md section 5.8): no key is needed to see
    // one's own, and the page says plainly that a role that signs in without an authenticator has none.
    // The vendor accounts are every holder of `vendor.read`'s (S0.52b): Ops Staff, Senior Ops, Platform Admin and Finance.
    // The riders are every holder of `dispatch.read`'s (S0.60): Ops Staff, Senior Ops and Platform Admin, and not Finance.
    // The three pickup entries (S1.19) are those of `pickup.read`, `pickup.request.create` and `pickup.exception.approve`, which the three
    // staff bundles hold (S1.8; the approval is every Ops Staff member's, the Product Owner's decision of 29 October 2026) and Finance does not.
    // The message log (S1.12e) is `notification.read`'s, which the same three hold ("A S P · own hub") and Finance does not.
    // The two manifest entries (S1.25) are those of `pickup.read` and `pickup.manifest.create`, which the same three hold and Finance does not.
    [
      'Ops Staff',
      [
        'Overview',
        'Pickup requests',
        'Book a pickup',
        'Exceptions to approve',
        'Messages',
        'Manifests',
        'Build a manifest',
        'Add a staff profile',
        'Vendors',
        'Riders',
        'Trusted browsers',
      ],
    ],
    [
      'Senior Ops',
      [
        'Overview',
        'Pickup requests',
        'Book a pickup',
        'Exceptions to approve',
        'Messages',
        'Manifests',
        'Build a manifest',
        'Staff',
        'Add a staff profile',
        'Sessions',
        'Vendors',
        'Riders',
        'Trusted browsers',
      ],
    ],
    [
      'Platform Admin',
      [
        'Overview',
        'Pickup requests',
        'Book a pickup',
        'Exceptions to approve',
        'Messages',
        'Manifests',
        'Build a manifest',
        'Staff',
        'Add a staff profile',
        'Sessions',
        'Vendors',
        'Riders',
        'Trusted browsers',
      ],
    ],
    ['Finance/Reconciliation', ['Overview', 'Vendors', 'Trusted browsers']],
  ] as const)('shows %s the screens its keys allow', (bundle, expected) => {
    expect(entriesFor(BUNDLE_KEY_SETS[bundle]).map((item) => item.label)).toEqual(expected);
  });

  // Break caught: a screen guarded by a key other than the one its operation needs, so that the guard lets in a person the server will
  // refuse (or turns away one it would serve). Each route's key is the `x-permission` of the operation that is the point of the screen.
  it.each([
    ['/admin/staff', 'listStaffIdentities'],
    ['/admin/staff/new', 'createStaffIdentity'],
    ['/admin/sessions', 'listSessions'],
    ['/admin/vendors', 'listVendorAccounts'],
    ['/admin/vendors/:id', 'getVendorAccount'],
    ['/admin/riders', 'listRiders'],
    ['/admin/riders/:id', 'getRider'],
    ['/admin/riders/:id/device/register', 'registerRiderDevice'],
    // The page that revokes and replaces opens for the key of the first act; the second is offered inside it to a session that holds its own.
    ['/admin/riders/:id/device', 'revokeRiderDevice'],
    ['/pickup-requests', 'listPickupRequests'],
    ['/pickup-requests/new', 'createPickupRequest'],
    // The page of one request opens for its read; each act on it is offered to a session that holds that act's own key.
    ['/pickup-requests/:id', 'getPickupRequest'],
    ['/pickup-requests/:id/exception', 'requestOnePackageException'],
    // The approver's queue opens for the key of its one act; the queue itself is read with `pickup.read`, which the page names if it is missing.
    ['/approvals', 'approveOnePackageException'],
    // The message log opens for the key of the one read it is: not a pickup key, although what it lists is about pickups.
    ['/messages', 'listNotifications'],
    // The runs (S1.25): the list and one run open for the read, the builder for the key that makes a manifest, the skip for the key of the act.
    ['/manifests', 'listPickupManifests'],
    ['/manifests/new', 'createPickupManifest'],
    ['/manifests/:id', 'getPickupManifest'],
    ['/manifests/:id/stops/:stopId/skip', 'skipPickupStop'],
  ])('guards %s with the key of %s in the contract', (path, operationId) => {
    const contract = parse(
      readFileSync(resolve(import.meta.dirname, '../../../../../contracts/openapi.yaml'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, { operationId?: string; 'x-permission'?: string }>>;
    };
    const operation = Object.values(contract.paths)
      .flatMap((item) => Object.values(item))
      .find((candidate) => candidate.operationId === operationId);
    const route = SIGNED_IN_ROUTES.find((candidate) => candidate.path === path);

    expect(operation?.['x-permission']).toBeDefined();
    expect(route?.access).toMatchObject({ permission: operation?.['x-permission'] });
  });

  // ops-portal.md section 7: the exception is decided by a holder of `pickup.exception.approve`, and a session that may not ask for one is told so.
  it('names the key that decides a one-package exception, as the contract has it', () => {
    const contract = parse(
      readFileSync(resolve(import.meta.dirname, '../../../../../contracts/openapi.yaml'), 'utf8'),
    ) as {
      paths: Record<string, Record<string, { operationId?: string; 'x-permission'?: string }>>;
    };
    const approve = Object.values(contract.paths)
      .flatMap((item) => Object.values(item))
      .find((candidate) => candidate.operationId === 'approveOnePackageException');
    const route = SIGNED_IN_ROUTES.find(
      (candidate) => candidate.path === '/pickup-requests/:id/exception',
    );

    expect(route?.access).toEqual({
      permission: 'pickup.exception.request',
      decidedBy: approve?.['x-permission'],
    });
  });

  it('has the landing, for any signed-in session', () => {
    expect(SIGNED_IN_ROUTES.map((route) => route.path)).toContain('/');
    // A session that lists no key can go to the overview and to its own trusted browsers, and nowhere else.
    expect(entriesFor(undefined)).toEqual([
      { to: '/', label: 'Overview', icon: 'overview' },
      { to: '/account/trusted-browsers', label: 'Trusted browsers', icon: 'trusted-browsers' },
    ]);
  });

  // Break caught: an entry with no picture, a picture that is not one of the design system's, or two different places drawn with one
  // picture, which is how a menu stops being readable at a glance (DESIGN_SYSTEM section 24: one meaning, one icon).
  it('gives each entry of the menu an icon of the design system, and no two the same', () => {
    const icons = SIGNED_IN_ROUTES.flatMap((route) =>
      route.menu === null ? [] : [route.menu.icon],
    );

    expect(icons.length).toBeGreaterThanOrEqual(4);
    for (const icon of icons) expect(ICON_NAMES).toContain(icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('is a sound registry', () => {
    expect(registryProblems(SIGNED_IN_ROUTES)).toEqual([]);
  });

  it('has the areas of the specification, in order', () => {
    expect(NAVIGATION_AREAS).toEqual([
      'overview',
      'pickup-intake',
      'pickup-runs',
      'failed-pickups',
      'hub-receive',
      'dispatch',
      'money',
      'administration',
    ]);
  });
});

describe('a route and its menu entry cannot disagree', () => {
  // Break caught: an entry that goes nowhere. The menu must never link a screen that does not exist.
  it('has a real route behind every entry of the menu', () => {
    for (const routes of [SIGNED_IN_ROUTES, FIXTURE_ROUTES]) {
      const tree = createAppRoutes([], routes);
      const everyKey = Object.values(BUNDLE_KEY_SETS).flat();
      for (const item of entriesFor(everyKey, routes)) {
        const matches = matchRoutes(tree, item.to) ?? [];
        const last = matches.at(-1)?.route;
        expect(last, item.to).toBeDefined();
        expect(last?.path, item.to).not.toBe('*');
      }
    }
  });

  // Break caught: a route added to the tree by hand, beside the registry, which is how a screen ends up with no decision about its
  // menu entry or its permission.
  it('builds the signed-in routes from the registry and from nothing else', () => {
    const signedIn = signedInRouteObjects(FIXTURE_ROUTES);

    expect(signedIn).toHaveLength(FIXTURE_ROUTES.length);
    expect(signedIn.map((route) => (route.index === true ? '/' : `/${route.path ?? ''}`))).toEqual(
      FIXTURE_ROUTES.map((route) => route.path),
    );
  });

  // The pickup queue's scope of memory is a layout with no address of its own, between the guard and the shell: it exists for a signed-in
  // session only, and is gone with it.
  it('puts every one of them under the session guard, the queue’s scope of memory and the shell, and nothing else there', () => {
    const tree = createAppRoutes([], FIXTURE_ROUTES);
    const pages = tree[0]?.children?.[0]?.children;
    const guard = pages?.[0];
    const scope = guard?.children?.[0];
    const shell = scope?.children?.[0];

    expect(guard?.children).toHaveLength(1);
    expect(scope?.path).toBeUndefined();
    expect(isValidElement(scope?.element) && scope.element.type).toBe(QueueContinuityScope);
    expect(scope?.children).toHaveLength(1);
    expect(shell?.children).toHaveLength(FIXTURE_ROUTES.length);
  });

  // Break caught: a registry that has a path twice, a path that is not a path or a menu that cannot be told apart. These are
  // defects of the page, and a registry that has one is refused when it is read.
  it('refuses a registry with a duplicate path', () => {
    const [first] = FIXTURE_ROUTES;
    expect(
      registryProblems([first, first].filter((r): r is SignedInRoute => r !== undefined)),
    ).toEqual([expect.stringContaining('twice')]);
  });

  it.each([
    ['a path without a leading slash', 'admin/staff'],
    ['a path with a trailing slash', '/admin/staff/'],
    ['an empty segment', '/admin//staff'],
    ['a query', '/admin/staff?x=1'],
    ['a fragment', '/admin/staff#x'],
  ])('refuses %s', (_label, path) => {
    const problems = registryProblems([
      { path, element: page('x'), access: ANY_SIGNED_IN_SESSION, menu: null },
    ]);

    expect(problems).toHaveLength(1);
  });

  // Break caught: a menu entry for a pattern: a link to "/admin/staff/:id" is a link to a screen that is not there.
  it.each(['/admin/staff/:id', '/files/*'])('refuses a menu entry for the pattern %s', (path) => {
    const problems = registryProblems([
      {
        path,
        element: page('x'),
        access: ANY_SIGNED_IN_SESSION,
        menu: { label: 'A pattern', icon: 'staff', area: 'administration', order: 1 },
      },
    ]);

    expect(problems).toEqual([expect.stringContaining('pattern')]);
  });

  it('refuses a permission that is not a key of the catalogue’s shape', () => {
    const problems = registryProblems([
      { path: '/x', element: page('x'), access: { permission: 'Senior Ops' }, menu: null },
    ]);

    expect(problems).toEqual([expect.stringContaining('permission')]);
  });

  // Break caught: a role named as the one who decides, where the key belongs.
  it('refuses a deciding permission that is not a key of the catalogue’s shape', () => {
    const problems = registryProblems([
      {
        path: '/x',
        element: page('x'),
        access: { permission: 'pickup.exception.request', decidedBy: 'Senior Ops' },
        menu: null,
      },
    ]);

    expect(problems).toEqual([expect.stringContaining('deciding permission')]);
  });

  it('refuses two entries with one place in one area, and an entry with no label', () => {
    const same = {
      element: page('x'),
      access: ANY_SIGNED_IN_SESSION,
    } as const;
    const problems = registryProblems([
      {
        ...same,
        path: '/a',
        menu: { label: 'A', icon: 'staff', area: 'administration', order: 1 },
      },
      {
        ...same,
        path: '/b',
        menu: { label: 'B', icon: 'staff', area: 'administration', order: 1 },
      },
      {
        ...same,
        path: '/c',
        menu: { label: '  ', icon: 'staff', area: 'administration', order: 2 },
      },
    ]);

    expect(problems).toHaveLength(2);
  });

  // Break caught: a description that is blank, which the landing would draw as an empty line under a link.
  it('refuses a menu entry whose description says nothing', () => {
    const problems = registryProblems([
      {
        path: '/a',
        element: page('x'),
        access: ANY_SIGNED_IN_SESSION,
        menu: { label: 'A', icon: 'staff', area: 'administration', order: 1, description: '   ' },
      },
    ]);

    expect(problems).toEqual([expect.stringContaining('description')]);
  });

  it('throws when the tree is asked to be built from an unsound registry', () => {
    const [first] = FIXTURE_ROUTES;
    const twice = [first, first].filter((r): r is SignedInRoute => r !== undefined);

    expect(() => signedInRouteObjects(twice)).toThrow(/twice/);
    expect(() => entriesFor([], twice)).toThrow(/twice/);
  });
});
