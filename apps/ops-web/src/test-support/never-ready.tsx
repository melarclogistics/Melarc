import { use } from 'react';

const NEVER = new Promise<never>(() => undefined);

/**
 * A page that is never ready: while it is awaited the router has already moved and the page the person left is still what is drawn, which is what a slow machine, an engine under load or a
 * chunk that is still on its way gives (the run of the browser tests in WebKit on 9 November 2026). A route whose element is this holds the next page undrawn for as long as a test likes.
 */
export function NeverReady(): null {
  use(NEVER);
  return null;
}
