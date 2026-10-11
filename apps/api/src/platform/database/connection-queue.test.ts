import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AcquireTimeoutError,
  ConnectionQueue,
  PoolClosedError,
  PoolSaturatedError,
} from './connection-queue.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets promise callbacks run without moving the fake timers. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ConnectionQueue: permits (S0.6, SECURITY_DESIGN.md §14.6)', () => {
  // Break caught: more permits than connections, which would send the surplus into the driver's own unbounded queue.
  it('grants at once up to its capacity, and counts what is in use', async () => {
    const queue = new ConnectionQueue({ capacity: 2, maxWaiters: 5 });

    const first = await queue.acquire({ timeoutMilliseconds: 1_000 });
    const second = await queue.acquire({ timeoutMilliseconds: 1_000 });

    expect(queue.inUse).toBe(2);
    expect(queue.waiting).toBe(0);
    first.release();
    second.release();
    expect(queue.inUse).toBe(0);
  });

  // Break caught: a waiter served out of order, so a caller that arrived first is starved.
  it('serves waiters first come first served as permits are released', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const held = await queue.acquire({ timeoutMilliseconds: 1_000 });
    const served: string[] = [];
    const a = queue.acquire({ timeoutMilliseconds: 1_000 }).then((permit) => {
      served.push('a');
      return permit;
    });
    const b = queue.acquire({ timeoutMilliseconds: 1_000 }).then((permit) => {
      served.push('b');
      return permit;
    });
    expect(queue.waiting).toBe(2);

    held.release();
    const permitA = await a;
    expect(served).toEqual(['a']);
    expect(queue.inUse).toBe(1);
    expect(queue.waiting).toBe(1);

    permitA.release();
    const permitB = await b;
    expect(served).toEqual(['a', 'b']);
    permitB.release();
    expect(queue.inUse).toBe(0);
  });

  // Break caught: a permit given back twice freeing two places, so the pool is overrun.
  it('frees a permit once, however many times it is released', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const permit = await queue.acquire({ timeoutMilliseconds: 1_000 });
    permit.release();
    permit.release();
    const next = await queue.acquire({ timeoutMilliseconds: 1_000 });
    expect(queue.inUse).toBe(1);
    const third = queue.acquire({ timeoutMilliseconds: 1_000 });
    expect(queue.waiting).toBe(1);
    permit.release();
    expect(queue.inUse).toBe(1);
    next.release();
    (await third).release();
  });
});

describe('ConnectionQueue: bounded waiters', () => {
  // Break caught: an unbounded queue, where a stall in the database turns every request into a parked promise.
  it('refuses at once when the waiters are as many as it allows, and does not queue the refused', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 2 });
    const held = await queue.acquire({ timeoutMilliseconds: 10_000 });
    const waiting = [
      queue.acquire({ timeoutMilliseconds: 10_000 }),
      queue.acquire({ timeoutMilliseconds: 10_000 }),
    ];
    expect(queue.waiting).toBe(2);

    await expect(queue.acquire({ timeoutMilliseconds: 10_000 })).rejects.toBeInstanceOf(
      PoolSaturatedError,
    );

    expect(queue.waiting).toBe(2);
    held.release();
    for (const permit of waiting) (await permit).release();
    expect(queue.inUse).toBe(0);
  });

  // Break caught: a refused caller that still takes a place in line.
  it('does not refuse a caller when a permit is free, however many may wait', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 1 });
    await expect(queue.acquire({ timeoutMilliseconds: 10 })).resolves.toBeDefined();
  });
});

