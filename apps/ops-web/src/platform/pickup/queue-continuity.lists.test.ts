import { describe, expect, it } from 'vitest';

import { isWithinVisit, QueueContinuity, type QueuePlace } from './queue-continuity';

/**
 * The memory of where a list was left, held for more than one list (COMPONENT_PATTERNS section 22f): the pickup queue's, whose address is the
 * default and whose behaviour is described in `queue-continuity.test.ts`, and the manifest list's. A list's visit is the list, the record that
 * was opened from it and the pages of that record; the rules of what is kept and for whom are the same for both.
 */
const MANIFEST = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const OTHER_MANIFEST = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
const BINDING = 'session-1|officer|hub-a,hub-b';
const MANIFESTS = '/manifests';

const place = (overrides: Partial<QueuePlace> = {}): QueuePlace => ({
  signature: 'DRAFT|2026-11-04',
  search: '?state=DRAFT&date=2026-11-04',
  tokens: ['token-one'],
  scrollY: 320,
  requestId: MANIFEST,
  ...overrides,
});

describe('isWithinVisit: the visit to a manifest', () => {
  it.each([
    ['the list', '/manifests'],
    ['the list, with a closing slash', '/manifests/'],
    ['the manifest that was opened', `/manifests/${MANIFEST}`],
    ['that manifest, in capitals', `/manifests/${MANIFEST.toUpperCase()}`],
    [
      'a stop of that manifest, being skipped',
      `/manifests/${MANIFEST}/stops/${OTHER_MANIFEST}/skip`,
    ],
  ])('is still the visit on %s', (_where, path) => {
    expect(isWithinVisit(path, MANIFEST, MANIFESTS)).toBe(true);
  });

  // Break caught: the visit to a manifest that lasts through the building of the next one, or into the pickup queue, so that a place outlives the work it was left for.
  it.each([
    ['the building of a new manifest', '/manifests/new'],
    ['another manifest', `/manifests/${OTHER_MANIFEST}`],
    ['an address that only begins like the manifest', `/manifests/${MANIFEST}0`],
    ['the pickup queue', '/pickup-requests'],
    ['the landing', '/'],
  ])('is over on %s', (_where, path) => {
    expect(isWithinVisit(path, MANIFEST, MANIFESTS)).toBe(false);
  });

  // Break caught: the pickup queue's visit widened to the manifests, which would keep a pickup place alive on the manifest screens.
  it('is the pickup queue’s visit when no list is named', () => {
    expect(isWithinVisit('/manifests', MANIFEST)).toBe(false);
    expect(isWithinVisit(`/manifests/${MANIFEST}`, MANIFEST)).toBe(false);
    expect(isWithinVisit('/pickup-requests', MANIFEST)).toBe(true);
    expect(isWithinVisit(`/pickup-requests/${MANIFEST}`, MANIFEST)).toBe(true);
  });
});

