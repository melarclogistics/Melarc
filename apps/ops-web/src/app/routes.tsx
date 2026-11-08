import type { RouteObject } from 'react-router';

import { LoadingIndicator } from '../components/ui/loading/LoadingIndicator';
import { RequireSession } from '../platform/session/RequireSession';
import { AppFrame } from './AppFrame';
import { AuthenticatedOpsShell } from './AuthenticatedOpsShell';
import {
  SIGNED_IN_ROUTES,
  signedInRouteObjects,
  type SignedInRoute,
} from './navigation/route-registry';
import { NotFoundPage } from './pages/NotFoundPage';
import { PRE_SIGN_IN_ROUTES } from './pages/pre-sign-in/pre-sign-in-routes';
import { FrameErrorPage, RouteErrorPage } from './pages/RouteErrorPage';

/**
 * The development-only component showcase (COMPONENT_PATTERNS section 27). `import.meta.env.DEV` is replaced by
 * `false` in a production build, and `import.meta.env.MODE` by `"production"`, so the route and the dynamic import behind it are
 * removed, not merely hidden; test/build.test.ts proves the built files hold no trace of it. The one other build that holds the
 * showcase is `vite build --mode showcase`, made by the browser tests (playwright.config.ts) so that the real components can be run
 * as a production build, under the strict content-security policy, in `test/browser/date-picker-policy.spec.ts`. It is never deployed.
 */
function showcaseRoutes(): RouteObject[] {
  if (!import.meta.env.DEV && import.meta.env.MODE !== 'showcase') return [];
  return [
    {
      path: '__showcase',
      lazy: async () => {
        const { ShowcasePage } = await import('../showcase/ShowcasePage');
        return { Component: ShowcasePage };
      },
    },
  ];
}

/**
 * What a page shows, inside the frame, while its code is still being fetched on the first load. Without it the router
 * renders nothing there and warns. No page of this build loads on demand outside development, so it is not seen in
 * production yet; the first routes that do will need it.
 */
function PageLoading() {
  return <LoadingIndicator label="Loading the page…" />;
}

/**
 * The route tree. The signed-in routes are the registry's (`route-registry.tsx`): they are the children of the authenticated
 * Ops shell, which is the child of `RequireSession`, so none of them is shown until the API has said who is signed in, and each is
 * behind the permission key the registry gives it. A slice adds its screens to the registry and to nothing else here. The
 * pre-sign-in screens are siblings of the guard, outside it, because they must render with no session and must not ask for one.
 * `extra` lets a test add a route of its own, outside the guard, inside the same frame and error handling, and `signedIn` lets a
 * test give the tree a registry of its own.
 */
export function createAppRoutes(
  extra: RouteObject[] = [],
  signedIn: readonly SignedInRoute[] = SIGNED_IN_ROUTES,
): RouteObject[] {
  return [
    {
      path: '/',
      element: <AppFrame />,
      // Only for a failure of the frame itself.
      errorElement: <FrameErrorPage />,
      children: [
        {
          // A failing page is replaced by the error message but keeps the frame around it.
          errorElement: <RouteErrorPage />,
          HydrateFallback: PageLoading,
          children: [
            {
              element: <RequireSession />,
              children: [
                {
                  element: <AuthenticatedOpsShell routes={signedIn} />,
                  children: signedInRouteObjects(signedIn),
                },
              ],
            },
            ...showcaseRoutes(),
            // A test's own route for an address comes before the real one: where two routes match alike the router takes the first.
            ...extra,
            ...PRE_SIGN_IN_ROUTES,
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}
