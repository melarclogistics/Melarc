import type { QueuePlace } from '../../../platform/pickup/queue-continuity';

/**
 * The parts of coming back to a list that touch the page itself (COMPONENT_PATTERNS section 22f): which click leaves a place, the filters as the
 * address carries them, and the position and the focus given back once the page has been read again. What is remembered, for whom and for how
 * long is `platform/pickup/queue-continuity.ts`; this file holds nothing between calls.
 */

/** How a list marks the link of a record on its rows and cards: what finds the link, and the name its record's id is kept under (`dataset`). */
export interface RecordLinks {
  readonly selector: string;
  readonly key: string;
}

/** The link of a request, in the queue's table and in its cards (`pickup-queue-view.tsx` puts the request's id on each). */
export const REQUEST_LINKS: RecordLinks = { selector: 'a[data-request-id]', key: 'requestId' };

/** The link of a manifest, in the manifest list's table and in its cards (`ManifestListPage.tsx` puts the manifest's id on each). */
export const MANIFEST_LINKS: RecordLinks = { selector: 'a[data-manifest-id]', key: 'manifestId' };

type Click = Pick<
  MouseEvent,
  'defaultPrevented' | 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
> & { readonly target: EventTarget | null };

/**
 * The record a click opens **in this tab**, or nothing: a plain left click (or the keyboard's activation of the link, which is one) on the link
 * of a record (a request's, unless the links of another list are given). A click that opens the record in another tab or window, or that
 * something has already handled, leaves the list as it is, so it leaves no place.
 */
export function requestOfClick(
  event: Click,
  links: RecordLinks = REQUEST_LINKS,
): string | undefined {
  if (event.defaultPrevented || event.button !== 0) return undefined;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined;
  if (!(event.target instanceof Element)) return undefined;
  const link = event.target.closest<HTMLAnchorElement>(links.selector);
  if (link === null) return undefined;
  if (link.target !== '' && link.target !== '_self') return undefined;
  return link.dataset[links.key];
}

/** The filters that are set, as the address carries them (`?state=PENDING&date=2026-11-03`), or nothing when none is. */
export function searchOf(filters: { readonly state?: string; readonly date?: string }): string {
  const out = new URLSearchParams();
  if (filters.state !== undefined) out.set('state', filters.state);
  if (filters.date !== undefined) out.set('date', filters.date);
  const text = out.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * Whether focus is where nobody has put it: on nothing, on the document, on the page's main region or on its heading, which is where the frame
 * puts it when a page replaces another (`AppFrame`). Focus anywhere else is the officer's.
 */
export function isUnclaimed(active: Element | null): boolean {
  return (
    active === null ||
    active === document.body ||
    active === document.documentElement ||
    active.matches('main, h1')
  );
}

/** Whether nothing between the element and the root hides it: the queue draws its rows twice and the stylesheet hides the drawing that does not fit. */
function isShown(element: HTMLElement, root: HTMLElement): boolean {
  for (
    let node: HTMLElement | null = element;
    node !== null && node !== root;
    node = node.parentElement
  ) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/** Brings the element into view by the least scroll, and not at all if it is in view already. */
function keepInView(element: HTMLElement): void {
  const box = element.getBoundingClientRect();
  if (box.top < 0 || box.bottom > window.innerHeight) {
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/**
 * Gives the officer back their position, once the page they left has been read again and drawn: the document is scrolled to where it was (the
 * browser clamps it to the content there now), and focus goes to the request they opened if it is still on the page and shown, else to the results,
 * else to whatever stands in their place (a message, a failure). **Focus is only ever given where nobody has put it**: an officer who moved
 * focus while the page was being read keeps it where they put it, and still gets their position back. The request is kept in view, by the least
 * scroll, when the saved position leaves it out. The links are a request's unless the links of another list's records are given.
 */
export function restorePlace(
  root: HTMLElement,
  place: QueuePlace,
  links: RecordLinks = REQUEST_LINKS,
): void {
  window.scrollTo({ top: place.scrollY, left: 0, behavior: 'instant' });
  if (!isUnclaimed(document.activeElement)) return;

  const wanted = place.requestId.toLowerCase();
  const link = Array.from(root.querySelectorAll<HTMLElement>(links.selector)).find(
    (candidate) =>
      candidate.dataset[links.key]?.toLowerCase() === wanted && isShown(candidate, root),
  );
  if (link !== undefined) {
    link.focus({ preventScroll: true });
    keepInView(link);
    return;
  }
  (
    root.querySelector<HTMLElement>('.ui-queue-table__results') ??
    root.querySelector<HTMLElement>('.ui-read-state')
  )?.focus({ preventScroll: true });
}
