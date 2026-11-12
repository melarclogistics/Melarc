import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { randomUUIDv7 } from '../../auth/crypto/uuid-v7.js';
import type { Clock } from '../../auth/ports/clock.port.js';
import type { Metrics } from '../../auth/ports/metrics.port.js';
import type { DatabaseService } from '../../database/database.service.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { DELIVERY_WORKER_PRINCIPAL_ID } from '../delivery-parameters.js';
import type { PeriodicTask } from '../worker/delivery-worker.js';

/**
 * The failure backstop (S1.28; AC-SLICE-001-34; OB-S1-07; the Product Owner's decision D-A1 of 11 November 2026): the second lane of the delivery worker process, under its own
 * `pickup_backstop` capability. "Never leave a failure undecided indefinitely. The backstop exists because a queue nobody works is a queue that hides parcels"
 * (pickup-failure.md section 5.3). A request whose stop failed and that has sat in the Ops decision context (still confirmed, not escalated) for longer than its hub's
 * `stale_failure_backstop_hours` is escalated, and the escalation is recorded with its trigger: the event `pickup.request.escalated` (enhanced) by the system, `BACKSTOP`, the
 * threshold in hours and the seconds the failure waited.
 *
 * **Everything it does is one database function** (`melarc.failure_backstop_escalate`, migration 0084): the capability role holds the `EXECUTE` of that function and no privilege on
 * any table, so the lane can escalate stale failures and nothing else. This file only opens the context, calls the function in a transaction of its own, and keeps the figures.
 *
 * **A hub whose threshold is missing or unusable is not judged, and the lane says so.** The function returns those hubs; the lane logs them at error level (their identifiers, which are
 * not secret), keeps their number for the worker's private metrics endpoint (the gauge `pickup_backstop_unusable_hubs`, the worker's health), and the alert reads it. Nothing is escalated
 * for such a hub and no threshold is invented in its place.
 *
 * **The cadence is configuration** (`PICKUP_BACKSTOP_INTERVAL_MINUTES`, required, the same in every environment: 15), not a constant here.
 */

/** The most requests one transaction escalates: a bound on the work and the time one run holds locks for, not a product value. A backlog is cleared in rounds. */
export const BACKSTOP_BATCH_SIZE = 100;
/** The most rounds one run takes, so that a backlog that keeps coming cannot hold the lane for ever; the rest is left to the next check. */
export const MAX_BACKSTOP_ROUNDS = 10;
/** The longest one run may take: the budget its transactions run under, inside the worker's. */
export const BACKSTOP_RUN_BUDGET_MS = 30_000;

export interface FailureBackstopOptions {
  /** The database the worker connects through, as `melarc_worker_runtime`: the `pickup_backstop` capability is opened over it. */
  readonly database: Pick<DatabaseService, 'transactionWithContext'>;
  /** The time of the correlation identifiers it makes (UUIDv7). What has waited long enough is judged on the database's clock. */
  readonly clock: Pick<Clock, 'now'>;
  /** The most requests one transaction escalates. */
  readonly batchSize?: number;
}

/** What one transaction did. `more` says the batch was full, so that there may be more waiting: run again. */
export interface BackstopReport {
  readonly escalated: number;
  readonly more: boolean;
  /** The hubs that have a failure waiting and whose threshold is missing or not a whole number of hours from 1 to 8760. */
  readonly unusableHubs: readonly string[];
}

interface FunctionRow {
  readonly out_escalated: number;
  readonly out_more: boolean;
  readonly out_unusable_hubs: readonly string[] | null;
}

export class FailureBackstop {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;
  readonly #clock: Pick<Clock, 'now'>;
  readonly #batchSize: number;
  #unusableHubs: number | undefined;

