import type { RedemptionRef } from '../../auth/ports/delivery-queue.port.js';

/**
 * Where a redemption record stands, as far as a send is concerned (SECURITY_DESIGN.md §13.9a: "re-read cancellation and expiry
 * before calling the provider"):
 *
 * - `PENDING`: the record can still be redeemed, so the message may be sent.
 * - `CLOSED`: it was consumed, superseded, invalidated or has expired. Nothing is sent, and the job ends.
 * - `UNCONFIRMED`: the worker could not find out. **It fails closed**: nothing is sent, and the job is tried again on its schedule
 *   (a message for a record that may have ended is a live link for a credential that may be dead).
 */
export type RedemptionStanding = 'PENDING' | 'CLOSED' | 'UNCONFIRMED';

/**
 * The worker's read of the hash-only redemption record a job serves: its state and its expiry, **never the hash** (data-scope
 * registry §5.2: `credential_delivery` reads `SetupGrant` and `RecoveryRequest` "state and expiry only"). The expiry is judged on
 * the database's clock, in the read itself, because an expiry is a persisted decision (plan section 3, "Time"). A reader that
 * cannot read answers `UNCONFIRMED`, or throws, which the worker takes for the same.
 *
 * The records are SLICE-000's S0.29 (setup grants) and S0.50 (recovery requests); their readers arrive with them. Until then the
 * worker is composed with the reader that confirms nothing (`UNBUILT_REDEMPTION_READER`), so that no message is ever sent for a
 * record the worker could not look at.
 */
export interface RedemptionRecordReader {
  standing(record: RedemptionRef): Promise<RedemptionStanding>;
}

/** The reader of a worker whose record tables do not exist yet: it confirms nothing, so nothing is sent. */
export const UNBUILT_REDEMPTION_READER: RedemptionRecordReader = {
  standing: () => Promise.resolve('UNCONFIRMED'),
};
