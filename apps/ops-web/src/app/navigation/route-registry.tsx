import type { ReactElement } from 'react';
import type { RouteObject } from 'react-router';

import { RequirePermission } from '../../platform/session/RequirePermission';
import { MyWorkPage } from '../pages/my-work/MyWorkPage';
import { TrustedBrowsersPage } from '../pages/account/TrustedBrowsersPage';
import { ManifestBuilderPage } from '../pages/manifests/ManifestBuilderPage';
import { ManifestDetailPage } from '../pages/manifests/ManifestDetailPage';
import { ManifestListPage } from '../pages/manifests/ManifestListPage';
import { StopSkipPage } from '../pages/manifests/StopSkipPage';
import { MessageLogPage } from '../pages/messages/MessageLogPage';
import { ApprovalsPage } from '../pages/pickup/ApprovalsPage';
import { PickupExceptionPage } from '../pages/pickup/PickupExceptionPage';
import { PickupRequestCreatePage } from '../pages/pickup/PickupRequestCreatePage';
import { PickupRequestDetailPage } from '../pages/pickup/PickupRequestDetailPage';
import { PickupRequestListPage } from '../pages/pickup/PickupRequestListPage';
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
import { ANY_SIGNED_IN_SESSION, assertSound, type NavigableRoute } from './navigation-model';

/**
 * The signed-in routes, and what each one means for the navigation, in one place.
 *
 * The route tree and the menus are both derived from this list (`signedInRouteObjects`, `navigationFor`), so they cannot disagree: a route cannot
 * exist without a decision about its menu entry and the key it needs, because the entry is the route; and an entry cannot link a screen that does not
 * exist, because nothing but a route makes one. The menus show what the session's permission keys allow and the implemented routes only
 * (surfaces/ops-portal.md section 4): a key in the catalogue exposes no entry for a feature that is not built. Neither a role name nor a bundle is
 * read anywhere here; the server checks the key again on every request.
 *
 * Where a route appears is its `menu`: an entry of the sidebar in one of the seven groups, an action of the New menu, a page of the account menu, or
 * none (a screen reached from another). A later task adds its screens here and nowhere else.
 */
export { ANY_SIGNED_IN_SESSION, type RouteAccess } from './navigation-model';

export interface SignedInRoute extends NavigableRoute {
  /** The screen. */
  readonly element: ReactElement;
}

