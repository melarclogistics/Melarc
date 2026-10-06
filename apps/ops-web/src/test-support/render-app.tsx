import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RouteObject } from 'react-router';
import { createMemoryRouter } from 'react-router';

import { App } from '../app/App';
import { createAppRoutes } from '../app/routes';

/**
 * Renders the real application: the real route tree, providers and error handling, with an in-memory
 * history instead of the browser's. `extraRoutes` adds routes that exist only in a test, inside the
 * same frame and error handling the real routes get.
 */
export function renderApp(initialPath = '/', extraRoutes: RouteObject[] = []) {
  const router = createMemoryRouter(createAppRoutes(extraRoutes), {
    initialEntries: [initialPath],
  });
  const view = render(<App router={router} />);
  return { ...view, router, user: userEvent.setup() };
}
