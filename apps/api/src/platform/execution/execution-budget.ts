import { AsyncLocalStorage } from 'node:async_hooks';

import type { Clock } from '../auth/ports/clock.port.js';

/**
 * The shared execution-budget mechanism (S0.6; plan section 11.8; OB-37). One budget bounds one unit of work, normally a
 * request. The database layer consumes it now; S0.20 puts one around every request in the HTTP pipeline.
 *
 * What a budget is, and is not:
 *
 * - It is **not** a timer raced against a response. Racing a response stops the caller waiting while the work goes on. An
 *   expiry here is an event the work is wired to: the signal aborts, each registered listener runs (the database layer
 *   cancels the running statement, rolls back, and destroys the connection), and a side effect that was not yet started is
 *   refused (`effect`).
 * - Elapsed time is measured on the **monotonic** clock of the injected `Clock`, never the wall clock, so a correction of the
 *   machine's clock can neither expire a budget at once nor extend it. A persisted expiry decision is a different thing: it
 *   takes the database's time (plan section 3, "Time").
 * - Expiry is also **checked on demand** (`expired`, `throwIfExpired`), not only by the timer, so a busy event loop that has
 *   not yet run the timer cannot let work through at a boundary the code checks.
 * - A side effect that cannot be cancelled (an outbound call) and that finishes after the budget ran out is **recorded**
 *   (`lateEffects`, `onLateEffect`), because the caller was already told the request failed.
 *
 * Every budget is finite and positive. The owner of a budget calls `finish()` when its work is done: that stops the timer and
 * forgets the listeners, and a finished budget never fires.
 *
 * **A finished budget is closed, and closed is not expired.** Finishing says the unit of work is over. From then on nothing new
 * may start under the budget, however the clock stands: `effect()` and `child()` refuse with `BudgetClosedError`, the database
 * layer refuses to begin a transaction under it (`assertOpen`), and a continuation that kept a reference to it, or the scope that
 * carries it, cannot reopen it. **Closure follows the ancestry:** a budget is closed when it, or any budget above it, has
 * finished, so a child made before its parent was finished authorizes nothing new once the request is answered, and no budget can
 * be constructed under a closed parent (the constructor refuses, as `child()` does). That is not a claim about work that already started: an effect begun before `finish()` is not
 * cancelled by it (an outbound call cannot be), and when it settles after the deadline it is still recorded as late, so the
 * accounting stays true. A budget that ran out is `expired`, a different fact with a different error (`BudgetExpiredError`).
 */

/** Raised when a budget ran out. `label` says which budget (`request`, `transaction`, ...). */
export class BudgetExpiredError extends Error {
  constructor(
    readonly label: string,
    readonly budgetMilliseconds: number,
  ) {
    super(`The ${label} budget of ${String(budgetMilliseconds)} ms ran out`);
    this.name = 'BudgetExpiredError';
  }
}

/**
 * Raised when work is asked of a budget that has finished. The unit of work it bounded is over, so no new effect or child budget
 * may start under it. It does not say the deadline passed: a budget finished in time is closed, not expired.
 */
export class BudgetClosedError extends Error {
  constructor(readonly label: string) {
    super(`The ${label} budget has finished: no new work may start under it`);
    this.name = 'BudgetClosedError';
  }
}

/** A side effect that took place (or failed) after its budget had expired. */
export interface LateEffect {
  readonly name: string;
  readonly outcome: 'completed' | 'failed';
  /** How long after the deadline the effect was seen to settle. */
  readonly lateByMilliseconds: number;
}

/** The late effects one budget keeps: the most recent, so a runaway request cannot grow it without bound. */
const LATE_EFFECT_LIMIT = 64;
const LISTENER_FAILURE_LIMIT = 16;
const MAX_TIMER_MILLISECONDS = 2 ** 31 - 1;

type State = 'running' | 'expired' | 'finished';

export class ExecutionBudget {
  readonly label: string;
  readonly budgetMilliseconds: number;
  readonly lateEffects: LateEffect[] = [];
  /** Errors thrown by expiry listeners, kept (bounded) and never rethrown: a listener must not stop the others. */
  readonly listenerFailures: unknown[] = [];

  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly expiryListeners = new Set<(error: BudgetExpiredError) => void>();
  private readonly lateListeners = new Set<(effect: LateEffect) => void>();
  private state: State = 'running';
  private failure: BudgetExpiredError | undefined;
  private timer: NodeJS.Timeout | undefined;
  private detachFromParent: (() => void) | undefined;

