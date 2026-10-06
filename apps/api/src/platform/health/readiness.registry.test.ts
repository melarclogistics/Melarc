import { describe, expect, it } from 'vitest';

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

  // Break caught: two checks under one name, so one silently replaces the other.
  it('refuses a second check with the same name', () => {
    const registry = new ReadinessRegistry();
    registry.register({ name: 'database', check: () => undefined });
    expect(() => {
      registry.register({ name: 'database', check: () => undefined });
    }).toThrow(/database/);
  });
});
