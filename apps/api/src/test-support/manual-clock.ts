import type { Clock } from '../platform/auth/ports/clock.port.js';

/**
 * A `Clock` a test moves by hand: the wall clock and the monotonic reading are independent, so a test can jump one without
 * the other. It is test-only (the production adapter is `SystemClock`, which offers no way to set time) and is excluded from
 * the build with the rest of `src/test-support`.
 */
export class ManualClock implements Clock {
  private wall: number;
  private monotonic: number;

  constructor(wall: Date = new Date('2026-10-10T08:00:00.000Z'), monotonicMilliseconds = 1_000) {
    this.wall = wall.getTime();
    this.monotonic = monotonicMilliseconds;
  }

  now(): Date {
    return new Date(this.wall);
  }

  monotonicMilliseconds(): number {
    return this.monotonic;
  }

  /** Moves both readings forward by the same amount, as real time does. */
  advance(milliseconds: number): void {
    this.wall += milliseconds;
    this.monotonic += milliseconds;
  }

  /** Jumps only the wall clock (a correction, a change of the machine's clock). The monotonic reading does not move. */
  jumpWallClock(to: Date): void {
    this.wall = to.getTime();
  }
}
