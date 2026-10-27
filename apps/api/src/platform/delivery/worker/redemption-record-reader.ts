import type { RedemptionRef } from '../../auth/ports/delivery-queue.port.js';
import type { RedemptionRecordType } from '../delivery-vocabulary.js';

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
 * The records are SLICE-000's S0.29 (setup grants) and S0.50 (recovery requests), read by `SetupGrantRedemptionReader` and
 * `RecoveryRequestRedemptionReader`. A record whose reader is not built is read by the reader that confirms nothing
 * (`UNBUILT_REDEMPTION_READER`, and `redemptionReaderOver` for a kind with none), so that no message is ever sent for a record the
 * worker could not look at.
 */
export interface RedemptionRecordReader {
  standing(record: RedemptionRef): Promise<RedemptionStanding>;
}

/** The reader of a worker whose record tables do not exist yet: it confirms nothing, so nothing is sent. */
export const UNBUILT_REDEMPTION_READER: RedemptionRecordReader = {
  standing: () => Promise.resolve('UNCONFIRMED'),
};

/**
 * The reader of every kind of record the worker serves, made of the readers that are built (`SetupGrantRedemptionReader` since S0.29,
 * `RecoveryRequestRedemptionReader` since S0.50). **A kind whose reader is not built, and a kind it does not know, is
 * `UNCONFIRMED`**: nothing is sent for a record nobody looked at. A reader's failure is not caught here: the worker takes a throw for
 * `UNCONFIRMED` and says so, and a router that answered for it would hide a fault behind the same word.
 */
export function redemptionReaderOver(
  readers: Readonly<Partial<Record<RedemptionRecordType, RedemptionRecordReader>>>,
): RedemptionRecordReader {
  return {
    standing: (record) => {
      const own = Object.hasOwn(readers, record.type)
        ? readers[record.type as RedemptionRecordType]
        : undefined;
      return own === undefined ? Promise.resolve('UNCONFIRMED') : own.standing(record);
    },
  };
}
