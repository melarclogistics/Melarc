import { describe, expect, it } from 'vitest';

import { bindingOf, isWithinVisit, QueueContinuity, type QueuePlace } from './queue-continuity';

/**
 * What the pickup queue remembers of where an officer was when they opened a request (COMPONENT_PATTERNS section 22f): navigation metadata and
 * nothing the server sent. It is held in memory, for one session and one authorized scope, and for one visit to a request.
 */
const REQUEST = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const OTHER_REQUEST = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
const BINDING = 'session-1|officer|hub-a,hub-b';

const place = (overrides: Partial<QueuePlace> = {}): QueuePlace => ({
  signature: 'PENDING|2026-11-03',
  search: '?state=PENDING&date=2026-11-03',
  tokens: ['token-one', 'token-two'],
  scrollY: 640,
  requestId: REQUEST,
  ...overrides,
});

describe('QueueContinuity: what it holds', () => {
  it('gives back the place that was left, for the session and scope it was left under', () => {
    const held = new QueueContinuity();

    held.leave(place(), BINDING);

    expect(held.peek(BINDING)).toEqual(place());
  });

  // Break caught: a place kept with whatever the caller handed over, so that a record, a name or an address given by mistake would be kept too.
  it('keeps the five facts of a place and nothing else, whatever it is handed', () => {
    const held = new QueueContinuity();
    const careless = {
      ...place(),
      items: [{ code: 'ACC-PR-7KQ2MZ', sender_name: 'Demo Fabrics Ltd' }],
      address: '14 Demo Lane, Osu',
    } as QueuePlace;

    held.leave(careless, BINDING);

    expect(Object.keys(held.peek(BINDING) ?? {}).sort()).toEqual([
      'requestId',
      'scrollY',
      'search',
      'signature',
      'tokens',
    ]);
    expect(JSON.stringify(held.peek(BINDING))).not.toMatch(/Demo|Osu|ACC-PR/);
  });

  it('holds one place: leaving for another request replaces the first', () => {
    const held = new QueueContinuity();

    held.leave(place(), BINDING);
    held.leave(place({ requestId: OTHER_REQUEST, scrollY: 12 }), BINDING);

    expect(held.peek(BINDING)?.requestId).toBe(OTHER_REQUEST);
    expect(held.peek(BINDING)?.scrollY).toBe(12);
  });

  it('gives a copy: changing what it gave changes nothing it holds', () => {
    const held = new QueueContinuity();
    held.leave(place(), BINDING);

    const given = held.peek(BINDING);
    (given?.tokens as string[]).push('added later');

    expect(held.peek(BINDING)?.tokens).toEqual(['token-one', 'token-two']);
  });

  it('is empty until a place is left, and empty again once it is discarded', () => {
    const held = new QueueContinuity();
    expect(held.peek(BINDING)).toBeUndefined();

    held.leave(place(), BINDING);
    held.discard();

    expect(held.peek(BINDING)).toBeUndefined();
  });

  it('does not change the place a caller still holds', () => {
    const held = new QueueContinuity();
    const given = place();

    held.leave(given, BINDING);
    (given.tokens as string[]).push('added later');

    expect(held.peek(BINDING)?.tokens).toEqual(['token-one', 'token-two']);
  });
});

describe('QueueContinuity: whose it is', () => {
  // Break caught: a place of one session shown to the next person, or kept across a change of the hubs the session acts in.
  it.each([
    ['another session', 'session-2|officer|hub-a,hub-b'],
    ['another person', 'session-1|colleague|hub-a,hub-b'],
    ['other hubs', 'session-1|officer|hub-a'],
  ])('is not given to %s, and is gone for the one it belonged to as well', (_who, other) => {
    const held = new QueueContinuity();
    held.leave(place(), BINDING);

    expect(held.peek(other)).toBeUndefined();
    expect(held.peek(BINDING)).toBeUndefined();
  });
});

