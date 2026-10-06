import type { RouteObject } from 'react-router';

import { AppFrame } from './AppFrame';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { FrameErrorPage, RouteErrorPage } from './pages/RouteErrorPage';

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
          children: [
            { index: true, element: <HomePage /> },
            ...extra,
            { path: '*', element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ];
}
