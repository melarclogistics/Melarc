import { describe, expect, it } from 'vitest';

import type { Argon2idParameters } from './argon2-parameters.js';
import { costMovement, pepperMovement, shouldRehash } from './rehash-policy.js';

const profile = (memoryKiB: number, passes: number, parallelism = 1): Argon2idParameters => ({
  memoryKiB,
  passes,
  parallelism,
});
const BASE = profile(64, 2);

describe('costMovement: only a cost increase is forward (the cost profile is not a single number)', () => {
  it('is SAME for the same profile', () => {
    expect(costMovement(BASE, profile(64, 2))).toBe('SAME');
  });

  it.each([
    ['more memory', profile(128, 2)],
    ['more passes', profile(64, 3)],
    ['more memory and more passes', profile(128, 3)],
  ])('is FORWARD with %s and the same lanes', (_label, current) => {
    expect(costMovement(BASE, current)).toBe('FORWARD');
  });

  // Break caught: calling every changed profile stronger, which is how a rolling deployment of an older configuration would
  // quietly replace a stronger hash with a weaker one.
  it.each([
    ['less memory', BASE, profile(32, 2)],
    ['fewer passes', BASE, profile(64, 1)],
    ['less memory and fewer passes', BASE, profile(32, 1)],
    ['more memory but fewer passes (incomparable)', BASE, profile(128, 1)],
    ['less memory but more passes (incomparable)', BASE, profile(32, 4)],
    ['more lanes (a different shape, not assumed stronger)', BASE, profile(128, 2, 2)],
    ['fewer lanes', profile(64, 2, 2), profile(64, 2, 1)],
  ])('is BLOCKED with %s', (_label, stored, current) => {
    expect(costMovement(stored, current)).toBe('BLOCKED');
  });
});

describe('pepperMovement: only a newer pepper version is forward', () => {
  it.each([
    [1, 1, 'SAME'],
    [1, 2, 'FORWARD'],
    [3, 7, 'FORWARD'],
    [2, 1, 'BLOCKED'],
    [999999, 1, 'BLOCKED'],
  ] as const)('stored version %i with active version %i is %s', (stored, active, movement) => {
    expect(pepperMovement(stored, active)).toBe(movement);
  });
});

describe('shouldRehash: permission to rewrite a hash is a separate decision from being able to verify it', () => {
  const stored = { parameters: BASE, pepperVersion: 2 };

  it('is false for the same profile and the same pepper', () => {
    expect(shouldRehash(stored, { parameters: profile(64, 2), pepperVersion: 2 })).toBe(false);
  });

  it('is true for a newer pepper with an unchanged cost', () => {
    expect(shouldRehash(stored, { parameters: BASE, pepperVersion: 3 })).toBe(true);
  });

  it('is true for a cost increase with the same lanes and the same pepper', () => {
    expect(shouldRehash(stored, { parameters: profile(128, 2), pepperVersion: 2 })).toBe(true);
    expect(shouldRehash(stored, { parameters: profile(64, 3), pepperVersion: 2 })).toBe(true);
  });

  it('is true when both move forward', () => {
    expect(shouldRehash(stored, { parameters: profile(128, 3), pepperVersion: 3 })).toBe(true);
  });

  // The two directions of a rolling deployment: the instance still on the old configuration must not undo the new one.
  describe('a rolling deployment, in both directions', () => {
    const oldInstance = { parameters: profile(64, 2), pepperVersion: 1 };
    const newInstance = { parameters: profile(128, 3), pepperVersion: 2 };

    it('moves a hash made by the old instance forward when the new instance verifies it', () => {
      expect(shouldRehash(oldInstance, newInstance)).toBe(true);
    });

    // Break caught: "any difference", which makes the old instance replace a hash the new one wrote.
    it('does not move a hash made by the new instance back when the old instance verifies it', () => {
      expect(shouldRehash(newInstance, oldInstance)).toBe(false);
    });

    it('does not let two overlapping instances take a hash back and forth', () => {
      let hash = oldInstance;
      const moves: boolean[] = [];
      for (const verifier of [newInstance, oldInstance, newInstance, oldInstance]) {
        const move = shouldRehash(hash, verifier);
        moves.push(move);
        if (move) hash = verifier;
      }
      expect(moves).toEqual([true, false, false, false]);
      expect(hash).toBe(newInstance);
    });
  });

  // Break caught: a forward move in one dimension allowed to pay for a step back in the other.
  it.each([
    ['an older pepper with an unchanged cost', { parameters: BASE, pepperVersion: 1 }],
    ['a cost reduction with an unchanged pepper', { parameters: profile(32, 2), pepperVersion: 2 }],
    ['fewer passes with an unchanged pepper', { parameters: profile(64, 1), pepperVersion: 2 }],
    [
      'an incomparable profile with an unchanged pepper',
      { parameters: profile(128, 1), pepperVersion: 2 },
    ],
    [
      'a different lane count with an unchanged pepper',
      { parameters: profile(64, 2, 2), pepperVersion: 2 },
    ],
    ['a newer pepper but a cost reduction', { parameters: profile(32, 2), pepperVersion: 3 }],
    ['a cost increase but an older pepper', { parameters: profile(128, 3), pepperVersion: 1 }],
    [
      'a newer pepper but an incomparable profile',
      { parameters: profile(128, 1), pepperVersion: 3 },
    ],
  ])('is false for %s: it needs an explicit migration decision', (_label, current) => {
    expect(shouldRehash(stored, current)).toBe(false);
  });
});