describe('ConnectionQueue: a waiter that gives up is removed (cleanup of expired waiters)', () => {
  // Break caught: the timed-out waiter left in the queue, which then receives a permit nobody will release.
  it('removes a waiter whose wait timed out, rejects it, and gives the next permit to the next waiter', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const held = await queue.acquire({ timeoutMilliseconds: 10_000 });
    const timedOut = queue.acquire({ timeoutMilliseconds: 100 });
    const outcome = timedOut.then(
      () => 'granted',
      (error: unknown) => error,
    );
    const later = queue.acquire({ timeoutMilliseconds: 10_000 });
    expect(queue.waiting).toBe(2);

    vi.advanceTimersByTime(100);

    expect(await outcome).toBeInstanceOf(AcquireTimeoutError);
    expect(queue.waiting).toBe(1);
    held.release();
    const permit = await later;
    expect(queue.inUse).toBe(1);
    permit.release();
    expect(queue.inUse).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Break caught: a budget that expires while its request waits for a connection, with the waiter still in line.
  it('removes a waiter whose signal aborts, and rejects it with the signal’s reason', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const held = await queue.acquire({ timeoutMilliseconds: 10_000 });
    const controller = new AbortController();
    const reason = new Error('the request ran out of time');
    const aborted = queue.acquire({
      timeoutMilliseconds: 10_000,
      signal: controller.signal,
    });
    const outcome = aborted.then(
      () => 'granted',
      (error: unknown) => error,
    );
    expect(queue.waiting).toBe(1);

    controller.abort(reason);

    expect(await outcome).toBe(reason);
    expect(queue.waiting).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    held.release();
    expect(queue.inUse).toBe(0);
  });

  it('rejects at once, queuing nothing, when the signal is already aborted', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const reason = new Error('already over');
    await expect(
      queue.acquire({ timeoutMilliseconds: 10_000, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(queue.inUse).toBe(0);
    expect(queue.waiting).toBe(0);
  });

  // Break caught: a granted waiter that still has its timer or its abort listener, which later takes back or rejects a permit
  // it already holds.
  it('leaves nothing behind for a waiter that was served: no timer, no listener', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const held = await queue.acquire({ timeoutMilliseconds: 10_000 });
    const controller = new AbortController();
    const waiter = queue.acquire({ timeoutMilliseconds: 500, signal: controller.signal });

    held.release();
    const permit = await waiter;
    vi.advanceTimersByTime(10_000);
    controller.abort(new Error('late'));
    await settle();

    expect(queue.inUse).toBe(1);
    expect(queue.waiting).toBe(0);
    permit.release();
    expect(queue.inUse).toBe(0);
  });

  // Break caught: a permit that is granted by being free but still starts a timer.
  it('starts no timer for a permit it grants at once', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const permit = await queue.acquire({ timeoutMilliseconds: 10_000 });
    expect(vi.getTimerCount()).toBe(0);
    permit.release();
  });
});

describe('ConnectionQueue: closing', () => {
  // Break caught: shutdown leaving parked requests that can never be served.
  it('rejects every waiter when closed, and refuses what comes after', async () => {
    const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 5 });
    const held = await queue.acquire({ timeoutMilliseconds: 10_000 });
    const waiter = queue.acquire({ timeoutMilliseconds: 10_000 });
    const outcome = waiter.then(
      () => 'granted',
      (error: unknown) => error,
    );

    queue.close();

    expect(await outcome).toBeInstanceOf(PoolClosedError);
    expect(queue.waiting).toBe(0);
    await expect(queue.acquire({ timeoutMilliseconds: 1_000 })).rejects.toBeInstanceOf(
      PoolClosedError,
    );
    expect(vi.getTimerCount()).toBe(0);
    held.release();
    expect(queue.inUse).toBe(0);
  });
});

describe('ConnectionQueue: its bounds', () => {
  it.each([0, -1, 1.5, Number.NaN])('refuses a capacity of %s', (capacity) => {
    expect(() => new ConnectionQueue({ capacity, maxWaiters: 1 })).toThrow(RangeError);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a waiter bound of %s', (maxWaiters) => {
    expect(() => new ConnectionQueue({ capacity: 1, maxWaiters })).toThrow(RangeError);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a wait of %s milliseconds: every wait is finite and positive',
    async (timeoutMilliseconds) => {
      const queue = new ConnectionQueue({ capacity: 1, maxWaiters: 1 });
      await expect(queue.acquire({ timeoutMilliseconds })).rejects.toBeInstanceOf(RangeError);
      expect(queue.inUse).toBe(0);
    },
  );
});
