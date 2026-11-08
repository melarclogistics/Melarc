import 'reflect-metadata';

import type { Logger } from 'pino';

import { AppModule } from './app.module.js';
import { createApp } from './create-app.js';
import { loadConfig } from './platform/config/load-config.js';
import { reportConfigProblems } from './platform/config/report-config-problems.js';
import { installFaultHandlers } from './platform/lifecycle/fault-handlers.js';
import { listenAndMarkReady } from './platform/lifecycle/listen-and-mark-ready.js';
import { installProcessShutdown } from './platform/lifecycle/shutdown-handlers.js';
import { ShutdownRegistry } from './platform/lifecycle/shutdown.registry.js';
import { describeError } from './platform/logging/redaction.js';
import {
  applicationMetricsSource,
  startProcessMetrics,
} from './platform/metrics/process-metrics.js';
import { LOGGER } from './platform/platform.tokens.js';

/**
 * The process entry point. It validates configuration before anything else exists, refuses to start
 * on a bad one, and does not call process.exit() on the normal paths: it sets the exit code and lets
 * the event loop drain, so every buffer is flushed and every handle closed first. The one exception is
 * a shutdown that ran out of its budget, which ends the process non-zero at once because a stalled
 * resource can hold a handle open for ever (see installShutdownHandlers).
 */
async function main(): Promise<void> {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    process.stderr.write(reportConfigProblems(loaded.problems));
    process.exitCode = 1;
    return;
  }
  const { config } = loaded;

  const app = await createApp({ config, rootModule: (options) => AppModule.register(options) });
  const logger = app.get<Logger>(LOGGER);

  installFaultHandlers(logger, {
    on: (event, listener) => process.on(event, listener),
    exit: (code) => process.exit(code),
  });

  installProcessShutdown(app, { logger, shutdown: config.shutdown });

  // The private metrics endpoint (S0.68), when configured: a listener of its own, started before the API listens so that a port it
  // cannot take stops the start, and closed with the other resources on shutdown.
  const metrics = await startProcessMetrics({
    endpoint: config.metrics,
    source: config.metrics === undefined ? undefined : applicationMetricsSource(app),
    logger,
  });
  if (metrics !== undefined) {
    app.get(ShutdownRegistry).register({ name: 'metrics endpoint', close: () => metrics.close() });
  }

  try {
    if (await listenAndMarkReady(app, config.http)) {
      logger.info({ host: config.http.host, port: config.http.port }, 'api listening');
    }
  } catch (error) {
    // The endpoint is a listener of its own and holds the event loop open. A start that failed after it opened (the API's port taken, an
    // unsound route inventory) would otherwise never end: no restart policy would fire, and a scraper would see a target that is up.
    await metrics?.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  // Configuration was valid but startup still failed (a port in use, an unsound route inventory).
  process.stderr.write(
    `${JSON.stringify({
      level: 'fatal',
      time: new Date().toISOString(),
      service: 'melarc-api',
      msg: 'startup failed',
      err: describeError(error),
    })}\n`,
  );
  process.exitCode = 1;
});
