import { describe, expect, it } from 'vitest';

import { createFixtures, FIXED_INSTANT, TestClock } from './fixtures.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const draw = (seed: string, count = 5) => {
  const fixtures = createFixtures(seed);
  return Array.from({ length: count }, () => fixtures.id());
};

describe('createFixtures', () => {
  // Break caught: data that differs from one run to the next, which makes a failure that depended on it
  // impossible to reproduce.
  it('gives the same sequence for the same seed, in any run', () => {
    expect(draw('journey')).toEqual(draw('journey'));
    // The values themselves are pinned: the generator is plain arithmetic, so they are the same on every
    // machine and Node version, and a change to the algorithm changes every test's data and must be deliberate.
    expect(draw('journey')).toEqual([
      '9f7fc9a9-1f9a-46f3-bf57-4a68079bebe5',
      'd71a92d3-d71a-4701-a78a-5ea1b79723ce',
      'eee654cc-9ebd-43d2-b77a-a71183facbef',
      'b1b0078f-e818-4165-a88c-ed5a857b7467',
      'd14ea78a-c08f-4e37-9499-51aa0f6c99bd',
    ]);
  });

  // Break caught: two tests that were given the same data and so interfere through a shared database.
  it('gives different data for different seeds', () => {
    expect(draw('one')).not.toEqual(draw('two'));
  });

  it('makes identifiers in the shape of a version 4 UUID, none repeated', () => {
    const ids = draw('shape', 1_000);

    expect(ids.every((id) => UUID_V4.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('makes labelled text that is the same for the same seed', () => {
    const fixtures = createFixtures('text');

    expect(fixtures.text('note')).toMatch(/^note-[0-9a-f]{8}$/);
    expect(createFixtures('text').text('note')).toBe(createFixtures('text').text('note'));
  });

  // Break caught: a test's data depending on how many other values were drawn before it, so that adding or
  // reordering a test changes the data of every test after it. A fork depends on the seed and its name alone.
  it('forks a stream that does not depend on how much of the parent was used', () => {
    const untouched = createFixtures('parent');
    const used = createFixtures('parent');
    for (let index = 0; index < 50; index += 1) used.id();

    expect(used.fork('orders').id()).toBe(untouched.fork('orders').id());
    expect(untouched.fork('orders').id()).not.toBe(untouched.fork('vendors').id());
  });
});

describe('instants', () => {
  // Break caught: a timestamp taken from the real clock, which would change every run.
  it('are fixed, offset from one agreed moment, and independent of the real clock', () => {
    const fixtures = createFixtures('time');

    expect(FIXED_INSTANT).toBe('2026-10-05T09:00:00.000Z');
    expect(fixtures.instant()).toBe('2026-10-05T09:00:00.000Z');
    expect(fixtures.instant(90_000)).toBe('2026-10-05T09:01:30.000Z');
    expect(fixtures.instant(-3_600_000)).toBe('2026-10-05T08:00:00.000Z');
  });
});

describe('TestClock', () => {
  it('starts at the agreed moment and only moves when told to', () => {
    const clock = new TestClock();

    expect(clock.iso()).toBe(FIXED_INSTANT);
    expect(clock.now().getTime()).toBe(Date.parse(FIXED_INSTANT));
    expect(clock.iso()).toBe(FIXED_INSTANT);

    clock.advance(60_000);
    expect(clock.iso()).toBe('2026-10-05T09:01:00.000Z');
  });

  // Break caught: a time that can go backwards, which no real clock does and which hides ordering bugs.
  it('does not move backwards', () => {
    expect(() => {
      new TestClock().advance(-1);
    }).toThrow(/backwards/);
  });

  // Break caught: a Date handed out that the caller can change, moving the clock behind its back.
  it('hands out a Date that is a copy', () => {
    const clock = new TestClock();

    clock.now().setFullYear(1999);

    expect(clock.iso()).toBe(FIXED_INSTANT);
  });

  it('can start somewhere else', () => {
    expect(new TestClock('2027-01-01T00:00:00.000Z').iso()).toBe('2027-01-01T00:00:00.000Z');
  });
});
