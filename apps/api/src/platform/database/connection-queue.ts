/**
 * The queue in front of the connection pool (S0.6; SECURITY_DESIGN.md §14.6). `capacity` permits, one per pooled connection,
 * so a caller that holds a permit is never made to wait inside the driver's own queue, which has no bound on how many may wait
 * and no way to take a waiter out. Here a waiter is bounded in number (`maxWaiters`) and in time (`timeoutMilliseconds`), and
 * a waiter that gives up (its wait ran out, or the request's budget expired) is **removed** from the line at that moment, so a
 * permit is never handed to a caller that is no longer there.
 *
 * It knows nothing of connections: whoever takes a permit takes a connection, and releases the permit when the connection is
 * given back or destroyed. Fairness is first come first served.
 */

/** Too many callers are already waiting for a connection: the caller is refused at once and takes no place in line. */
export class PoolSaturatedError extends Error {
  constructor(readonly maxWaiters: number) {
    super(
      `The database pool is saturated: ${String(maxWaiters)} callers are already waiting for a connection`,
    );
    this.name = 'PoolSaturatedError';
  }
}

/** The caller waited as long as it was allowed for a connection and was not served. */
export class AcquireTimeoutError extends Error {
  constructor(readonly waitedMilliseconds: number) {
    super(`No database connection became free within ${String(waitedMilliseconds)} ms`);
    this.name = 'AcquireTimeoutError';
  }
}

/** The pool is closing or closed. */
export class PoolClosedError extends Error {
  constructor() {
    super('The database pool is closed');
    this.name = 'PoolClosedError';
  }
}

/** The reason an abort signal carries, as an error: a budget's `BudgetExpiredError` is passed through as it is. */
function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('The wait was aborted', { cause: reason });
}

export interface Permit {
  /** Gives the permit back. Releasing a permit more than once frees it once. */
  release(): void;
}

export interface AcquireOptions {
  /** The longest the caller waits, in milliseconds: finite and positive. */
  readonly timeoutMilliseconds: number;
  /** When this aborts, the caller stops waiting and is rejected with the signal's reason. */
  readonly signal?: AbortSignal;
}

interface Waiter {
  readonly grant: (permit: Permit) => void;
  readonly reject: (error: unknown) => void;
  readonly stop: () => void;
}

export class ConnectionQueue {
  private readonly capacity: number;
  private readonly maxWaiters: number;
  private held = 0;
  private closed = false;
  private readonly line: Waiter[] = [];

  constructor(options: { readonly capacity: number; readonly maxWaiters: number }) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new RangeError(
        `A pool has a positive whole number of connections, not ${String(options.capacity)}`,
      );
    }
    if (!Number.isInteger(options.maxWaiters) || options.maxWaiters < 1) {
      throw new RangeError(
        `The waiters allowed are a positive whole number, not ${String(options.maxWaiters)}`,
      );
    }
    this.capacity = options.capacity;
    this.maxWaiters = options.maxWaiters;
  }

  /** Permits in use. */
  get inUse(): number {
    return this.held;
  }

  /** Callers waiting for a permit. */
  get waiting(): number {
    return this.line.length;
  }

  acquire(options: AcquireOptions): Promise<Permit> {
    const { timeoutMilliseconds, signal } = options;
    if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
      return Promise.reject(
        new RangeError(
          `A wait for a connection is a finite, positive number of milliseconds, not ${String(timeoutMilliseconds)}`,
        ),
      );
    }
    if (this.closed) return Promise.reject(new PoolClosedError());
    if (signal?.aborted === true) return Promise.reject(abortError(signal));

    if (this.held < this.capacity && this.line.length === 0) {
      this.held += 1;
      return Promise.resolve(this.permit());
    }
    if (this.line.length >= this.maxWaiters) {
      return Promise.reject(new PoolSaturatedError(this.maxWaiters));
    }

    return new Promise<Permit>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.leave(waiter);
        reject(new AcquireTimeoutError(timeoutMilliseconds));
      }, timeoutMilliseconds);
      timer.unref();
      const onAbort = (): void => {
        this.leave(waiter);
        reject(signal === undefined ? new Error('aborted') : abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const waiter: Waiter = {
        grant: (permit) => {
          resolve(permit);
        },
        reject,
        stop: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };
      this.line.push(waiter);
    });
  }

  /** Stops serving: every waiter is rejected and nothing new is accepted. Permits already held are released as usual. */
  close(): void {
    this.closed = true;
    const waiters = this.line.splice(0);
    for (const waiter of waiters) {
      waiter.stop();
      waiter.reject(new PoolClosedError());
    }
  }

  private permit(): Permit {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.give();
      },
    };
  }

  /** A permit came back: it goes straight to the first waiter, or is freed. */
  private give(): void {
    const next = this.line.shift();
    if (next === undefined) {
      this.held -= 1;
      return;
    }
    next.stop();
    next.grant(this.permit());
  }

  private leave(waiter: Waiter): void {
    const at = this.line.indexOf(waiter);
    if (at >= 0) this.line.splice(at, 1);
    waiter.stop();
  }
}
