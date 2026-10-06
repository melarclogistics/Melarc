import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from 'pino';

import { LifecycleService } from './lifecycle.service.js';
import { ShutdownRegistry } from './shutdown.registry.js';
import { withinBudget } from './within-budget.js';

/**
 * `forced` means shutdown did not finish cleanly: the budget ran out, or something failed to close.
 * It never means everything was closed; the log names what is unconfirmed.
 */
export type ShutdownOutcome = 'clean' | 'forced';

export interface GracefulShutdownOptions {
  /** The one budget for everything: drain delay, application close, HTTP connections and resources. */
  readonly timeoutMs: number;
  /** How long to keep serving after readiness flips, so the load balancer stops sending traffic. */
  readonly drainDelayMs: number;
  readonly logger: Logger;
}

/** Where the budget ran out. */
type Stage = 'application' | 'resources';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function closeApplication(
  app: NestExpressApplication,
  logger: Logger,
): Promise<'closed' | 'failed'> {
  try {
    await app.close();
    return 'closed';
  } catch (error) {
    logger.error({ err: error }, 'shutdown failed');
    return 'failed';
  }
}

/** Stops accepting connections and cuts the ones still open. Safe when the listener is already closed. */
function closeHttpConnections(app: NestExpressApplication): void {
  const server = app.getHttpServer();
  server.close();
  server.closeAllConnections();
}

/**
 * Stops the API without losing work, inside one budget that nothing escapes:
 *
 * 1. readiness turns false at once, so the platform stops routing new requests here;
 * 2. the listener stays open for the drain delay, so requests already on their way are served;
 * 3. Nest closes the application: the listener closes, in-flight requests finish and the shutdown
 *    hooks run;
 * 4. every registered resource (the database pool, from B0.4) is closed, last registered first, with
 *    the time that is left.
 *
 * The drain delay, the application close and the resource cleanup all draw on the same `timeoutMs`.
 * When it ends, nothing is waited for any longer, however stalled: the listener and every remaining
 * connection are closed, the resources not yet confirmed are still started (not awaited), and the
 * outcome is `forced`. So this always settles within the budget, plus timer granularity, and the
 * caller can end the process knowing the shutdown has nothing left to wait for.
 */
export async function gracefulShutdown(
  app: NestExpressApplication,
  { timeoutMs, drainDelayMs, logger }: GracefulShutdownOptions,
): Promise<ShutdownOutcome> {
  const startedAt = performance.now();
  const remaining = () => Math.max(timeoutMs - (performance.now() - startedAt), 0);

  app.get(LifecycleService).beginDraining();
  logger.info({ drain_delay_ms: drainDelayMs, timeout_ms: timeoutMs }, 'shutdown started');

  // The drain delay is part of the budget, so it can never be longer than it.
  await sleep(Math.min(drainDelayMs, timeoutMs));

  let timedOutAt: Stage | undefined;
  const timeOut = (stage: Stage): void => {
    if (timedOutAt !== undefined) return;
    timedOutAt = stage;
    logger.warn({ stage, timeout_ms: timeoutMs }, 'shutdown timed out');
    closeHttpConnections(app);
  };

  const application = await withinBudget(closeApplication(app, logger), remaining());
  if (application.expired) timeOut('application');
  const applicationFailed = !application.expired && application.value === 'failed';

  // With no time left the resources are still started, but nothing waits for them.
  const report = await app
    .get(ShutdownRegistry)
    .closeAll(timedOutAt === undefined ? remaining() : 0);
  if (report.stalled.length > 0 || report.unreached.length > 0) timeOut('resources');

  for (const failure of report.failed) {
    logger.error({ resource: failure.name, err: failure.error }, 'resource failed to close');
  }

  if (timedOutAt === undefined && !applicationFailed && report.failed.length === 0) {
    logger.info('shutdown complete');
    return 'clean';
  }

  logger.error(
    {
      reason: timedOutAt === undefined ? 'failure' : 'timeout',
      stage: timedOutAt,
      closed_resources: report.closed,
      failed_resources: report.failed.map((failure) => failure.name),
      stalled_resources: report.stalled,
      unreached_resources: report.unreached,
    },
    'shutdown forced',
  );
  return 'forced';
}
