import { sql, type SQL } from 'drizzle-orm';
import type { Logger } from 'pino';

import { randomUUIDv7 } from '../auth/crypto/uuid-v7.js';
import type { Clock } from '../auth/ports/clock.port.js';
import type { DatabaseService } from '../database/database.service.js';
import type { SecurityContext } from '../database/transaction-context.js';
import { DELIVERY_WORKER_PRINCIPAL_ID } from '../delivery/delivery-parameters.js';
import type { PeriodicTask } from '../delivery/worker/delivery-worker.js';

/**
 * The most rows one run of the sweep takes, how often the worker runs it, and the longest one run may take. A batch keeps a run to a short transaction. **The cadence is the
 * document's: hourly** (BACKGROUND_JOBS_AND_EVENTS.md section 3.5, "Evidence `PENDING_UPLOAD` sweep"), so an abandoned capture stays `PENDING_UPLOAD` for about an hour after its
 * window closed; nothing waits on it (a pending record cannot be referenced and cannot be read, and the guard refuses to store it once the window has passed, so the sweep only tidies
 * the state). The batch and the budget are development-qualified, not production-qualified.
 */
export const EVIDENCE_SWEEP_BATCH_SIZE = 200;
export const EVIDENCE_SWEEP_INTERVAL_MS = 60 * 60_000;
export const EVIDENCE_SWEEP_RUN_BUDGET_MS = 30_000;

/** The most rounds one run of the task takes, so that a sweep that is always finding more cannot hold the task for ever. */
export const MAX_EVIDENCE_SWEEP_ROUNDS = 20;

export interface EvidenceSweepOptions {
  /** The database the worker connects through, as `melarc_worker_runtime`: the `evidence_validation` capability is opened over it. */
  readonly database: Pick<DatabaseService, 'transactionWithContext'>;
  /** The time of the correlation identifiers it makes (UUIDv7). What has expired is judged on the database's clock. */
  readonly clock: Pick<Clock, 'now'>;
  /** The most rows one run takes. */
  readonly batchSize?: number;
}

/** What one run did: how many abandoned captures it marked `EXPIRED`, and whether a batch was full, so that there may be more waiting. */
export interface EvidenceSweepReport {
  readonly expired: number;
  readonly more: boolean;
}

/**
 * The sweep of abandoned captures (S1.11; registry section 5.2, the capability `evidence_validation`). It runs inside the delivery worker, as `melarc_worker_runtime` under the
 * capability, and does one thing: a record still `PENDING_UPLOAD` whose upload window has closed becomes `EXPIRED`. **It deletes nothing and writes nothing else**: the
 * capability reads the id, the state and the end of the window of the records still pending or already expired, and writes the state, to `EXPIRED` and only once the window has passed (the grants, the
 * policies and the record's guard hold it for every writer, whatever this statement says). The object a rider uploaded and never completed stays in the store: removing it is the
 * store's lifecycle rule and the owner's retention decision (OB-S1-05), not this sweep's.
 *
 * It is **bounded** (a batch per run; rows another sweep holds locked are skipped, never waited for, so two at once take different rows) and **idempotent** (a record it has dealt
 * with no longer matches).
 */
export class EvidenceSweep {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #batchSize: number;

  constructor(options: EvidenceSweepOptions) {
    const batchSize = options.batchSize ?? EVIDENCE_SWEEP_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError('A sweep batch is a whole number of rows, one or more.');
    }
    this.#database = options.database;
    this.#clock = options.clock;
    this.#batchSize = batchSize;
  }

  async runOnce(): Promise<EvidenceSweepReport> {
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: DELIVERY_WORKER_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'evidence_validation',
      correlationId: randomUUIDv7(this.#clock),
    };
    const expired = await this.#database.transactionWithContext(context, async (tx) => {
      const result = await tx.execute(expireAbandonedEvidenceStatement(this.#batchSize));
      return result.rowCount ?? 0;
    });
    return { expired, more: expired >= this.#batchSize };
  }
}

/**
 * The statement that marks the abandoned captures `EXPIRED`, a batch at a time. Exported so that a test can show it. The window is bounded by `statement_timestamp()`, which is
 * stable for the statement (so that the partial index on the end of the window of the pending records can be descended), and the guard of the record judges each row against
 * `clock_timestamp()` when it is reached: a record is never expired before its window has closed, whatever this bound says, and the stable bound can only be earlier than the
 * clock, so it can only leave a record to the next run.
 */
export function expireAbandonedEvidenceStatement(batchSize: number): SQL {
  return sql`
    with due as (
      select id
        from evidence
       where state = 'PENDING_UPLOAD' and upload_expires_at <= statement_timestamp()
       order by upload_expires_at, id
       limit ${batchSize}
         for update skip locked
    )
    update evidence e
       set state = 'EXPIRED'
      from due
     where e.id = due.id`;
}

export interface EvidenceSweepTaskOptions {
  readonly sweep: { runOnce(): Promise<EvidenceSweepReport> };
  readonly logger: Logger;
  /** How long the worker waits between runs: `EVIDENCE_SWEEP_INTERVAL_MS` by default. */
  readonly intervalMs?: number;
  /** The longest one run may take: `EVIDENCE_SWEEP_RUN_BUDGET_MS` by default. */
  readonly budgetMs?: number;
  readonly maxRounds?: number;
}

/**
 * The sweep as the delivery worker runs it: on a schedule, beside the lanes. A run goes on while a batch was full (a backlog is cleared in rounds, not one batch a minute) up to
 * `MAX_EVIDENCE_SWEEP_ROUNDS`, and says what it expired once, with a count and nothing else; a run that found nothing says nothing. A run leaves off between rounds when the
 * worker is told to stop. A failure of a round is raised, for the worker's loop to log (its class and code, never its text) and to try again at the next interval.
 */
export function evidenceSweepTask(options: EvidenceSweepTaskOptions): PeriodicTask {
  const maxRounds = options.maxRounds ?? MAX_EVIDENCE_SWEEP_ROUNDS;
  return {
    name: 'evidence',
    intervalMs: options.intervalMs ?? EVIDENCE_SWEEP_INTERVAL_MS,
    budgetMs: options.budgetMs ?? EVIDENCE_SWEEP_RUN_BUDGET_MS,
    run: async (stop) => {
      let expired = 0;
      for (let round = 0; round < maxRounds && !stop.aborted; round += 1) {
        const report = await options.sweep.runOnce();
        expired += report.expired;
        if (!report.more) break;
      }
      if (expired > 0) {
        options.logger.info(
          { evidence_expired: expired },
          'evidence sweep expired abandoned captures',
        );
      }
    },
  };
}
