import { describe, expect, it } from 'vitest';

import { LifecycleService } from './lifecycle.service.js';

describe('LifecycleService', () => {
  // Break caught: an instance that reports ready before it has finished starting.
  it('starts in the starting state', () => {
    expect(new LifecycleService().state).toBe('starting');
  });

  it('becomes ready once marked ready', () => {
    const lifecycle = new LifecycleService();
    lifecycle.markReady();
    expect(lifecycle.state).toBe('ready');
  });

  it('moves from ready to draining', () => {
    const lifecycle = new LifecycleService();
    lifecycle.markReady();
    lifecycle.beginDraining();
    expect(lifecycle.state).toBe('draining');
  });

  // Break caught: a late markReady() (a slow start racing a shutdown) putting a draining instance back
  // into rotation.
  it('never leaves draining', () => {
    const lifecycle = new LifecycleService();
    lifecycle.beginDraining();
    lifecycle.markReady();
    expect(lifecycle.state).toBe('draining');
  });
});
