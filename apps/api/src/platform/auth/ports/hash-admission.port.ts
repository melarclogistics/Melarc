import type { PortDescriptor } from './port-descriptor.js';

/** A place in the bounded set of concurrent password hashes. Release it when the hash finishes, and only then. */
export interface HashSlot {
  release(): void;
}

/**
 * Admission to hashing (SECURITY_DESIGN.md §13.4c): a bounded number of concurrent hashes, taken **before any identity-dependent
 * work**. A request refused here is answered `RATE_LIMITED` at once, without verifying and without counting; a request refused
 * by the rate limit never reaches it. The slot count is an engineering value set by measurement, not by this port.
 */
export interface HashAdmission {
  tryAdmit(): HashSlot | null;
}

export const HASH_ADMISSION = Symbol('HASH_ADMISSION');

export const HASH_ADMISSION_DESCRIPTOR: PortDescriptor<HashAdmission> = {
  port: 'HashAdmission',
  owner: { kind: 'platform', area: 'limiter' },
  operations: {
    tryAdmit: {
      inputs: 'none',
      outputs: 'a slot to release when the hash finishes, or null when every slot is taken',
      outcomes: ['ADMISSION_FULL'],
      raises: 'none',
      transaction: 'outside-any-transaction',
    },
  },
};
