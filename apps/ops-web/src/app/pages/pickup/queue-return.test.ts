import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QueuePlace } from '../../../platform/pickup/queue-continuity';
import {
  isUnclaimed,
  requestOfClick,
  restoreQueuePlace,
  searchOf,
  type RecordLinks,
} from './queue-return';

/**
 * The parts of coming back to the pickup queue that touch the page itself (COMPONENT_PATTERNS section 22f): which click leaves a place, what a
 * place is made of, and how the position and the focus are given back. The flows that use them are in PickupRequestListPage.return.test.tsx.
 */
const REQUEST = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
/** A list that marks the link itself with the id of its record. */
const REQUEST_LINKS: RecordLinks = { selector: 'a[data-request-id]', key: 'requestId' };
/** The queue workspace's lists, which mark the row and draw the record's code in it as the link: the id is read from the row. */
const ROW_LINKS: RecordLinks = {
  selector: 'a[href]',
  key: 'href',
  idOf: (found) => found.closest<HTMLElement>('[data-row-id]')?.dataset.rowId,
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** A request's link; `null` for a link that is not a request's (it carries no id). */
function link(id: string | null = REQUEST, attributes: Record<string, string> = {}) {
  const anchor = document.createElement('a');
  anchor.href = `/pickup-requests/${REQUEST}`;
  anchor.textContent = 'ACC-PR-7KQ2MZ';
  if (id !== null) anchor.dataset.requestId = id;
  for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
  return anchor;
}

const click = (target: EventTarget | null, init: Partial<MouseEvent> = {}) => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target,
  ...init,
});

describe('requestOfClick: which click leaves a place', () => {
  it('is the request of a plain left click on its link, or on anything inside the link', () => {
    const anchor = link();
    const inner = document.createElement('span');
    anchor.append(inner);

    expect(requestOfClick(click(anchor), REQUEST_LINKS)).toBe(REQUEST);
    expect(requestOfClick(click(inner), REQUEST_LINKS)).toBe(REQUEST);
  });

  // Break caught: a place left for a click that opens the request in a new tab or window, where the queue stays as it is.
  it.each([
    ['a middle click', { button: 1 }],
    ['a right click', { button: 2 }],
    ['control held', { ctrlKey: true }],
    ['command held', { metaKey: true }],
    ['shift held', { shiftKey: true }],
    ['alt held', { altKey: true }],
    ['a click something has already handled', { defaultPrevented: true }],
  ])('is nothing for %s', (_what, init) => {
    expect(requestOfClick(click(link(), init), REQUEST_LINKS)).toBeUndefined();
  });

  it('is nothing for a link that opens in another tab', () => {
    expect(
      requestOfClick(click(link(REQUEST, { target: '_blank' }), {}), REQUEST_LINKS),
    ).toBeUndefined();
  });

  it('is nothing for a click elsewhere, or on a link that is not a request’s', () => {
    expect(requestOfClick(click(document.createElement('button')), REQUEST_LINKS)).toBeUndefined();
    expect(requestOfClick(click(link(null)), REQUEST_LINKS)).toBeUndefined();
    expect(requestOfClick(click(null), REQUEST_LINKS)).toBeUndefined();
  });

  // The manifest list and the pickup queue's own links are marked by their row: a plain click on the code in a row is the record of the row, whatever the link says of it.
  it('is the record of the row a link is in, when the list marks its rows and not its links', () => {
    const row = document.createElement('tr');
    row.dataset.rowId = REQUEST;
    const anchor = document.createElement('a');
    anchor.href = `/manifests/${REQUEST}`;
    row.append(anchor);
    const elsewhere = document.createElement('a');
    elsewhere.href = '/manifests/new';
    document.body.append(row, elsewhere);

    expect(requestOfClick(click(anchor), ROW_LINKS)).toBe(REQUEST);
    expect(requestOfClick(click(anchor, { ctrlKey: true }), ROW_LINKS)).toBeUndefined();
    expect(requestOfClick(click(anchor, { button: 1 }), ROW_LINKS)).toBeUndefined();
    // A link outside every row (the page's own action) is no record's.
    expect(requestOfClick(click(elsewhere), ROW_LINKS)).toBeUndefined();
  });
});

