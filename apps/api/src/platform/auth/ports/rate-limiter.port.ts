import type { PortDescriptor } from './port-descriptor.js';

/** The six canonical buckets of settings.md §7.7, named by their setting keys. There is no seventh. */
export const RATE_LIMIT_BUCKETS = [
  'rate_limit_staff_signin',
  'rate_limit_privileged_mfa',
  'rate_limit_vendor_signin',
  'rate_limit_rider_challenge',
  'rate_limit_recovery',
  'rate_limit_authenticated_api',
] as const;

export type RateLimitBucket = (typeof RATE_LIMIT_BUCKETS)[number];

export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * The authoritative request limiter (SECURITY_DESIGN.md §13.4b): a rolling 60-second window per key, decided on database time
 * and shared by every instance. The caller gives the canonical identifier of the bucket's key (the normalised email, the
 * account and device, the session); the adapter digests it under the limiter key, so no identifier reaches storage. It runs in
 * its own short transaction and takes none of the policy locks, so it is called with **no transaction of the caller's open**
 * (a second pooled connection taken from inside one is what the category forbids). A store that cannot answer fails closed.
 */
export interface RateLimiter {
  admit(bucket: RateLimitBucket, canonicalKey: string): Promise<RateLimitDecision>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export const RATE_LIMITER_DESCRIPTOR: PortDescriptor<RateLimiter> = {
  port: 'RateLimiter',
  owner: { kind: 'platform', area: 'limiter' },
  operations: {
    admit: {
      inputs: 'the bucket and the canonical key of the request',
      outputs: 'allowed, or refused with the seconds to wait; an allowed request has been counted',
      outcomes: ['RATE_LIMITED'],
      raises: ['LIMITER_STORE_UNAVAILABLE'],
      transaction: 'outside-any-transaction',
    },
  },
};