describe('QueueContinuity for the manifest list: what it holds and for how long', () => {
  it('keeps the same five facts of a place, for the binding it was left under', () => {
    const held = new QueueContinuity(MANIFESTS);

    held.leave(place(), BINDING);

    expect(held.peek(BINDING)).toEqual(place());
    expect(Object.keys(held.peek(BINDING) ?? {}).sort()).toEqual([
      'requestId',
      'scrollY',
      'search',
      'signature',
      'tokens',
    ]);
  });

  it('is not given to another session, person or set of hubs', () => {
    const held = new QueueContinuity(MANIFESTS);
    held.leave(place(), BINDING);

    expect(held.peek('session-2|officer|hub-a,hub-b')).toBeUndefined();
    expect(held.peek(BINDING)).toBeUndefined();
  });

  it('refuses a manifest that is not an identifier, and a token that is not one the server gives', () => {
    const held = new QueueContinuity(MANIFESTS);

    held.leave(place({ requestId: 'ACC-MF-Q92422' }), BINDING);
    expect(held.peek(BINDING)).toBeUndefined();

    held.leave(place({ tokens: [''] }), BINDING);
    expect(held.peek(BINDING)).toBeUndefined();
  });

  // Break caught: the list's visit not told to the memory, so that a place left for a manifest is kept after the officer has gone elsewhere.
  it('keeps the place while the person stays in the visit to the manifest, and drops it when they leave', () => {
    const held = new QueueContinuity(MANIFESTS);
    held.leave(place(), BINDING);

    held.noteLocation(`/manifests/${MANIFEST}`);
    held.noteLocation(`/manifests/${MANIFEST}/stops/${OTHER_MANIFEST}/skip`);
    held.noteLocation('/manifests');
    expect(held.peek(BINDING)).toBeDefined();

    held.noteLocation('/manifests/new');
    expect(held.peek(BINDING)).toBeUndefined();
  });

  it('drops the place on the pickup queue, which is another list’s visit', () => {
    const held = new QueueContinuity(MANIFESTS);
    held.leave(place(), BINDING);

    held.noteLocation('/pickup-requests');

    expect(held.peek(BINDING)).toBeUndefined();
  });

  // Break caught: the default list changed, so that the pickup queue's memory would follow the manifests.
  it('is the pickup queue’s memory when no list is named', () => {
    const held = new QueueContinuity();
    held.leave(place(), BINDING);

    held.noteLocation(`/manifests/${MANIFEST}`);
    expect(held.peek(BINDING)).toBeUndefined();

    held.leave(place(), BINDING);
    held.noteLocation(`/pickup-requests/${MANIFEST}`);
    expect(held.peek(BINDING)).toBeDefined();
  });
});

/**
 * The approver's queue (run 5, the review of 499399c) lists requests, and a request's page is the pickup queue's (`/pickup-requests/{id}`): its visit is out of `/approvals` and into a
 * record under another address, which a memory is told (`recordsPath`) and which is judged as strictly as a record under the list's own.
 */
describe('QueueContinuity for the approver’s queue: a visit to a record of another address', () => {
  const APPROVALS = '/approvals';
  const REQUESTS = '/pickup-requests';

  it.each([
    ['the queue', '/approvals'],
    ['the queue, with a closing slash', '/approvals/'],
    ['the request that was opened', `/pickup-requests/${MANIFEST}`],
    ['that request, in capitals', `/pickup-requests/${MANIFEST.toUpperCase()}`],
    ['the exception page of that request', `/pickup-requests/${MANIFEST}/exception`],
  ])('is still the visit on %s', (_where, path) => {
    expect(isWithinVisit(path, MANIFEST, APPROVALS, REQUESTS)).toBe(true);
  });

  // Break caught: a visit that lasts through the pickup queue, another request or the booking of a new one, so that a place outlives the work it was left for.
  it.each([
    ['another request', `/pickup-requests/${OTHER_MANIFEST}`],
    ['the booking of a new request', '/pickup-requests/new'],
    ['the pickup queue', '/pickup-requests'],
    ['an address that only begins like the request', `/pickup-requests/${MANIFEST}0`],
    ['the manifests', '/manifests'],
    ['the landing', '/'],
  ])('is over on %s', (_where, path) => {
    expect(isWithinVisit(path, MANIFEST, APPROVALS, REQUESTS)).toBe(false);
  });

  it('keeps the place while the person is on the request they opened, and drops it when they leave', () => {
    const held = new QueueContinuity(APPROVALS, REQUESTS);
    held.leave(place(), BINDING);

    held.noteLocation(`/pickup-requests/${MANIFEST}`);
    held.noteLocation('/approvals');
    expect(held.peek(BINDING)).toBeDefined();

    held.noteLocation('/pickup-requests');
    expect(held.peek(BINDING)).toBeUndefined();
  });

  // Break caught: a memory that was not told where its records are, which would have dropped the place the moment the person reached the request.
  it('is over on the request when the memory is not told where the records are', () => {
    const held = new QueueContinuity(APPROVALS);
    held.leave(place(), BINDING);

    held.noteLocation(`/pickup-requests/${MANIFEST}`);

    expect(held.peek(BINDING)).toBeUndefined();
  });
});
