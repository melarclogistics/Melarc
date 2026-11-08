import {
  isValidArgon2idParameters,
  profileKey,
  type Argon2idParameters,
} from '../auth/crypto/argon2-parameters.js';

/**
 * How credentials are hashed, as the configuration carries it (SECURITY_DESIGN.md §13.4, §13.4c): the profile new hashes are
 * written at (and the dummy verification runs at), and the older profiles that hashes already stored may still be verified at.
 * A stored hash at any other profile is refused without being derived. The Hasher is given these by whoever binds it.
 */
export interface CredentialHashingConfig {
  readonly profile: Argon2idParameters;
  readonly acceptedProfiles: readonly Argon2idParameters[];
}

/** The most older profiles that may be accepted at once: the same bound as the key versions a purpose holds. */
export const MAX_ACCEPTED_PROFILES = 8;

const ENTRY = /^([1-9]\d{0,9}):([1-9]\d{0,9}):([1-9]\d{0,9})$/;

/**
 * Reads `<memory KiB>:<passes>:<lanes>[,<memory>:<passes>:<lanes>...]`: one to eight profiles, each a valid cost, none repeated.
 * Returns undefined for anything else, and never says why. Whether a profile is also the write profile is judged by the loader,
 * which knows both.
 */
export function parseAcceptedProfiles(text: string): Argon2idParameters[] | undefined {
  const entries = text.split(',');
  if (entries.length > MAX_ACCEPTED_PROFILES) return undefined;
  const profiles: Argon2idParameters[] = [];
  for (const entry of entries) {
    const match = ENTRY.exec(entry);
    if (match === null) return undefined;
    const profile = {
      memoryKiB: Number(match[1]),
      passes: Number(match[2]),
      parallelism: Number(match[3]),
    };
    if (!isValidArgon2idParameters(profile)) return undefined;
    if (profiles.some((seen) => profileKey(seen) === profileKey(profile))) return undefined;
    profiles.push(profile);
  }
  return profiles;
}
