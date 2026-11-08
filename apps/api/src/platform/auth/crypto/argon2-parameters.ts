/**
 * The cost of one Argon2id hash. Memory is in KiB, the unit of Node's `crypto.argon2` and of the PHC string.
 *
 * **No cost is fixed by the design.** SECURITY_DESIGN.md §13.4 says memory and time "must be benchmarked on the production
 * deployment", because a figure copied from a general source is either too weak to matter or too slow to serve. The Hasher is
 * given its cost by whoever composes it; the value below is only the development-qualified one.
 */
export interface Argon2idParameters {
  readonly memoryKiB: number;
  readonly passes: number;
  readonly parallelism: number;
}

/** A salt of 16 bytes and a tag of 32 are the only sizes this service writes or reads. */
export const ARGON2ID_SALT_BYTES = 16;
export const ARGON2ID_TAG_BYTES = 32;

/**
 * Ceilings, not recommendations: engineering bounds so that a cost read from storage or configuration cannot make one
 * verification take unbounded memory or time. A stored hash is data from a database column, and an old hash must verify at the
 * cost it was made with, so these are wide. They are not what a verification may actually ask for: the Hasher derives a stored
 * hash only at a profile it was explicitly given to support, and the profile new hashes are written at is its own parameters.
 */
export const ARGON2ID_LIMITS = Object.freeze({
  maxMemoryKiB: 1_048_576,
  maxPasses: 16,
  maxParallelism: 16,
});

/**
 * The least a deployed environment (staging or production) may write new hashes at: 19 MiB and 2 passes, the OWASP minimum
 * named in the correction review of S0.3 and taken as the agreed minimum of the initial policy. It is a floor on what is written
 * and not a claim about capacity, and it does not apply to older profiles that may still be verified. Whether it is the right
 * minimum is the Product Owner's to confirm; S0.65 proposes the release profile. A local run may use less, in an explicit test
 * composition.
 */
export const ARGON2ID_DEPLOYED_FLOOR = Object.freeze({ memoryKiB: 19_456, passes: 2 });

/** The key of a profile, for telling two apart by value. */
export const profileKey = ({ memoryKiB, passes, parallelism }: Argon2idParameters): string =>
  `${String(memoryKiB)}:${String(passes)}:${String(parallelism)}`;

export const isBelowDeployedFloor = (parameters: Argon2idParameters): boolean =>
  parameters.memoryKiB < ARGON2ID_DEPLOYED_FLOOR.memoryKiB ||
  parameters.passes < ARGON2ID_DEPLOYED_FLOOR.passes;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Whether the value is a cost the library will honour exactly and the limits allow. Node rounds `memory` down to a multiple of
 * 4 KiB per lane and requires at least 8 KiB per lane, so a cost that is not already such a multiple is refused: the cost written
 * into a hash must be the cost that was spent.
 */
export function isValidArgon2idParameters(value: unknown): value is Argon2idParameters {
  if (typeof value !== 'object' || value === null) return false;
  const memoryKiB: unknown = Reflect.get(value, 'memoryKiB');
  const passes: unknown = Reflect.get(value, 'passes');
  const parallelism: unknown = Reflect.get(value, 'parallelism');
  if (!isCount(memoryKiB) || !isCount(passes) || !isCount(parallelism)) return false;
  return (
    parallelism <= ARGON2ID_LIMITS.maxParallelism &&
    passes <= ARGON2ID_LIMITS.maxPasses &&
    memoryKiB <= ARGON2ID_LIMITS.maxMemoryKiB &&
    memoryKiB >= 8 * parallelism &&
    memoryKiB % (4 * parallelism) === 0
  );
}

/** Throws a `RangeError` that says what a valid cost is and never what was given. */
export function assertArgon2idParameters(value: Argon2idParameters): void {
  if (!isValidArgon2idParameters(value)) {
    throw new RangeError(
      'Argon2id parameters must be whole numbers within the limits, with memory of at least 8 KiB and a multiple of 4 KiB per lane.',
    );
  }
}

/**
 * The cost the development and test compositions use: 64 MiB, 2 passes, one lane. **Development-qualified, not
 * production-qualified.**
 *
 * It was chosen by measurement, as plan §3 ("Engineering parameters") and S0.3a require, and not copied from a general source:
 * the lowest-memory single-lane candidate of the benchmark's grid whose median single-hash time on the development machine is at
 * least 100 ms (`src/tools/benchmark-argon2.ts`; the target is an engineering convention for an interactive sign-in, not a
 * product decision). One lane, because a hash with more than one lane spreads over several cores and a single-lane hash
 * occupies one thread of the shared pool, which is what the capacity analysis of S0.16 and S0.65 can reason about.
 *
 * **The record of the measurement** (9 October 2026): Windows 11 Pro 10.0.26200, x64, Intel Core i7-8750H at 2.20 GHz with 12
 * logical CPUs and 16300 MiB, Node 24.21.0 with OpenSSL 3.5.8 and the default libuv pool of 4; PostgreSQL not involved. The
 * machine was quiet (0.28 of 12 cores busy before and during, CPU load 11 percent, no other build or test running). 15 measured
 * runs after one warm-up, one hash at a time. This cost: median 110.7 ms, minimum 107.0 ms, 95th percentile 144.8 ms. The rest of
 * the single-lane grid, by median: 19 MiB with 2 passes 35.7 ms, 19 MiB with 3 passes 50.8 ms, 32 MiB with 2 passes 62.9 ms, 45 MiB
 * with 1 pass 48.5 ms, 64 MiB with 3 passes 157.7 ms, 128 MiB with 2 passes 226.4 ms. The tests that exercise this cost are
 * `argon2id.test.ts` (the Argon2 reference implementation's published vector, which uses exactly this cost) and
 * `argon2.hasher.adapter.test.ts`.
 *
 * It measures one hash at a time and nothing under load, and a figure from this machine is not a capacity claim: S0.65 calibrates
 * this value on a recorded machine and proposes the deployment values for the Product Owner's approval.
 */
export const DEVELOPMENT_QUALIFIED_ARGON2ID: Argon2idParameters = Object.freeze({
  memoryKiB: 65_536,
  passes: 2,
  parallelism: 1,
});
