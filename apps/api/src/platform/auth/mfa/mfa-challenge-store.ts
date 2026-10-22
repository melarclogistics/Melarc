import { sql } from 'drizzle-orm';

import { guardReasonIn } from '../../database/database-failures.js';
import { timestampOf } from '../../database/timestamps.js';
import { isUuid } from '../../database/transaction-context.js';
import { securityContextOf, transactionOf } from '../../database/transaction-handle.js';
import { randomUUIDv7 } from '../crypto/uuid-v7.js';
import type { Clock } from '../ports/clock.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import {
  MfaChallengeContextError,
  MfaChallengeExpiredError,
  MfaChallengeRequestError,
} from './mfa-challenge-errors.js';

/** The states of a challenge (`src/staff/mfa-challenge.schema.ts` repeats them as a check, and a test compares the two). */
export type ChallengeState = 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'UNUSABLE';

const COLUMNS = sql.raw(
  'id, staff_identity_id, credential_generation, issued_at, expires_at, state, attempt_count',
);

interface ChallengeColumns {
  readonly id: string;
  readonly staff_identity_id: string;
  /** `bigint` comes back from a raw statement as text. */
  readonly credential_generation: number | string;
  /** A raw statement returns an instant as the server's text; `timestampOf` reads it. */
  readonly issued_at: Date | string;
  readonly expires_at: Date | string;
  readonly state: ChallengeState;
  readonly attempt_count: number;
}

/** An MFA challenge as the platform reads it: whose it is, on which credential, how long it lives and where it stands. */
export interface StoredChallenge {
  readonly id: string;
  readonly staffIdentityId: string;
  readonly credentialGeneration: number;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly state: ChallengeState;
  /** The wrong codes presented on this challenge. */
  readonly attemptCount: number;
}

function challengeOf(row: ChallengeColumns): StoredChallenge {
  return {
    id: row.id,
    staffIdentityId: row.staff_identity_id,
    credentialGeneration: Number(row.credential_generation),
    issuedAt: timestampOf(row.issued_at),
    expiresAt: timestampOf(row.expires_at),
    state: row.state,
    attemptCount: row.attempt_count,
  };
}

export interface IssueChallengeRequest {
  readonly staffIdentityId: string;
  /** The credential the password step proved, by its generation (one or more). */
  readonly credentialGeneration: number;
  /** `authentication_challenge_ttl_minutes`, read by the caller from the setting and never defaulted here. */
  readonly ttlMinutes: number;
}

/** A challenge locked for a decision, and whether its time has passed on the database's clock read after the lock. */
export interface ChallengeForDecision {
  readonly challenge: StoredChallenge;
  readonly expired: boolean;
}

export interface MfaChallengeStoreOptions {
  /** The time of the identifiers it makes (UUIDv7). Issue and expiry are the database's. */
  readonly clock: Pick<Clock, 'now'>;
}

function assertAuthentication(handle: TransactionHandle): void {
  const context = securityContextOf(handle);
  if (context.principalType !== 'SYSTEM' || context.taskCapability !== 'authentication') {
    throw new MfaChallengeContextError();
  }
}

/**
 * The store of MFA challenges (S0.32; domain-model.md §6.8 `MfaChallenge`; SECURITY_DESIGN.md §13.4b). Every method joins the caller's
 * transaction, under the authentication capability (row-level security admits nothing else to read or write a challenge), so issuing
 * a challenge and the act that did it commit together or not at all.
 *
 * - **A challenge is found by its id and by nothing else.** There is no list, no scan and no search by identity (`GBT-E5`, the port
 *   half): the id is the reference the client holds.
 * - **Time is the database's.** `issued_at` and `expires_at` come from one `clock_timestamp()` of the issuing statement, and the
 *   lifetime is the setting the caller read. The store's own clock only makes the identifier.
 * - **Issuing ends the identity's other live challenge**: a `PENDING` challenge of the same identity becomes `UNUSABLE` in the same
 *   transaction (the catalogue calls it superseded), so that asking for another challenge does not give three more wrong codes on the
 *   old one, and a code can be tried on one challenge of an identity at a time.
 * - The challenge is bound to the credential the password step proved: a guard of the table refuses one issued on a credential the
 *   identity does not hold now.
 */
export class MfaChallengeStore {
  readonly #clock: Pick<Clock, 'now'>;

  constructor(options: MfaChallengeStoreOptions) {
    this.#clock = options.clock;
  }

