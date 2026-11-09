import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../../test-support/manual-clock.js';
import {
  BudgetCancelledError,
  BudgetClosedError,
  BudgetExpiredError,
  ExecutionBudget,
  currentBudget,
  runWithBudget,
  type LateEffect,
} from './execution-budget.js';

let clock: ManualClock;

beforeEach(() => {
  vi.useFakeTimers();
  clock = new ManualClock();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Real time passes for the fake timers and for the manual clock together, as it does in production. */
function pass(milliseconds: number): void {
  clock.advance(milliseconds);
  vi.advanceTimersByTime(milliseconds);
}

describe('ExecutionBudget: expiry (S0.6, OB-37)', () => {
  // Break caught: a budget that never expires, or one that expires at once.
  it('is not expired before its time and is expired at it, on the monotonic clock', () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    expect(budget.expired).toBe(false);
    expect(budget.remainingMilliseconds()).toBe(1_000);

    pass(999);
    expect(budget.expired).toBe(false);
    expect(budget.remainingMilliseconds()).toBe(1);

    pass(1);
    expect(budget.expired).toBe(true);
    expect(budget.remainingMilliseconds()).toBe(0);
    budget.finish();
  });

  // Break caught: elapsed time taken from the wall clock, which a correction can move by hours in either direction.
  it('ignores the wall clock: a jump of a day in either direction neither expires nor extends it', () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    clock.jumpWallClock(new Date('2026-12-25T08:00:00.000Z'));
    expect(budget.expired).toBe(false);
    clock.jumpWallClock(new Date('2026-10-01T08:00:00.000Z'));
    pass(1_000);
    expect(budget.expired).toBe(true);
    budget.finish();
  });

  // Break caught: a budget that is only checked when something asks, so a handler that never asks runs on for ever.
  it('expires by itself, on its timer, and tells each listener once with the error', () => {
    const budget = new ExecutionBudget(clock, 'request', 500);
    const heard: BudgetExpiredError[] = [];
    budget.onExpiry((error) => heard.push(error));
    budget.onExpiry((error) => heard.push(error));

    pass(499);
    expect(heard).toHaveLength(0);
    pass(1);

    expect(heard).toHaveLength(2);
    expect(heard[0]).toBeInstanceOf(BudgetExpiredError);
    expect(heard[0]?.label).toBe('request');
    expect(heard[0]?.budgetMilliseconds).toBe(500);
    // Later time does not tell them again.
    pass(5_000);
    expect(heard).toHaveLength(2);
    budget.finish();
  });

  // Break caught: a timer that fires early (a coarse or throttled timer) expiring the budget before its time.
  it('does not expire when its timer fires before the monotonic clock says the time is up', () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    vi.advanceTimersByTime(1_000);
    expect(budget.expired).toBe(false);
    expect(budget.signal.aborted).toBe(false);

    pass(1_000);
    expect(budget.expired).toBe(true);
    expect(budget.signal.aborted).toBe(true);
    budget.finish();
  });

  // Break caught: expiry that waits for a timer a busy event loop has not run, so a statement boundary lets work through late.
  it('is expired at a check even when its timer has not run yet', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    const heard: BudgetExpiredError[] = [];
    budget.onExpiry((error) => heard.push(error));

    clock.advance(150);

    expect(budget.expired).toBe(true);
    expect(heard).toHaveLength(1);
    expect(() => {
      budget.throwIfExpired();
    }).toThrow(BudgetExpiredError);
    budget.finish();
  });

  it('aborts its signal with the error as the reason', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    expect(budget.signal.aborted).toBe(false);
    pass(100);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.signal.reason).toBeInstanceOf(BudgetExpiredError);
    budget.finish();
  });

  it('tells a listener added after expiry at once, and only once', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    pass(100);
    const heard: BudgetExpiredError[] = [];
    budget.onExpiry((error) => heard.push(error));
    expect(heard).toHaveLength(1);
    budget.finish();
  });

  it('lets a listener be removed before expiry', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    const heard: BudgetExpiredError[] = [];
    const remove = budget.onExpiry((error) => heard.push(error));
    remove();
    pass(100);
    expect(heard).toHaveLength(0);
    budget.finish();
  });

  // Break caught: one listener that throws stopping the others, so a cancellation never reaches the connection.
  it('tells every listener even when one of them throws', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    const heard: string[] = [];
    budget.onExpiry(() => {
      throw new Error('a listener that fails');
    });
    budget.onExpiry(() => heard.push('second'));
    expect(() => {
      pass(100);
    }).not.toThrow();
    expect(heard).toEqual(['second']);
    budget.finish();
  });

  // Break caught: a timer left running after the request ended, which keeps the process alive and fires into a finished request.
  it('stops when finished: no timer, no listener, and the signal is never aborted', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    const heard: BudgetExpiredError[] = [];
    budget.onExpiry((error) => heard.push(error));
    expect(vi.getTimerCount()).toBe(1);

    budget.finish();

    expect(vi.getTimerCount()).toBe(0);
    pass(10_000);
    expect(heard).toHaveLength(0);
    expect(budget.signal.aborted).toBe(false);
    expect(budget.expired).toBe(false);
  });

  it('can be finished twice', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    budget.finish();
    expect(() => {
      budget.finish();
    }).not.toThrow();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a budget of %s milliseconds: every budget is finite and positive',
    (milliseconds) => {
      expect(() => new ExecutionBudget(clock, 'request', milliseconds)).toThrow(RangeError);
    },
  );

  // Break caught: a budget timer that keeps the process alive after everything else has finished.
  it('keeps its timer from holding the process open', () => {
    const made: NodeJS.Timeout[] = [];
    const real = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((...args: Parameters<typeof setTimeout>) => {
        const timer = real(...args);
        made.push(timer);
        return timer;
      });
    const budget = new ExecutionBudget(clock, 'request', 100);
    spy.mockRestore();

    expect(made).toHaveLength(1);
    expect(made[0]?.hasRef()).toBe(false);
    budget.finish();
  });
});

