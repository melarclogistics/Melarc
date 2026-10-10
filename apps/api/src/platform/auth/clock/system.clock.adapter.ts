import type { Clock } from '../ports/clock.port.js';

/**
 * The production `Clock` (S0.6; assigned at the review of S0.3). Two readings, and the difference between them is the point:
 *
 * - `now()` is the UTC **wall clock**. It is for TOTP steps and for any decision that is not persisted. The wall clock can jump
 *   (a correction, a change of the machine's clock), so nothing that measures elapsed time uses it.
 * - `monotonicMilliseconds()` is a **monotonic** clock in milliseconds (`performance.now()`): it never goes back, ignores
 *   changes of the wall clock and is meaningful only against another reading of itself. Budgets, deadlines and lease arithmetic
 *   use it.
 *
 * A **persisted expiry decision does not use either**: it takes one fresh database wall-clock value after the locks it needs
 * (plan section 3, "Time"), so that every instance judges expiry on the same clock. There is no production time-travel switch:
 * the adapter keeps no state and offers no way to set, advance or freeze time; a test injects a clock it controls instead.
 */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  monotonicMilliseconds(): number {
    return performance.now();
  }
}
