import {
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { gracefulShutdown } from './graceful-shutdown.js';
import { ShutdownRegistry } from './shutdown.registry.js';

/** Stands in for a pool or client: the only thing that matters is whether shutdown closed it. */
@Injectable()
class FixtureResource {
  closed = false;
  constructor(registry: ShutdownRegistry) {
    registry.register({
      name: 'fixture-resource',
      close: () => {
        this.closed = true;
      },
    });
  }
}

@Injectable()
class FailingResource {
  constructor(registry: ShutdownRegistry) {
    registry.register({
      name: 'failing-resource',
      close: () => {
        throw new Error('could not close: postgres://melarc:hunter2@db.internal/melarc');
      },
    });
  }
}

/**
 * Lets a test hold a Nest shutdown hook open and release it afterwards, so the application can still
 * be stopped for real once the test is over.
 */
const hook: { release: () => void } = {
  release: () => undefined,
};

/** A hook that runs after the HTTP listener has closed and never finishes. */
@Injectable()
class StalledShutdownHook implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return new Promise<void>((resolve) => {
      hook.release = resolve;
    });
  }
}

/** A hook that runs before the HTTP listener closes and never finishes. */
@Injectable()
class StalledDestroyHook implements OnModuleDestroy {
  onModuleDestroy(): Promise<void> {
    return new Promise<void>((resolve) => {
      hook.release = resolve;
    });
  }
}

@Module({ providers: [FixtureResource], exports: [FixtureResource] })
class ResourceModule {}

@Module({ providers: [FailingResource] })
class FailingResourceModule {}

@Module({ providers: [StalledShutdownHook] })
class StalledShutdownHookModule {}

@Module({ providers: [StalledDestroyHook] })
class StalledDestroyHookModule {}

let running: TestApp | undefined;

async function start(...extra: Parameters<typeof appWith>): Promise<TestApp> {
  running = await startTestApp({ rootModule: appWith(FixtureModule, ...extra) });
  return running;
}

