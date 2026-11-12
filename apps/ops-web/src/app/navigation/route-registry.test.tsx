import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isValidElement } from 'react';
import { matchRoutes } from 'react-router';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { ICON_NAMES, ICONS, type IconName } from '../../components/ui/icon/icons';
import { QueueContinuityScope } from '../../platform/pickup/QueueContinuityScope';
import { BUNDLE_KEY_SETS, type BundleName } from '../../test-support/bundle-key-sets';
import { createAppRoutes } from '../routes';
import { navigationFor, registryProblems } from './navigation-model';
import {
  ANY_SIGNED_IN_SESSION,
  SIGNED_IN_ROUTES,
  signedInRouteObjects,
  type SignedInRoute,
} from './route-registry';

/**
 * The real registry: which screens exist, who may open each, and where each appears. The derivation itself (keys and routes in, menus out) is held
 * in `navigation-model.test.ts`; what is held here is the registry's own content, written out by hand from the route table of
 * surfaces/ops-portal.md section 7 and the navigation model of its section 4, and the tree built from it.
 */
const page = (name: string) => <p>{name}</p>;

/** The menus a holder of `keys` is given by the real registry: the sidebar's groups, the New menu's actions and the account menu's pages, by name. */
function menusFor(keys: readonly string[] | undefined) {
  const navigation = navigationFor(keys, SIGNED_IN_ROUTES);
  return {
    groups: navigation.groups.map((group) => [group.label, group.entries.map((e) => e.label)]),
    create: navigation.create.map((entry) => entry.label),
    account: navigation.account.map((entry) => entry.label),
  };
}