describe('ExecutionBudget: a budget inside a budget', () => {
  // Break caught: a transaction allowed to outlive the request that opened it.
  it('is capped by what its parent has left', () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    pass(700);
    const child = parent.child('transaction', 10_000);
    expect(child.remainingMilliseconds()).toBe(300);

    const looser = parent.child('transaction', 100);
    expect(looser.remainingMilliseconds()).toBe(100);
    child.finish();
    looser.finish();
    parent.finish();
  });

  // Break caught: a request that expires while its transaction goes on.
  it('expires with its parent, and carries the parent’s error', () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 5_000);
    const heard: BudgetExpiredError[] = [];
    child.onExpiry((error) => heard.push(error));

    pass(1_000);

    expect(child.expired).toBe(true);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.label).toBe('request');
    child.finish();
    parent.finish();
  });

  // Break caught: one slow transaction expiring the whole request.
  it('expires alone when its own time is shorter, leaving the parent running', () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 200);

    pass(200);

    expect(child.expired).toBe(true);
    expect(child.signal.reason).toMatchObject({ label: 'transaction' });
    expect(parent.expired).toBe(false);
    child.finish();
    parent.finish();
  });

  // Break caught: a finished child leaving a listener on its parent for every transaction of a long request.
  it('is forgotten by its parent when finished', () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 500);
    child.finish();
    pass(1_000);
    expect(child.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    parent.finish();
  });

  // Break caught: the caller told the transaction ran out when it was the request, because only the child was asked in time.
  it('names the parent when the parent’s time is what ran out, even if only the child is asked', () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 5_000);

    // No timer has run: the clock alone says the time is up.
    clock.advance(1_000);

    expect(child.expiredWith).toBeInstanceOf(BudgetExpiredError);
    expect(child.expiredWith?.label).toBe('request');
    expect(parent.expired).toBe(true);
    child.finish();
    parent.finish();
  });

  it('is already expired when made from an expired parent', () => {
    const parent = new ExecutionBudget(clock, 'request', 100);
    pass(100);
    const child = parent.child('transaction', 500);
    expect(child.expired).toBe(true);
    expect(child.signal.reason).toMatchObject({ label: 'request' });
    child.finish();
    parent.finish();
  });
});

