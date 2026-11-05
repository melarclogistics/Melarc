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

/**
 * The sub-ceilings of settings.md §7.7: a tighter safeguard **inside** `rate_limit_authenticated_api`, "not a seventh bucket". A request that carries one
 * has been admitted by the bucket first and is then admitted again here, by the same session key, against the ceiling the setting of the same name holds.
 * Only the ceiling that bounds the operations that cause an outbound text (or a payment call) exists in the implemented scope; the report and export
 * ceiling arrives with the first operation that needs it.
 */
export const RATE_LIMIT_SUB_CEILINGS = [
  'provider_initiating_operation_ceiling_per_minute',
] as const;

export type RateLimitSubCeiling = (typeof RATE_LIMIT_SUB_CEILINGS)[number];

/** Everything the limiter counts under: one of the six buckets, or a sub-ceiling inside one of them. Each is named by its setting. */
export const RATE_LIMIT_COUNTERS = [...RATE_LIMIT_BUCKETS, ...RATE_LIMIT_SUB_CEILINGS] as const;

export type RateLimitCounter = (typeof RATE_LIMIT_COUNTERS)[number];

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
  admit(counter: RateLimitCounter, canonicalKey: string): Promise<RateLimitDecision>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

export const RATE_LIMITER_DESCRIPTOR: PortDescriptor<RateLimiter> = {
  port: 'RateLimiter',
  owner: { kind: 'platform', area: 'limiter' },
  operations: {
    admit: {
      inputs: 'the bucket (or the sub-ceiling) and the canonical key of the request',
      outputs: 'allowed, or refused with the seconds to wait; an allowed request has been counted',
      outcomes: ['RATE_LIMITED'],
      raises: ['LIMITER_STORE_UNAVAILABLE'],
      transaction: 'outside-any-transaction',
    },
  },
};
