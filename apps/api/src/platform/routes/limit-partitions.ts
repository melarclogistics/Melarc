import type { Request } from 'express';

/**
 * A finer key for an anonymous limit than its identifier alone (S0.48): the bucket of a request is the identifier's canonical form **and**
 * what the partition reads of the request. One is built: `VENDOR_DEVICE`, the vendor sign-in's (`AC-SLICE-000-19`; openapi.yaml
 * `vendorSignIn`), keyed on the submitted account together with the registered browser's identity, and only once the browser is
 * recognised; device material that is not recognised shares the account's invalid-device partition, so inventing cookie values buys no
 * bucket. `RECOVERY_PRINCIPAL` (S0.50), the recovery request's: the principal type the body names beside the identifier, each in that type's
 * canonical form. The partitions are composed in `platform/auth/limit-partitions-providers.ts` (one reads the database, so it is composed
 * where the stores are), and a route that names one the application was not composed with fails closed, as a missing limiter does.
 */
export type LimitPartition = 'VENDOR_DEVICE' | 'RECOVERY_PRINCIPAL';

/** Reads the request and returns the key the limiter is asked with, built from the identifier's canonical form. Never throws a request's text. */
export type LimitPartitioner = (request: Request, canonicalKey: string) => Promise<string>;

export type LimitPartitions = Readonly<Partial<Record<LimitPartition, LimitPartitioner>>>;

export const LIMIT_PARTITIONS = Symbol('LIMIT_PARTITIONS');
