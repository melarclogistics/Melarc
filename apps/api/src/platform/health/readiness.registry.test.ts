import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReadinessRegistry } from './readiness.registry.js';

describe('ReadinessRegistry', () => {
  // Break caught: a registry with no checks reporting failure, which would keep a bare API unready.
  it('reports nothing failing when no checks are registered', async () => {
    expect(await new ReadinessRegistry().failing()).toEqual([]);
  });

  it('names exactly the checks that fail', async () => {
    const registry = new ReadinessRegistry();
    registry.register({ name: 'healthy', check: () => undefined });
    registry.register({ name: 'rejects', check: () => Promise.reject(new Error('down')) });
    registry.register({
      name: 'throws',
      check: () => {
        throw new Error('down');
      },
    });
    expect((await registry.failing()).toSorted()).toEqual(['rejects', 'throws']);
  });

  // Break caught: a dependency check that never returns hanging the probe, so the platform cannot tell
  // "slow" from "down".
  it('treats a check that does not answer in time as failing', async () => {
    const registry = new ReadinessRegistry();
    registry.register({ name: 'hangs', check: () => new Promise<void>(() => undefined) });
    registry.register({ name: 'fine', check: () => undefined });

    const startedAt = Date.now();
    expect(await registry.failing(50)).toEqual(['hangs']);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  // Break caught: the default deadline stretching until the platform's own probe timeout is the only limit, so
  // one hung dependency makes every probe hang with it. Fake timers: the deadline is exactly two seconds.
  describe('with the default deadline', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives a check two seconds to answer, and not a moment longer', async () => {
      vi.useFakeTimers();
      const registry = new ReadinessRegistry();
      registry.register({ name: 'hangs', check: () => new Promise<void>(() => undefined) });

      let answer: string[] | undefined;
      void registry.failing().then((names) => {
        answer = names;
      });

      await vi.advanceTimersByTimeAsync(1999);
      expect(answer).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(answer).toEqual(['hangs']);
    });
  });

  // Break caught: every probe starting a run of its own. A flood of probes (or just several instances of a load
  // balancer) then put one query each on the pool that serves the business, and one slow database made the
  // number of waiting queries grow with the number of probes.
  it('runs the checks once for probes that arrive while a run is under way', async () => {
    let calls = 0;
    let finish: () => void = () => undefined;
    const registry = new ReadinessRegistry();
    registry.register({
      name: 'database',
      check: () => {
        calls += 1;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });

    const probes = [registry.failing(), registry.failing(), registry.failing()];
    await Promise.resolve();
    finish();

    expect(await Promise.all(probes)).toEqual([[], [], []]);
    expect(calls).toBe(1);
  });

  // Break caught: the shared run being kept after it ends, so a dependency that recovered is reported down.
  it('runs the checks again for a probe that arrives after the run has ended', async () => {
    let healthy = false;
    const registry = new ReadinessRegistry();
    registry.register({
      name: 'database',
      check: () => (healthy ? undefined : Promise.reject(new Error('down'))),
    });

    expect(await registry.failing()).toEqual(['database']);
    healthy = true;
    expect(await registry.failing()).toEqual([]);
  });

  // Break caught: a timed-out run being kept for ever as the shared run, so every later probe waits for it.
  it('starts a new run after one that timed out', async () => {
    let calls = 0;
    const registry = new ReadinessRegistry();
    registry.register({
      name: 'database',
      check: () => {
        calls += 1;
        return new Promise<void>(() => undefined);
      },
    });

    expect(await registry.failing(30)).toEqual(['database']);
    expect(await registry.failing(30)).toEqual(['database']);
    expect(calls).toBe(2);
  });

  // Break caught: two checks under one name, so one silently replaces the other.
  it('refuses a second check with the same name', () => {
    const registry = new ReadinessRegistry();
    registry.register({ name: 'database', check: () => undefined });
    expect(() => {
      registry.register({ name: 'database', check: () => undefined });
    }).toThrow(/database/);
  });
});
