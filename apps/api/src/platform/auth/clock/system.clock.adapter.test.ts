import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from '../ports/clock.port.js';
import { SystemClock } from './system.clock.adapter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemClock: the production Clock (S0.6)', () => {
  // Break caught: an adapter that does not satisfy the port, so a platform service binds something it cannot call.
  it('is a Clock', () => {
    const clock: Clock = new SystemClock();
    expect(typeof clock.now).toBe('function');
    expect(typeof clock.monotonicMilliseconds).toBe('function');
  });

  // Break caught: a wall clock that is frozen at construction or shared between calls, which would make every expiry judged on
  // it the same instant, or a caller that mutates the returned Date change the clock.
  it('reads the UTC wall clock afresh, as a new Date each time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'));
    const clock = new SystemClock();

    const first = clock.now();
    vi.setSystemTime(new Date('2026-10-10T08:00:30.000Z'));
    const second = clock.now();

    expect(first.toISOString()).toBe('2026-10-10T08:00:00.000Z');
    expect(second.toISOString()).toBe('2026-10-10T08:00:30.000Z');
    expect(second).not.toBe(first);
    first.setUTCFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  // Break caught: elapsed time taken from the wall clock, which jumps (a correction, a leap, a change of the machine clock) and
  // would make a budget expire at once or never. The monotonic reading moves with real elapsed time and ignores the wall clock.
  it('reads a monotonic clock that the wall clock cannot move', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'));
    const clock = new SystemClock();

    const before = clock.monotonicMilliseconds();
    vi.setSystemTime(new Date('2026-10-09T08:00:00.000Z'));
    const afterWallClockWentBackADay = clock.monotonicMilliseconds();
    vi.setSystemTime(new Date('2026-12-25T08:00:00.000Z'));
    const afterWallClockJumpedAhead = clock.monotonicMilliseconds();

    expect(afterWallClockWentBackADay).toBeGreaterThanOrEqual(before);
    expect(afterWallClockJumpedAhead).toBeGreaterThanOrEqual(afterWallClockWentBackADay);
    // Nowhere near a day: only the real time between three calls has passed.
    expect(afterWallClockJumpedAhead - before).toBeLessThan(1_000);
  });

  it('reads a monotonic clock in milliseconds that advances with real time and never goes back', async () => {
    const clock = new SystemClock();
    const readings: number[] = [];
    for (let at = 0; at < 50; at += 1) readings.push(clock.monotonicMilliseconds());
    const before = clock.monotonicMilliseconds();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = clock.monotonicMilliseconds();

    expect(
      readings.every((value, index) => index === 0 || value >= (readings[index - 1] ?? 0)),
    ).toBe(true);
    expect(Number.isFinite(after)).toBe(true);
    // Milliseconds, not seconds or nanoseconds: 30 ms of waiting is between about 25 and a few hundred of them.
    expect(after - before).toBeGreaterThanOrEqual(25);
    expect(after - before).toBeLessThan(1_000);
  });

  // Break caught: a time-travel switch in production (SECURITY_DESIGN.md; plan section 3, "Time"). The adapter reads time and
  // offers nothing to set, advance or freeze it: a test injects a clock it controls instead.
  it('offers no way to set, advance or freeze time', () => {
    const own = Object.getOwnPropertyNames(SystemClock.prototype).toSorted();
    expect(own).toEqual(['constructor', 'monotonicMilliseconds', 'now']);
    expect(Object.getOwnPropertyNames(new SystemClock())).toEqual([]);
  });
});
