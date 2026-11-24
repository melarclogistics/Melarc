import type { QueryClient } from '@tanstack/react-query';
import type { ComponentProps } from 'react';
import { RouterProvider } from 'react-router/dom';

import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { AppProviders } from './providers';

type Router = ComponentProps<typeof RouterProvider>['router'];

/**
 * The application: the outermost error boundary, the providers, and the router. The router is passed
 * in so production uses the browser's history and tests use an in-memory one, through the same code. The
 * providers sit above the router, so they are given its `navigate` for the one thing they do to it: take the
 * person away from a session that ended.
 */
export function App({
  router,
  queryClient,
}: {
  readonly router: Router;
  /** A query client of the caller's (a test makes a read ask again with it); the application passes none. */
  readonly queryClient?: QueryClient;
}) {
  return (
    <AppErrorBoundary>
      <AppProviders
        navigate={(to) => {
          void router.navigate(to, { replace: true });
        }}
        {...(queryClient === undefined ? {} : { queryClient })}
      >
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  );
}
