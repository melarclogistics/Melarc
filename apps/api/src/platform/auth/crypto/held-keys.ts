import type { KeyPurpose, PurposeKeys } from '../../config/key-material.js';
import type { KeyConfig } from '../../config/load-config.js';
import { decodeBase64Url32 } from './canonical-base64url.js';

/** The versions of one purpose a deployment holds, as the key bytes they spell. */
export interface HeldKeys {
  /** The version new records are written under. It may not be among `keys` in a configuration made by hand. */
  readonly activeVersion: number;
  readonly keys: ReadonlyMap<number, Buffer>;
}

/**
 * The keys of one purpose, decoded once so that `Secret.reveal()` is called here and nowhere else, or undefined when the
 * configuration holds none: the describe custody holds no key at all, and a configuration made by hand may leave a purpose out.
 *
 * Key material that is not a canonical 32-byte key is refused at once, so that an adapter built on it fails when it is composed
 * and not at the first request that uses it. `loadConfig` has already refused such a key for a configuration made from the
 * environment; this holds for one made by hand. The message is fixed text: what failed to parse may be a key.
 *
 * **Each key gets an ArrayBuffer of its own.** A Buffer made from a string is a view into Node's shared 8 KiB pool, and a key
 * lives as long as the process: left there, the pepper and the AES keys would share memory with every other small Buffer made
 * from a string, and any later exposure of `.buffer` by unrelated code would show the pool. `Buffer.alloc` is never pooled, and the
 * pooled temporary is cleared.
 */
export function heldKeys(config: KeyConfig, purpose: KeyPurpose): HeldKeys | undefined {
  if (config.custody !== 'local') return undefined;
  const held: Partial<Record<KeyPurpose, PurposeKeys>> = config.purposes;
  const entry = held[purpose];
  if (entry === undefined) return undefined;

  const keys = new Map<number, Buffer>();
  for (const [version, secret] of Object.entries(entry.versions)) {
    const number = Number(version);
    const decoded = decodeBase64Url32(secret.reveal());
    if (!Number.isSafeInteger(number) || number < 1 || decoded === undefined) {
      throw new TypeError(
        'The key material of a purpose is not a version and a canonical 32-byte key.',
      );
    }
    const key = Buffer.alloc(decoded.length);
    decoded.copy(key);
    decoded.fill(0);
    keys.set(number, key);
  }
  return { activeVersion: entry.activeVersion, keys };
}
