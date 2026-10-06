import type { ComponentProps } from 'react';
import { RouterProvider } from 'react-router/dom';

import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { AppProviders } from './providers';

/**
 * The application: the outermost error boundary, the providers, and the router. The router is passed
 * in so production uses the browser's history and tests use an in-memory one, through the same code.
 */
export function App({
  router,
}: {
  readonly router: ComponentProps<typeof RouterProvider>['router'];
}) {
  return (
    <AppErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>
  );
}
