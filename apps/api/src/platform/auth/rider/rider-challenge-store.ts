import { sql } from 'drizzle-orm';

import { guardReasonIn } from '../../database/database-failures.js';
import { timestampOf } from '../../database/timestamps.js';
import { isUuid } from '../../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import {
  RiderChallengeContextError,
  RiderChallengeExpiredError,
  RiderChallengeRequestError,
} from './rider-challenge-errors.js';
import { RIDER_CHALLENGE_PURPOSE, type RiderChallengeState } from './rider-vocabulary.js';

const COLUMNS = sql.raw(
  'id, rider_identity_id, issued_at, expires_at, state, phone_hash, purpose, audience, device_context_hash',
);

interface ChallengeColumns {
  readonly id: string;
  readonly rider_identity_id: string | null;
  /** A raw statement returns an instant as the server's text; `timestampOf` reads it. */
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly state: RiderChallengeState;
  readonly phone_hash: Uint8Array;
  readonly purpose: string;
  readonly audience: string;
  readonly device_context_hash: Uint8Array | null;
}

/** A sign-in challenge as the platform reads it: whom it was issued for, what it is bound to, how long it lives and where it stands. */
export interface StoredRiderChallenge {
  readonly id: string;
  /** The rider the number belonged to when the challenge was issued, or null for a number that matched no rider. */
  readonly riderIdentityId: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly state: RiderChallengeState;
  readonly phoneHash: Buffer;
  readonly purpose: string;
  readonly audience: string;
  readonly deviceContextHash: Buffer | null;
}

function challengeOf(row: ChallengeColumns): StoredRiderChallenge {
  return {
    id: row.id,
    riderIdentityId: row.rider_identity_id,
    issuedAt: timestampOf(row.issued_at),
    expiresAt: timestampOf(row.expires_at),
    state: row.state,
    phoneHash: Buffer.from(row.phone_hash),
    purpose: row.purpose,
    audience: row.audience,
    deviceContextHash:
      row.device_context_hash === null ? null : Buffer.from(row.device_context_hash),
  };
}

export interface IssueRiderChallengeRequest {
  /** The rider the number belongs to; null for a number that matched no rider (the row that keeps issuance from disclosing either). */
  readonly riderId: string | null;
  /** `TokenService.hash` of the nonce the handset will sign: the only form of it kept. */
  readonly nonceHash: Uint8Array;
  readonly phoneHash: Uint8Array;
  /** The binding to the rider's `ACTIVE` device; null for a number that matched no rider or a rider with no `ACTIVE` device. */
  readonly deviceContextHash: Uint8Array | null;
  readonly audience: string;
  /** `authentication_challenge_ttl_minutes`, read by the caller from the setting and never defaulted here. */
  readonly ttlMinutes: number;
}

/** A challenge locked for a decision, and whether its time has passed on the database's clock read after the lock. */
export interface RiderChallengeForDecision {
  readonly challenge: StoredRiderChallenge;
  readonly expired: boolean;
}

export interface RiderChallengeStoreOptions {
  /** The time of the identifiers it makes (UUIDv7). Issue and expiry are the database's. */
  readonly clock: Pick<Clock, 'now'>;
}

function assertAuthentication(handle: TransactionHandle): void {
  const context = securityContextOf(handle);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new RiderChallengeContextError();
  }
}

const HASH_BYTES = 32;
const isHash = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array && value.length === HASH_BYTES;

/**
 * The store of the rider's sign-in challenges (S0.59; domain-model.md section 6.8 `RiderSignInChallenge`; SECURITY_DESIGN.md sections 13.4b
 * and 13.6). Every method joins the caller's transaction, under the authentication capability (row-level security admits nothing else to
 * read or write a challenge), so issuing a challenge and the act that did it commit together or not at all.
 *
 * - **A challenge is found by the hash of the nonce a request presents and by nothing else.** There is no list, no scan and no search by
 *   rider or number: the nonce is the reference the handset holds, and it is 256 bits.
 * - **Time is the database's.** `issued_at` and `expires_at` come from one `clock_timestamp()` of the issuing statement, and the lifetime is
 *   the setting the caller read. The store's own clock only makes the identifier.
 * - **Issuing ends no other challenge.** A rider may hold several live challenges (a request is limited by the number it names, 20 a minute),
 *   each good for one presentation: ending an earlier one would let anyone who knows a number take a rider's pending challenge away.
 * - **A challenge is ended by its first presentation**, whatever the presentation did (`consume`, or `end` as `UNUSABLE` where a binding did
 *   not hold), and the table's guard keeps the state machine: only `PENDING` changes, a consumption only before the time has passed.
 */
