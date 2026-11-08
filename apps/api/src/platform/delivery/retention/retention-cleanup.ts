import { sql, type SQL } from 'drizzle-orm';

import { randomUUIDv7 } from '../../auth/crypto/uuid-v7.js';
import type { Clock } from '../../auth/ports/clock.port.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { DELIVERY_WORKER_PRINCIPAL_ID, RETENTION_BATCH_SIZE } from '../delivery-parameters.js';
import { ERASE_PAYLOAD } from '../delivery-sql.js';

export interface RetentionCleanupOptions {
  /** The database the worker connects through, as `melarc_worker_runtime`: the `credential_delivery` capability is opened over it. */
  readonly database: Pick<DatabaseService, 'transactionWithContext'>;
  /** The time of the correlation identifiers it makes (UUIDv7). What has expired is judged on the database's clock. */
  readonly clock: Pick<Clock, 'now'>;
  /** The most rows of each kind one run takes. */
  readonly batchSize?: number;
}

/**
 * What one run did. `leasesExpired` is how many of the jobs it expired were ones a lease had ended on with no outcome (a worker
 * crashed or was too slow): a takeover counts those, and no takeover comes for a job whose credential has ended. `more` says a batch
 * was full, so that there may be more waiting: run again.
 */
export interface RetentionReport {
  readonly jobsExpired: number;
  readonly replayErased: number;
  readonly leasesExpired: number;
  readonly more: boolean;
}

/**
 * The retention cleanup of credential material (S0.19; SECURITY_DESIGN.md §13.9a and §14.16; registry §5.2, the task
 * `erase_expired_credential_material`). It runs inside the delivery worker, under the `credential_delivery` capability, as
 * `melarc_worker_runtime`, and does two things to material whose time has passed:
 *
 * - **A delivery job whose redemption record has ended** and that no worker is working on (queued, waiting to retry, or leased with a
 *   lease that has ended) becomes `EXPIRED`, and its payload, which holds a live token, is erased. A job a worker still holds a lease
 *   of is left to that worker, which records its own outcome.
 * - **The sealed replay of an idempotency record whose window has closed** (`sealed_expires_at`, on the database's clock) is erased,
 *   all of it together, and the tombstone is set to say it was there. The saved answer stays byte for byte.
 *
 * **It deletes nothing**, and could not: no identity holds `DELETE` on either table (the registry gives none; who reclaims an
 * idempotency record after its time to live, and the retention of a finished job's metadata, are the Product Owner's decisions, plan
 * section 7.14). A finished job is not touched at all: it holds no secret, and its metadata stays.
 *
 * It is **bounded** (a batch of each kind per run; rows another cleanup holds locked are skipped, never waited for, so two at once take
 * different rows), **idempotent** (a row it has dealt with no longer matches), and each kind is its own short transaction so that one
 * that cannot run does not hold back the other: a run attempts both and then raises the first failure.
 */
export class RetentionCleanup {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #batchSize: number;

  constructor(options: RetentionCleanupOptions) {
    const batchSize = options.batchSize ?? RETENTION_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError('A cleanup batch is a whole number of rows, one or more.');
    }
    this.#database = options.database;
    this.#clock = options.clock;
    this.#batchSize = batchSize;
  }

  async runOnce(): Promise<RetentionReport> {
    let jobsExpired = 0;
    let leasesExpired = 0;
    let replayErased = 0;
    let failure: unknown;
    let failed = false;
    try {
      ({ expired: jobsExpired, leased: leasesExpired } = await this.#expireJobs());
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      replayErased = await this.#eraseReplays();
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
    return {
      jobsExpired,
      replayErased,
      leasesExpired,
      more: jobsExpired >= this.#batchSize || replayErased >= this.#batchSize,
    };
  }

  #context(): SecurityContext {
    return {
      principalType: 'SYSTEM',
      principalId: DELIVERY_WORKER_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'credential_delivery',
      correlationId: randomUUIDv7(this.#clock),
    };
  }

  async #expireJobs(): Promise<{ readonly expired: number; readonly leased: number }> {
    return this.#database.transactionWithContext(this.#context(), async (tx) => {
      const result = await tx.execute(sql`
        with due as (
          select id, state as previous_state
            from credential_delivery_job
           where expires_at <= clock_timestamp()
             and (state in ('QUEUED', 'RETRYABLE')
               or (state = 'LEASED' and lease_expires_at <= clock_timestamp()))
           order by expires_at, id
           limit ${this.#batchSize}
             for update skip locked
        )
        update credential_delivery_job j
           set state = 'EXPIRED', outcome_class = 'EXPIRED', lease_expires_at = null, ${ERASE_PAYLOAD}
          from due
         where j.id = due.id
     returning (due.previous_state = 'LEASED') as was_leased`);
      const rows = result.rows as unknown as { readonly was_leased: boolean }[];
      return { expired: rows.length, leased: rows.filter((row) => row.was_leased).length };
    });
  }

  async #eraseReplays(): Promise<number> {
    return this.#database.transactionWithContext(this.#context(), async (tx) => {
      const result = await tx.execute(eraseDueReplaysStatement(this.#batchSize));
      return result.rowCount ?? 0;
    });
  }
}

/**
 * The statement that erases the sealed replay of the idempotency records whose window has closed, a batch at a time (S0.19; G2-07).
 * Exported so that a test can show the plan it gets at a representative size, as the worker's own role and capability.
 *
 * The window is bounded by `statement_timestamp()`, which is **stable** for the statement, and not by `clock_timestamp()`, which is
 * volatile: a btree cannot be descended with a volatile bound, so a volatile bound makes the whole index a filter and a cleanup that
 * finds nothing due reads every sealed record every time it runs. The row-level policy of migration 0010 still judges each row
 * against `clock_timestamp()` when it is reached, so a replay is never erased before its window has closed, whatever this bound
 * says: the stable bound can only be earlier than the clock, and so can only leave a record to the next run. The partial index
 * `idempotency_record_sealed_expiry_idx` (migration 0013) holds only the records that still hold a sealed replay, in the order the
 * cleanup takes them.
 */
export function eraseDueReplaysStatement(batchSize: number): SQL {
  return sql`
    with due as (
      select id
        from idempotency_record
       where sealed_expires_at <= statement_timestamp()
       order by sealed_expires_at, id
       limit ${batchSize}
         for update skip locked
    )
    update idempotency_record r
       set sealed_ciphertext = null, sealed_nonce = null, sealed_key_version = null,
           sealed_envelope_version = null, sealed_expires_at = null, replay_unavailable_at = clock_timestamp()
      from due
     where r.id = due.id`;
}