  constructor(options: FailureBackstopOptions) {
    const batchSize = options.batchSize ?? BACKSTOP_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new RangeError(
        'A backstop batch is a whole number of requests, from one to a thousand.',
      );
    }
    this.#database = options.database;
    this.#clock = options.clock;
    this.#batchSize = batchSize;
  }

  /**
   * How many hubs the latest check could not judge; `undefined` until a check has run to its end, so that a lane that has not looked yet is not read as one that looked and found
   * nothing. Kept in the process's memory: it is the worker's health, read when the metrics endpoint is read.
   */
  get unusableHubs(): number | undefined {
    return this.#unusableHubs;
  }

  /** One transaction of the backstop: the function escalates up to a batch and answers what it did. */
  async runOnce(): Promise<BackstopReport> {
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: DELIVERY_WORKER_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'pickup_backstop',
      correlationId: randomUUIDv7(this.#clock),
    };
    const answer = await this.#database.transactionWithContext(context, async (tx) => {
      const result = await tx.execute(
        sql`select out_escalated, out_more, out_unusable_hubs::text[] as out_unusable_hubs
              from melarc.failure_backstop_escalate(${this.#batchSize}::integer)`,
      );
      return result.rows[0] as unknown as FunctionRow | undefined;
    });
    if (answer === undefined) throw new Error('The failure backstop gave no answer');
    return {
      escalated: answer.out_escalated,
      more: answer.out_more,
      unusableHubs: answer.out_unusable_hubs ?? [],
    };
  }

  /** Keeps the figure of a check that ran to its end. */
  recordUnusable(count: number): void {
    this.#unusableHubs = count;
  }
}

export interface FailureBackstopTaskOptions {
  readonly backstop: Pick<FailureBackstop, 'runOnce' | 'recordUnusable'>;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** How long the worker waits between checks: the worker's configuration, `PICKUP_BACKSTOP_INTERVAL_MINUTES`. */
  readonly intervalMs: number;
  readonly maxRounds?: number;
  /** The longest one run may take: `BACKSTOP_RUN_BUDGET_MS` by default. */
  readonly budgetMs?: number;
}

/**
 * The backstop as the delivery worker runs it: a periodic task, beside the lanes. A run goes on while a batch was full, up to `MAX_BACKSTOP_ROUNDS`, and says what it escalated once, with
 * counts and nothing else; a run that found nothing says nothing. A hub it could not judge is an error in the log on every check that finds it (the identifiers of the hubs, never a
 * request), and a gauge. A check that raises is counted as failed and raised again, for the worker's loop to log and to try at the next interval; a check that ran to its end is counted
 * as checked.
 */
export function failureBackstopTask(options: FailureBackstopTaskOptions): PeriodicTask {
  const maxRounds = options.maxRounds ?? MAX_BACKSTOP_ROUNDS;
  return {
    name: 'failure-backstop',
    intervalMs: options.intervalMs,
    budgetMs: options.budgetMs ?? BACKSTOP_RUN_BUDGET_MS,
    run: async (stop) => {
      let escalated = 0;
      let unusable: readonly string[] = [];
      try {
        for (let round = 0; round < maxRounds && !stop.aborted; round += 1) {
          const report = await options.backstop.runOnce();
          escalated += report.escalated;
          // The hubs the function names are the ones it met in this transaction; the last round's list is the latest word.
          unusable = report.unusableHubs;
          for (let each = 0; each < report.escalated; each += 1) {
            options.metrics.increment('pickup_backstop_escalations_total');
          }
          if (!report.more) break;
        }
      } catch (error) {
        options.metrics.increment('pickup_backstop_runs_total', { outcome: 'FAILED' });
        throw error;
      }
      options.metrics.increment('pickup_backstop_runs_total', { outcome: 'CHECKED' });
      options.backstop.recordUnusable(unusable.length);
      if (escalated > 0) {
        options.logger.info(
          { requests_escalated: escalated },
          'failure backstop escalated failures left undecided',
        );
      }
      if (unusable.length > 0) {
        options.logger.error(
          { hubs: unusable },
          'failure backstop cannot judge a hub: its stale_failure_backstop_hours is missing or unusable, and a failure waiting there is not escalated',
        );
      }
    },
  };
}
