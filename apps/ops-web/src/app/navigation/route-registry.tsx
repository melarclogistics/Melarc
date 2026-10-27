import type { ReactElement } from 'react';
import type { RouteObject } from 'react-router';

import type { NavigationItem } from '../../components/PrimaryNavigation';
import type { IconName } from '../../components/ui/icon/icons';
import { RequirePermission } from '../../platform/session/RequirePermission';
import { isPermissionKey } from '../../platform/session/session-shape';
import { LandingPage } from '../pages/LandingPage';
import { TrustedBrowsersPage } from '../pages/account/TrustedBrowsersPage';
import { SessionsPage } from '../pages/staff/SessionsPage';
import { StaffCreatePage } from '../pages/staff/StaffCreatePage';
import { StaffDetailPage } from '../pages/staff/StaffDetailPage';
import { StaffListPage } from '../pages/staff/StaffListPage';
import { StaffMfaResetPage } from '../pages/staff/StaffMfaResetPage';
import { RiderDetailPage } from '../pages/riders/RiderDetailPage';
import { RiderDevicePage } from '../pages/riders/RiderDevicePage';
import { RiderDeviceRegisterPage } from '../pages/riders/RiderDeviceRegisterPage';
import { RiderListPage } from '../pages/riders/RiderListPage';
import { VendorDetailPage } from '../pages/vendors/VendorDetailPage';
import { VendorListPage } from '../pages/vendors/VendorListPage';

/**
 * The signed-in routes, and what each one means for the navigation, in one place.
 *
 * The route tree and the menu are both derived from this list (`signedInRouteObjects`, `entriesFor`), so they cannot disagree: a route
 * cannot exist without a decision about its menu entry and the key it needs, because the entry is the route; and an entry cannot link a
 * screen that does not exist, because nothing but a route makes one. The menu shows what the session's permission keys allow and the
 * implemented routes only (surfaces/ops-portal.md section 4): a key in the catalogue exposes no entry for a feature that is not built.
 * Neither a role name nor a bundle is read anywhere here; the server checks the key again on every request.
 *
 * A later task adds its screens here and nowhere else.
 */

/** Who may open a route: any signed-in session, or one that holds the permission key. */
export const ANY_SIGNED_IN_SESSION = 'any-signed-in-session';

export type RouteAccess = typeof ANY_SIGNED_IN_SESSION | { readonly permission: string };

/**
 * The areas of the Ops Portal's navigation (surfaces/ops-portal.md section 4), plus the overview the landing belongs to. The order is the
 * order of the menu.
 */
export const NAVIGATION_AREAS = [
  'overview',
  'pickup-intake',
  'pickup-runs',
  'failed-pickups',
  'hub-receive',
  'dispatch',
  'money',
  'administration',
] as const;

export type NavigationArea = (typeof NAVIGATION_AREAS)[number];

export interface MenuEntry {
  /** What the entry says. */
  readonly label: string;
  /**
   * Its icon, from the one family of the design system (DESIGN_SYSTEM section 24). Stated for every entry, so that a screen cannot be added to the
   * menu without deciding what it looks like there, and the same meaning keeps the same picture on the menu and on the landing.
   */
  readonly icon: IconName;
  readonly area: NavigationArea;
  /** Its place in its area; unique there. */
  readonly order: number;
  /** One line for the landing's list of where to go: what the screen is for, in the words of the person using it. */
  readonly description?: string;
}

export interface SignedInRoute {
  /** Absolute, with no query or fragment: `/` for the landing. A `:name` segment is a parameter and a `*` a splat. */
  readonly path: string;
  /** The screen. */
  readonly element: ReactElement;
  readonly access: RouteAccess;
  /**
   * The menu entry, or `null` for a screen that is reached from another and never from the menu (a detail or an action). Stated for
   * every route, so that leaving it out is a type error and not a screen nobody can find.
   */
  readonly menu: MenuEntry | null;
}