describe('ExecutionBudget.effect: a side effect after the caller was told it failed (OB-37)', () => {
  // Break caught: an outbound call, a delivery enqueue or an audit write started after the request already failed.
  it('refuses to start an effect once the budget has expired, and never runs it', async () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    pass(100);
    const action = vi.fn(() => Promise.resolve('sent'));

    await expect(budget.effect('send the message', action)).rejects.toBeInstanceOf(
      BudgetExpiredError,
    );

    expect(action).not.toHaveBeenCalled();
    expect(budget.lateEffects).toEqual([]);
    budget.finish();
  });

  it('runs an effect that starts and ends inside the budget, and records nothing', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    await expect(budget.effect('send the message', () => Promise.resolve('sent'))).resolves.toBe(
      'sent',
    );
    expect(budget.lateEffects).toEqual([]);
    budget.finish();
  });

  // Break caught: an effect that cannot be cancelled and takes place after the answer, with nobody told.
  it('records an effect that started in time and completed after the budget expired', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    const heard: LateEffect[] = [];
    budget.onLateEffect((record) => heard.push(record));
    let finish: (value: string) => void = () => undefined;
    const running = budget.effect(
      'send the message',
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );

    pass(1_500);
    finish('sent');

    await expect(running).resolves.toBe('sent');
    expect(budget.lateEffects).toEqual([
      { name: 'send the message', outcome: 'completed', lateByMilliseconds: 500 },
    ]);
    expect(heard).toEqual(budget.lateEffects);
    budget.finish();
  });

  it('records an effect that started in time and failed after the budget expired', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    let fail: (error: Error) => void = () => undefined;
    const running = budget.effect(
      'send the message',
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );

    pass(1_200);
    fail(new Error('the provider refused'));

    await expect(running).rejects.toThrow('the provider refused');
    expect(budget.lateEffects).toEqual([
      { name: 'send the message', outcome: 'failed', lateByMilliseconds: 200 },
    ]);
    budget.finish();
  });

  // Break caught: a synchronous throw from the action escaping the record.
  it('turns a synchronous throw of the action into a rejection', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    await expect(
      budget.effect('send the message', () => {
        throw new Error('at once');
      }),
    ).rejects.toThrow('at once');
    budget.finish();
  });

  it('keeps a bounded record of late effects', async () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    const releases: (() => void)[] = [];
    const running: Promise<void>[] = [];
    for (let each = 0; each < 80; each += 1) {
      running.push(
        budget.effect(
          `effect ${String(each)}`,
          () =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        ),
      );
    }
    pass(200);
    for (const release of releases) release();
    await Promise.all(running);

    expect(budget.lateEffects.length).toBeLessThanOrEqual(64);
    expect(budget.lateEffects.at(-1)?.name).toBe('effect 79');
    budget.finish();
  });
});

/**
 * A finished budget is closed (correction F05). Finishing says the unit of work is over: nothing new may start under it, however
 * the clock stands, and a continuation that kept a reference (or the request's scope) cannot start more. Completion is not
 * expiry: a budget that finished before its deadline did not run out, and says so by a different error.
 */