export class RiderChallengeStore {
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: RiderChallengeStoreOptions) {
    this.#clock = options.clock;
  }

  /** Issues a `PENDING` challenge and answers when it ends, on the database's clock. */
  async issue(
    handle: TransactionHandle,
    request: IssueRiderChallengeRequest,
  ): Promise<{ readonly id: string; readonly expiresAt: Date }> {
    assertAuthentication(handle);
    const { riderId, nonceHash, phoneHash, deviceContextHash, audience, ttlMinutes } = request;
    if (riderId !== null && !isUuid(riderId)) throw new RiderChallengeRequestError('riderId');
    if (!isHash(nonceHash)) throw new RiderChallengeRequestError('nonceHash');
    if (!isHash(phoneHash)) throw new RiderChallengeRequestError('phoneHash');
    if (deviceContextHash !== null && !isHash(deviceContextHash)) {
      throw new RiderChallengeRequestError('deviceContextHash');
    }
    if (deviceContextHash !== null && riderId === null) {
      throw new RiderChallengeRequestError('deviceContextHash');
    }
    if (typeof audience !== 'string' || audience.length < 1 || audience.length > 128) {
      throw new RiderChallengeRequestError('audience');
    }
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1) {
      throw new RiderChallengeRequestError('ttlMinutes');
    }
    const id = randomUUIDv7(this.#clock);
    const inserted = await transactionOf(handle).execute(sql`
      with at as (select clock_timestamp() as now)
      insert into rider_sign_in_challenge (id, rider_identity_id, issued_at, expires_at, nonce_hash, phone_hash, purpose, audience,
                                           device_context_hash)
      select ${id}::uuid, ${riderId}::uuid, at.now, at.now + make_interval(mins => ${ttlMinutes}::int), ${Buffer.from(nonceHash)},
             ${Buffer.from(phoneHash)}, ${RIDER_CHALLENGE_PURPOSE}, ${audience},
             ${deviceContextHash === null ? null : Buffer.from(deviceContextHash)}
        from at
      returning expires_at`);
    const row = inserted.rows[0] as unknown as { expires_at: Date | string } | undefined;
    if (row === undefined) throw new Error('A rider challenge was inserted and not returned');
    return { id, expiresAt: timestampOf(row.expires_at) };
  }

  /**
   * The challenge a presented nonce names, **without a lock**, and whether its time has passed on the database's clock: a hint to judge by
   * (the decision is made on `lockForDecision`), and `null` for a nonce that names none.
   */
  async findByNonceHash(
    handle: TransactionHandle,
    nonceHash: Uint8Array,
  ): Promise<RiderChallengeForDecision | null> {
    assertAuthentication(handle);
    if (!isHash(nonceHash)) throw new RiderChallengeRequestError('nonceHash');
    const result = await transactionOf(handle).execute(sql`
      select ${COLUMNS}, expires_at <= clock_timestamp() as expired
        from rider_sign_in_challenge where nonce_hash = ${Buffer.from(nonceHash)}`);
    const row = result.rows[0] as unknown as (ChallengeColumns & { expired: boolean }) | undefined;
    return row === undefined ? null : { challenge: challengeOf(row), expired: row.expired };
  }

  /**
   * The challenge, **locked until the transaction ends** (the rider's identity is locked first where there is one, the order of the session
   * issue), and whether its time has passed: the row is locked in a statement of its own and read, with the database's clock, in the next
   * one. Two statements because a lock and a time are not one thing: an expression of a statement that locks is read before the wait for the
   * lock when the holder leaves the row unchanged, and the judgement would be made on a time from before the wait. Read after it, the time is
   * the time at which the lock was granted. `null` for a challenge that is not there.
   */
  async lockForDecision(
    handle: TransactionHandle,
    id: string,
  ): Promise<RiderChallengeForDecision | null> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A challenge is identified by its id (a UUID)');
    const database = transactionOf(handle);
    const locked = await database.execute(
      sql`select id from rider_sign_in_challenge where id = ${id}::uuid for no key update`,
    );
    if (locked.rows.length === 0) return null;
    const result = await database.execute(sql`
      select ${COLUMNS}, expires_at <= clock_timestamp() as expired
        from rider_sign_in_challenge where id = ${id}::uuid`);
    const row = result.rows[0] as unknown as (ChallengeColumns & { expired: boolean }) | undefined;
    return row === undefined ? null : { challenge: challengeOf(row), expired: row.expired };
  }

  /**
   * Consumes a live challenge, once: `true` for the request that did, `false` for any other, a spent, ended or expired one included.
   * **One refusal is an error and not a `false`**: a challenge that lapsed while the statement waited for a lock that left the row unchanged
   * is judged by the table's guard, after the wait (the `where` was judged before it), and the guard's refusal fails the statement and so the
   * transaction. It is raised as `RiderChallengeExpiredError`, and only for the guard's stated reason: the caller lets the transaction roll
   * back and answers the sign-in as expired.
   */
  async consume(handle: TransactionHandle, id: string): Promise<boolean> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A challenge is identified by its id (a UUID)');
    let result;
    try {
      result = await transactionOf(handle).execute(sql`
        update rider_sign_in_challenge set state = 'CONSUMED'
         where id = ${id}::uuid and state = 'PENDING' and expires_at > clock_timestamp()
        returning id`);
    } catch (error) {
      // Only the guard's stated reason is the expiry; any other failure (a lost commit and a check violation without it included) is
      // rethrown as it was.
      if (guardReasonIn(error) === 'CHALLENGE_EXPIRED') throw new RiderChallengeExpiredError();
      throw error;
    }
    return result.rows.length === 1;
  }

  /**
   * Ends a `PENDING` challenge: as `UNUSABLE` (a binding that does not hold: the number, the service or the purpose), or as `EXPIRED`, which
   * the database allows only once its time has passed and which this refuses for a challenge with time left. `false` when nothing was ended.
   */
  async end(
    handle: TransactionHandle,
    id: string,
    state: 'UNUSABLE' | 'EXPIRED',
  ): Promise<boolean> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A challenge is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(
      state === 'EXPIRED'
        ? sql`update rider_sign_in_challenge set state = 'EXPIRED'
                where id = ${id}::uuid and state = 'PENDING' and expires_at <= clock_timestamp() returning id`
        : sql`update rider_sign_in_challenge set state = 'UNUSABLE' where id = ${id}::uuid and state = 'PENDING' returning id`,
    );
    return result.rows.length === 1;
  }
}