/** The routes that exist. */
export const SIGNED_IN_ROUTES: readonly SignedInRoute[] = [
  {
    path: '/',
    element: <LandingPage />,
    access: ANY_SIGNED_IN_SESSION,
    menu: { label: 'Overview', icon: 'overview', area: 'overview', order: 0 },
  },
  {
    path: '/admin/staff',
    element: <StaffListPage />,
    access: { permission: 'staff.read' },
    menu: {
      label: 'Staff',
      icon: 'staff',
      area: 'administration',
      order: 0,
      description: 'Find a staff profile, and approve the ones that are waiting.',
    },
  },
  {
    path: '/admin/staff/new',
    element: <StaffCreatePage />,
    access: { permission: 'staff.identity.create' },
    menu: {
      label: 'Add a staff profile',
      icon: 'add-staff',
      area: 'administration',
      order: 1,
      description: 'Create a profile for a new colleague. It is approved before they can sign in.',
    },
  },
  {
    path: '/admin/staff/:id',
    element: <StaffDetailPage />,
    access: { permission: 'staff.read' },
    menu: null,
  },
  {
    path: '/admin/staff/:id/mfa/reset',
    element: <StaffMfaResetPage />,
    access: { permission: 'staff.mfa.reset' },
    menu: null,
  },
  // It names the person in its address, so a profile leads to it with the person chosen; the entry opens it with nobody chosen, and the
  // page says how to choose.
  {
    path: '/admin/sessions',
    element: <SessionsPage />,
    access: { permission: 'staff.read' },
    menu: {
      label: 'Sessions',
      icon: 'sessions',
      area: 'administration',
      order: 2,
      description: 'See where a person is signed in, and end a session.',
    },
  },
  // The vendor accounts the session's grant reaches (S0.52b): their authentication status, and the acts on their credential.
  {
    path: '/admin/vendors',
    element: <VendorListPage />,
    access: { permission: 'vendor.read' },
    menu: {
      label: 'Vendors',
      icon: 'vendors',
      area: 'administration',
      order: 3,
      description: 'Find a vendor account, send a setup link again, or start a recovery.',
    },
  },
  {
    path: '/admin/vendors/:id',
    element: <VendorDetailPage />,
    access: { permission: 'vendor.read' },
    menu: null,
  },
  // The riders the session's grant reaches (S0.60): the roster, one rider, and the two device pages. The roster is `dispatch.read`; the first
  // binding is `staff.device.register` and the page of the device (revoke, and replace for a holder of `staff.device.reregister`) is
  // `staff.device.revoke`, each a key and never a role.
  {
    path: '/admin/riders',
    element: <RiderListPage />,
    access: { permission: 'dispatch.read' },
    menu: {
      label: 'Riders',
      icon: 'riders',
      area: 'administration',
      order: 4,
      description: 'Find a rider, register a device, or report a lost handset.',
    },
  },
  {
    path: '/admin/riders/:id',
    element: <RiderDetailPage />,
    access: { permission: 'dispatch.read' },
    menu: null,
  },
  {
    path: '/admin/riders/:id/device/register',
    element: <RiderDeviceRegisterPage />,
    access: { permission: 'staff.device.register' },
    menu: null,
  },
  {
    path: '/admin/riders/:id/device',
    element: <RiderDevicePage />,
    access: { permission: 'staff.device.revoke' },
    menu: null,
  },
  // The signed-in person's own (staff-authentication.md section 5.8): any signed-in staff session, and no permission, because the server shows
  // a person their own trusted browsers and nobody else's. A role that signs in without an authenticator finds it says so.
  {
    path: '/account/trusted-browsers',
    element: <TrustedBrowsersPage />,
    access: ANY_SIGNED_IN_SESSION,
    menu: {
      label: 'Trusted browsers',
      icon: 'trusted-browsers',
      area: 'administration',
      order: 5,
      description: 'See the browsers where you skip the authenticator code, and remove one.',
    },
  },
];

const isPattern = (path: string): boolean =>
  path.split('/').some((segment) => segment.startsWith(':') || segment === '*');