describe('ExecutionBudget: a finished budget authorizes nothing new (F05)', () => {
  // Break caught: a finished budget that still runs an effect (an outbound call, an enqueue) for a request already answered.
  it('refuses an effect after finish, before the original deadline, and never runs it', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    budget.finish();
    const action = vi.fn(() => Promise.resolve('sent'));

    const refusal = await budget
      .effect('send the message', action)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BudgetClosedError);
    // Closed is not expired: the work finished in time, and the error says what happened.
    expect(refusal).not.toBeInstanceOf(BudgetExpiredError);
    expect((refusal as BudgetClosedError).label).toBe('request');
    expect(action).not.toHaveBeenCalled();
    expect(budget.lateEffects).toEqual([]);
  });

  // Break caught: the reproduction of F05. The budget is finished, the clock moves past its deadline, and the effect ran, with
  // expired false and nothing recorded.
  it('refuses an effect after finish, after the original deadline, and never runs it', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    budget.finish();
    pass(5_000);
    const action = vi.fn(() => Promise.resolve('sent'));

    const refusal = await budget
      .effect('send the message', action)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BudgetClosedError);
    expect(action).not.toHaveBeenCalled();
    // Finishing is not a deadline expiry, and the two stay apart.
    expect(budget.closed).toBe(true);
    expect(budget.expired).toBe(false);
  });

  // Break caught: a transaction, a nested budget or a coordinator started under a request that has been answered.
  it('refuses child work after finish, and starts no timer for it', () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    budget.finish();

    expect(() => budget.child('transaction', 500)).toThrow(BudgetClosedError);
    pass(5_000);
    expect(() => budget.child('transaction', 500)).toThrow(BudgetClosedError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says it has no time left to give once it is closed', () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    expect(budget.remainingMilliseconds()).toBe(1_000);
    budget.finish();
    expect(budget.remainingMilliseconds()).toBe(0);
  });

  // Break caught: an expired budget that finishing turns into a closed one, losing the reason it ended.
  it('keeps an expired budget expired when it is finished afterwards', async () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    pass(100);
    budget.finish();

    expect(budget.expired).toBe(true);
    expect(budget.closed).toBe(false);
    await expect(budget.effect('send', () => Promise.resolve())).rejects.toBeInstanceOf(
      BudgetExpiredError,
    );
  });

  // Break caught: a continuation that kept the request's scope starting new work after the request ended. Nothing reopens the
  // budget: not a child, not an effect.
  it('cannot be reopened by a continuation that kept it', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    const later = runWithBudget(budget, () => async () => {
      const kept = currentBudget();
      expect(kept).toBe(budget);
      expect(() => kept?.child('transaction', 100)).toThrow(BudgetClosedError);
      await expect(kept?.effect('send', () => Promise.resolve())).rejects.toBeInstanceOf(
        BudgetClosedError,
      );
    });
    budget.finish();
    // A late continuation, run from the request's scope.
    await runWithBudget(budget, later);
  });

  // Truthful accounting: what started before finish() is not cancelled by it, and is not forgotten when it settles.
  it('lets an effect that started before finish settle after it, and records nothing while it is inside the deadline', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    let settle: (value: string) => void = () => undefined;
    const running = budget.effect(
      'send the message',
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );

    budget.finish();
    pass(500);
    settle('sent');

    await expect(running).resolves.toBe('sent');
    expect(budget.lateEffects).toEqual([]);
  });

  it('records an effect that started before finish and settles after the original deadline, as late', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    const heard: LateEffect[] = [];
    budget.onLateEffect((record) => heard.push(record));
    let settle: (value: string) => void = () => undefined;
    const running = budget.effect(
      'send the message',
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );

    budget.finish();
    pass(1_500);
    settle('sent');

    await expect(running).resolves.toBe('sent');
    expect(budget.lateEffects).toEqual([
      { name: 'send the message', outcome: 'completed', lateByMilliseconds: 500 },
    ]);
    expect(heard).toEqual(budget.lateEffects);
  });

  it('records the failure of such an effect as a failure, and returns its error unchanged', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    let fail: (error: Error) => void = () => undefined;
    const running = budget.effect(
      'send the message',
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        }),
    );

    budget.finish();
    pass(1_200);
    fail(new Error('the provider refused'));

    await expect(running).rejects.toThrow('the provider refused');
    expect(budget.lateEffects).toEqual([
      { name: 'send the message', outcome: 'failed', lateByMilliseconds: 200 },
    ]);
  });

  // The cleanup that finishing owes, and that it owes once.
  it('forgets its listeners and its timer when finished, hears nothing later, and can be finished again', () => {
    const budget = new ExecutionBudget(clock, 'request', 100);
    const heard: BudgetExpiredError[] = [];
    budget.onExpiry((error) => heard.push(error));
    budget.finish();
    budget.finish();
    const remove = budget.onExpiry((error) => heard.push(error));

    pass(10_000);

    expect(heard).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(budget.signal.aborted).toBe(false);
    expect(() => {
      remove();
    }).not.toThrow();
  });

  it('is refused as a parent too: no child of a finished parent is made, and a finished child hears nothing of its parent', () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 500);
    child.finish();
    parent.finish();
    expect(() => parent.child('transaction', 500)).toThrow(BudgetClosedError);
    pass(5_000);
    expect(child.signal.aborted).toBe(false);
  });
});

/**
 * A finished budget closes everything below it (review of the F05 correction). The first correction closed the budget that was
 * finished and left its children free: a child made before `finish()` kept authorizing effects after the request was answered, and
 * the public constructor made a new one under a finished parent. Closure now follows the ancestry. What is already in flight is
 * left to settle and is still accounted for; expiry stays a different fact with a different error.
 */
