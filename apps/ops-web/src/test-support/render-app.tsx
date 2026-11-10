import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RouteObject } from 'react-router';
import { createMemoryRouter } from 'react-router';

import { App } from '../app/App';
import type { SignedInRoute } from '../app/navigation/route-registry';
import { createAppRoutes } from '../app/routes';
import { failWhenAPermissionKeyIsDrawn } from './permission-keys';

/**
 * Renders the real application: the real route tree, providers and error handling, with an in-memory
 * history instead of the browser's. `extraRoutes` adds routes that exist only in a test, inside the
 * same frame and error handling the real routes get, and `signedIn` gives the tree a registry of signed-in routes of its own.
 * The test fails if a permission key of the catalogue is drawn, as text or in an attribute, at any moment of it (`permission-keys.ts`).
 */
export function renderApp(
  initialPath = '/',
  extraRoutes: RouteObject[] = [],
  signedIn?: readonly SignedInRoute[],
) {
  failWhenAPermissionKeyIsDrawn();
  const router = createMemoryRouter(createAppRoutes(extraRoutes, signedIn), {
    initialEntries: [initialPath],
  });
  const view = render(<App router={router} />);
  return { ...view, router, user: userEvent.setup() };
}
