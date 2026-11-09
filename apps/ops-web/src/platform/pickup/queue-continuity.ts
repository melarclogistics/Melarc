import type { SessionView } from '../session/session-store';
import { uuidOf } from '../staff/staff-shape';

/**
 * Where a list was left when an officer opened a record from it (COMPONENT_PATTERNS section 22f; the pickup queue and a request, the manifest list
 * and a manifest): the filters, the way back to the page they were on, how far down it they were and which record they opened. These are
 * **places, not records**: no code, name, address or state of any record is kept, only the position tokens the server gave for the pages (opaque
 * text that says where a page starts) and the identifier of the one record that was opened, so that nothing a person may not read can be read
 * back from here.
 */
export interface QueuePlace {
  /** The filters the place was left under, as the page names them; a place is only given back to the same filters. */
  readonly signature: string;
  /** The filters as the address carries them (`?state=PENDING`), so that the record's link back can name the same queue. */
  readonly search: string;
  /** The position token of each page after the first, in the order they were opened: the way back to the page that was left. */
  readonly tokens: readonly string[];
  /** How far down the document the officer was, in pixels. */
  readonly scrollY: number;
  /** The record that was opened (a request, a manifest), to give focus back to. */
  readonly requestId: string;
}

/**
 * The most a place can hold, far beyond anything a person does: an officer pages through tens of pages, a server's position token is a few
 * hundred characters and the address holds three filters. A place over any of these is not one this screen made, and is not kept.
 */
const MOST_TOKENS = 200;
const LONGEST_TOKEN = 2048;
const LONGEST_SEARCH = 256;

/**
 * The lists that remember where they were left, and the address of each with the records under it. The pickup queue was the first and is the one
 * a memory is made for unless it is told another; the manifest list (S1.25) and the approver's queue (run 5) keep their place by the same rules, each
 * in a memory of its own.
 */
export type ContinuityList = 'pickup' | 'manifests' | 'approvals';
export const LIST_PATHS: Readonly<Record<ContinuityList, string>> = {
  pickup: '/pickup-requests',
  manifests: '/manifests',
  approvals: '/approvals',
};

/**
 * The address the records of each list live under. A request and a manifest are under their list; the approver's queue lists requests, whose pages are the pickup queue's
 * (`/pickup-requests/{id}`), so its visit is out of `/approvals` and into a record of another path.
 */
export const RECORD_PATHS: Readonly<Record<ContinuityList, string>> = {
  pickup: '/pickup-requests',
  manifests: '/manifests',
  approvals: '/pickup-requests',
};

/** The address of the pickup queue, and of the requests under it. */
const QUEUE_PATH = LIST_PATHS.pickup;

/**
 * Whether a place in the application is still within the visit that began when a record was opened from a list: the list, that record and the
 * pages of that record (the pickup queue and a request, unless another list's address is given, and the records' address when it is not the list's).
 * Any other screen, another record or the making of a new one ends it.
 */
export function isWithinVisit(
  pathname: string,
  requestId: string,
  listPath: string = QUEUE_PATH,
  recordsPath: string = listPath,
): boolean {
  const path = pathname.replace(/\/+$/, '').toLowerCase();
  if (path === listPath) return true;
  const record = `${recordsPath}/${requestId.toLowerCase()}`;
  return path === record || path.startsWith(`${record}/`);
}

/**
 * Whose a place is: this session, this person and the hubs they act in, as one text of identifiers (no name, and the same whatever order the API
 * lists the hubs in). A place is given back only to the binding it was left under, so a new session, another person or a change of the hubs
 * the session acts in finds none. Like everything here it grants nothing: the server decides what the page it asks for may hold.
 */
export function bindingOf(
  session: Pick<SessionView, 'id' | 'principal_id' | 'authorized_hubs'>,
): string {
  const hubs = session.authorized_hubs.map((hub) => hub.id).sort();
  return `${session.id}|${session.principal_id ?? ''}|${hubs.join(',')}`;
}

/** A position token as this screen keeps one: some text, not empty, no longer than any the server gives. */
const isToken = (token: unknown): token is string =>
  typeof token === 'string' && token !== '' && token.length <= LONGEST_TOKEN;

/** What is kept, from what was given: the five facts and nothing else, or nothing at all when any of them is not one this screen would make. */
function kept(given: QueuePlace): QueuePlace | undefined {
  const requestId = uuidOf(given.requestId);
  const { signature, search } = given;
  if (requestId === undefined || typeof signature !== 'string' || typeof search !== 'string')
    return undefined;
  if (search.length > LONGEST_SEARCH || (search !== '' && !search.startsWith('?')))
    return undefined;
  const tokens: unknown = given.tokens;
  if (!Array.isArray(tokens) || tokens.length > MOST_TOKENS) return undefined;
  const pages: unknown[] = tokens;
  if (!pages.every(isToken)) return undefined;
  const scrollY =
    Number.isFinite(given.scrollY) && given.scrollY > 0 ? Math.round(given.scrollY) : 0;
  return { signature, search, tokens: [...pages], scrollY, requestId };
}

/**
 * A list's one remembered place, in the memory of the application and nowhere else: not the address, not a storage, not the server. It
 * lives and dies with the scope that holds it (a full reload empties it), and it is **bound to one session and one authorized scope**: given
 * the binding of anyone else, it is gone for everyone.
 *
 * Reading it changes nothing (`peek`), so that a render, or a render the development build runs twice, cannot use it up; whoever restores from
 * it says so (`discard`) once the visit is over.
 *
 * One memory is for one list (`listPath`, the pickup queue's unless another is given, and `recordsPath`, the address its records live under when that is not the list's): the places of
 * two lists are held apart, because the same filters make the same signature in each, and a place is judged by the visit of the list that made it.
 */
export class QueueContinuity {
  private held: { readonly place: QueuePlace; readonly binding: string } | undefined;
  private readonly listPath: string;
  private readonly recordsPath: string;

  constructor(listPath: string = QUEUE_PATH, recordsPath: string = listPath) {
    this.listPath = listPath;
    this.recordsPath = recordsPath;
  }

  /** Keeps where the officer was as they open a request, in place of any place held before. A place that cannot be kept leaves none. */
  leave(place: QueuePlace, binding: string): void {
    const next = kept(place);
    this.held = next === undefined ? undefined : { place: next, binding };
  }

  /** The place held for this binding, as a copy; nothing for any other, and then nothing for the one it belonged to either. */
  peek(binding: string): QueuePlace | undefined {
    if (this.held === undefined) return undefined;
    if (this.held.binding !== binding) {
      this.held = undefined;
      return undefined;
    }
    const { place } = this.held;
    return { ...place, tokens: [...place.tokens] };
  }

  /** Lets go of the place. */
  discard(): void {
    this.held = undefined;
  }

  /** Told where the application now is: a place is let go of once the person is out of the visit that made it. */
  noteLocation(pathname: string): void {
    if (
      this.held !== undefined &&
      !isWithinVisit(pathname, this.held.place.requestId, this.listPath, this.recordsPath)
    )
      this.held = undefined;
  }
}
