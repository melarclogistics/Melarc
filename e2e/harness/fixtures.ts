/** The one moment every test agrees it is, so nothing in a run depends on the real clock. */
export const FIXED_INSTANT = '2026-10-05T09:00:00.000Z';

/** A hash of text to a 32-bit number (the xmur3 construction), so a seed can be any string. */
function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    h = Math.imul(h ^ text.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A small, fast generator with a 32-bit state (mulberry32): the same seed gives the same numbers anywhere. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');

export interface Fixtures {
  /** An identifier in the shape of a version 4 UUID. */
  id(): string;
  /** A label with a short suffix, such as `note-9f3a2b10`. */
  text(label: string): string;
  /** A moment, the given number of milliseconds from {@link FIXED_INSTANT}. */
  instant(offsetMs?: number): string;
  /** A stream of its own that depends on this seed and the name alone, not on how much of this one was used. */
  fork(name: string): Fixtures;
}

/**
 * Data that is the same in every run for the same seed, so that a failure can be reproduced and a test can
 * state what it expects. Nothing here reads the clock, the environment or the machine.
 */
export function createFixtures(seed: string): Fixtures {
  const random = generator(hashSeed(seed));
  const word = () => Math.floor(random() * 4294967296);

  return {
    id() {
      const [a, b, c, d] = [word(), word(), word(), word()];
      const third = (((b >>> 16) & 0x0fff) | 0x4000) >>> 0;
      const fourth = ((c >>> 16) & 0x3fff) | 0x8000;
      return `${hex(a, 8)}-${hex(b & 0xffff, 4)}-${hex(third, 4)}-${hex(fourth, 4)}-${hex(c & 0xffff, 4)}${hex(d, 8)}`;
    },
    text: (label) => `${label}-${hex(word(), 8)}`,
    instant: (offsetMs = 0) => new Date(Date.parse(FIXED_INSTANT) + offsetMs).toISOString(),
    fork: (name) => createFixtures(`${seed}/${name}`),
  };
}

/**
 * A clock the test owns. It starts at an agreed moment and moves only when told to, never backwards, and it
 * hands out copies so nothing outside can move it.
 */
export class TestClock {
  private current: number;

  constructor(start: string = FIXED_INSTANT) {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  iso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): void {
    if (ms < 0) throw new Error('A test clock does not move backwards.');
    this.current += ms;
  }
}