/** What is wrong with a registry: every problem is a defect of the page, so building anything from an unsound one throws. */
export function registryProblems(routes: readonly SignedInRoute[]): string[] {
  const problems: string[] = [];
  const paths = new Set<string>();
  const places = new Set<string>();

  for (const route of routes) {
    const { path, access, menu } = route;
    const segments = path.split('/').slice(1);
    const wellFormed =
      path.startsWith('/') &&
      !/[?#]/.test(path) &&
      (path === '/' || (!path.endsWith('/') && segments.every((segment) => segment !== '')));
    if (!wellFormed)
      problems.push(
        `The path "${path}" is not an absolute path with no empty segment, query or fragment.`,
      );
    if (paths.has(path)) {
      // The second of two routes with one path says nothing more than that it is the second.
      problems.push(`The path "${path}" is in the registry twice.`);
      continue;
    }
    paths.add(path);

    if (access !== ANY_SIGNED_IN_SESSION && !isPermissionKey(access.permission)) {
      problems.push(
        `The permission "${access.permission}" of "${path}" is not a key of the catalogue's shape.`,
      );
    }

    if (menu !== null) {
      if (menu.label.trim() === '') problems.push(`The menu entry of "${path}" has no label.`);
      if (menu.description?.trim() === '') {
        problems.push(`The menu entry of "${path}" has a description that says nothing.`);
      }
      if (!Number.isInteger(menu.order) || menu.order < 0) {
        problems.push(
          `The menu entry of "${path}" has an order that is not a whole number from zero.`,
        );
      }
      if (isPattern(path)) {
        problems.push(
          `The path "${path}" is a pattern, and a menu entry for a pattern links a screen that is not there.`,
        );
      }
      const place = `${menu.area}/${String(menu.order)}`;
      if (places.has(place)) problems.push(`Two menu entries have the place ${place}.`);
      places.add(place);
    }
  }
  return problems;
}

function assertSound(routes: readonly SignedInRoute[]): void {
  const problems = registryProblems(routes);
  if (problems.length > 0) throw new Error(problems.join(' '));
}

/**
 * The menu a session may use: the entries of the routes whose key it holds (or that need none), by area and then by place. The
 * session's `permissions` are keys only, hints for what to show; a session that lists none holds none. A key matches exactly.
 */
function allowedEntries(
  permissions: readonly string[] | undefined,
  routes: readonly SignedInRoute[],
): { to: string; menu: MenuEntry }[] {
  assertSound(routes);
  const held = new Set(permissions);
  const areaIndex = (area: NavigationArea): number => NAVIGATION_AREAS.indexOf(area);
  return routes
    .flatMap((route) =>
      route.menu !== null &&
      (route.access === ANY_SIGNED_IN_SESSION || held.has(route.access.permission))
        ? [{ to: route.path, menu: route.menu }]
        : [],
    )
    .toSorted(
      (a, b) =>
        areaIndex(a.menu.area) - areaIndex(b.menu.area) ||
        a.menu.order - b.menu.order ||
        a.menu.label.localeCompare(b.menu.label),
    );
}

export function entriesFor(
  permissions: readonly string[] | undefined,
  routes: readonly SignedInRoute[] = SIGNED_IN_ROUTES,
): NavigationItem[] {
  return allowedEntries(permissions, routes).map(({ to, menu }) => ({
    to,
    label: menu.label,
    icon: menu.icon,
  }));
}

/** A place the landing offers: where it goes, what it is called, and what it is for when the screen says. */
export interface Destination extends NavigationItem {
  readonly description?: string;
}

/**
 * The places to go from the landing: the menu a session may use, without the overview (the landing is where the person already is), and
 * with what each is for. It is derived from the same entries as the menu, so the two cannot disagree.
 */
export function destinationsFor(
  permissions: readonly string[] | undefined,
  routes: readonly SignedInRoute[] = SIGNED_IN_ROUTES,
): Destination[] {
  return allowedEntries(permissions, routes)
    .filter(({ menu }) => menu.area !== 'overview')
    .map(({ to, menu }) => ({
      to,
      label: menu.label,
      icon: menu.icon,
      ...(menu.description === undefined ? {} : { description: menu.description }),
    }));
}

/** The route objects of the signed-in routes, each behind the key it needs. They are the children of the shell, and there are no others. */
export function signedInRouteObjects(
  routes: readonly SignedInRoute[] = SIGNED_IN_ROUTES,
): RouteObject[] {
  assertSound(routes);
  return routes.map((route): RouteObject => {
    const element =
      route.access === ANY_SIGNED_IN_SESSION ? (
        route.element
      ) : (
        <RequirePermission permission={route.access.permission}>{route.element}</RequirePermission>
      );
    return route.path === '/' ? { index: true, element } : { path: route.path.slice(1), element };
  });
}