  async issue(handle: TransactionHandle, request: IssueChallengeRequest): Promise<StoredChallenge> {
    assertAuthentication(handle);
    const { staffIdentityId, credentialGeneration, ttlMinutes } = request;
    if (!isUuid(staffIdentityId)) throw new MfaChallengeRequestError('staffIdentityId');
    if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 1) {
      throw new MfaChallengeRequestError('credentialGeneration');
    }
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1) {
      throw new MfaChallengeRequestError('ttlMinutes');
    }
    const database = transactionOf(handle);

    // The identity's other live challenge ends first, rows locked in id order so that two issues that overlap cannot wait for each
    // other in a cycle.
    await database.execute(sql`
      with live as (
        select id from mfa_challenge
         where staff_identity_id = ${staffIdentityId}::uuid and state = 'PENDING'
         order by id for no key update
      )
      update mfa_challenge c set state = 'UNUSABLE' from live where c.id = live.id`);

    const inserted = await database.execute(sql`
      with at as (select clock_timestamp() as now)
      insert into mfa_challenge (id, staff_identity_id, credential_generation, issued_at, expires_at)
      select ${randomUUIDv7(this.#clock)}::uuid, ${staffIdentityId}::uuid, ${credentialGeneration}::bigint, at.now,
             at.now + make_interval(mins => ${ttlMinutes}::int)
        from at
      returning ${COLUMNS}`);
    return challengeOf(inserted.rows[0] as unknown as ChallengeColumns);
  }

  async findById(handle: TransactionHandle, id: string): Promise<StoredChallenge | null> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A challenge is identified by its id (a UUID)');
    const result = await transactionOf(handle).execute(
      sql`select ${COLUMNS} from mfa_challenge where id = ${id}::uuid`,
    );
    const row = result.rows[0] as unknown as ChallengeColumns | undefined;
    return row === undefined ? null : challengeOf(row);
  }

  /**
   * The challenge, **locked until the transaction ends** (the second step takes the identity's lock first and this second, the order of
   * the session issue), and whether its time has passed: the row is locked in a statement of its own and read, with the database's
   * clock, in the next one. Two statements because a lock and a time are not one thing: an expression of a statement that locks is
   * read before the wait for the lock when the holder leaves the row unchanged (a plain lock, which changes no row, so the statement
   * is not re-evaluated on the new version), and the judgement would be made on a time from before the wait. Read after it, the time
   * is the time at which the lock was granted. `null` for a challenge that is not there.
   */
  async lockForDecision(
    handle: TransactionHandle,
    id: string,
  ): Promise<ChallengeForDecision | null> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A challenge is identified by its id (a UUID)');
    const database = transactionOf(handle);
    const locked = await database.execute(
      sql`select id from mfa_challenge where id = ${id}::uuid for no key update`,
    );
    if (locked.rows.length === 0) return null;
    const result = await database.execute(sql`
      select ${COLUMNS}, expires_at <= clock_timestamp() as expired
        from mfa_challenge where id = ${id}::uuid`);
    const row = result.rows[0] as unknown as (ChallengeColumns & { expired: boolean }) | undefined;
    return row === undefined ? null : { challenge: challengeOf(row), expired: row.expired };
  }

  /**
   * Counts one wrong code on a challenge that is still live, and ends it with the wrong code that reaches `maxAttempts`: one conditional
   * update, so concurrent wrong codes each add one and none steps over the maximum. `null` when the challenge is not live (ended,
   * consumed, expired or not there): a code presented to it counts nothing. The maximum is the setting the caller read.
   */
  async recordWrongCode(
    handle: TransactionHandle,
    id: string,
    maxAttempts: number,
  ): Promise<StoredChallenge | null> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A challenge is identified by its id (a UUID)');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new MfaChallengeRequestError('maxAttempts');
    }
    const result = await transactionOf(handle).execute(sql`
      update mfa_challenge
         set attempt_count = attempt_count + 1,
             state = case when attempt_count + 1 >= ${maxAttempts}::int then 'UNUSABLE' else state end
       where id = ${id}::uuid and state = 'PENDING' and expires_at > clock_timestamp()
      returning ${COLUMNS}`);
    const row = result.rows[0] as unknown as ChallengeColumns | undefined;
    return row === undefined ? null : challengeOf(row);
  }

  /**
   * Consumes a live challenge, once: `true` for the request that did, `false` for any other, a spent, ended or expired one included.
   * **One refusal is an error and not a `false`**: a challenge that lapsed while the statement waited for a lock that left the row
   * unchanged is judged by the table's guard, after the wait (the `where` was judged before it), and the guard's refusal fails the
   * statement and so the transaction. It is raised as `MfaChallengeExpiredError`, and only for the guard's stated reason: the caller
   * lets the transaction roll back and answers the sign-in as expired.
   */
  async consume(handle: TransactionHandle, id: string): Promise<boolean> {
    assertAuthentication(handle);
    if (!isUuid(id)) throw new TypeError('A challenge is identified by its id (a UUID)');
    let result;
    try {
      result = await transactionOf(handle).execute(sql`
        update mfa_challenge set state = 'CONSUMED'
         where id = ${id}::uuid and state = 'PENDING' and expires_at > clock_timestamp()
        returning id`);
    } catch (error) {
      // Only the guard's stated reason is the expiry; any other failure (a lost commit and a check violation without it included) is
      // rethrown as it was.
      if (guardReasonIn(error) === 'CHALLENGE_EXPIRED') throw new MfaChallengeExpiredError();
      throw error;
    }
    return result.rows.length === 1;
  }

  /**
   * Ends a `PENDING` challenge: as `UNUSABLE` (superseded, or the identity can no longer sign in), or as `EXPIRED`, which the database
   * allows only once its time has passed and which this refuses for a challenge with time left. `false` when nothing was ended.
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
        ? sql`update mfa_challenge set state = 'EXPIRED'
                where id = ${id}::uuid and state = 'PENDING' and expires_at <= clock_timestamp() returning id`
        : sql`update mfa_challenge set state = 'UNUSABLE' where id = ${id}::uuid and state = 'PENDING' returning id`,
    );
    return result.rows.length === 1;
  }
}
