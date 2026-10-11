import { sql, type SQL } from 'drizzle-orm';

import type { LimiterDigest } from '../auth/crypto/limiter-digest.js';
import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type { Metrics } from '../auth/ports/metrics.port.js';
import {
  RATE_LIMIT_BUCKETS,
  type RateLimitBucket,
  type RateLimitDecision,
  type RateLimiter,
} from '../auth/ports/rate-limiter.port.js';
import type { DatabaseService, DatabaseTransaction } from '../database/database.service.js';
import {
  RATE_LIMIT_CAPACITY,
  RATE_LIMIT_KEY,
  rateLimitLockKey,
} from '../database/policy-lock/lock-keys.js';
import type { SecurityContext } from '../database/transaction-context.js';
import { bindTransactionHandle } from '../database/transaction-handle.js';
import { SettingInvalidError, SettingMissingError } from '../settings/settings-reader.js';
import { decideAgainstLimit, retryAfterSeconds } from './admission-decision.js';
import type { BucketLimits } from './bucket-limits.js';
import { LimiterKeyVersionError, LimiterUnavailableError } from './limiter-errors.js';
import {
  CLEANUP_BATCH,
  LIMITER_PRINCIPAL_ID,
  MAX_BUCKET_LIMIT,
  MAX_KEY_BYTES,
  MAX_TOTAL_ROWS,
  WINDOW_SECONDS,
} from './limiter-parameters.js';

export interface PostgresRateLimiterOptions {
  /** Only the door: the limiter opens a transaction of its own and uses nothing else of the service. */
  readonly database: Pick<DatabaseService, 'transactionWithContext'>;
  readonly digest: LimiterDigest;
  /** The limits, read in the admission transaction itself. */
  readonly limits: BucketLimits;
  /** Names the limiter's transactions (an identifier, a correlation id). It decides nothing: the window is the database's. */
  readonly clock: Pick<Clock, 'now'>;
  /** The table's capacity and the cleanup batch. They default to the development-qualified values; a test sets small ones. */
  readonly maxTotalRows?: number;
  readonly cleanupBatch?: number;
  /** Counts the refusals (`rate_limited_total`, per bucket and cause). The counters carry no identifier. */
  readonly metrics?: Metrics;
}

/** The refusal given to a key that is too long to digest: indistinguishable from any other, and it counts nothing. */
const REFUSED_UNIFORMLY: RateLimitDecision = { allowed: false, retryAfterSeconds: WINDOW_SECONDS };

/** How many key versions a refusal reports at most: a handful, because a deployment holds a handful. */
const MAX_REPORTED_VERSIONS = 8;

/**
 * What one admission transaction answers. Everything that can be expected is **returned** and not thrown: a transaction that raises
 * an error is rolled back and its connection destroyed (`DatabaseService.runInTransaction`), and an instance that is refused on
 * every request (an incompatible key, a missing setting) must not destroy a connection on every request.
 */
type Outcome =
  | {
      readonly kind: 'DECIDED';
      readonly decision: RateLimitDecision;
      readonly cause: 'BUCKET_CEILING' | 'STORE_CAPACITY' | undefined;
    }
  | { readonly kind: 'KEY_VERSIONS'; readonly held: number[]; readonly liveUnheld: number[] }
  | { readonly kind: 'LIMIT_INVALID'; readonly error: unknown };