/** Every address a menu offers, in any of the three. */
function offered(keys: readonly string[] | undefined, routes = SIGNED_IN_ROUTES): string[] {
  const navigation = navigationFor(keys, routes);
  return [
    ...navigation.groups.flatMap((group) => group.entries),
    ...navigation.create,
    ...navigation.account,
  ].map((entry) => entry.to);
}

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

    expect(offered(everyKey).toSorted()).toEqual(
      SIGNED_IN_ROUTES.filter((route) => route.menu !== null)
        .map((route) => route.path)
        .toSorted(),
    );
    expect(menusFor(everyKey)).toEqual({
      groups: [
        ['Today', ['My work', 'Decisions']],
        ['Pickups', ['Requests', 'Pickup runs']],
        ['People and access', ['Staff', 'Riders', 'Vendors', 'Sessions']],
        ['System', ['Message log']],
      ],
      create: ['Book a pickup', 'Build a pickup run', 'Add a staff profile'],
      account: ['Trusted browsers'],
    });
  });

  // Break caught: a group drawn for a part of the product that is not built: Hub, Dispatch and Money have no page, so a person holding every key
  // is shown four of the seven groups.
  it('has four of the seven groups, because three have no page yet', () => {
    const everyKey = [...Object.values(BUNDLE_KEY_SETS).flat(), ...PICKUP_KEYS];

    expect(navigationFor(everyKey, SIGNED_IN_ROUTES).groups.map((group) => group.id)).toEqual([
      'today',
      'pickups',
      'people',
      'system',
    ]);
  });

  // Break caught: the create actions left in the sidebar (the Product Owner moved every one of them into the New menu), or a create page
  // offered to a session without its key, or the booking offered to one that may only read the queue.
  it('offers the pickup queue to a holder of pickup.read, the booking to a holder of pickup.request.create, and the builder to a holder of pickup.manifest.create', () => {
    expect(menusFor(['pickup.read'])).toEqual({
      groups: [
        ['Today', ['My work']],
        ['Pickups', ['Requests', 'Pickup runs']],
      ],
      create: [],
      account: ['Trusted browsers'],
    });
    expect(menusFor(['pickup.read', 'pickup.request.create']).create).toEqual(['Book a pickup']);
    expect(menusFor(['pickup.read', 'pickup.manifest.create']).create).toEqual([
      'Build a pickup run',
    ]);
    const sidebar = navigationFor(
      [...Object.values(BUNDLE_KEY_SETS).flat(), ...PICKUP_KEYS],
      SIGNED_IN_ROUTES,
    ).groups.flatMap((group) => group.entries.map((entry) => entry.to));
    for (const create of ['/pickup-requests/new', '/manifests/new', '/admin/staff/new']) {
      expect(sidebar).not.toContain(create);
    }
  });

  // Break caught: the approver's queue offered to a session that cannot approve, or hidden from one that can (ops-portal.md section 7).
  it('offers Decisions to a holder of pickup.exception.approve, and to no one else', () => {
    expect(offered(['pickup.read'])).not.toContain('/approvals');
    expect(offered(['pickup.read', 'pickup.exception.request'])).not.toContain('/approvals');
    expect(menusFor(['pickup.read', 'pickup.exception.approve']).groups).toEqual([
      ['Today', ['My work', 'Decisions']],
      ['Pickups', ['Requests', 'Pickup runs']],
    ]);
  });

  // Break caught: Decisions gathering the staff approver's count: it stays on Staff, and a merged inbox is a later page that is not built.
  it('gives each queue to one entry (the exceptions to Decisions, the confirmations to Requests, the runs to Pickup runs, the staff profiles to Staff), and no other entry carries a queue', () => {
    const queues = Object.fromEntries(
      navigationFor(Object.values(BUNDLE_KEY_SETS).flat(), SIGNED_IN_ROUTES)
        .groups.flatMap((group) => group.entries)
        .filter((entry) => entry.queue !== undefined)
        .map((entry) => [entry.label, entry.queue]),
    );

    expect(queues).toEqual({
      Decisions: 'PICKUP_EXCEPTION_APPROVAL',
      Requests: 'PICKUP_AWAITING_CONFIRMATION',
      'Pickup runs': 'PICKUP_RUNS_IN_PROGRESS',
      Staff: 'STAFF_AWAITING_APPROVAL',
    });
  });

  // Break caught (ops-portal.md section 7, `/messages`): the message log offered to a session without notification.read, or withheld from one
  // that holds it, or gated by a pickup key because it is about pickups. Its menu entry is the key's alone.
  it('offers the message log to a holder of notification.read, in System, and to no one else', () => {
    expect(offered(['pickup.read'])).not.toContain('/messages');
    expect(offered(['pickup.read', 'pickup.request.create', 'staff.read'])).not.toContain(
      '/messages',
    );
    expect(menusFor(['notification.read'])).toEqual({
      groups: [
        ['Today', ['My work']],
        ['System', ['Message log']],
      ],
      create: [],
      account: ['Trusted browsers'],
    });
  });

  // The expectations are written out by hand from the route table of surfaces/ops-portal.md section 7.
  it.each([
    // Ops Staff hold the pickup keys, the message log's, the vendor and rider reads and the key that makes a staff profile (and not staff.read:
    // "they see no menu entry" for the staff list, nor for the sessions page it also gates).
    [
      'Ops Staff',
      {
        groups: [
          ['Today', ['My work', 'Decisions']],
          ['Pickups', ['Requests', 'Pickup runs']],
          ['People and access', ['Riders', 'Vendors']],
          ['System', ['Message log']],
        ],
        create: ['Book a pickup', 'Build a pickup run', 'Add a staff profile'],
        account: ['Trusted browsers'],
      },
    ],
    [
      'Senior Ops',
      {
        groups: [
          ['Today', ['My work', 'Decisions']],
          ['Pickups', ['Requests', 'Pickup runs']],
          ['People and access', ['Staff', 'Riders', 'Vendors', 'Sessions']],
          ['System', ['Message log']],
        ],
        create: ['Book a pickup', 'Build a pickup run', 'Add a staff profile'],
        account: ['Trusted browsers'],
      },
    ],
    [
      'Platform Admin',
      {
        groups: [
          ['Today', ['My work', 'Decisions']],
          ['Pickups', ['Requests', 'Pickup runs']],
          ['People and access', ['Staff', 'Riders', 'Vendors', 'Sessions']],
          ['System', ['Message log']],
        ],
        create: ['Book a pickup', 'Build a pickup run', 'Add a staff profile'],
        account: ['Trusted browsers'],
      },
    ],
    // Finance reads vendor accounts and nothing else of the built screens.
    [
      'Finance/Reconciliation',
      {
        groups: [
          ['Today', ['My work']],
          ['People and access', ['Vendors']],
        ],
        create: [],
        account: ['Trusted browsers'],
      },
    ],
  ] as const satisfies readonly (readonly [BundleName, ReturnType<typeof menusFor>])[])(
    'shows %s the screens its keys allow',
    (bundle, expected) => {
      expect(menusFor(BUNDLE_KEY_SETS[bundle])).toEqual(expected);
    },
  );

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

  it('has My work, for any signed-in session', () => {
    const mine = SIGNED_IN_ROUTES.find((route) => route.path === '/');

    expect(mine?.access).toBe(ANY_SIGNED_IN_SESSION);
    // A session that lists no key can go to My work and to its own trusted browsers, and nowhere else.
    expect(menusFor(undefined)).toEqual({
      groups: [['Today', ['My work']]],
      create: [],
      account: ['Trusted browsers'],
    });
  });

  // Break caught: an entry with no picture, a picture that is not one of the design system's, or two different places drawn with one
  // picture, which is how a menu stops being readable at a glance (DESIGN_SYSTEM section 24: one meaning, one icon).
  it('gives each entry of a menu an icon of the design system, and no two the same', () => {
    const icons = SIGNED_IN_ROUTES.flatMap((route) =>
      route.menu === null ? [] : [route.menu.icon],
    );

    expect(icons.length).toBeGreaterThanOrEqual(10);
    for (const icon of icons) expect(ICON_NAMES).toContain(icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  // Break caught (the review of 5edada2): Requests and Decisions drawn with Package and PackageCheck, which are one picture at 16px. Two entries of the sidebar are not drawn from one
  // family of pictures (the first word of the library's name for the picture: Package, Clipboard, Message).
  it('draws no two entries of the sidebar from one family of pictures', () => {
    const familyOf = (icon: IconName): string => {
      const name = ICONS[icon].displayName ?? '';
      return /^[A-Z][a-z]+/.exec(name)?.[0] ?? name;
    };
    const owners = new Map<string, string>();
    for (const route of SIGNED_IN_ROUTES) {
      if (route.menu?.place !== 'sidebar') continue;
      const family = familyOf(route.menu.icon);
      expect(family, `${route.menu.label} has a picture with a name`).not.toBe('');
      expect(
        owners.get(family),
        `${route.menu.label} and ${owners.get(family) ?? ''} are drawn from one family of pictures (${family})`,
      ).toBeUndefined();
      owners.set(family, route.menu.label);
    }
    expect(owners.size).toBeGreaterThanOrEqual(8);
  });

  // Break caught: a label that is not a few words, or that names a role or a key (PRODUCT_DESIGN_DIRECTION section 6.5).
  it('words each entry in a few words, with no key and no role', () => {
    for (const route of SIGNED_IN_ROUTES) {
      if (route.menu === null) continue;
      const words = route.menu.label.trim().split(/\s+/);
      expect(words.length, route.menu.label).toBeLessThanOrEqual(4);
      expect(route.menu.label).not.toMatch(/\.|Platform Admin|Senior Ops|Ops Staff/);
    }
  });

  it('is a sound registry', () => {
    expect(registryProblems(SIGNED_IN_ROUTES)).toEqual([]);
  });
});

const FIXTURE_ROUTES: readonly SignedInRoute[] = [
  {
    path: '/',
    element: page('Home'),
    access: ANY_SIGNED_IN_SESSION,
    menu: { place: 'sidebar', group: 'today', label: 'Home', icon: 'staff', order: 0 },
  },
  {
    path: '/admin/staff',
    element: page('Staff'),
    access: { permission: 'staff.read' },
    menu: { place: 'sidebar', group: 'people', label: 'Staff', icon: 'riders', order: 0 },
  },
  {
    path: '/admin/staff/new',
    element: page('New staff'),
    access: { permission: 'staff.identity.create' },
    menu: { place: 'create', label: 'New staff identity', icon: 'add-staff', order: 0 },
  },
  {
    path: '/admin/staff/:id',
    element: page('A staff identity'),
    access: { permission: 'staff.read' },
    menu: null,
  },
];

describe('a route and its menu entry cannot disagree', () => {
  // Break caught: an entry that goes nowhere. The menu must never link a screen that does not exist.
  it('has a real route behind every entry of every menu', () => {
    for (const routes of [SIGNED_IN_ROUTES, FIXTURE_ROUTES]) {
      const tree = createAppRoutes([], routes);
      const everyKey = Object.values(BUNDLE_KEY_SETS).flat();
      for (const to of offered(everyKey, routes)) {
        const matches = matchRoutes(tree, to) ?? [];
        const last = matches.at(-1)?.route;
        expect(last, to).toBeDefined();
        expect(last?.path, to).not.toBe('*');
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

  it('throws when the tree or a menu is asked to be built from an unsound registry', () => {
    const [first] = FIXTURE_ROUTES;
    const twice = [first, first].filter((r): r is SignedInRoute => r !== undefined);

    expect(() => signedInRouteObjects(twice)).toThrow(/twice/);
    expect(() => navigationFor([], twice)).toThrow(/twice/);
  });
});
