import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueuePlace } from '../../../platform/pickup/queue-continuity';
import { MANIFEST_LINKS, requestOfClick, restorePlace } from './queue-return';

/**
 * The parts of coming back to a list that touch the page itself (COMPONENT_PATTERNS section 22f), for the manifest list: the link of a manifest
 * in place of the link of a request. The pickup queue's own are in `queue-return.test.ts`; the flows that use these are in
 * `ManifestListPage.return.test.tsx`.
 */
const MANIFEST = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const OTHER_MANIFEST = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/** A manifest's link, or a request's (`data-request-id`) when `request` is given: the two lists mark their links differently. */
function link(id: string, kind: 'manifest' | 'request' = 'manifest') {
  const anchor = document.createElement('a');
  anchor.href = `/manifests/${id}`;
  anchor.textContent = 'ACC-MF-Q92422';
  if (kind === 'manifest') anchor.dataset.manifestId = id;
  else anchor.dataset.requestId = id;
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

describe('requestOfClick, for the manifest list: which click leaves a place', () => {
  it('is the manifest of a plain left click on its link, or on anything inside it', () => {
    const anchor = link(MANIFEST);
    const inner = document.createElement('span');
    anchor.append(inner);

    expect(requestOfClick(click(anchor), MANIFEST_LINKS)).toBe(MANIFEST);
    expect(requestOfClick(click(inner), MANIFEST_LINKS)).toBe(MANIFEST);
  });

  // Break caught: the two lists' links taken for each other's, so that a click in one leaves a place the other's page would try to restore.
  it('is nothing for the link of a request, and the pickup queue’s own reading is nothing for a manifest’s', () => {
    expect(requestOfClick(click(link(MANIFEST, 'request')), MANIFEST_LINKS)).toBeUndefined();
    expect(requestOfClick(click(link(MANIFEST)))).toBeUndefined();
  });

  // Break caught: a place left for a click that opens the manifest in a new tab or window, where the list stays as it is.
  it.each([
    ['a middle click', { button: 1 }],
    ['a right click', { button: 2 }],
    ['control held', { ctrlKey: true }],
    ['command held', { metaKey: true }],
    ['shift held', { shiftKey: true }],
    ['alt held', { altKey: true }],
    ['a click something has already handled', { defaultPrevented: true }],
  ])('is nothing for %s', (_what, init) => {
    expect(requestOfClick(click(link(MANIFEST), init), MANIFEST_LINKS)).toBeUndefined();
  });

  it('is nothing for a link that opens in another tab, or for a click elsewhere', () => {
    const blank = link(MANIFEST);
    blank.target = '_blank';

    expect(requestOfClick(click(blank), MANIFEST_LINKS)).toBeUndefined();
    expect(requestOfClick(click(document.createElement('button')), MANIFEST_LINKS)).toBeUndefined();
    expect(requestOfClick(click(null), MANIFEST_LINKS)).toBeUndefined();
  });
});

describe('restorePlace, for the manifest list: the position and the focus, given back', () => {
  const spyOnScroll = () => vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  let scrollTo: ReturnType<typeof spyOnScroll>;

  beforeEach(() => {
    scrollTo = spyOnScroll();
  });

  const place = (overrides: Partial<QueuePlace> = {}): QueuePlace => ({
    signature: 'DRAFT|',
    search: '?state=DRAFT',
    tokens: ['token-two'],
    scrollY: 420,
    requestId: MANIFEST,
    ...overrides,
  });

  /** The list as it is drawn: the results with a table and cards, each holding the manifest's link, inside a read state. */
  function list(
    ids: readonly string[] = [MANIFEST, OTHER_MANIFEST],
    kind: 'manifest' | 'request' = 'manifest',
  ) {
    const results = document.createElement('div');
    results.className = 'ui-queue-table__results';
    results.tabIndex = -1;
    const table = document.createElement('div');
    table.className = 'ui-queue-table__table';
    for (const id of ids) table.append(link(id, kind));
    const cards = document.createElement('ul');
    cards.className = 'ui-queue-table__cards';
    results.append(table, cards);
    const readState = document.createElement('div');
    readState.className = 'ui-read-state';
    readState.tabIndex = -1;
    readState.append(results);
    const root = document.createElement('div');
    root.append(readState);
    document.body.append(root);
    return root;
  }

  it('scrolls to where the officer was, once, without easing', () => {
    restorePlace(list(), place(), MANIFEST_LINKS);

    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 420, left: 0, behavior: 'instant' });
  });

  // Break caught: the manifest list given the pickup queue's link attribute, so that the manifest opened is never found and focus goes to the results.
  it('gives focus to the manifest that was opened', () => {
    const root = list();

    restorePlace(root, place(), MANIFEST_LINKS);

    expect(document.activeElement).toBe(root.querySelector(`a[data-manifest-id="${MANIFEST}"]`));
  });

  it('gives focus to the results when the manifest is no longer on the page', () => {
    const root = list([OTHER_MANIFEST]);

    restorePlace(root, place(), MANIFEST_LINKS);

    expect(document.activeElement).toBe(root.querySelector('.ui-queue-table__results'));
  });

  it('does not take a request’s link for the manifest that was opened', () => {
    const root = list([MANIFEST], 'request');

    restorePlace(root, place(), MANIFEST_LINKS);

    expect(document.activeElement).toBe(root.querySelector('.ui-queue-table__results'));
  });

  it('leaves focus where the officer put it, and still gives the position back', () => {
    const root = list();
    const filter = document.createElement('select');
    document.body.append(filter);
    filter.focus();

    restorePlace(root, place(), MANIFEST_LINKS);

    expect(document.activeElement).toBe(filter);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});