describe('ExecutionBudget: a finished ancestor closes every budget below it (F05)', () => {
  const effect = (budget: ExecutionBudget) => {
    const action = vi.fn(() => Promise.resolve('sent'));
    return { action, run: () => budget.effect('send the message', action) };
  };

  // Break caught: the reproduction. The child outlived its parent's `finish()` and still ran a new effect.
  it('refuses a new effect of a child whose parent has finished, however much time is left', async () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 500);
    parent.finish();

    // Inside the child's own deadline, at the start and later: it is closure that refuses, not time running out.
    for (const elapsed of [0, 200]) {
      pass(elapsed);
      const { action, run } = effect(child);
      const refusal = await run().catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(BudgetClosedError);
      // The error names the budget that was finished: the request, which is what ended the unit of work.
      expect((refusal as BudgetClosedError).label).toBe('request');
      expect(action).not.toHaveBeenCalled();
    }
    expect(child.closed).toBe(true);
    expect(child.remainingMilliseconds()).toBe(0);
  });

  // Break caught: closure that stops at the parent, so a grandchild is still free.
  it('refuses a new effect and a new descendant of a grandchild when the grandparent has finished', async () => {
    const grandparent = new ExecutionBudget(clock, 'request', 10_000);
    const parent = grandparent.child('transaction', 5_000);
    const grandchild = parent.child('statement', 1_000);
    grandparent.finish();

    const { action, run } = effect(grandchild);
    const refusal = await run().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BudgetClosedError);
    expect((refusal as BudgetClosedError).label).toBe('request');
    expect(action).not.toHaveBeenCalled();
    expect(() => parent.child('another', 100)).toThrow(BudgetClosedError);
    expect(() => grandchild.child('another', 100)).toThrow(BudgetClosedError);
    expect(() => {
      grandchild.assertOpen();
    }).toThrow(BudgetClosedError);
  });

  // Break caught: the public constructor, which `child()` did not guard: a budget could be made under a finished parent, and it
  // authorized effects as if it were open.
  it('refuses to construct a budget under a finished parent, or under a parent whose ancestor has finished', () => {
    const grandparent = new ExecutionBudget(clock, 'request', 10_000);
    const parent = grandparent.child('transaction', 5_000);
    const timers = vi.getTimerCount();

    parent.finish();
    expect(() => new ExecutionBudget(clock, 'statement', 500, parent)).toThrow(BudgetClosedError);

    const other = grandparent.child('second', 5_000);
    grandparent.finish();
    expect(() => new ExecutionBudget(clock, 'statement', 500, other)).toThrow(BudgetClosedError);
    // A refused construction leaves nothing running: no timer and no listener on the parent.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
  });

  // The two facts stay apart. A child that ran out by its own deadline after its parent finished ran out; a child under a parent that
  // ran out carries the parent's error; neither is reported as closure.
  it('keeps expiry and closure apart: the child’s own deadline, and the parent’s, are expiry', async () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 100);
    parent.finish();
    pass(200);

    expect(child.expired).toBe(true);
    expect(child.closed).toBe(true);
    const own = await child
      .effect('send the message', () => Promise.resolve())
      .catch((error: unknown) => error);
    expect(own).toBeInstanceOf(BudgetExpiredError);
    expect((own as BudgetExpiredError).label).toBe('transaction');

    const late = new ExecutionBudget(clock, 'request', 100);
    const below = late.child('transaction', 50);
    pass(100);
    late.finish();
    const inherited = await below
      .effect('send the message', () => Promise.resolve())
      .catch((error: unknown) => error);
    expect(inherited).toBeInstanceOf(BudgetExpiredError);
    expect((inherited as BudgetExpiredError).label).toBe('request');
  });

  // Truthful accounting: an effect that began under the child before the parent finished is not cancelled by it, and when it
  // settles after the deadline it is still recorded, on the budget it ran under.
  it('lets an effect that started before the parent finished settle, and records it when it is late', async () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 500);
    let settle: (value: string) => void = () => undefined;
    const running = child.effect(
      'send the message',
      () =>
        new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );

    parent.finish();
    pass(800);
    settle('sent');

    await expect(running).resolves.toBe('sent');
    expect(child.lateEffects).toEqual([
      { name: 'send the message', outcome: 'completed', lateByMilliseconds: 300 },
    ]);
  });

  // Break caught: closure that a continuation could step around. The child is carried by the scope the request's work runs in; a
  // continuation that comes back after the request was answered reads it from there and is refused all the same.
  it('refuses the effect of a continuation that kept the child’s scope after the parent finished', async () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const child = parent.child('transaction', 500);
    let proceed: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const action = vi.fn(() => Promise.resolve('sent'));

    const continuation = runWithBudget(child, async () => {
      await gate;
      await Promise.resolve();
      return currentBudget()?.effect('late send', action);
    });
    parent.finish();
    proceed();

    await expect(continuation).rejects.toBeInstanceOf(BudgetClosedError);
    expect(action).not.toHaveBeenCalled();
  });

  it('leaves the other branch of the tree alone: a sibling under a parent that has not finished is open', async () => {
    const parent = new ExecutionBudget(clock, 'request', 1_000);
    const finished = parent.child('first', 500);
    const open = parent.child('second', 500);
    finished.finish();

    expect(finished.closed).toBe(true);
    expect(open.closed).toBe(false);
    const { action, run } = effect(open);
    await expect(run()).resolves.toBe('sent');
    expect(action).toHaveBeenCalledOnce();
    expect(() => parent.child('third', 100)).not.toThrow();
  });
});

/**
 * Telling a budget that its line was closed, and ending one at once (run 4, Stage 1, A4.2). Finishing a request's budget is silent and is not expiry, so a
 * statement already running under a budget below it was cancelled by nobody and ran on to its own bound: an aborted lookup kept its session's slot for up
 * to three seconds. A holder of a budget below it can now be told of the closure (`onClosed`) and end its own budget at once (`cancel`), which is an expiry
 * as every listener of one (the database layer's cancel of the running statement among them) understands it.
 */