/**
 * The authoritative rate limiter over PostgreSQL (S0.14; SECURITY_DESIGN.md §14.12), shared by every instance.
 *
 * **One decision is one short transaction of its own** under the `SYSTEM` context of the `rate_limit` capability, called with no
 * transaction of the caller's open (a second pooled connection taken from inside one is what the category forbids; the service
 * refuses a nested transaction). It takes none of the policy locks. Its steps, in order:
 *
 * 1. **Read the bucket's limit** from the settings, in this transaction: the capability may read the six `rate_limit_*` settings and
 *    no other (migration 0012), so an admission needs no second connection for its configuration.
 * 2. **Serialise the key.** A transaction-scoped advisory lock on the keyed digest of the bucket's key (class `RATE_LIMIT_KEY`,
 *    `lock-keys.ts`), for the digest under every held key version in ascending order, so two instances that hold a version in
 *    common exclude each other through it. Decisions for different keys do not wait for one another at this step.
 * 3. **Check that every live row can be counted (G2-04).** Rows live under a key version this instance does not hold cannot be
 *    seen by its digests, so it would count a key's allowance short. The instance then refuses to decide (`LimiterKeyVersionError`,
 *    inside `LimiterUnavailableError`) and writes nothing. A shared lock proves that two instances are ordered, not that each can
 *    count what the other wrote; this is the check that proves the second.
 * 4. **Count what is live for the key**, on the database's clock (`clock_timestamp()`, one reading for the statement), under every
 *    held version. **Decide.** Fewer live rows than the bucket's limit admits; at the limit the caller is told to wait until the row
 *    whose leaving frees a place has left. A refusal writes nothing, so it never extends a penalty, and it ends here: it takes no
 *    global lock.
 * 5. **Take the capacity lock (G2-05)** (class `RATE_LIMIT_CAPACITY`), the last lock of the transaction and the only one that is
 *    not per key. Under it, in order: **check key versions again** (step 3's check, now made at the one point every insert passes
 *    through, so that two instances which share no key lock cannot both pass step 3 and then both insert); remove a bounded batch
 *    of the oldest rows that have left the window; count every row the table
 *    holds, **live or expired**, up to the capacity; at the capacity the admission is refused **uniformly**, whoever asks, and
 *    nothing live is evicted; otherwise insert the row. Because every insert into the table is made under this lock and judges
 *    the whole table, the table never holds more than its capacity, whatever the number of instances and however many admissions
 *    for different keys are in flight; the lock is taken after the key locks and nothing else is taken after it, so it cannot
 *    take part in a cycle. This is brief global coordination, honestly: admissions that reach this step (the admitted ones) queue
 *    for it one at a time, for the length of a cleanup, a count, an insert and the commit. Refusals at the ceiling never do.
 *
 * The consumption commits with this transaction, **independently of any later authentication or business rollback**: the caller's
 * work happens after this has returned. Nothing is counted outside the rows, so a rollback, a lost commit or a crash leaves no
 * accounting behind to correct.
 *
 * **Fail closed.** If the limiter cannot decide for any reason (the pool, a lock not taken within the server's lock time, a refused
 * write, an uncertain commit, a limit that is missing or invalid, a key version it cannot count) it raises `LimiterUnavailableError`
 * with the cause and admits nothing. An uncertain commit is never retried here: the caller's retry is a new request and is counted as
 * one.
 *
 * What is stored is the bucket, a keyed digest and the database's time: no identifier, address or token.
 */
export class PostgresRateLimiter implements RateLimiter {
  readonly #database: PostgresRateLimiterOptions['database'];
  readonly #digest: LimiterDigest;
  readonly #limits: BucketLimits;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #maxTotalRows: number;
  readonly #cleanupBatch: number;
  readonly #metrics: Metrics | undefined;

