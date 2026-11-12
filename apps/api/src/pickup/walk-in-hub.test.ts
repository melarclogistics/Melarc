import { describe, expect, it } from 'vitest';

import type { EffectiveScope } from '../platform/authorization/effective-scope.js';
import { coversMoreThanOneHub, walkInHubChoice } from './walk-in-hub.js';

/**
 * The hub of a walk-in booking (task P1; `AC-SLICE-001-82`; permissions.md section 5): the Ops member names it when the grant of
 * `pickup.request.create` reaches more than one hub, and books in their own when it reaches exactly one. The rule is the same however many
 * hubs the company has today, so that a client that works now does not stop working when a second hub is opened.
 */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const all: EffectiveScope = { hubScopeMode: 'ALL', authorizedHubIds: [] };
const set = (...hubs: string[]): EffectiveScope => ({
  hubScopeMode: 'SET',
  authorizedHubIds: hubs,
});

describe('coversMoreThanOneHub', () => {
  // Break caught: an all-hub grant taken for one hub (the Platform Admin is then booked into a hub it never chose), or a grant of several
  // hubs taken for one.
  it.each([
    ['a grant of all hubs', all, true],
    ['a grant of two hubs', set(A, B), true],
    ['a grant of one hub', set(A), false],
    ['a grant that reaches no hub', set(), false],
  ])('is as it should be for %s', (_name, scope, expected) => {
    expect(coversMoreThanOneHub(scope)).toBe(expected);
  });
});

describe('walkInHubChoice', () => {
  // Break caught: a hub that was named ignored, or a missing one defaulted when the person has more than one to choose from.
  it('takes the hub that is named, whatever the grant', () => {
    expect(walkInHubChoice(all, B)).toEqual({ kind: 'named', hubId: B });
    expect(walkInHubChoice(set(A), A)).toEqual({ kind: 'named', hubId: A });
    expect(walkInHubChoice(set(A, B), B)).toEqual({ kind: 'named', hubId: B });
  });

  it('asks the person to name the hub when the grant reaches more than one and none was named', () => {
    expect(walkInHubChoice(all, undefined)).toEqual({ kind: 'must-name' });
    expect(walkInHubChoice(set(A, B), undefined)).toEqual({ kind: 'must-name' });
  });

  // The hub the member books in when it reaches one is their own: the booking service reads it from the member's record.
  it('books in the member’s own hub when the grant reaches one hub or none and none was named', () => {
    expect(walkInHubChoice(set(A), undefined)).toEqual({ kind: 'own' });
    expect(walkInHubChoice(set(), undefined)).toEqual({ kind: 'own' });
  });
});
