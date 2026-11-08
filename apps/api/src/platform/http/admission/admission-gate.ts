/**
 * The admission gate of the HTTP pipeline (S0.20; DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "Deadlines"): at most `concurrency`
 * requests are admitted at once, a request over that waits in a line of at most `maxWaiters` for at most `waitMs`, and
 * everything beyond either bound is refused at once. It bounds how many requests the process works on, so that a flood is
 * turned away at the door and not queued in memory; it does **not** bound how long an admitted request runs (the request's
 * execution budget does, `request-budget.ts`) and does not bound a slow sender (the receipt deadlines do).
 *
 * A refused waiter leaves the line at the moment it is refused, so a slot that comes free is never handed to a request that
 * is no longer there. Fairness is first come, first served. The waits are timers that never keep the process alive.
 */

export type AdmissionRefusal = 'full' | 'timeout' | 'aborted' | 'closed';

/** The gate refused the request. `reason` says which bound: a full line, an expired wait, a caller that gave up, a closed gate. */
export class AdmissionRefusedError extends Error {
  constructor(readonly reason: AdmissionRefusal) {
    super(`The request was not admitted: ${reason}`);
    this.name = 'AdmissionRefusedError';
  }
}

export interface AdmissionSlot {
  /** Gives the slot back. Releasing a slot more than once frees it once. */
  release(): void;
}

export interface AdmissionGateOptions {
  /** How many requests are admitted at once. A positive integer. */
  readonly concurrency: number;
  /** How many may wait for a slot. Zero means none: a request over the concurrency is refused at once. */
  readonly maxWaiters: number;
  /** The most one request waits for a slot, in milliseconds. */
  readonly waitMs: number;
}

interface Waiter {
  readonly grant: (slot: AdmissionSlot) => void;
  readonly refuse: (reason: AdmissionRefusal) => void;
}

export class AdmissionGate {
  private readonly concurrency: number;
  private readonly maxWaiters: number;
  private readonly waitMs: number;
  private readonly line = new Set<Waiter>();
  private inUse = 0;
  private closed = false;

  constructor(options: AdmissionGateOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError('The admission concurrency is a positive whole number');
    }
    if (!Number.isInteger(options.maxWaiters) || options.maxWaiters < 0) {
      throw new RangeError('The admission line is a whole number of places, none or more');
    }
    if (!Number.isFinite(options.waitMs) || options.waitMs <= 0) {
      throw new RangeError('The admission wait is a finite, positive number of milliseconds');
    }
    this.concurrency = options.concurrency;
    this.maxWaiters = options.maxWaiters;
    this.waitMs = options.waitMs;
  }

  /** How many requests hold a slot now. */
  get active(): number {
    return this.inUse;
  }

  /** How many requests wait for a slot now. */
  get waiting(): number {
    return this.line.size;
  }

  /**
   * A slot, at once when one is free, else after a wait of at most `waitMs`; or an `AdmissionRefusedError`. A caller that goes
   * away while it waits (`signal`) leaves the line and is refused as `aborted`.
   */
  acquire(options: { readonly signal?: AbortSignal } = {}): Promise<AdmissionSlot> {
    const { signal } = options;
    if (this.closed) return Promise.reject(new AdmissionRefusedError('closed'));
    if (signal?.aborted === true) return Promise.reject(new AdmissionRefusedError('aborted'));
    if (this.inUse < this.concurrency) return Promise.resolve(this.take());
    if (this.line.size >= this.maxWaiters) {
      return Promise.reject(new AdmissionRefusedError('full'));
    }

    return new Promise<AdmissionSlot>((resolve, reject) => {
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.line.delete(waiter);
      };
      const waiter: Waiter = {
        grant: (slot) => {
          settle();
          resolve(slot);
        },
        refuse: (reason) => {
          settle();
          reject(new AdmissionRefusedError(reason));
        },
      };
      const timer = setTimeout(() => {
        waiter.refuse('timeout');
      }, this.waitMs);
      timer.unref();
      const onAbort = (): void => {
        waiter.refuse('aborted');
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.line.add(waiter);
    });
  }

  /** Refuses every waiter and every later caller. Slots already held are still taken back by `release`. */
  close(): void {
    this.closed = true;
    for (const waiter of [...this.line]) waiter.refuse('closed');
  }

  private take(): AdmissionSlot {
    this.inUse += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inUse -= 1;
        this.handOver();
      },
    };
  }

  /** The next waiter in line, if there is one and a slot is free, is served. */
  private handOver(): void {
    if (this.inUse >= this.concurrency) return;
    const next = this.line.values().next();
    if (next.done === true) return;
    next.value.grant(this.take());
  }
}
