import type { Logger } from 'pino';

import type { Metrics } from '../../auth/ports/metrics.port.js';
import { RETENTION_RUN_BUDGET_MS } from '../delivery-parameters.js';
import type { PeriodicTask } from '../worker/delivery-worker.js';
import type { RetentionReport } from './retention-cleanup.js';

/** The most rounds one run of the task takes, so that a cleanup that is always finding more cannot hold the task for ever. */
export const MAX_RETENTION_ROUNDS = 20;

export interface RetentionTaskOptions {
  readonly cleanup: { runOnce(): Promise<RetentionReport> };
  readonly logger: Logger;
  /** Counts the leases that ended on the jobs the cleanup expired. */
  readonly metrics: Metrics;
  /** How long the worker waits between runs. */
  readonly intervalMs: number;
  readonly maxRounds?: number;
  /** The longest one run may take: `RETENTION_RUN_BUDGET_MS` by default. */
  readonly budgetMs?: number;
}

/**
 * The retention cleanup as the delivery worker runs it (S0.19): on a schedule, beside the lanes. A run goes on while a batch was full
 * (a backlog is cleared in rounds, not one batch a minute) up to `MAX_RETENTION_ROUNDS`, and says what it erased once, with counts and
 * nothing else; a run that found nothing says nothing. A run leaves off between rounds when the worker is told to stop. A failure of a
 * round is raised, for the worker's loop to log (its class and code, never its text) and to try again at the next interval.
 */
export function retentionTask(options: RetentionTaskOptions): PeriodicTask {
  const maxRounds = options.maxRounds ?? MAX_RETENTION_ROUNDS;
  return {
    name: 'retention',
    intervalMs: options.intervalMs,
    budgetMs: options.budgetMs ?? RETENTION_RUN_BUDGET_MS,
    run: async (stop) => {
      let jobsExpired = 0;
      let replayErased = 0;
      for (let round = 0; round < maxRounds && !stop.aborted; round += 1) {
        const report = await options.cleanup.runOnce();
        jobsExpired += report.jobsExpired;
        replayErased += report.replayErased;
        // A lease that ended with no outcome is what the alert on expired leases reads; a takeover counts the others.
        for (let each = 0; each < report.leasesExpired; each += 1) {
          options.metrics.increment('credential_delivery_leases_expired_total');
        }
        if (!report.more) break;
      }
      if (jobsExpired > 0 || replayErased > 0) {
        options.logger.info(
          { jobs_expired: jobsExpired, replay_erased: replayErased },
          'delivery retention erased expired material',
        );
      }
    },
  };
}
