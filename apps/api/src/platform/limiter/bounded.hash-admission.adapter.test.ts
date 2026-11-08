import { describe, expect, it } from 'vitest';

import {
  BoundedHashAdmission,
  DEFAULT_RESERVED_THREADS,
  libuvThreadpoolSize,
  planHashAdmission,
  runAdmitted,
} from './bounded.hash-admission.adapter.js';

describe('the bounded set of concurrent hashes', () => {
  // Break caught: more hashes admitted than there are slots, or a refusal that waits (there is no queue until a waiting policy is measured).
  it('admits as many hashes as there are slots and refuses the next at once', () => {
    const admission = new BoundedHashAdmission({ slots: 2, threadpoolSize: 4 });

    const first = admission.tryAdmit();
    const second = admission.tryAdmit();
    const third = admission.tryAdmit();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).toBeNull();
    expect(admission.inUse).toBe(2);
  });

  // Break caught: a slot that never comes back, or one that comes back twice and lets in more than the bound.
  it('gives a place back when its slot is released, once however often it is released', () => {
    const admission = new BoundedHashAdmission({ slots: 2, threadpoolSize: 4 });
    const first = admission.tryAdmit();
    admission.tryAdmit();

    first?.release();
    first?.release();
    first?.release();

    expect(admission.inUse).toBe(1);
    expect(admission.tryAdmit()).not.toBeNull();
    expect(admission.tryAdmit()).toBeNull();
  });

  // Break caught: a slot for each hash that is not distinct, so that releasing one frees another’s.
  it('gives each admission a slot of its own', () => {
    const admission = new BoundedHashAdmission({ slots: 3, threadpoolSize: 8 });
    const slots = [admission.tryAdmit(), admission.tryAdmit(), admission.tryAdmit()];

    slots[1]?.release();

    expect(admission.inUse).toBe(2);
    slots[0]?.release();
    slots[2]?.release();
    expect(admission.inUse).toBe(0);
  });

  // Break caught: a bound that rests on a count a caller can set, rather than on slots the admission owns.
  it('cannot be given more than it holds by forging a slot', () => {
    const admission = new BoundedHashAdmission({ slots: 1, threadpoolSize: 4 });
    admission.tryAdmit();
    const forged = { release: () => undefined };

    forged.release();

    expect(admission.tryAdmit()).toBeNull();
  });
});

describe('running work in a slot', () => {
  // Break caught: work run when no slot was free, which is a hash that should not have happened.
  it('does not run the work at all when every slot is taken', async () => {
    const admission = new BoundedHashAdmission({ slots: 1, threadpoolSize: 4 });
    admission.tryAdmit();
    let ran = 0;

    const outcome = await runAdmitted(admission, () => {
      ran += 1;
      return Promise.resolve('hashed');
    });

    expect(outcome).toEqual({ admitted: false });
    expect(ran).toBe(0);
  });

  // Break caught: a slot kept by work that failed, which would lose capacity one failure at a time.
  it('gives the slot back when the work finishes, and when it fails', async () => {
    const admission = new BoundedHashAdmission({ slots: 1, threadpoolSize: 4 });

    expect(await runAdmitted(admission, () => Promise.resolve(7))).toEqual({
      admitted: true,
      value: 7,
    });
    expect(admission.inUse).toBe(0);

    await expect(
      runAdmitted(admission, () => Promise.reject(new Error('the hash failed'))),
    ).rejects.toThrow('the hash failed');
    expect(admission.inUse).toBe(0);
    expect(admission.tryAdmit()).not.toBeNull();
  });

  // Break caught: the bound not holding while admitted work is running, which is the whole of the bound.
  it('holds the bound while admitted work is in flight', async () => {
    const admission = new BoundedHashAdmission({ slots: 2, threadpoolSize: 4 });
    const releases: (() => void)[] = [];
    const running = [0, 1].map(() =>
      runAdmitted(admission, () => new Promise<void>((resolve) => releases.push(resolve))),
    );

    expect(await runAdmitted(admission, () => Promise.resolve(1))).toEqual({ admitted: false });
    for (const release of releases) release();
    expect((await Promise.all(running)).every((outcome) => outcome.admitted)).toBe(true);
    expect(await runAdmitted(admission, () => Promise.resolve(1))).toEqual({
      admitted: true,
      value: 1,
    });
  });
});

