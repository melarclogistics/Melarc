import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuePlace } from '../../../platform/pickup/queue-continuity';
import { isUnclaimed, requestOfClick, restorePlace, searchOf } from './queue-return';

/**
 * The parts of coming back to the pickup queue that touch the page itself (COMPONENT_PATTERNS section 22f): which click leaves a place, what a
 * place is made of, and how the position and the focus are given back. The flows that use them are in PickupRequestListPage.return.test.tsx.
 */
const REQUEST = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const OTHER_REQUEST = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';

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

    expect(requestOfClick(click(anchor))).toBe(REQUEST);
    expect(requestOfClick(click(inner))).toBe(REQUEST);
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
    expect(requestOfClick(click(link(), init))).toBeUndefined();
  });

  it('is nothing for a link that opens in another tab', () => {
    expect(requestOfClick(click(link(REQUEST, { target: '_blank' })))).toBeUndefined();
  });

  it('is nothing for a click elsewhere, or on a link that is not a request’s', () => {
    expect(requestOfClick(click(document.createElement('button')))).toBeUndefined();
    expect(requestOfClick(click(link(null)))).toBeUndefined();
    expect(requestOfClick(click(null))).toBeUndefined();
  });
});

describe('searchOf: the filters as the address carries them', () => {
  it('is the filters that are set, state then date, and nothing when none is', () => {
    expect(searchOf({ state: 'PENDING', date: '2026-11-03' })).toBe(
      '?state=PENDING&date=2026-11-03',
    );
    expect(searchOf({ state: 'PENDING' })).toBe('?state=PENDING');
    expect(searchOf({ date: '2026-11-03' })).toBe('?date=2026-11-03');
    expect(searchOf({})).toBe('');
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
});

const spyOnScroll = () => vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);

describe('restorePlace: the position and the focus, given back', () => {
  let scrollTo: ReturnType<typeof spyOnScroll>;

  beforeEach(() => {
    scrollTo = spyOnScroll();
  });

  const place = (overrides: Partial<QueuePlace> = {}): QueuePlace => ({
    signature: 'PENDING|',
    search: '?state=PENDING',
    tokens: ['token-two'],
    scrollY: 420,
    requestId: REQUEST,
    ...overrides,
  });

  /** The queue as it is drawn: the results with a table and cards, each holding the request's link, inside a read state. */
  function queue(ids: readonly string[] = [REQUEST, OTHER_REQUEST]) {
    const element = (tag: string, className?: string, ...children: Node[]): HTMLElement => {
      const made = document.createElement(tag);
      if (className !== undefined) made.className = className;
      made.append(...children);
      return made;
    };
    const anchor = (drawing: string, id: string): HTMLElement => {
      const made = link(id);
      made.textContent = `${drawing} ${id}`;
      return made;
    };
    const readState = element(
      'div',
      'ui-read-state',
      element(
        'div',
        'ui-queue-table',
        element(
          'div',
          'ui-queue-table__results',
          element(
            'div',
            'ui-queue-table__table',
            element(
              'table',
              undefined,
              element(
                'tbody',
                undefined,
                ...ids.map((id) =>
                  element('tr', undefined, element('td', undefined, anchor('table', id))),
                ),
              ),
            ),
          ),
          element(
            'ul',
            'ui-queue-table__cards',
            ...ids.map((id) => element('li', undefined, anchor('card', id))),
          ),
        ),
      ),
    );
    readState.tabIndex = -1;
    readState
      .querySelector<HTMLElement>('.ui-queue-table__results')
      ?.setAttribute('tabindex', '-1');
    const root = element('div', undefined, readState);
    document.body.append(root);
    return root;
  }

  it('scrolls to where the officer was, once, without easing', () => {
    restorePlace(queue(), place());

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 420, left: 0, behavior: 'instant' });
  });

  it('gives focus to the request that was opened, in the drawing that is shown', () => {
    const root = queue();

    restorePlace(root, place());

    expect(document.activeElement).toBe(
      root.querySelector(`.ui-queue-table__table a[data-request-id="${REQUEST}"]`),
    );
  });

  it('gives focus to the one that is shown when the other drawing is hidden', () => {
    const root = queue();
    root.querySelector<HTMLElement>('.ui-queue-table__table')?.style.setProperty('display', 'none');

    restorePlace(root, place());

    expect(document.activeElement).toBe(
      root.querySelector(`.ui-queue-table__cards a[data-request-id="${REQUEST}"]`),
    );
  });

  it('gives focus to the results when the request is no longer on the page', () => {
    const root = queue([OTHER_REQUEST]);

    restorePlace(root, place());

    expect(document.activeElement).toBe(root.querySelector('.ui-queue-table__results'));
  });

  it('gives focus to whatever stands in the place of the rows when there are none', () => {
    const root = document.createElement('div');
    const readState = document.createElement('div');
    readState.className = 'ui-read-state';
    readState.tabIndex = -1;
    readState.append(document.createElement('p'));
    root.append(readState);
    document.body.append(root);

    restorePlace(root, place());

    expect(document.activeElement).toBe(readState);
  });

  // Break caught: focus pulled to the request from the control the officer has already moved to while the page was being read.
  it('leaves focus where the officer put it, and still gives the position back', () => {
    const root = queue();
    const filter = document.createElement('select');
    document.body.append(filter);
    filter.focus();

    restorePlace(root, place());

    expect(document.activeElement).toBe(filter);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('takes focus from the heading the frame placed it on, which nobody has chosen', () => {
    const root = queue();
    const heading = document.createElement('h1');
    heading.tabIndex = -1;
    document.body.append(heading);
    heading.focus();

    restorePlace(root, place());

    expect(document.activeElement).toBe(
      root.querySelector(`.ui-queue-table__table a[data-request-id="${REQUEST}"]`),
    );
  });

  it('does not scroll to bring a request into view that already is in view', () => {
    const root = queue();
    const request = root.querySelector<HTMLElement>(`a[data-request-id="${REQUEST}"]`);
    if (request === null) throw new Error('no link');
    const scrollIntoView = vi.fn();
    request.scrollIntoView = scrollIntoView;
    vi.spyOn(request, 'getBoundingClientRect').mockReturnValue({
      top: 200,
      bottom: 230,
    } as DOMRect);

    restorePlace(root, place());

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls only as far as brings the request into view when the saved position leaves it out', () => {
    const root = queue();
    const request = root.querySelector<HTMLElement>(`a[data-request-id="${REQUEST}"]`);
    if (request === null) throw new Error('no link');
    const scrollIntoView = vi.fn();
    request.scrollIntoView = scrollIntoView;
    vi.spyOn(request, 'getBoundingClientRect').mockReturnValue({
      top: 2000,
      bottom: 2030,
    } as DOMRect);

    restorePlace(root, place());

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });
});
