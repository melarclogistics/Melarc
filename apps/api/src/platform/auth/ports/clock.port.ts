import type { PortDescriptor } from './port-descriptor.js';

/**
 * Time the application reads for itself. A persisted expiry decision does not use it: that takes the database's time, once,
 * after the locks (`UnitOfWork.databaseNow`). Tests inject a clock they control; production has no time-travel switch.
 */
export interface Clock {
  /** The UTC wall clock: TOTP steps and any decision that is not persisted. */
  now(): Date;
  /** A monotonic clock in milliseconds, for process budgets, deadlines and lease arithmetic. Comparable only with itself. */
  monotonicMilliseconds(): number;
}

export const CLOCK = Symbol('CLOCK');

export const CLOCK_DESCRIPTOR: PortDescriptor<Clock> = {
  port: 'Clock',
  owner: { kind: 'platform', area: 'auth' },
  operations: {
    now: {
      inputs: 'none',
      outputs: 'the current instant on the UTC wall clock',
      outcomes: 'none',
      raises: 'none',
      transaction: 'independent',
    },
    monotonicMilliseconds: {
      inputs: 'none',
      outputs: 'milliseconds on a monotonic clock, meaningful only against another reading of it',
      outcomes: 'none',
      raises: 'none',
      transaction: 'independent',
    },
  },
};