describe('searchOf: the filters as the address carries them', () => {
  it('is the filters that are set, state then cut-off decision then date, and nothing when none is', () => {
    expect(searchOf({ state: 'PENDING', date: '2026-11-03' })).toBe(
      '?state=PENDING&date=2026-11-03',
    );
    expect(searchOf({ state: 'PENDING' })).toBe('?state=PENDING');
    expect(searchOf({ date: '2026-11-03' })).toBe('?date=2026-11-03');
    expect(searchOf({})).toBe('');
    // Task C1.1 (AC-QSUM-11): the late bookings' filter comes back with the officer to the list they left.
    expect(searchOf({ state: 'CONFIRMED', cutoff: 'PENDING_OPS_REVIEW' })).toBe(
      '?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW',
    );
    expect(searchOf({ state: 'CONFIRMED', cutoff: 'PENDING_OPS_REVIEW', date: '2026-11-03' })).toBe(
      '?state=CONFIRMED&cutoff=PENDING_OPS_REVIEW&date=2026-11-03',
    );
  });
});

describe('isUnclaimed: focus nobody has taken', () => {
  it('is focus on nothing, on the document, on the page’s main region or on its heading', () => {
    const main = document.createElement('main');
    const heading = document.createElement('h1');
    const filter = document.createElement('select');
    const control = document.createElement('button');
    document.body.append(main, heading, filter, control);

    expect(isUnclaimed(null)).toBe(true);
    expect(isUnclaimed(document.body)).toBe(true);
    expect(isUnclaimed(main)).toBe(true);
    expect(isUnclaimed(heading)).toBe(true);
    expect(isUnclaimed(filter)).toBe(false);
    expect(isUnclaimed(control)).toBe(false);
  });

  // Break caught (the engines run of 10 November 2026): after an act made in the panel, Safari's engine leaves focus on the panel's content region (it gives no focus to a pressed button and gives
  // it to the nearest ancestor that can have it), which the page took for the officer's own and so never gave the row that changed its focus. A container reached only by a script is nobody's
  // choice; a control with that tabindex still is.
  it('is focus on a container that only a script or a press inside it gives focus to, and not on a control', () => {
    const region = document.createElement('div');
    region.setAttribute('tabindex', '-1');
    const parked = document.createElement('button');
    parked.setAttribute('tabindex', '-1');
    const reachable = document.createElement('div');
    reachable.setAttribute('tabindex', '0');
    document.body.append(region, parked, reachable);

    expect(isUnclaimed(region)).toBe(true);
    expect(isUnclaimed(parked)).toBe(false);
    expect(isUnclaimed(reachable)).toBe(false);
  });
});

describe('restoreQueuePlace: the position and the focus, given back through the table (the review of 5edada2, M4)', () => {
  const place = (overrides: Partial<QueuePlace> = {}): QueuePlace => ({
    signature: 'all',
    search: '',
    tokens: [],
    scrollY: 480,
    requestId: REQUEST,
    ...overrides,
  });
  const target = (found: boolean) => ({
    focusRow: vi.fn(() => found),
    focusResults: vi.fn(),
  });

  // Break caught: a page that has to look for the kit's classes to find the request, and a position that is not given back.
  it('scrolls the document to where it was and asks the table for the request the officer opened', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const rows = target(true);

    restoreQueuePlace(rows, place());

    expect(scrollTo).toHaveBeenCalledWith({ top: 480, left: 0, behavior: 'instant' });
    expect(rows.focusRow).toHaveBeenCalledWith(REQUEST);
    expect(rows.focusResults).not.toHaveBeenCalled();
  });

  it('asks for the results when the request is no longer on the page', () => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const rows = target(false);

    restoreQueuePlace(rows, place());

    expect(rows.focusRow).toHaveBeenCalledWith(REQUEST);
    expect(rows.focusResults).toHaveBeenCalledTimes(1);
  });

  // Break caught: focus taken from an officer who moved it while the page was being read.
  it('gives the position back and leaves focus where the officer put it', () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    const rows = target(true);

    restoreQueuePlace(rows, place());

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(rows.focusRow).not.toHaveBeenCalled();
    expect(rows.focusResults).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
  });
});