describe('ExecutionBudget: closure is told, and a budget can be ended at once (A4.2)', () => {
  // Break caught: a closure that is silent (the owner of a budget below the request is never told the request is over), or one told twice.
  it('tells a listener once when the budget is finished, and not again when it is finished twice', () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    const told = vi.fn();
    budget.onClosed(told);
    expect(told).not.toHaveBeenCalled();

    budget.finish();
    budget.finish();

    expect(told).toHaveBeenCalledTimes(1);
  });

  // Break caught: a child that stays wired to its parent after it ended (the relay of a lookup that has finished, left in the request's listeners), which
  // would tell a finished child of a closure that is no longer its concern, and hold it in memory for the life of the request.
  it('is told once by its own finish, and not again when its parent is finished later', () => {
    const parent = new ExecutionBudget(clock, 'request', 10_000);
    const child = parent.child('lookupRecords', 3_000);
    const told = vi.fn();
    child.onClosed(told);

    child.finish();
    expect(told).toHaveBeenCalledTimes(1);
    parent.finish();

    expect(told).toHaveBeenCalledTimes(1);
  });

  // Break caught: closure that stops at the parent, so the budget a lookup makes for itself under the request's is never told the request ended.
  it('tells the listeners of a child and of a grandchild when an ancestor is finished, and not those of a sibling branch', () => {
    const request = new ExecutionBudget(clock, 'request', 10_000);
    const child = request.child('lookupRecords', 3_000);
    const grandchild = child.child('transaction', 1_000);
    const other = new ExecutionBudget(clock, 'other request', 10_000);
    const told = { child: vi.fn(), grandchild: vi.fn(), other: vi.fn() };
    child.onClosed(told.child);
    grandchild.onClosed(told.grandchild);
    other.onClosed(told.other);

    request.finish();

    expect(told.child).toHaveBeenCalledTimes(1);
    expect(told.grandchild).toHaveBeenCalledTimes(1);
    expect(told.other).not.toHaveBeenCalled();
    expect(child.closed).toBe(true);
    expect(child.expired, 'closure is not expiry').toBe(false);
  });

  // Break caught: a listener added to a budget that is already closed and so never told, which would leave a late holder believing its request is open.
  it('tells a listener added to a closed budget at once, and only once', () => {
    const request = new ExecutionBudget(clock, 'request', 10_000);
    const child = request.child('lookupRecords', 3_000);
    request.finish();
    const told = vi.fn();

    child.onClosed(told);
    expect(told).toHaveBeenCalledTimes(1);
    request.finish();

    expect(told).toHaveBeenCalledTimes(1);
  });

  // Break caught: expiry told as closure (a budget that ran out is expired, a different fact), or a listener that is called after it was removed.
  it('does not tell a listener when the budget expires, and not one that was removed', () => {
    const expiring = new ExecutionBudget(clock, 'request', 1_000);
    const removed = new ExecutionBudget(clock, 'request', 1_000);
    const heard = vi.fn();
    const forgotten = vi.fn();
    expiring.onClosed(heard);
    const remove = removed.onClosed(forgotten);
    remove();

    pass(1_500);
    removed.finish();

    expect(expiring.expired).toBe(true);
    expect(heard).not.toHaveBeenCalled();
    expect(forgotten).not.toHaveBeenCalled();
  });

  // Break caught: a listener that throws and stops the others from hearing, as for expiry.
  it('tells every listener even when one of them throws, and keeps what it threw', () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);
    const heard = vi.fn();
    budget.onClosed(() => {
      throw new Error('a listener that fails');
    });
    budget.onClosed(heard);

    budget.finish();

    expect(heard).toHaveBeenCalledTimes(1);
    expect(budget.listenerFailures).toHaveLength(1);
  });

  // Break caught: `cancel` that only marks the budget (the signal is not aborted, the listeners are not run), so the database layer would not cancel the statement.
  it('ends a running budget at once as an expiry of its own: signal aborted, listeners told, with its label and its time', () => {
    const budget = new ExecutionBudget(clock, 'lookupRecords', 3_000);
    const told: BudgetExpiredError[] = [];
    budget.onExpiry((error) => {
      told.push(error);
    });

    budget.cancel();

    expect(budget.expired).toBe(true);
    expect(budget.signal.aborted).toBe(true);
    expect(told).toHaveLength(1);
    expect(told[0]).toBeInstanceOf(BudgetExpiredError);
    expect(told[0]?.label).toBe('lookupRecords');
    expect(told[0]?.budgetMilliseconds).toBe(3_000);
    expect(budget.expiredWith).toBe(told[0]);
    expect(() => {
      budget.assertOpen();
    }).toThrow(BudgetExpiredError);
  });

  // Break caught (run 5, Stage 1): a cancel that cannot say why, so that a budget ended because its client left reads, wherever its error is looked at (the database layer's log
  // among them), as a budget whose time ran out.
  it('ends with an error that says why it was cancelled, which is still an expiry, and says only "cancelled" when it is given no reason', () => {
    const abandoned = new ExecutionBudget(clock, 'lookupRecords', 3_000);
    const plain = new ExecutionBudget(clock, 'other', 3_000);
    const late = new ExecutionBudget(clock, 'late', 100);

    abandoned.cancel('abandoned by the client');
    plain.cancel();
    pass(150);

    const error = abandoned.expiredWith;
    expect(error).toBeInstanceOf(BudgetExpiredError);
    expect(error).toBeInstanceOf(BudgetCancelledError);
    expect((error as BudgetCancelledError).reason).toBe('abandoned by the client');
    expect(error?.message).toBe('The lookupRecords budget was cancelled: abandoned by the client');
    expect(abandoned.signal.reason).toBe(error);
    expect((plain.expiredWith as BudgetCancelledError).reason).toBe('cancelled');
    // A budget whose time ran out is not a cancelled one, and says so.
    expect(late.expiredWith).toBeInstanceOf(BudgetExpiredError);
    expect(late.expiredWith).not.toBeInstanceOf(BudgetCancelledError);
    expect(late.expiredWith?.message).toBe('The late budget of 100 ms ran out');
  });

  // Break caught: a budget below the one that is ended that keeps running (a transaction's statement is wired to a budget below the lookup's).
  it('ends the budgets below it too, as any expiry does, and leaves the parent running', () => {
    const request = new ExecutionBudget(clock, 'request', 10_000);
    const lookup = request.child('lookupRecords', 3_000);
    const transaction = lookup.child('transaction', 2_000);

    lookup.cancel();

    expect(transaction.expired).toBe(true);
    expect(transaction.expiredWith?.label).toBe('lookupRecords');
    expect(request.expired).toBe(false);
  });

  // Break caught: `cancel` that reopens or re-expires what has ended (a finished budget is not expired afterwards, an expired one keeps its error).
  it('does nothing to a budget that was finished or has expired', () => {
    const finished = new ExecutionBudget(clock, 'finished', 1_000);
    finished.finish();
    const expired = new ExecutionBudget(clock, 'expired', 1_000);
    pass(1_500);
    const before = expired.expiredWith;
    const told = vi.fn();
    expired.onExpiry(told);
    told.mockClear();

    finished.cancel();
    expired.cancel();

    expect(finished.expired).toBe(false);
    expect(finished.signal.aborted).toBe(false);
    expect(expired.expiredWith).toBe(before);
    expect(told).not.toHaveBeenCalled();
  });

  // Break caught: a `cancel` that refuses a budget whose request is over, which is the very case it is for (the request finished, the statement runs on).
  it('can end a budget whose request has finished: closed is not expired, so a running statement can still be cancelled', () => {
    const request = new ExecutionBudget(clock, 'request', 10_000);
    const lookup = request.child('lookupRecords', 3_000);
    const transaction = lookup.child('transaction', 2_000);
    lookup.onClosed(() => {
      lookup.cancel();
    });

    request.finish();

    expect(lookup.expired).toBe(true);
    expect(transaction.expired).toBe(true);
    expect(transaction.signal.aborted).toBe(true);
  });
});

