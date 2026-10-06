import { describe, expect, it, vi } from 'vitest';

import { ShutdownRegistry } from './shutdown.registry.js';

const never = () => new Promise<void>(() => undefined);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('ShutdownRegistry', () => {
  // Break caught: closing in registration order, so a pool is closed before the client that still uses it.
  it('closes resources in the reverse order they were registered', async () => {
    const closed: string[] = [];
    const registry = new ShutdownRegistry();
    registry.register({ name: 'first', close: () => void closed.push('first') });
    registry.register({ name: 'second', close: () => void closed.push('second') });
    registry.register({ name: 'third', close: () => Promise.resolve(void closed.push('third')) });

    const report = await registry.closeAll();

    expect(closed).toEqual(['third', 'second', 'first']);
    expect(report).toEqual({
      closed: ['third', 'second', 'first'],
      failed: [],
      stalled: [],
      unreached: [],
    });
  });

  // Break caught: one resource that cannot close stopping the rest from closing, or going unreported.
  it('keeps closing after a failure and names every resource that failed', async () => {
    const closed: string[] = [];
    const registry = new ShutdownRegistry();
    registry.register({ name: 'ok-1', close: () => void closed.push('ok-1') });
    registry.register({
      name: 'throws',
      close: () => {
        throw new Error('boom');
      },
    });
    registry.register({ name: 'rejects', close: () => Promise.reject(new Error('boom')) });
    registry.register({ name: 'ok-2', close: () => void closed.push('ok-2') });

    const report = await registry.closeAll();

    expect(report.failed.map((failure) => failure.name)).toEqual(['rejects', 'throws']);
    expect(report.failed.every((failure) => failure.error instanceof Error)).toBe(true);
    expect(report.closed).toEqual(['ok-2', 'ok-1']);
    expect(closed).toEqual(['ok-2', 'ok-1']);
  });

  // Break caught: a second shutdown call closing the same resource twice.
  it('closes each resource at most once', async () => {
    let closes = 0;
    const registry = new ShutdownRegistry();
    registry.register({ name: 'pool', close: () => void (closes += 1) });
    await registry.closeAll();
    await registry.closeAll();
    expect(closes).toBe(1);
  });
});

describe('ShutdownRegistry under a budget', () => {
  // Break caught: one resource that never finishes closing holding shutdown up for ever.
  it('stops waiting at the budget and names the resource it was waiting for', async () => {
    const registry = new ShutdownRegistry();
    registry.register({ name: 'stalls', close: never });

    const startedAt = performance.now();
    const report = await registry.closeAll(150);

    expect(report.stalled).toEqual(['stalls']);
    expect(report.closed).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  });

  // Break caught: a stalled resource keeping everything registered before it from being attempted at
  // all. They are started, not awaited, and reported as unreached because nothing confirms them.
  it('still starts the resources it did not reach, without waiting for them', async () => {
    const attempted: string[] = [];
    const registry = new ShutdownRegistry();
    registry.register({ name: 'database-pool', close: () => void attempted.push('database-pool') });
    registry.register({ name: 'cache', close: () => void attempted.push('cache') });
    registry.register({ name: 'stalls', close: never });

    const report = await registry.closeAll(150);

    expect(report.stalled).toEqual(['stalls']);
    expect(report.unreached).toEqual(['cache', 'database-pool']);
    expect(attempted).toEqual(['cache', 'database-pool']);
    expect(report.closed).toEqual([]);
  });

  // Break caught: a resource that closed in time being reported as unconfirmed because a later one
  // stalled, which would hide what really is known.
  it('keeps what it confirmed before the budget ended', async () => {
    const registry = new ShutdownRegistry();
    registry.register({ name: 'late', close: never });
    registry.register({ name: 'quick', close: () => sleep(20) });

    const report = await registry.closeAll(300);

    expect(report.closed).toEqual(['quick']);
    expect(report.stalled).toEqual(['late']);
  });

  // Break caught: a rejection that arrives after the budget ending as an unhandled rejection, which
  // the fault handlers treat as fatal and would replace the shutdown report with a crash.
  it('swallows a failure that arrives after the budget', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const registry = new ShutdownRegistry();
      registry.register({
        name: 'slow-failure',
        close: () => sleep(200).then(() => Promise.reject(new Error('late: secret-value'))),
      });

      const report = await registry.closeAll(50);
      await sleep(500);

      expect(report.stalled).toEqual(['slow-failure']);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // Break caught: a budget that is already spent skipping resources that would have closed at once.
  it('still counts a resource that closes immediately when no time is left', async () => {
    const registry = new ShutdownRegistry();
    registry.register({ name: 'instant', close: () => undefined });

    const report = await registry.closeAll(0);

    expect(report.closed).toEqual(['instant']);
    expect(report.stalled).toEqual([]);
  });

  // Break caught: a resource whose close throws synchronously escaping as an exception instead of a
  // reported failure when a budget is in force.
  it('reports a synchronous throw as a failure, not as an exception', async () => {
    const registry = new ShutdownRegistry();
    registry.register({
      name: 'throws',
      close: () => {
        throw new Error('sync boom');
      },
    });

    const report = await registry.closeAll(500);

    expect(report.failed.map((failure) => failure.name)).toEqual(['throws']);
  });
});
