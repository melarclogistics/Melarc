import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdmissionGate, AdmissionRefusedError } from './admission-gate.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const gate = (concurrency = 2, maxWaiters = 2, waitMs = 1_000): AdmissionGate =>
  new AdmissionGate({ concurrency, maxWaiters, waitMs });

/** The reason the gate gave for a refusal, or undefined when the promise was not refused. */
async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof AdmissionRefusedError
      ? error.reason
      : `not a refusal: ${String(error)}`;
  }
}

describe('AdmissionGate: how many requests are admitted at once', () => {
  // Break caught: a gate that admits more than its concurrency, or fewer.
  it('admits up to its concurrency at once, without waiting', async () => {
    const admission = gate(3);

    const slots = await Promise.all([
      admission.acquire(),
      admission.acquire(),
      admission.acquire(),
    ]);

    expect(slots).toHaveLength(3);
    expect(admission.active).toBe(3);
    expect(admission.waiting).toBe(0);
  });

  // Break caught: a slot that is not given back (a leaked slot shrinks the gate until nothing is admitted), or one given back
  // twice (a double release admits one more than the limit).
  it('gives a slot back once, however often it is released', async () => {
    const admission = gate(1, 2);
    const slot = await admission.acquire();

    slot.release();
    slot.release();
    expect(admission.active).toBe(0);
    const next = await admission.acquire();
    // The double release did not leave a second free slot behind: the caller after `next` has to wait.
    const waiting = admission.acquire();

    expect(admission.active).toBe(1);
    expect(admission.waiting).toBe(1);
    next.release();
    (await waiting).release();
    expect(admission.active).toBe(0);
  });

  // Break caught: a caller that is served out of turn.
  it('serves the waiters in the order they came', async () => {
    const admission = gate(1, 3);
    const first = await admission.acquire();
    const order: string[] = [];
    const second = admission.acquire().then((slot) => {
      order.push('second');
      return slot;
    });
    const third = admission.acquire().then((slot) => {
      order.push('third');
      return slot;
    });

    first.release();
    (await second).release();
    (await third).release();

    expect(order).toEqual(['second', 'third']);
    expect(admission.active).toBe(0);
  });

  // Break caught: a slot handed to a waiter and also left free, so the gate admits one more than its limit.
  it('hands a freed slot to a waiter without ever exceeding the concurrency', async () => {
    const admission = gate(2, 4);
    const [a, b] = await Promise.all([admission.acquire(), admission.acquire()]);
    const waiters = [admission.acquire(), admission.acquire()];

    a.release();
    expect(admission.active).toBe(2);
    expect(admission.waiting).toBe(1);
    b.release();
    expect(admission.active).toBe(2);
    expect(admission.waiting).toBe(0);
    for (const slot of await Promise.all(waiters)) slot.release();
    expect(admission.active).toBe(0);
  });
});

describe('AdmissionGate: how long and how many wait', () => {
  // Break caught: a waiter that waits for ever, which holds the connection and the request for as long as the holder does.
  it('refuses a waiter whose wait reached the admission deadline, and takes it out of the line', async () => {
    const admission = gate(1, 2, 2_000);
    const held = await admission.acquire();
    const waiting = refusal(admission.acquire());

    await vi.advanceTimersByTimeAsync(1_999);
    expect(admission.waiting).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(await waiting).toBe('timeout');
    expect(admission.waiting).toBe(0);
    held.release();
    // The refused waiter took no slot with it: the next caller is admitted at once.
    const next = await admission.acquire();
    expect(admission.active).toBe(1);
    next.release();
  });

  // Break caught: an unbounded line, which is memory an attacker chooses.
  it('refuses at once, without waiting, when the line is full', async () => {
    const admission = gate(1, 2, 60_000);
    const held = await admission.acquire();
    const waiters = [admission.acquire(), admission.acquire()];

    expect(await refusal(admission.acquire())).toBe('full');
    expect(admission.waiting).toBe(2);
    held.release();
    // One slot, so the waiters are served one after the other: each gives its slot back for the next.
    for (const waiter of waiters) (await waiter).release();
    expect(admission.active).toBe(0);
  });

  // Break caught: a waiter whose client went away still taking the next free slot.
  it('takes a waiter out of the line when its caller gives up, and passes the slot on', async () => {
    const admission = gate(1, 2, 60_000);
    const held = await admission.acquire();
    const controller = new AbortController();
    const gone = refusal(admission.acquire({ signal: controller.signal }));
    const stays = admission.acquire();

    controller.abort();

    expect(await gone).toBe('aborted');
    expect(admission.waiting).toBe(1);
    held.release();
    (await stays).release();
    expect(admission.active).toBe(0);
  });

  it('refuses a caller whose signal had already been aborted, without taking a place', async () => {
    const admission = gate(1, 2, 60_000);
    const held = await admission.acquire();
    const controller = new AbortController();
    controller.abort();

    expect(await refusal(admission.acquire({ signal: controller.signal }))).toBe('aborted');
    expect(admission.waiting).toBe(0);
    held.release();
  });

  // Break caught: a free slot not used by the caller who aborted at the moment it was offered.
  it('does not lose a slot to a waiter that was aborted as the slot came free', async () => {
    const admission = gate(1, 2, 60_000);
    const held = await admission.acquire();
    const controller = new AbortController();
    const gone = refusal(admission.acquire({ signal: controller.signal }));

    controller.abort();
    held.release();

    expect(await gone).toBe('aborted');
    const next = await admission.acquire();
    expect(admission.active).toBe(1);
    next.release();
  });

  // Break caught: timers left behind by waiters that were served, which keep the process and the test runner alive.
  it('leaves no timer behind once its waiters are served, refused or gone', async () => {
    const admission = gate(1, 3, 5_000);
    const held = await admission.acquire();
    const served = admission.acquire();
    const controller = new AbortController();
    const gone = refusal(admission.acquire({ signal: controller.signal }));
    const timedOut = refusal(admission.acquire());

    controller.abort();
    held.release();
    const slot = await served;
    await vi.advanceTimersByTimeAsync(5_000);
    slot.release();

    expect(await gone).toBe('aborted');
    expect(await timedOut).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AdmissionGate: construction and closing', () => {
  // Break caught: a gate configured so that nothing can ever be admitted, or that never refuses.
  it.each([
    ['no concurrency', { concurrency: 0, maxWaiters: 1, waitMs: 1 }],
    ['a fractional concurrency', { concurrency: 1.5, maxWaiters: 1, waitMs: 1 }],
    ['a negative line', { concurrency: 1, maxWaiters: -1, waitMs: 1 }],
    ['no wait', { concurrency: 1, maxWaiters: 1, waitMs: 0 }],
    ['an infinite wait', { concurrency: 1, maxWaiters: 1, waitMs: Number.POSITIVE_INFINITY }],
  ])('refuses to be built with %s', (_label, options) => {
    expect(() => new AdmissionGate(options)).toThrow(RangeError);
  });

  it('allows a line of no length: a caller over the concurrency is refused at once', async () => {
    const admission = gate(1, 0);
    const held = await admission.acquire();

    expect(await refusal(admission.acquire())).toBe('full');
    held.release();
  });

  // Break caught: shutdown leaving callers waiting for a gate that will never open.
  it('refuses its waiters and every later caller once closed, and still takes slots back', async () => {
    const admission = gate(1, 2);
    const held = await admission.acquire();
    const waiting = refusal(admission.acquire());

    admission.close();

    expect(await waiting).toBe('closed');
    expect(await refusal(admission.acquire())).toBe('closed');
    held.release();
    expect(admission.active).toBe(0);
  });
});