afterEach(async () => {
  vi.restoreAllMocks();
  hook.release();
  hook.release = () => undefined;
  await running?.stop();
  running = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<void>(() => undefined);

async function status(baseUrl: string, path: string): Promise<number> {
  const response = await fetch(`${baseUrl}${path}`);
  await response.text();
  return response.status;
}

describe('gracefulShutdown', () => {
  // Break caught: an in-flight request cut off by shutdown, a resource never closed, or a listener
  // that keeps accepting connections after shutdown.
  it('lets in-flight requests finish, closes resources, then stops listening', async () => {
    const { app, baseUrl, logs } = await start(ResourceModule);
    const inFlight = fetch(`${baseUrl}/api/v1/fixture/slow/inflight?ms=400`);
    await sleep(100);

    const outcome = await gracefulShutdown(app, {
      timeoutMs: 5000,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    const response = await inFlight;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ label: 'inflight' });
    expect(outcome).toBe('clean');
    expect(app.get(FixtureResource).closed).toBe(true);
    await expect(fetch(`${baseUrl}/livez`)).rejects.toThrow();
    expect(logs.records().map((record) => record.msg)).toEqual(
      expect.arrayContaining(['shutdown started', 'shutdown complete']),
    );
  });

  // Break caught: readiness only flipping after the listener has closed (the load balancer learns too
  // late), or the listener closing before the drain delay has elapsed.
  it('reports not-ready at once and keeps serving through the drain delay', async () => {
    const { app, baseUrl, logs } = await start();
    const shutdown = gracefulShutdown(app, {
      timeoutMs: 5000,
      drainDelayMs: 600,
      logger: logs.logger,
    });

    expect(await status(baseUrl, '/readyz')).toBe(503);
    expect(await status(baseUrl, '/livez')).toBe(200);
    expect(await shutdown).toBe('clean');
    await expect(fetch(`${baseUrl}/livez`)).rejects.toThrow();
  });

  // Break caught: a stuck request making shutdown hang until the platform kills the process without
  // closing anything.
  it('forces connections closed after the timeout, and still closes resources', async () => {
    const { app, baseUrl, logs } = await start(ResourceModule);
    const stuck = fetch(`${baseUrl}/api/v1/fixture/slow/stuck?ms=8000`).catch(() => 'cut off');
    await sleep(100);

    const startedAt = Date.now();
    const outcome = await gracefulShutdown(app, {
      timeoutMs: 500,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    expect(outcome).toBe('forced');
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(await stuck).toBe('cut off');
    expect(app.get(FixtureResource).closed).toBe(true);
    expect(logs.records().map((record) => record.msg)).toContain('shutdown timed out');
  });

  // Break caught: a resource that fails to close going unreported, or leaking its credentials into the
  // log through the error.
  it('reports a resource that fails to close, without leaking its error', async () => {
    const { app, logs } = await start(FailingResourceModule);

    const outcome = await gracefulShutdown(app, {
      timeoutMs: 5000,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    expect(outcome).toBe('forced');
    expect(
      logs.records().find((record) => record.msg === 'resource failed to close'),
    ).toMatchObject({ level: 'error', resource: 'failing-resource' });
    expect(logs.text()).not.toContain('hunter2');
  });
});

describe('gracefulShutdown with something that never finishes', () => {
  // Break caught: a registered resource that never finishes closing holding shutdown up for ever. The
  // resource cleanup used to run outside the timeout, so one stalled pool kept the process alive until
  // the platform killed it. The resources registered earlier must still be attempted, and the log must
  // not claim that anything stalled was closed.
  it('stops waiting for a stalled resource, still attempts the others, and says which is unconfirmed', async () => {
    const { app, logs } = await start();
    const attempted = vi.fn();
    const registry = app.get(ShutdownRegistry);
    registry.register({ name: 'database-pool', close: attempted });
    registry.register({ name: 'stalled-client', close: never });

    const startedAt = performance.now();
    const outcome = await gracefulShutdown(app, {
      timeoutMs: 600,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    expect(outcome).toBe('forced');
    expect(performance.now() - startedAt).toBeLessThan(600 + 1500);
    expect(attempted).toHaveBeenCalledOnce();
    const messages = logs.records().map((record) => record.msg);
    expect(messages).toContain('shutdown timed out');
    expect(messages).not.toContain('shutdown complete');
    expect(logs.records().find((record) => record.msg === 'shutdown forced')).toMatchObject({
      level: 'error',
      reason: 'timeout',
      stage: 'resources',
      stalled_resources: ['stalled-client'],
      unreached_resources: ['database-pool'],
      closed_resources: [],
    });
  });

  // Break caught: a Nest shutdown hook that never finishes (after the listener has closed) making
  // app.close() wait for ever, and with it the whole shutdown.
  it('stops waiting for a stalled Nest shutdown hook, and still attempts the resources', async () => {
    const { app, logs } = await start(StalledShutdownHookModule, ResourceModule);

    const startedAt = performance.now();
    const outcome = await gracefulShutdown(app, {
      timeoutMs: 600,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    expect(outcome).toBe('forced');
    expect(performance.now() - startedAt).toBeLessThan(600 + 1500);
    expect(app.get(FixtureResource).closed).toBe(true);
    expect(logs.records().find((record) => record.msg === 'shutdown timed out')).toMatchObject({
      stage: 'application',
    });
    expect(logs.records().map((record) => record.msg)).not.toContain('shutdown complete');
  });

  // Break caught: a forced shutdown that leaves the listener accepting connections because Nest never
  // got as far as closing it (a hook stalled before it).
  it('stops listening when the budget ends, even if Nest never reached the listener', async () => {
    const { app, baseUrl, logs } = await start(StalledDestroyHookModule);
    const stuck = fetch(`${baseUrl}/api/v1/fixture/slow/stuck?ms=8000`).catch(() => 'cut off');
    await sleep(100);

    const outcome = await gracefulShutdown(app, {
      timeoutMs: 500,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    expect(outcome).toBe('forced');
    expect(await stuck).toBe('cut off');
    await expect(fetch(`${baseUrl}/livez`)).rejects.toThrow();
  });

  // Break caught: the budget starting again after the drain delay, so a shutdown meant to end within
  // the platform's grace period takes the drain delay longer.
  it('counts the drain delay inside the one budget', async () => {
    const { app, logs } = await start();
    app.get(ShutdownRegistry).register({ name: 'stalled-client', close: never });

    const startedAt = performance.now();
    const outcome = await gracefulShutdown(app, {
      timeoutMs: 1800,
      drainDelayMs: 1200,
      logger: logs.logger,
    });
    const elapsed = performance.now() - startedAt;

    expect(outcome).toBe('forced');
    expect(elapsed).toBeGreaterThanOrEqual(1700);
    expect(elapsed).toBeLessThan(2600);
  });

  // Break caught: a drain delay longer than the budget being waited out in full. The configuration refuses such a
  // pair, but this function is the one that has to keep its promise to settle within the budget, whoever calls it.
  it('never drains for longer than the budget, whatever the delay it is given', async () => {
    const { app, logs } = await start();

    const startedAt = performance.now();
    await gracefulShutdown(app, { timeoutMs: 400, drainDelayMs: 6000, logger: logs.logger });

    expect(performance.now() - startedAt).toBeLessThan(2500);
  });

  // Break caught: a second expiry replacing the first. When the application close stalls and a resource then
  // does too, the listener is closed once and the log names the stage that ran out first, not whichever was last.
  it('reports the first stage that ran out of time, once, when a later one stalls too', async () => {
    const { app, logs } = await start(StalledDestroyHookModule);
    app.get(ShutdownRegistry).register({ name: 'stalled-client', close: never });

    const outcome = await gracefulShutdown(app, {
      timeoutMs: 400,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    expect(outcome).toBe('forced');
    const timedOut = logs.records().filter((record) => record.msg === 'shutdown timed out');
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0]).toMatchObject({ stage: 'application' });
    expect(logs.records().find((record) => record.msg === 'shutdown forced')).toMatchObject({
      stage: 'application',
    });
  });

  // Break caught: a stalled cleanup that fails later becoming an unhandled rejection, which the fault
  // handlers treat as fatal, and its error text reaching the log unredacted.
  it('handles a failure that arrives after the budget, without logging it', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { app, logs } = await start();
      app.get(ShutdownRegistry).register({
        name: 'slow-failure',
        close: () =>
          sleep(400).then(() =>
            Promise.reject(new Error('late: postgres://melarc:hunter2@db.internal/melarc')),
          ),
      });

      const outcome = await gracefulShutdown(app, {
        timeoutMs: 200,
        drainDelayMs: 0,
        logger: logs.logger,
      });
      await sleep(700);

      expect(outcome).toBe('forced');
      expect(unhandled).not.toHaveBeenCalled();
      expect(logs.text()).not.toContain('hunter2');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // Break caught: a failing app.close() skipping resource cleanup, or its error leaking into the log.
  it('still closes resources when closing the application fails', async () => {
    const { app, logs } = await start(ResourceModule);
    vi.spyOn(app, 'close').mockRejectedValue(
      new Error('close failed: postgres://melarc:hunter2@db.internal/melarc'),
    );

    const outcome = await gracefulShutdown(app, {
      timeoutMs: 5000,
      drainDelayMs: 0,
      logger: logs.logger,
    });

    expect(outcome).toBe('forced');
    expect(app.get(FixtureResource).closed).toBe(true);
    expect(logs.records().find((record) => record.msg === 'shutdown failed')).toMatchObject({
      level: 'error',
    });
    expect(logs.records().find((record) => record.msg === 'shutdown forced')).toMatchObject({
      reason: 'failure',
    });
    expect(logs.text()).not.toContain('hunter2');
  });
});
