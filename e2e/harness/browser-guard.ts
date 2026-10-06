import type { BrowserContext } from '@playwright/test';

import { canonicalOrigin, isAllowedRequest, isAllowedWebSocket } from './origin.ts';

/**
 * Limits everything a browser context does to the stack's origin: requests that go anywhere else are aborted and
 * `record`ed, and so are WebSockets. It is set on the context, not on a page, so it covers the pages the page
 * opens (a popup is a new page in the same context) and whatever they load. The origin is compared as a parsed
 * origin (see origin.ts).
 *
 * Service workers are blocked in the project's configuration (`serviceWorkers: 'block'`): a service worker's
 * own requests are not seen here, and a test does not need one.
 */
export async function guardBrowserContext(
  context: BrowserContext,
  origin: string,
  record: (url: string) => void,
): Promise<void> {
  canonicalOrigin(origin);

  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (isAllowedRequest(url, origin)) {
      await route.continue();
      return;
    }
    record(url);
    await route.abort('blockedbyclient');
  });

  await context.routeWebSocket(/.*/, async (socket) => {
    const url = socket.url();
    if (isAllowedWebSocket(url, origin)) {
      socket.connectToServer();
      return;
    }
    record(url);
    await socket.close({ code: 1008, reason: 'blocked by the test sandbox' });
  });
}