/** The routes that exist. */
export const SIGNED_IN_ROUTES: readonly SignedInRoute[] = [
  {
    path: '/',
    element: <MyWorkPage />,
    access: ANY_SIGNED_IN_SESSION,
    menu: { place: 'sidebar', group: 'today', label: 'My work', icon: 'my-work', order: 0 },
  },
  // Pickup intake (S1.19): the queue is an entry of the sidebar and the booking an action of the New menu; one request and the exception of one
  // are reached from the queue. Each is behind the key of the operation that is its point, and never a role.
  {
    path: '/pickup-requests',
    element: <PickupRequestListPage />,
    access: { permission: 'pickup.read' },
    menu: {
      place: 'sidebar',
      group: 'pickups',
      label: 'Requests',
      icon: 'pickup-requests',
      order: 0,
      queue: 'PICKUP_AWAITING_CONFIRMATION',
      description: 'See the pickups booked at your hubs, and confirm, reschedule or cancel them.',
    },
  },
  {
    path: '/pickup-requests/new',
    element: <PickupRequestCreatePage />,
    access: { permission: 'pickup.request.create' },
    menu: {
      place: 'create',
      label: 'Book a pickup',
      icon: 'book-pickup',
      order: 0,
      description: 'Enter a booking from WhatsApp, a vendor’s call or a walk-in sender.',
    },
  },
  {
    path: '/pickup-requests/:id',
    element: <PickupRequestDetailPage />,
    access: { permission: 'pickup.read' },
    menu: null,
  },
  // A one-package exception is decided by a holder of `pickup.exception.approve`: a session that may not ask for one is told who decides
  // (ops-portal.md section 7), by the key and not by a role.
  {
    path: '/pickup-requests/:id/exception',
    element: <PickupExceptionPage />,
    access: { permission: 'pickup.exception.request', decidedBy: 'pickup.exception.approve' },
    menu: null,
  },
  // The checker's queue of the one-package exception (ops-portal.md section 7): behind the key of the approval, which names no role. It is
  // *Decisions* in the Today group, counted by its queue; the other decisions a person may give (the staff approver's queue, which stays on
  // *Staff*) join it in one inbox when that page is built, and no page is built for it now.
  {
    path: '/approvals',
    element: <ApprovalsPage />,
    access: { permission: 'pickup.exception.approve' },
    menu: {
      place: 'sidebar',
      group: 'today',
      label: 'Decisions',
      icon: 'exception-approvals',
      order: 1,
      queue: 'PICKUP_EXCEPTION_APPROVAL',
      description: 'Approve the single-package pickups waiting for a one-package exception.',
    },
  },
  // The message log (S1.12e): what the platform said to people about an act, and what became of each message. Behind the key of its one read,
  // `notification.read`, and never a role. It is reached from the menu and, for one request, from that request's page.
  {
    path: '/messages',
    element: <MessageLogPage />,
    access: { permission: 'notification.read' },
    menu: {
      place: 'sidebar',
      group: 'system',
      label: 'Message log',
      icon: 'messages',
      order: 0,
      description: 'See the messages the platform sent about pickups, and what became of each.',
    },
  },
  // Manifests and runs (S1.25): the list, the builder, one run and the Ops skip of one of its stops. Each is behind the key of the operation that
  // is its point, and never a role: the list and the run open for the read, the builder for the key that makes a manifest, and the skip for the
  // key of the act. What a run's page offers inside is offered to the session that holds that act's own key.
  {
    path: '/manifests',
    element: <ManifestListPage />,
    access: { permission: 'pickup.read' },
    menu: {
      place: 'sidebar',
      group: 'pickups',
      label: 'Pickup runs',
      icon: 'manifests',
      order: 1,
      queue: 'PICKUP_RUNS_IN_PROGRESS',
      description:
        'See the pickup runs at your hubs, and open one to order, assign and dispatch it.',
    },
  },
  // The builder is an action of the New menu and draws no count: the pool it is built from (`PICKUP_UNMANIFESTED_POOL`) is shown on My work, as
  // the late bookings are, and has no entry of its own.
  {
    path: '/manifests/new',
    element: <ManifestBuilderPage />,
    access: { permission: 'pickup.manifest.create' },
    menu: {
      place: 'create',
      label: 'Build a pickup run',
      icon: 'build-manifest',
      order: 1,
      description: 'Choose confirmed pickups for one run, and the day it is worked.',
    },
  },
  {
    path: '/manifests/:id',
    element: <ManifestDetailPage />,
    access: { permission: 'pickup.read' },
    menu: null,
  },
  {
    path: '/manifests/:id/stops/:stopId/skip',
    element: <StopSkipPage />,
    access: { permission: 'pickup.stop.skip' },
    menu: null,
  },
  {
    path: '/admin/staff',
    element: <StaffListPage />,
    access: { permission: 'staff.read' },
    menu: {
      place: 'sidebar',
      group: 'people',
      label: 'Staff',
      icon: 'staff',
      order: 0,
      queue: 'STAFF_AWAITING_APPROVAL',
      description: 'Find a staff profile, and approve the ones that are waiting.',
    },
  },
  {
    path: '/admin/staff/new',
    element: <StaffCreatePage />,
    access: { permission: 'staff.identity.create' },
    menu: {
      place: 'create',
      label: 'Add a staff profile',
      icon: 'add-staff',
      order: 2,
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
      place: 'sidebar',
      group: 'people',
      label: 'Sessions',
      icon: 'sessions',
      order: 3,
      description: 'See where a person is signed in, and end a session.',
    },
  },
  // The vendor accounts the session's grant reaches (S0.52b): their authentication status, and the acts on their credential.
  {
    path: '/admin/vendors',
    element: <VendorListPage />,
    access: { permission: 'vendor.read' },
    menu: {
      place: 'sidebar',
      group: 'people',
      label: 'Vendors',
      icon: 'vendors',
      order: 2,
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
      place: 'sidebar',
      group: 'people',
      label: 'Riders',
      icon: 'riders',
      order: 1,
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
  // a person their own trusted browsers and nobody else's. A role that signs in without an authenticator finds it says so. It is a page of the
  // account menu and has no entry in the sidebar.
  {
    path: '/account/trusted-browsers',
    element: <TrustedBrowsersPage />,
    access: ANY_SIGNED_IN_SESSION,
    menu: {
      place: 'account',
      label: 'Trusted browsers',
      icon: 'trusted-browsers',
      order: 0,
      description: 'See the browsers where you skip the authenticator code, and remove one.',
    },
  },
];

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
        <RequirePermission
          permission={route.access.permission}
          {...(route.access.decidedBy === undefined ? {} : { decidedBy: route.access.decidedBy })}
        >
          {route.element}
        </RequirePermission>
      );
    return route.path === '/' ? { index: true, element } : { path: route.path.slice(1), element };
  });
}
