import type { AuthenticatedRouteOptions } from '../platform/routes/access-declaration.js';

/**
 * What a fixture route states beside what it requires (S0.26): the surfaces it serves and whether a request of it counts as the
 * person acting. A real route states these for itself; a fixture takes the most common reading of its own, by name, so that a test
 * reads as "an Ops route" or "a route every surface serves", and a different reading is written out where it is the point.
 */

/** A route every surface serves, whose requests are the person's own actions. */
export const EVERY_SURFACE: AuthenticatedRouteOptions = {
  surfaces: ['OPS_PORTAL', 'VENDOR_PWA', 'RIDER_ANDROID'],
  activity: 'qualifying',
};

/** A route of the Ops Portal alone. */
export const OPS_ONLY: AuthenticatedRouteOptions = {
  surfaces: ['OPS_PORTAL'],
  activity: 'qualifying',
};

/** A route the Vendor PWA's browser calls. */
export const VENDOR_ONLY: AuthenticatedRouteOptions = {
  surfaces: ['VENDOR_PWA'],
  activity: 'qualifying',
};

/** A route of the Rider app alone. */
export const RIDER_ONLY: AuthenticatedRouteOptions = {
  surfaces: ['RIDER_ANDROID'],
  activity: 'qualifying',
};

/** The same route, for a page that polls it on its own: it never extends the idle lifetime. */
export const asBackground = (options: AuthenticatedRouteOptions): AuthenticatedRouteOptions => ({
  ...options,
  activity: 'background',
});
