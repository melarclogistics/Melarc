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

/**
 * The host the in-process evidence store names in the links it gives (`STAND_IN_HOST` of `apps/api/src/platform/evidence/in-process.evidence-store.adapter.ts`, which `database.test.ts` holds this copy to): a name
 * under `.invalid`, which can never resolve, so there is nothing behind it. A screen that draws a photo (the receiving run, the order screens) asks that host for the picture.
 */
export const STAND_IN_PICTURE_HOST = 'evidence.stand-in.invalid';

/** A one-pixel transparent GIF: what the stand-in store answers every picture with. */
const ONE_PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * Answers the stand-in store's host from inside the browser context, **with a picture that is made here**: the request is fulfilled by the context itself, so it never leaves the browser, reaches nothing, and is not
 * recorded as an external request. Under the trusted HTTPS origin the page's own policy (`img-src 'self'`) blocks that host before any request is made; over plain HTTP, which sends no such policy, the browser asks, and
 * without this the screens that draw photos could not be walked by the diagnostic run. Every other host is still aborted and recorded, as before (`tests/browser-boundary.spec.ts` holds both). Registered after the
 * guard, so that it is the route a request for this host meets first.
 */
export async function answerStandInPictures(context: BrowserContext): Promise<void> {
  await context.route(`https://${STAND_IN_PICTURE_HOST}/**`, async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/gif', body: ONE_PIXEL_GIF });
  });
}
