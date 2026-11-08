import type { INestApplicationContext } from '@nestjs/common';
import type { Logger } from 'pino';

import { METRICS } from '../auth/ports/metrics.port.js';
import type { MetricsEndpointConfig } from '../config/load-config.js';
import { renderExposition, type GaugeReading } from './exposition.js';
import { startMetricsListener, type MetricsListener } from './metrics-listener.js';
import { snapshotSourceOf, type SnapshotSource } from './metrics-snapshot.js';

/** A process whose metrics endpoint is configured, and that has no registry it can serve, is a wiring defect: it never starts. */
export class MetricsEndpointUnservedError extends Error {
  override name = 'MetricsEndpointUnservedError';

  constructor() {
    super('The metrics endpoint is configured, and no registry that serves a snapshot is bound');
  }
}

/**
 * The registry an application binds to the `Metrics` port, read as one that serves a snapshot (the bounded registry of the runtime
 * composition), for the process entry, which names no port itself.
 */
export function applicationMetricsSource(
  app: Pick<INestApplicationContext, 'get'>,
): SnapshotSource | undefined {
  return snapshotSourceOf(app.get(METRICS, { strict: false }));
}

export interface ProcessMetricsOptions {
  /** Where to listen; absent when the endpoint is off. */
  readonly endpoint: MetricsEndpointConfig | undefined;
  readonly source: SnapshotSource | undefined;
  /** The gauges the process reads when it is asked: the worker's age of the oldest due message. */
  readonly gauges?: () => Promise<readonly GaugeReading[]>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
}

/**
 * Starts a process's private metrics endpoint (S0.68) when it is configured, and nothing when it is not. Each read renders the
 * registry's counters and observations and the gauges read at that moment; a gauge that cannot be read (the database is away) makes
 * the read fail with `503`, so a scraper sees the target as unhealthy instead of a backlog of zero.
 */
export async function startProcessMetrics(
  options: ProcessMetricsOptions,
): Promise<MetricsListener | undefined> {
  const { endpoint, source } = options;
  if (endpoint === undefined) return undefined;
  if (source === undefined) throw new MetricsEndpointUnservedError();
  return startMetricsListener({
    ...endpoint,
    read: async () => renderExposition(source.snapshot(), (await options.gauges?.()) ?? []),
    logger: options.logger,
  });
}
