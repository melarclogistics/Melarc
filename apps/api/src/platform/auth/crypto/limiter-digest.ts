import { createHmac } from 'node:crypto';

import type { KeyConfig } from '../../config/load-config.js';
import { CryptoConditionError } from './condition.js';
import { heldKeys } from './held-keys.js';

/** One digest of a key, and the version of the limiter key it was made under. */
export interface KeyedDigest {
  readonly version: number;
  /** 32 bytes: HMAC-SHA-256. */
  readonly bytes: Buffer;
}

/** The namespace of a limiter key: bucket and purpose. A change to it is a new digest of everything, so it is never edited. */
const NAMESPACE = 'melarc.rate-limit.v1';

/**
 * The text that is keyed: the namespace, the bucket and the canonical key, each followed by a NUL byte. The separators keep one
 * part from running into the next (`("ab","c")` and `("a","bc")` are two inputs), and the namespace keeps a digest made for a
 * limiter from being a digest of anything else made under the same key.
 */
export function limiterDigestInput(bucket: string, canonicalKey: string): Buffer {
  return Buffer.from(`${NAMESPACE}\u0000${bucket}\u0000${canonicalKey}`, 'utf8');
}

/**
 * The keyed digest the rate limiter stores in place of an identifier (SECURITY_DESIGN.md §14.12: "formed with a keyed digest
 * under the limiter's own key purpose (§14.9), so no identifier or token is stored or logged in clear"). It is the HMAC-SHA-256
 * of the namespaced key under the `limiter_digest` purpose's key, and it is a pseudonym and not a secret: whoever holds the key
 * can test a guess against a stored digest, and nobody else can.
 *
 * **Rotation overlaps.** A new key version is added beside the old, and then made active: from then on rows are written under the
 * active version, and a lookup asks for the digest under **every version held**, so an allowance a caller has already used is not
 * reset by a rotation. The old version is retired only after the longest live window (60 seconds) has passed with the new one
 * active everywhere. `digestsFor` gives all of them, ascending, and names the active one.
 *
 * It is not composed without its key (a limiter that hashes everything under nothing would fail every request, or none): the
 * purpose must be held and its active version must be among the versions held. Key material is read in `held-keys.ts` and nowhere
 * else; this class keeps the decoded keys, never the keys' text, and never the identifiers it digests.
 */
export class LimiterDigest {
  readonly #keys: ReadonlyMap<number, Buffer>;
  readonly activeVersion: number;

  constructor(config: KeyConfig) {
    const held = heldKeys(config, 'limiter_digest');
    if (held === undefined) throw new CryptoConditionError('PURPOSE_KEY_ABSENT');
    if (!held.keys.has(held.activeVersion)) throw new CryptoConditionError('KEY_VERSION_UNKNOWN');
    this.#keys = new Map([...held.keys].sort(([a], [b]) => a - b));
    this.activeVersion = held.activeVersion;
  }

  /** The digests of `canonicalKey` in `bucket` under every held version, ascending, and the one under the active version. */
  digestsFor(
    bucket: string,
    canonicalKey: string,
  ): { readonly active: KeyedDigest; readonly all: readonly KeyedDigest[] } {
    if (typeof bucket !== 'string' || bucket === '' || typeof canonicalKey !== 'string') {
      throw new TypeError('A rate-limit key is made from a bucket and a canonical key');
    }
    const input = limiterDigestInput(bucket, canonicalKey);
    const all = [...this.#keys].map(([version, key]) => ({
      version,
      bytes: createHmac('sha256', key).update(input).digest(),
    }));
    const active = all.find((entry) => entry.version === this.activeVersion);
    if (active === undefined) throw new CryptoConditionError('KEY_VERSION_UNKNOWN');
    return { active, all };
  }
}
