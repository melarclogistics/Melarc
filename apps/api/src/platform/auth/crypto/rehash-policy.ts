import type { Argon2idParameters } from './argon2-parameters.js';

/**
 * Whether a stored credential hash may be rewritten when it has just been verified. **Being able to verify a hash and being
 * permitted to replace it are two decisions.** A hash must keep verifying under the cost and pepper version it was made with
 * (SECURITY_DESIGN.md §14.9), but replacing it is a migration, and a migration only goes forward: an instance still running an
 * older configuration during a rolling deployment must not undo the newer one, and two overlapping instances must not take a
 * hash back and forth.
 *
 * - **Cost.** Forward means the same lanes, no less memory and no more passes lost, and at least one of the two larger. Anything
 *   else is `BLOCKED`: a reduction, a profile that gains in one of memory and passes and loses in the other, and a change of lane
 *   count. A changed profile is never assumed to be a stronger one.
 * - **Pepper.** Forward means a newer version, taken as a greater number (versions are assigned in increasing order,
 *   `KEY_PASSWORD_PEPPER_ACTIVE_VERSION`). The active version is the approved target, so an older one is `BLOCKED`.
 *
 * Rewriting is allowed only when neither dimension is blocked and at least one has moved forward. Anything else needs an explicit
 * migration decision, which this policy does not make. Pepper rotation at an unchanged cost does not change the configured
 * derivation cost, and is judged apart from a cost migration.
 */
export type Movement = 'SAME' | 'FORWARD' | 'BLOCKED';

export interface HashProfile {
  readonly parameters: Argon2idParameters;
  readonly pepperVersion: number;
}

export function costMovement(stored: Argon2idParameters, current: Argon2idParameters): Movement {
  if (current.parallelism !== stored.parallelism) return 'BLOCKED';
  if (current.memoryKiB < stored.memoryKiB || current.passes < stored.passes) return 'BLOCKED';
  return current.memoryKiB > stored.memoryKiB || current.passes > stored.passes
    ? 'FORWARD'
    : 'SAME';
}

export function pepperMovement(storedVersion: number, activeVersion: number): Movement {
  if (activeVersion === storedVersion) return 'SAME';
  return activeVersion > storedVersion ? 'FORWARD' : 'BLOCKED';
}

/** `stored` is what the hash records; `current` is this instance's write profile and active pepper version. */
export function shouldRehash(stored: HashProfile, current: HashProfile): boolean {
  const cost = costMovement(stored.parameters, current.parameters);
  const pepper = pepperMovement(stored.pepperVersion, current.pepperVersion);
  if (cost === 'BLOCKED' || pepper === 'BLOCKED') return false;
  return cost === 'FORWARD' || pepper === 'FORWARD';
}