  /** Use `child()` to make a budget inside another. `parent` is for that method. */
  constructor(
    private readonly clock: Clock,
    label: string,
    milliseconds: number,
    private readonly parent?: ExecutionBudget,
  ) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      throw new RangeError(
        `An execution budget is a finite, positive number of milliseconds, not ${String(milliseconds)}`,
      );
    }
    // Nothing is built under a closed line: the check comes before a deadline, a timer or a listener exists.
    const closedAbove = parent?.closedBy();
    if (closedAbove !== undefined) throw new BudgetClosedError(closedAbove.label);
    this.label = label;
    this.budgetMilliseconds = milliseconds;
    const own = clock.monotonicMilliseconds() + milliseconds;
    this.deadline = parent === undefined ? own : Math.min(own, parent.deadline);

    if (parent !== undefined) {
      if (parent.state === 'expired' && parent.failure !== undefined) {
        this.expire(parent.failure);
        return;
      }
      // A finished parent has nothing left to tell. A running one tells this budget when it expires.
      this.detachFromParent = parent.onExpiry((error) => {
        this.expire(error);
      });
    }
    this.arm();
  }

  /** The abort signal: aborted with the `BudgetExpiredError` as its reason when the budget expires. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** True once the budget has run out. Reads the monotonic clock, so it does not wait for the timer. */
  get expired(): boolean {
    if (this.state === 'running') this.expireIfDue();
    return this.state === 'expired';
  }

  /**
   * True once the owner has finished the budget, or any budget above it (`finish()`). Closed is not expired: the work ended,
   * whatever the clock says, and nothing new may start under the budget.
   */
  get closed(): boolean {
    return this.closedBy() !== undefined;
  }

  /** The nearest budget, this one or one above it, that its owner has finished; undefined while the whole line is open. */
  private closedBy(): ExecutionBudget | undefined {
    if (this.state === 'finished') return this;
    return this.parent?.closedBy();
  }

  /** Why the budget ended, once it has: the error a refused statement and the caller are given. */
  get expiredWith(): BudgetExpiredError | undefined {
    return this.expired ? this.failure : undefined;
  }

  /** The time this budget can still give to new work: none once it has expired or been finished. */
  remainingMilliseconds(): number {
    if (this.state !== 'running' || this.closedBy() !== undefined) return 0;
    return Math.max(0, this.deadline - this.clock.monotonicMilliseconds());
  }

  throwIfExpired(): void {
    if (this.expired && this.failure !== undefined) throw this.failure;
  }

  /**
   * Throws unless new work may start under this budget: `BudgetExpiredError` when it ran out, `BudgetClosedError` when its owner
   * finished it. Everything that begins work under a budget asks this first, so a finished budget cannot authorize anything.
   */
  assertOpen(): void {
    this.throwIfExpired();
    const closed = this.closedBy();
    if (closed !== undefined) throw new BudgetClosedError(closed.label);
  }

  /**
   * Runs `listener` once when the budget expires; at once when it already has. Returns a function that removes it. A finished
   * budget never expires, so a listener added to one is never called.
   */
  onExpiry(listener: (error: BudgetExpiredError) => void): () => void {
    if (this.state === 'expired' && this.failure !== undefined) {
      this.callExpiryListener(listener, this.failure);
      return () => undefined;
    }
    if (this.state === 'finished') return () => undefined;
    this.expiryListeners.add(listener);
    return () => {
      this.expiryListeners.delete(listener);
    };
  }

  /** Called with each late effect as it is recorded. Returns a function that removes the listener. */
  onLateEffect(listener: (effect: LateEffect) => void): () => void {
    this.lateListeners.add(listener);
    return () => {
      this.lateListeners.delete(listener);
    };
  }

  /**
   * A budget inside this one: it is capped by what this one has left, it expires with this one (carrying this one's error),
   * and it can expire alone when its own time is shorter. The caller finishes it.
   */
  child(label: string, milliseconds: number): ExecutionBudget {
    // A finished budget, or one below a finished budget, has no work left to bound, so it is no parent: the constructor refuses.
    // (An expired one still makes an expired child.)
    return new ExecutionBudget(this.clock, label, milliseconds, this);
  }

  /**
   * Runs a side effect under the budget. An effect that has not started when the budget expires is **refused and never runs**.
   * One that started in time cannot be taken back (an outbound call is not a statement): if it settles after the budget
   * expired it is **recorded** as a late effect, so the request that was told it failed is never silently a request that
   * also did something. The effect's own result or error is returned unchanged. An effect is also refused, and never runs, under
   * a budget that has been finished: the unit of work is over.
   */
  async effect<T>(name: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    try {
      const value = await action();
      this.recordIfLate(name, 'completed');
      return value;
    } catch (error) {
      this.recordIfLate(name, 'failed');
      throw error;
    }
  }

  /**
   * The work is done. Stops the timer and forgets the listeners, and closes the budget: nothing new may start under it
   * (`effect`, `child` and `assertOpen` refuse), and so does every budget below it. A budget that already expired stays expired; finishing twice is harmless.
   */
  finish(): void {
    if (this.state === 'running') this.state = 'finished';
    this.stop();
  }

  private arm(): void {
    if (this.state !== 'running') return;
    const remaining = this.deadline - this.clock.monotonicMilliseconds();
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.state === 'running') this.expireIfDue();
      },
      // At least a millisecond, and never past what a timer can hold (a longer wait re-arms when the timer fires).
      Math.min(Math.max(remaining, 1), MAX_TIMER_MILLISECONDS),
    );
    // A budget never keeps the process alive: shutdown is not held up by a request that has already been abandoned.
    this.timer.unref();
  }

  /** The timer can fire before the monotonic clock agrees (a coarse timer): then the budget waits for what is left. */
  private expireIfDue(): void {
    if (this.clock.monotonicMilliseconds() >= this.deadline) {
      // When the parent's time is what ran out, the parent's expiry reaches this budget through its listener, carrying the
      // parent's error: the caller is told it was the request, not the transaction.
      if (this.parent?.expired === true) return;
      this.expire(new BudgetExpiredError(this.label, this.budgetMilliseconds));
      return;
    }
    if (this.timer === undefined) this.arm();
  }

  private expire(error: BudgetExpiredError): void {
    if (this.state !== 'running') return;
    this.state = 'expired';
    this.failure = error;
    this.stop();
    const listeners = [...this.expiryListeners];
    this.expiryListeners.clear();
    this.controller.abort(error);
    for (const listener of listeners) this.callExpiryListener(listener, error);
  }

  private stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.detachFromParent?.();
    this.detachFromParent = undefined;
    if (this.state !== 'expired') this.expiryListeners.clear();
  }

  private callExpiryListener(
    listener: (error: BudgetExpiredError) => void,
    error: BudgetExpiredError,
  ): void {
    try {
      listener(error);
    } catch (thrown) {
      if (this.listenerFailures.length < LISTENER_FAILURE_LIMIT) this.listenerFailures.push(thrown);
    }
  }

  private recordIfLate(name: string, outcome: LateEffect['outcome']): void {
    // Late means settled at or after the deadline. That holds whether the budget expired while the effect ran or its owner
    // finished it first: finishing does not cancel an effect that had started, so it is still accounted for.
    if (!this.expired && this.clock.monotonicMilliseconds() < this.deadline) return;
    const effect: LateEffect = {
      name,
      outcome,
      lateByMilliseconds: Math.max(0, this.clock.monotonicMilliseconds() - this.deadline),
    };
    if (this.lateEffects.length >= LATE_EFFECT_LIMIT) this.lateEffects.shift();
    this.lateEffects.push(effect);
    for (const listener of [...this.lateListeners]) {
      try {
        listener(effect);
      } catch (thrown) {
        if (this.listenerFailures.length < LISTENER_FAILURE_LIMIT)
          this.listenerFailures.push(thrown);
      }
    }
  }
}

const scope = new AsyncLocalStorage<ExecutionBudget>();

/** Runs `work` with `budget` as the budget of everything it awaits, so the database layer needs no parameter for it. */
export function runWithBudget<T>(budget: ExecutionBudget, work: () => T): T {
  return scope.run(budget, work);
}

/** The budget of the request this code runs in, if one was set. */
export function currentBudget(): ExecutionBudget | undefined {
  return scope.getStore();
}
