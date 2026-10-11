import type { HashAdmission, HashSlot } from '../auth/ports/hash-admission.port.js';
import type { CredentialHashingConfig } from '../config/credential-hashing.js';
import type { HashAdmissionConfig } from '../config/load-config.js';

/**
 * Threads of the libuv pool that hashing never takes. **Measured, not chosen** (DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.16
 * applied"): on the development machine, with all four threads of the default pool taken by hashes at the development profile,
 * a small piece of other libuv work (an asynchronous `randomBytes`, a `stat`) waited 174 to 448 ms for a thread; with three
 * of four taken it waited about 1 ms. Argon2id runs on the shared pool (`crypto.argon2`), so a bound that let it take every thread
 * would stall DNS lookups, file reads and every other asynchronous crypto call of the process, hash after hash.
 */
export const DEFAULT_RESERVED_THREADS = 1;

export interface BoundedHashAdmissionOptions {
  /** The most hashes at once. */
  readonly slots: number;
  /** The libuv pool hashing shares with the rest of the process (`libuvThreadpoolSize`). */
  readonly threadpoolSize: number;
  /** Threads hashing never takes; `DEFAULT_RESERVED_THREADS` when left out. */
  readonly reservedThreads?: number;
}

const isWhole = (value: unknown, least: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least;

/**
 * The libuv pool size the process has, read as libuv reads `UV_THREADPOOL_SIZE`: 4 when the variable is absent; when it is present,
 * C's `atoi` of it (the leading integer after any white space and an optional sign, 0 when there is none); a pool of 0 becomes 1,
 * a negative number is stored in an unsigned integer and so becomes a very large pool, and the pool is capped at 1024. So `0`,
 * `abc` and the empty string are a pool of one thread, not of four (measured on Node 24.21.0; DEPLOYMENT_AND_ENVIRONMENTS.md
 * §12.5). The variable is read once, when the pool is first used, so it is set in the environment of the process and cannot be
 * changed from inside it.
 */
export function libuvThreadpoolSize(env: Readonly<Record<string, string | undefined>>): number {
  const text = env.UV_THREADPOOL_SIZE;
  if (text === undefined) return 4;
  // C's atoi: white space, an optional sign, digits; nothing readable is 0.
  const leading = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(text);
  const value = leading === null ? 0 : Number(leading[1]);
  if (value === 0) return 1;
  if (value < 0) return 1024;
  return Math.min(1024, value);
}

/**
 * Admission to hashing (SECURITY_DESIGN.md §13.4c): a bounded number of concurrent password hashes, taken **before any
 * identity-dependent work**. `tryAdmit` answers at once, with a slot or with `null`: there is **no waiting queue** until a measured,
 * bounded waiting policy is recorded, and a request refused here is answered `RATE_LIMITED` without verifying, without a dummy
 * hash and without counting against any credential. It touches no database and keeps no identifier: it is a count.
 *
 * A slot is released when the hash finishes and only then (`runAdmitted` does that in a `finally`). Releasing a slot twice frees one
 * place, not two; a slot that is never released is a place lost for the life of the process, which is why callers use
 * `runAdmitted` and not the slot by hand.
 *
 * **The bound is also a bound on the shared libuv pool.** The slots plus the threads kept back must fit the pool: constructing
 * an admission that would let hashing take the whole pool is refused. Memory is bounded by the configuration (the slots, each at
 * the largest profile that may be derived, fit the budget: `planHashAdmission`).
 */
export class BoundedHashAdmission implements HashAdmission {
  readonly #slots: number;
  #inUse = 0;

  constructor(options: BoundedHashAdmissionOptions) {
    const reserved = options.reservedThreads ?? DEFAULT_RESERVED_THREADS;
    if (
      !isWhole(options.slots, 1) ||
      !isWhole(options.threadpoolSize, 1) ||
      !isWhole(reserved, 0)
    ) {
      throw new RangeError('Hash slots, the libuv pool and the reserve are whole numbers in range');
    }
    if (options.slots > options.threadpoolSize - reserved) {
      throw new RangeError(
        'Hash admission would let hashing take more of the shared libuv pool than it may; raise UV_THREADPOOL_SIZE or lower the slots',
      );
    }
    this.#slots = options.slots;
  }

  /** The hashes in flight. Diagnostic: nothing decides on it but this class. */
  get inUse(): number {
    return this.#inUse;
  }

  tryAdmit(): HashSlot | null {
    if (this.#inUse >= this.#slots) return null;
    this.#inUse += 1;
    let released = false;
    return {
      release: () => {
        // A slot gives back the one place it took, once.
        if (released) return;
        released = true;
        this.#inUse -= 1;
      },
    };
  }
}

export type AdmittedOutcome<T> =
  { readonly admitted: true; readonly value: T } | { readonly admitted: false };

/**
 * Runs `work` in a slot, or does not run it. When no slot is free the work is **not called at all** (nothing is hashed, nothing
 * counted) and the outcome says so; the caller answers `RATE_LIMITED`. The slot is given back when the work finishes or fails.
 */
export async function runAdmitted<T>(
  admission: HashAdmission,
  work: () => Promise<T>,
): Promise<AdmittedOutcome<T>> {
  const slot = admission.tryAdmit();
  if (slot === null) return { admitted: false };
  try {
    return { admitted: true, value: await work() };
  } finally {
    slot.release();
  }
}

export interface HashAdmissionPlan {
  readonly slots: number;
  /** The largest memory, in MiB, that a hash may be derived at: the write profile and every accepted one. */
  readonly largestProfileMiB: number;
  /** The slots, each at that memory: the most the hashes can take together. */
  readonly worstCaseMiB: number;
  readonly memoryBudgetMiB: number;
  /** Threads of the pool left to everything else when every slot is in use. */
  readonly threadsLeft: number;
}

/**
 * The capacity of hash admission as the process will have it, or the refusal (S0.16; SECURITY_DESIGN.md §13.4c: "memory held per
 * hash and contention for the shared worker pool belong to the capacity analysis, not only the CPU count"). The composition that
 * binds the admission calls it with the process's libuv pool; the configuration has already refused the memory relation at start
 * (`load-config.ts`), and this refuses it again for a configuration made by hand, and adds the one thing the configuration cannot
 * see: the pool the process actually has. The memory is that of the **largest accepted profile**, not the write profile alone,
 * because an old hash verifies at the cost it was made with.
 *
 * Every figure is development-qualified; S0.65 calibrates them. The message holds none of a profile's figures.
 */
export function planHashAdmission(input: {
  readonly hashAdmission: HashAdmissionConfig;
  readonly credentialHashing: CredentialHashingConfig;
  readonly threadpoolSize: number;
  readonly reservedThreads?: number;
}): HashAdmissionPlan {
  const { hashAdmission, credentialHashing } = input;
  const reserved = input.reservedThreads ?? DEFAULT_RESERVED_THREADS;
  const largestKiB = Math.max(
    credentialHashing.profile.memoryKiB,
    ...credentialHashing.acceptedProfiles.map((profile) => profile.memoryKiB),
  );
  const largestProfileMiB = largestKiB / 1024;
  const worstCaseMiB = hashAdmission.slots * largestProfileMiB;
  if (worstCaseMiB > hashAdmission.memoryBudgetMiB) {
    throw new RangeError(
      'Hash admission would let the hashes take more memory than the budget allows, at the largest profile that may be derived',
    );
  }
  // The pool relation is the admission's own (it refuses the same plan at construction); stating it here fails a start early.
  new BoundedHashAdmission({
    slots: hashAdmission.slots,
    threadpoolSize: input.threadpoolSize,
    reservedThreads: reserved,
  });
  return {
    slots: hashAdmission.slots,
    largestProfileMiB,
    worstCaseMiB,
    memoryBudgetMiB: hashAdmission.memoryBudgetMiB,
    threadsLeft: input.threadpoolSize - hashAdmission.slots,
  };
}