  constructor(options: PostgresRateLimiterOptions) {
    this.#database = options.database;
    this.#digest = options.digest;
    this.#limits = options.limits;
    this.#clock = options.clock;
    this.#maxTotalRows = options.maxTotalRows ?? MAX_TOTAL_ROWS;
    this.#cleanupBatch = options.cleanupBatch ?? CLEANUP_BATCH;
    this.#metrics = options.metrics;
    if (!Number.isInteger(this.#maxTotalRows) || this.#maxTotalRows < 1) {
      throw new RangeError('The limiter’s capacity is a whole number of rows');
    }
    if (!Number.isInteger(this.#cleanupBatch) || this.#cleanupBatch < 1) {
      throw new RangeError('The limiter’s cleanup batch is a whole number of rows');
    }
  }

  async admit(bucket: RateLimitBucket, canonicalKey: string): Promise<RateLimitDecision> {
    if (!(RATE_LIMIT_BUCKETS as readonly string[]).includes(bucket)) {
      throw new TypeError('A rate-limit bucket is one of the six canonical buckets');
    }
    if (typeof canonicalKey !== 'string') throw new TypeError('A rate-limit key is text');
    if (Buffer.byteLength(canonicalKey, 'utf8') > MAX_KEY_BYTES) {
      this.#metrics?.increment('rate_limited_total', { bucket, cause: 'KEY_TOO_LONG' });
      return REFUSED_UNIFORMLY;
    }

    try {
      const digests = this.#digest.digestsFor(bucket, canonicalKey);
      const context: SecurityContext = {
        principalType: 'SYSTEM',
        principalId: LIMITER_PRINCIPAL_ID,
        surface: 'SYSTEM',
        taskCapability: 'rate_limit',
        correlationId: randomUUIDv7(this.#clock),
      };
      const outcome = await this.#database.transactionWithContext(context, (tx) =>
        this.#decide(tx, bucket, digests),
      );
      // Counted once the transaction has committed, so that a refusal whose commit was lost is not counted as one that was answered.
      if (outcome.kind === 'KEY_VERSIONS') {
        this.#metrics?.increment('rate_limiter_key_incompatible_total');
        throw new LimiterKeyVersionError(outcome.held, outcome.liveUnheld);
      }
      if (outcome.kind === 'LIMIT_INVALID') throw outcome.error;
      if (outcome.cause !== undefined) {
        this.#metrics?.increment('rate_limited_total', { bucket, cause: outcome.cause });
      }
      return outcome.decision;
    } catch (error) {
      throw new LimiterUnavailableError({ cause: error });
    }
  }

  async #decide(
    tx: DatabaseTransaction,
    bucket: RateLimitBucket,
    digests: ReturnType<LimiterDigest['digestsFor']>,
  ): Promise<Outcome> {
    // 1. The limit, in this transaction. A setting that is missing or not valid is an answer ("this limiter cannot decide"), not a
    //    fault of the connection; a failed statement is a fault, and is raised.
    let limit: number;
    try {
      limit = await this.#limits.limitOf(bucket, bindTransactionHandle(tx));
    } catch (error) {
      if (error instanceof SettingMissingError || error instanceof SettingInvalidError) {
        return { kind: 'LIMIT_INVALID', error };
      }
      throw error;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BUCKET_LIMIT) {
      return {
        kind: 'LIMIT_INVALID',
        error: new RangeError('The limit of a bucket is not a whole number from one to the cap'),
      };
    }

    // 2. One lock per held key version, in a fixed order: the lock keys are sorted, so two transactions never wait in a cycle.
    const lockKeys = [...new Set(digests.all.map((entry) => rateLimitLockKey(entry.bytes)))].sort(
      (a, b) => a - b,
    );
    for (const key of lockKeys) {
      await tx.execute(sql`select pg_advisory_xact_lock(${RATE_LIMIT_KEY}::int4, ${key}::int4)`);
    }

    // 3. Every live row must be one this instance can count.
    const held = digests.all.map((entry) => entry.version);
    const liveUnheld = await this.#liveVersionsNotHeld(tx, held);
    if (liveUnheld.length > 0) return { kind: 'KEY_VERSIONS', held, liveUnheld };

    // 4. What is live for this key, under every held version, on the database's clock: the seconds until each leaves.
    const versions = sql.join(
      digests.all.map((entry) => sql`${entry.bytes}`),
      sql`, `,
    );
    const live = await tx.execute(sql`
      with moment as (select clock_timestamp() as now)
      select extract(epoch from (admitted_at + make_interval(secs => ${WINDOW_SECONDS}) - moment.now))::float8 as leaves_in
        from rate_limit_admission, moment
       where bucket = ${bucket} and key_digest in (${versions})
         and admitted_at > moment.now - make_interval(secs => ${WINDOW_SECONDS})
       order by admitted_at asc`);
    const decision = decideAgainstLimit(
      limit,
      live.rows.map((row) => Number((row as { leaves_in: number | string }).leaves_in)),
    );
    if (!decision.allowed) return { kind: 'DECIDED', decision, cause: 'BUCKET_CEILING' };

    // 5. The capacity lock, last. Everything that writes to the table writes under it.
    await tx.execute(sql`select pg_advisory_xact_lock(${RATE_LIMIT_CAPACITY}::int4, 0)`);
    //    The check of step 3 is made again, now that no other insert can interleave with this one. Two instances that hold no key
    //    version in common take different key locks, so nothing before this point orders them: each can find the table clear and the
    //    key unused, and queue here. The one that gets the lock inserts and commits; the other, when it gets the lock, reads a row
    //    committed under a version it cannot count, and refuses to decide, which is what step 3 promises. A refusal here writes and
    //    deletes nothing. An instance that shares a key version with the writer was excluded at step 2 and finds nothing new.
    const liveUnheldNow = await this.#liveVersionsNotHeld(tx, held);
    if (liveUnheldNow.length > 0) return { kind: 'KEY_VERSIONS', held, liveUnheld: liveUnheldNow };
    //    The oldest rows that have left the window, a bounded batch. The policy of DELETE admits nothing that still counts, so a
    //    live row cannot be removed whatever this statement says. Only transactions holding the capacity lock delete, so no delete
    //    ever waits for another's rows.
    await tx.execute(sql`
      delete from rate_limit_admission
       where ctid = any (array(
         select ctid from rate_limit_admission
          where admitted_at <= clock_timestamp() - make_interval(secs => ${WINDOW_SECONDS})
          order by admitted_at asc
          limit ${this.#cleanupBatch}))`);
    //    Every row the table holds, live or expired, counted up to the capacity: at the capacity nobody is admitted.
    const counted = await tx.execute(sql`
      select count(*)::int as retained
        from (select 1 from rate_limit_admission limit ${this.#maxTotalRows}) as sample`);
    if ((counted.rows[0] as { retained: number }).retained >= this.#maxTotalRows) {
      const oldest = await tx.execute(sql`
        select extract(epoch from (min(admitted_at) + make_interval(secs => ${WINDOW_SECONDS}) - clock_timestamp()))::float8 as leaves_in
          from rate_limit_admission
         where admitted_at > clock_timestamp() - make_interval(secs => ${WINDOW_SECONDS})`);
      const leavesIn = (oldest.rows[0] as { leaves_in: number | string | null }).leaves_in;
      return {
        kind: 'DECIDED',
        decision: {
          allowed: false,
          retryAfterSeconds: retryAfterSeconds(Number(leavesIn ?? 1)),
        },
        cause: 'STORE_CAPACITY',
      };
    }

    // 6. Admit: one row, under the active key version, stamped by the database.
    await tx.execute(sql`
      insert into rate_limit_admission (bucket, key_digest, digest_version)
      values (${bucket}, ${digests.active.bytes}, ${digests.active.version})`);
    return { kind: 'DECIDED', decision: { allowed: true }, cause: undefined };
  }

  /** The key versions that have live rows and are not among `held` (see `liveVersionsNotHeldStatement`), ascending. */
  async #liveVersionsNotHeld(tx: DatabaseTransaction, held: readonly number[]): Promise<number[]> {
    const statement = liveVersionsNotHeldStatement(held);
    if (statement === undefined) return [];
    const result = await tx.execute(statement);
    return result.rows.map((row) => (row as { digest_version: number }).digest_version);
  }
}

/**
 * The statement that finds the key versions with live rows that are not among `held` (ascending, which is the order a caller gives
 * them in). A range for each stretch of version numbers the held versions leave out, so that each is one probe of the index on
 * `(digest_version, admitted_at)` and the cost is the number of held versions and not the number of rows. A correctly rotated
 * deployment has none, and the probes find nothing. Exported so that a test can show the plan it gets at a representative size.
 */
export function liveVersionsNotHeldStatement(held: readonly number[]): SQL | undefined {
  const first = held[0];
  const last = held[held.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const ranges = [sql`digest_version < ${first}`];
  for (let at = 0; at < held.length - 1; at += 1) {
    const from = held[at] ?? first;
    const to = held[at + 1] ?? last;
    if (to - from > 1) ranges.push(sql`(digest_version > ${from} and digest_version < ${to})`);
  }
  ranges.push(sql`digest_version > ${last}`);
  return sql`
    with moment as (select clock_timestamp() as now)
    select digest_version from rate_limit_admission, moment
     where admitted_at > moment.now - make_interval(secs => ${WINDOW_SECONDS})
       and (${sql.join(ranges, sql` or `)})
     group by digest_version order by digest_version limit ${MAX_REPORTED_VERSIONS}`;
}
