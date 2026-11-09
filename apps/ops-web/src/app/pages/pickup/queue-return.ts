import type { QueuePlace } from '../../../platform/pickup/queue-continuity';

/**
 * The parts of coming back to a list that touch the page itself (COMPONENT_PATTERNS section 22f): which click leaves a place, the filters as the
 * address carries them, and the position and the focus given back once the page has been read again. What is remembered, for whom and for how
 * long is `platform/pickup/queue-continuity.ts`; this file holds nothing between calls.
 */

/** How a list's links to its records are found, and where each one's record is named: the selector of the link, and the name its record's id is kept under (`dataset`) or the way to read it. */
export interface RecordLinks {
  readonly selector: string;
  readonly key: string;
  /**
   * Where the record's id is kept when it is not on the link itself: the queue workspace's table marks its **row** (`data-row-id`) and the code in the row is the link, so the id is read from
   * the row (`link.closest('[data-row-id]')`). Left out, the id is `dataset[key]` of the link.
   */
  readonly idOf?: (control: HTMLElement) => string | undefined;
}

type Click = Pick<
  MouseEvent,
  'defaultPrevented' | 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
> & { readonly target: EventTarget | null };

/**
 * The record a click opens **in this tab**, or nothing: a plain left click (or the keyboard's activation of the link, which is one) on a link
 * of the list's records (`links`). A click that opens the record in another tab or window, or that something has already handled, leaves the
 * list as it is, so it leaves no place.
 */
export function requestOfClick(event: Click, links: RecordLinks): string | undefined {
  if (event.defaultPrevented || event.button !== 0) return undefined;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return undefined;
  if (!(event.target instanceof Element)) return undefined;
  const link = event.target.closest<HTMLAnchorElement>(links.selector);
  if (link === null) return undefined;
  if (link.target !== '' && link.target !== '_self') return undefined;
  return links.idOf === undefined ? link.dataset[links.key] : links.idOf(link);
}

/**
 * The filters that are set, as the address carries them (`?state=PENDING&date=2026-11-03`, and `cutoff=PENDING_OPS_REVIEW` between the two for
 * the late bookings), or nothing when none is.
 */
export function searchOf(filters: {
  readonly state?: string;
  readonly cutoff?: string;
  readonly date?: string;
}): string {
  const out = new URLSearchParams();
  if (filters.state !== undefined) out.set('state', filters.state);
  if (filters.cutoff !== undefined) out.set('cutoff', filters.cutoff);
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

/** What gives focus back, as the queue workspace and a table offer it (`QueueWorkspaceHandle`): a page asks the table and never looks for a class of the kit's markup. */
export interface PlaceTarget {
  readonly focusRow: (id: string) => boolean;
  readonly focusResults: () => void;
}

/**
 * Gives the officer back their position, once the queue workspace has read the page they left again and drawn it: the document is scrolled to where it was (the browser clamps it to the
 * content there now), and focus goes to the request they opened if it is still on the page, else to the results. **Focus is only ever given where nobody has put it**: an officer who moved
 * focus while the page was being read keeps it where they put it, and still gets their position back. The row is kept in view by the least scroll (the table does that).
 */
export function restoreQueuePlace(target: PlaceTarget, place: QueuePlace): void {
  window.scrollTo({ top: place.scrollY, left: 0, behavior: 'instant' });
  if (!isUnclaimed(document.activeElement)) return;
  if (!target.focusRow(place.requestId)) target.focusResults();
}
