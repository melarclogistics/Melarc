import { afterEach, describe, expect, it } from 'vitest';

import { BoundedMetrics } from './bounded.metrics.adapter.js';
import type { MetricsListener } from './metrics-listener.js';
import { snapshotSourceOf } from './metrics-snapshot.js';
import { MetricsEndpointUnservedError, startProcessMetrics } from './process-metrics.js';

const quiet = { info: () => undefined, warn: () => undefined };
const ENDPOINT = { host: '127.0.0.1', port: 0 };

let listener: MetricsListener | undefined;
afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

describe('a process’s private metrics endpoint (S0.68)', () => {
  it('starts nothing when it is not configured', async () => {
    expect(
      await startProcessMetrics({ endpoint: undefined, source: undefined, logger: quiet }),
    ).toBeUndefined();
  });

  // Break caught: an endpoint configured over a registry that cannot serve a snapshot (a double bound by mistake), which would
  // listen and answer nothing true.
  it('refuses to start when it is configured and no registry that serves a snapshot is bound', async () => {
    await expect(
      startProcessMetrics({
        endpoint: ENDPOINT,
        source: snapshotSourceOf({ increment: () => undefined }),
        logger: quiet,
      }),
    ).rejects.toThrow(MetricsEndpointUnservedError);
  });

  it('serves the registry and the gauges read at that moment, and 503 when a gauge cannot be read', async () => {
    const metrics = new BoundedMetrics({
      policy: 'throw',
      clock: { monotonicMilliseconds: () => 0 },
    });
    metrics.increment('credential_delivery_leases_expired_total');
    let age: number | Error = 42;
    listener = await startProcessMetrics({
      endpoint: ENDPOINT,
      source: snapshotSourceOf(metrics),
      gauges: () =>
        age instanceof Error
          ? Promise.reject(age)
          : Promise.resolve([{ name: 'credential_delivery_oldest_due_age_seconds', value: age }]),
      logger: quiet,
    });
    const url = `http://127.0.0.1:${String(listener?.port)}/metrics`;

    const text = await (await fetch(url)).text();
    expect(text).toContain('credential_delivery_leases_expired_total 1');
    expect(text).toContain('credential_delivery_oldest_due_age_seconds 42');

    age = new Error('the database is away');
    expect((await fetch(url)).status).toBe(503);
  });
});