describe('QueueContinuity: what it refuses to keep', () => {
  it.each([
    ['a request that is not an identifier', place({ requestId: 'ACC-PR-7KQ2MZ' })],
    ['a token that is empty', place({ tokens: [''] })],
    ['a token far longer than any the server gives', place({ tokens: ['x'.repeat(2049)] })],
    [
      'more pages than a person pages through',
      place({ tokens: Array.from({ length: 201 }, () => 't') }),
    ],
    ['an address that is not a query', place({ search: '/pickup-requests?state=PENDING' })],
    ['a query far longer than two filters', place({ search: `?${'a'.repeat(400)}` })],
  ])('keeps nothing for %s', (_why, refused) => {
    const held = new QueueContinuity();

    held.leave(refused, BINDING);

    expect(held.peek(BINDING)).toBeUndefined();
  });

  it('takes a scroll position that is not a position for the top of the page', () => {
    const held = new QueueContinuity();

    held.leave(place({ scrollY: Number.NaN }), BINDING);
    expect(held.peek(BINDING)?.scrollY).toBe(0);

    held.leave(place({ scrollY: -40 }), BINDING);
    expect(held.peek(BINDING)?.scrollY).toBe(0);
  });
});

describe('QueueContinuity: where the visit ends', () => {
  it.each([
    ['the queue', '/pickup-requests'],
    ['the request that was opened', `/pickup-requests/${REQUEST}`],
    ['that request, in capitals', `/pickup-requests/${REQUEST.toUpperCase()}`],
    ['a page of that request', `/pickup-requests/${REQUEST}/exception`],
  ])('is still the visit on %s', (_where, path) => {
    expect(isWithinVisit(path, REQUEST)).toBe(true);
  });

  it.each([
    ['another screen', '/admin/staff'],
    ['the landing', '/'],
    ['the booking', '/pickup-requests/new'],
    ['another request', `/pickup-requests/${OTHER_REQUEST}`],
    ['an address that only begins like the request', `/pickup-requests/${REQUEST}0`],
    ['the approvals', '/approvals'],
  ])('is over on %s', (_where, path) => {
    expect(isWithinVisit(path, REQUEST)).toBe(false);
  });

  it('keeps the place while the person stays in the visit, and drops it when they leave', () => {
    const held = new QueueContinuity();
    held.leave(place(), BINDING);

    held.noteLocation(`/pickup-requests/${REQUEST}`);
    held.noteLocation('/pickup-requests');
    expect(held.peek(BINDING)).toBeDefined();

    held.noteLocation('/admin/staff');
    expect(held.peek(BINDING)).toBeUndefined();
  });
});

/**
 * Whose a place is: the session, the person and the hubs they act in, as one text. It names no one (an identifier and a list of identifiers) and
 * does not depend on the order the API lists the hubs in.
 */
describe('bindingOf: whose a place is', () => {
  const session = {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    principal_id: 'a1b2c3d4-0000-4000-8000-000000000002',
    authorized_hubs: [
      { id: 'a1b2c3d4-0000-4000-8000-0000000000b2', display_name: 'Tema Hub' },
      { id: 'a1b2c3d4-0000-4000-8000-0000000000b1', display_name: 'Accra Central' },
    ],
  };

  it('is the same for the same session and the same hubs, in whatever order they are listed', () => {
    const reordered = { ...session, authorized_hubs: [...session.authorized_hubs].reverse() };

    expect(bindingOf(reordered)).toBe(bindingOf(session));
  });

  // Break caught: a binding that leaves out the session, the person or the hubs, so that a place would outlive the change it must not.
  it.each([
    ['another session', { ...session, id: 'a1b2c3d4-0000-4000-8000-000000000003' }],
    ['another person', { ...session, principal_id: 'a1b2c3d4-0000-4000-8000-000000000004' }],
    ['a hub fewer', { ...session, authorized_hubs: session.authorized_hubs.slice(0, 1) }],
    [
      'another hub',
      {
        ...session,
        authorized_hubs: [{ id: 'a1b2c3d4-0000-4000-8000-0000000000b9', display_name: 'Tema Hub' }],
      },
    ],
  ])('is not the binding of %s', (_what, other) => {
    expect(bindingOf(other)).not.toBe(bindingOf(session));
  });

  it('holds no name, only identifiers', () => {
    expect(bindingOf(session)).not.toMatch(/Tema|Accra|Hub/);
  });

  it('still binds a session that names no person, to that session and its hubs', () => {
    const unnamed = { id: session.id, authorized_hubs: session.authorized_hubs };

    expect(bindingOf(unnamed)).not.toBe(bindingOf(session));
    expect(bindingOf({ ...unnamed, id: 'a1b2c3d4-0000-4000-8000-000000000003' })).not.toBe(
      bindingOf(unnamed),
    );
  });
});
