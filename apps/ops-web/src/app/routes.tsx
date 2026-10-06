import type { RouteObject } from 'react-router';

import { LoadingIndicator } from '../components/ui/loading/LoadingIndicator';
import { AppFrame } from './AppFrame';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { FrameErrorPage, RouteErrorPage } from './pages/RouteErrorPage';

/**
 * The development-only component showcase (COMPONENT_PATTERNS section 27). `import.meta.env.DEV` is replaced by
 * `false` in a production build, so the route and the dynamic import behind it are removed, not merely hidden;
 * test/build.test.ts proves the built files hold no trace of it.
 */
function showcaseRoutes(): RouteObject[] {
  if (!import.meta.env.DEV) return [];
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
 * The route tree. Product routes are added by slices, each beside the others under the frame; none exist
 * yet. `extra` lets a test add a route of its own, inside the same frame and error handling.
 */
export function createAppRoutes(extra: RouteObject[] = []): RouteObject[] {
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
            { index: true, element: <HomePage /> },
            ...showcaseRoutes(),
            ...extra,
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}