describe('the libuv pool hashing shares', () => {
  // Break caught: hashing allowed to take every thread of the pool, which starves everything else that uses it (measured, DEPLOYMENT §12.5).
  it('leaves at least the reserved threads to everything else', () => {
    expect(DEFAULT_RESERVED_THREADS).toBe(1);
    expect(() => new BoundedHashAdmission({ slots: 3, threadpoolSize: 4 })).not.toThrow();
    expect(() => new BoundedHashAdmission({ slots: 4, threadpoolSize: 4 })).toThrow(RangeError);
    expect(
      () => new BoundedHashAdmission({ slots: 4, threadpoolSize: 4, reservedThreads: 0 }),
    ).not.toThrow();
    expect(
      () => new BoundedHashAdmission({ slots: 3, threadpoolSize: 4, reservedThreads: 2 }),
    ).toThrow(RangeError);
    expect(() => new BoundedHashAdmission({ slots: 1, threadpoolSize: 1 })).toThrow(RangeError);
  });

  // Break caught: a slot count or a pool size that is not a whole number being read as one.
  it('refuses slots, a pool or a reserve that are not whole numbers in range', () => {
    for (const options of [
      { slots: 0, threadpoolSize: 4 },
      { slots: 1.5, threadpoolSize: 4 },
      { slots: Number.NaN, threadpoolSize: 4 },
      { slots: 1, threadpoolSize: 0 },
      { slots: 1, threadpoolSize: 4, reservedThreads: -1 },
      { slots: 1, threadpoolSize: 4, reservedThreads: 1.5 },
    ]) {
      expect(() => new BoundedHashAdmission(options), JSON.stringify(options)).toThrow(RangeError);
    }
  });

  // Break caught: the pool size read differently from how libuv reads it, so the check judges a pool the process does not have.
  // libuv reads a variable that is present with C's atoi: its leading integer, 0 when there is none, and a pool of 0 becomes 1.
  // Measured on Node 24.21.0 (8 equal tasks at once on the pool: '0', 'abc' and '' took as many waves as '1'; review of 10 October 2026).
  it('reads the pool size as libuv does: 4 when absent, else the leading integer, 1 for none or zero, at most 1024', () => {
    expect(libuvThreadpoolSize({})).toBe(4);
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: undefined })).toBe(4);
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '8' })).toBe(8);
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '1024' })).toBe(1024);
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '5000' })).toBe(1024);
    for (const none of ['', '0', '+0', 'many', 'abc']) {
      expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: none }), none).toBe(1);
    }
    for (const [text, size] of [
      ['2x', 2],
      [' 3', 3],
      ['+5', 5],
      ['4.5x', 4],
    ] as const) {
      expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: text }), text).toBe(size);
    }
    // A negative number is stored in an unsigned integer by libuv, which makes it a very large pool, and the pool is capped.
    expect(libuvThreadpoolSize({ UV_THREADPOOL_SIZE: '-3' })).toBe(1024);
  });
});

describe('the plan: slots, memory and threads together (SECURITY_DESIGN.md §13.4c)', () => {
  const profile = { memoryKiB: 65_536, passes: 2, parallelism: 1 };

  // Break caught: memory planned for the write profile alone.
  it('works out the worst case from the largest profile a slot may derive, and the threads left', () => {
    const plan = planHashAdmission({
      hashAdmission: { slots: 2, memoryBudgetMiB: 256 },
      credentialHashing: {
        profile,
        acceptedProfiles: [{ memoryKiB: 131_072, passes: 2, parallelism: 1 }],
      },
      threadpoolSize: 4,
    });

    expect(plan).toEqual({
      slots: 2,
      largestProfileMiB: 128,
      worstCaseMiB: 256,
      memoryBudgetMiB: 256,
      threadsLeft: 2,
    });
  });

  // Break caught: a plan that passes though a slot at an older, larger profile would exceed the budget.
  it('refuses a plan whose worst case exceeds the memory budget, or that leaves no thread', () => {
    const over = {
      hashAdmission: { slots: 3, memoryBudgetMiB: 256 },
      credentialHashing: {
        profile,
        acceptedProfiles: [{ memoryKiB: 131_072, passes: 2, parallelism: 1 }],
      },
      threadpoolSize: 8,
    };
    expect(() => planHashAdmission(over)).toThrow(RangeError);
    expect(() =>
      planHashAdmission({
        ...over,
        hashAdmission: { slots: 2, memoryBudgetMiB: 256 },
        threadpoolSize: 2,
      }),
    ).toThrow(RangeError);
    expect(() =>
      planHashAdmission({ ...over, hashAdmission: { slots: 2, memoryBudgetMiB: 256 } }),
    ).not.toThrow();
  });

  // Break caught: the refusal carrying a profile’s cost in its text.
  it('says what is wrong in words that hold no figure of a profile', () => {
    try {
      planHashAdmission({
        hashAdmission: { slots: 9, memoryBudgetMiB: 256 },
        credentialHashing: { profile, acceptedProfiles: [] },
        threadpoolSize: 16,
      });
      expect.unreachable('the plan must be refused');
    } catch (error) {
      expect((error as Error).message).toContain('memory');
      expect((error as Error).message).not.toMatch(/65536/);
    }
  });
});
