import { UNCLAIMED_FOCUS_SELECTOR } from '../../../components/ui/read-state/unclaimed-focus';
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
 * What holds the person's focus because the page behind it is inert: a question (a native modal dialog, an alert dialog) and the sheet the panel becomes at 768px and below (a modal dialog on the
 * sheet primitive, which does not say `aria-modal="false"`). There is nothing behind them to give focus to.
 */
const MODAL_SURFACE = 'dialog, [role="alertdialog"], [role="dialog"]:not([aria-modal="false"])';

/** What the page knows that the element alone does not say. */
export interface UnclaimedOptions {
  /**
   * The officer pressed or typed something after the act was done with: whatever has focus now is theirs, wherever it is (the panel's region, its text, a heading, the page's main region). Left out,
   * the page knows nothing of an act and only the mark decides, as when a position is given back (`restoreQueuePlace`).
   */
  readonly touchedSinceAct?: boolean;
}

/**
 * Whether focus is where nobody has put it: on nothing, on the document, on the page's main region or on its heading, which is where the frame
 * puts it when a page replaces another (`AppFrame`), or on the region of a read state that the kit marks (`UNCLAIMED_FOCUS_SELECTOR`).
 * The last is what Safari's engine does when a button of the panel is pressed: it gives no focus to a button, and gives it to the nearest ancestor
 * that can have it (the region of the read state that draws the panel's content, `ReadState`), so that after an act made in the panel focus is on a wrapper that no officer chose, and the
 * row that changed would never be given it. Only that region is named, by the mark the kit sets on it and never by `tabindex="-1"`: the panel's own heading is at `tabindex="-1"` too, and
 * it is where an officer is after opening another request while the queue was read again (run 7, Stage 2.1). Focus anywhere else, on a control or on a heading, is the officer's.
 *
 * **Focus inside a surface that holds the person's focus is theirs, whatever holds it** (the Product Owner's review of 67bc979): the mark counts only outside such a surface. A question and the sheet
 * the panel becomes are modal, always.
 *
 * **Focus is the officer's, wherever it is, once they have pressed or typed since the act** (the Product Owner's review of ba9a18c, which replaced the rule that a docked panel showing another request
 * is theirs): the page notes a press or a key after the act was done with (`touchedSinceAct`), and then whatever has focus when the read lands is the officer's, a click on plain text in a panel among
 * it (it focuses the nearest element that can have focus, the read-state region, marked), whichever request the panel shows. It is the press that is noted and not a change of the focused element,
 * because the element does not change in every engine: Safari's engine gives a pressed button no focus and the press on plain text in the panel of the request just confirmed leaves focus on the
 * region the confirmation left it on, with no event, and puts it there at times of its own (the development server and the production build differ) after the question has closed, so that an
 * element compared with the one at the act is "moved" by the engine as much as by the officer (the targeted run of 11 November 2026 on WebKit: the panel of a confirmed request, whose row must be given
 * focus when the officer has done nothing, and the trace of 12 November 2026). Where they have done nothing since the act, the document is nobody's and the marked region is what the press left behind.
 */
export function isUnclaimed(active: Element | null, options: UnclaimedOptions = {}): boolean {
  if (active === null || active === document.body || active === document.documentElement) {
    return true;
  }
  if (options.touchedSinceAct === true) return false;
  if (active.closest(MODAL_SURFACE) !== null) return false;
  return active.matches(`main, h1, ${UNCLAIMED_FOCUS_SELECTOR}`);
}

/**
 * Whether a surface that holds the officer's focus is open above the page now: a question (a `dialog` opened as a modal, or an `alertdialog`), or the sheet the panel becomes at 768px and below (a
 * `dialog` that does not say `aria-modal="false"`, as the docked panel does). A native dialog counts only while it is open; the others are drawn only while they are. **Nothing behind such a
 * surface is given focus by the page** (the hosted WebKit runs of 12 November 2026): a question that closes over the sheet leaves Safari's engine with focus on the document, which is nobody's, and
 * the row that changed is behind the sheet. The surface keeps the officer's focus, and the table gives the row focus when the sheet is closed.
 */
export function modalSurfaceIsOpen(): boolean {
  return [...document.querySelectorAll(MODAL_SURFACE)].some(
    (surface) => !(surface instanceof HTMLDialogElement) || surface.open,
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