/**
 * What a parent keeps of its children (run 5, Stage 1.1). The delivery worker's budget lives as long as the process and makes a child for each task and each job. A child that
 * expired or was cancelled stayed on its parent's closure listeners for ever (its owner's `finish()` returned before the relay was detached, and expiry never detached it), so
 * under a slow database or provider the parent's listeners grew without bound. A budget that has stopped, however it stopped, leaves nothing on its parent.
 */
describe('ExecutionBudget: a child that has stopped leaves nothing on its parent (run 5, Stage 1.1)', () => {
  const CHILDREN = 1_000;

  /**
   * What a budget keeps for the budgets below it and for its own holders: the sizes of its expiry and closure listener sets. Both are private, so the probe reads them through a cast
   * and fails loudly if they are renamed or are no longer sets: it can never count nothing and pass.
   */
  function listenersOf(budget: ExecutionBudget): { expiry: number; closed: number } {
    const inside = budget as unknown as {
      expiryListeners?: unknown;
      closedListeners?: unknown;
    };
    if (!(inside.expiryListeners instanceof Set) || !(inside.closedListeners instanceof Set)) {
      throw new Error(
        'ExecutionBudget no longer keeps its listeners in the sets expiryListeners and closedListeners: update this probe',
      );
    }
    return { expiry: inside.expiryListeners.size, closed: inside.closedListeners.size };
  }

  // Break caught: a probe that counts nothing, which would let every proof below pass whatever the budget did.
  it('has the probe see a child while it runs: one expiry listener and one closure listener on the parent, and none once it is finished', () => {
    const parent = new ExecutionBudget(clock, 'process', 1_000_000);
    expect(listenersOf(parent)).toEqual({ expiry: 0, closed: 0 });

    const child = parent.child('task', 500);
    expect(listenersOf(parent)).toEqual({ expiry: 1, closed: 1 });

    child.finish();
    expect(listenersOf(parent)).toEqual({ expiry: 0, closed: 0 });
    parent.finish();
  });

  // Break caught: a child that stays on its parent's listeners once it has stopped, by expiry (the clock), by `cancel`, or by `finish` after either: the process-long budget
  // of the delivery worker gains one listener for each task and job that ran long.
  const WAYS: readonly (readonly [string, (children: readonly ExecutionBudget[]) => void])[] = [
    [
      'are finished',
      (children) => {
        for (const child of children) child.finish();
      },
    ],
    [
      'are cancelled',
      (children) => {
        for (const child of children) child.cancel();
      },
    ],
    [
      'are cancelled and then finished by their owners',
      (children) => {
        for (const child of children) {
          child.cancel();
          child.finish();
        }
      },
    ],
    [
      'expire',
      () => {
        pass(600);
      },
    ],
    [
      'expire and are then finished by their owners',
      (children) => {
        pass(600);
        for (const child of children) child.finish();
      },
    ],
  ];

  it.each(WAYS)('leaves 0 listeners on the parent when %s, of 1,000 children', (_way, stop) => {
    const parent = new ExecutionBudget(clock, 'process', 10_000_000);
    const children = Array.from({ length: CHILDREN }, (_, index) =>
      parent.child(`task ${String(index)}`, 500),
    );
    expect(listenersOf(parent)).toEqual({ expiry: CHILDREN, closed: CHILDREN });

    stop(children);

    expect(listenersOf(parent)).toEqual({ expiry: 0, closed: 0 });
    expect(parent.expired).toBe(false);
    expect(parent.closed).toBe(false);
    parent.finish();
  });

  // Break caught: the children of a parent that expires keep a relay on a parent that is over, or the expired parent keeps listeners of its own.
  it('leaves 0 listeners on a parent that expires first, and so ends its children', () => {
    const parent = new ExecutionBudget(clock, 'process', 400);
    const children = Array.from({ length: CHILDREN }, (_, index) =>
      parent.child(`task ${String(index)}`, 500),
    );
    const own = vi.fn();
    parent.onClosed(own);

    pass(450);

    expect(parent.expired).toBe(true);
    expect(children.every((child) => child.expired)).toBe(true);
    expect(listenersOf(parent)).toEqual({ expiry: 0, closed: 0 });
    for (const child of children) child.finish();
    expect(listenersOf(parent)).toEqual({ expiry: 0, closed: 0 });
    expect(own).not.toHaveBeenCalled();
  });

  // Break caught: a budget that has stopped but keeps the closure listeners of its own holders, or keeps one that is added afterwards, which nothing will ever call.
  it('forgets its own closure listeners when it expires, keeps none added afterwards, and is told nothing more', () => {
    const parent = new ExecutionBudget(clock, 'process', 10_000);
    const child = parent.child('task', 500);
    const before = vi.fn();
    child.onClosed(before);
    expect(listenersOf(child).closed).toBe(1);

    pass(600);
    expect(child.expired).toBe(true);
    expect(listenersOf(child).closed).toBe(0);
    const after = vi.fn();
    const remove = child.onClosed(after);
    expect(listenersOf(child).closed).toBe(0);
    remove();

    parent.finish();

    expect(before).not.toHaveBeenCalled();
    // The parent is finished now, so a budget below it is closed and a listener added to it is told at once: closure is a fact of the line and not a message.
    const last = vi.fn();
    child.onClosed(last);
    expect(last).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
  });
});

describe('runWithBudget and currentBudget', () => {
  it('has no budget outside a request', () => {
    expect(currentBudget()).toBeUndefined();
  });

  // Break caught: a budget lost across an await, or leaking to the next request.
  it('makes the budget visible to everything the request awaits, and to nothing else', async () => {
    const budget = new ExecutionBudget(clock, 'request', 1_000);

    const seen = await runWithBudget(budget, async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        queueMicrotask(resolve);
      });
      return currentBudget();
    });

    expect(seen).toBe(budget);
    expect(currentBudget()).toBeUndefined();
    budget.finish();
  });
});
