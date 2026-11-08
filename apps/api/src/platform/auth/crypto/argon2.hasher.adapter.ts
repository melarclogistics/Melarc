import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { KeyConfig } from '../../config/load-config.js';
import { CREDENTIAL_MAX_CODE_POINTS } from '../credentials/credential-rule.js';
import { codePointCount, isWellFormedUnicode } from '../credentials/unicode.js';
import type { HashedCredentialKind, HashVerdict, Hasher } from '../ports/hasher.port.js';
import { decodeArgon2idHash, encodeArgon2idHash, type Argon2idHash } from './argon2-hash-format.js';
import {
  ARGON2ID_SALT_BYTES,
  ARGON2ID_TAG_BYTES,
  assertArgon2idParameters,
  profileKey,
  type Argon2idParameters,
} from './argon2-parameters.js';
import { argon2idTag } from './argon2id.js';
import { CryptoConditionError } from './condition.js';
import { heldKeys, type HeldKeys } from './held-keys.js';
import { shouldRehash } from './rehash-policy.js';

/** The credential kinds, as a record so that a kind added to the port without a line here does not compile. */
const KINDS: Readonly<Record<HashedCredentialKind, true>> = Object.freeze({
  STAFF_PASSWORD: true,
  VENDOR_SECRET: true,
  RIDER_PIN: true,
});

/**
 * What every credential hash is bound to besides the secret, as Argon2's associated data: the kind, so that a hash made for one
 * kind of credential is not a hash for another (a vendor's secret hash moved into a staff record verifies nothing). It is part of
 * the format of every stored hash: changing it orphans them all, and `argon2.hasher.adapter.test.ts` recomputes a tag outside the
 * adapter to hold it still.
 */
const CONTEXT_PREFIX = 'MELARC-CREDENTIAL-V1:';

/**
 * The asynchronous Argon2id `Hasher` (SECURITY_DESIGN.md §13.4, §13.4c, §14.9): unique salts, versioned parameters, and a
 * versioned pepper held outside the database and given to the algorithm as its secret input. The hash records its parameters and
 * its pepper version, so a hash made under an older cost or an older pepper still verifies at the cost it was made with.
 *
 * **Verifying and rewriting are separate decisions.** `verify` says whether the secret matches; `needsRehash` says whether the
 * stored hash may be replaced on this success, and it is forward-only (`rehash-policy.ts`): a newer pepper at an unchanged cost, or
 * a larger cost at the same lanes, and never a step back to an older pepper, a lower cost or a profile that merely differs. An
 * instance still on an older configuration during a rolling deployment therefore verifies what the newer one wrote and leaves it
 * alone. Pepper rotation at an unchanged cost does not change the configured derivation cost, and is judged apart from a cost
 * migration.
 *
 * **The cost is given, not chosen, and so is what is supported.** Whoever composes the adapter passes the write profile (what
 * `hash` makes, and what the dummy runs at) and the historical profiles that may still be verified. A stored hash is derived only
 * at one of those: any other well-formed hash raises `HASH_PROFILE_UNSUPPORTED` before any derivation, and is never reported as a
 * wrong password. `ARGON2ID_LIMITS` stay as absolute ceilings underneath, but they are wide; the resources a verification can ask
 * for are those of the largest supported profile, which is what hash admission (S0.16) must budget for. The class has no default
 * profile; the application configuration carries them (`ARGON2_*`), and cheap profiles belong to explicit test compositions.
 *
 * **It is not composed without a pepper.** No pepper purpose, or an active version that is not among the versions held, is a
 * deployment that cannot hash: construction fails with `PEPPER_UNAVAILABLE` and there is no instance that starts and then fails
 * on each call (security-test-matrix.md GBT-V8, "fails to start, no degraded mode", for local custody). A hash made under a
 * version that is no longer held is a different case and a call-time one: `verify` raises `PEPPER_UNAVAILABLE` for it, and does
 * not answer "wrong password", because that would lock every user of that version out with no signal why (§14.9).
 *
 * **Work is bounded, and one derivation each.** Every call that is admitted does exactly one derivation, and a call that cannot
 * succeed does none: a malformed stored hash, an unsupported profile, a pepper version that is not held and an input the
 * credential rule would have refused are all answered before the algorithm starts. That fixes the number of derivations and
 * their ceiling, not their equality: the derivation is at the cost recorded in the hash it concerns (the write profile for `hash`
 * and for the dummy), so while a cost migration is under way a real verification of a hash not yet migrated and a dummy one differ
 * in cost. Old hashes must verify at the cost they were made with, so that cannot be removed; §13.4b calls equal timing a
 * diagnostic and not the proof, and the migration window needs assessing before a cost migration is enabled.
 *
 * It is a port adapter and is imported only by the composition root. It is called outside any transaction and, in a request, after
 * hash admission. It normalises nothing: the secret has already passed the credential rule.
 */
export class Argon2Hasher implements Hasher {
  readonly #parameters: Argon2idParameters;
  readonly #supported: ReadonlySet<string>;
  readonly #pepper: HeldKeys;
  /** The fixed hash a dummy verification runs against: the write profile and pepper version, and a tag nothing derives. */
  readonly #dummy: Argon2idHash;

  constructor(
    keys: KeyConfig,
    parameters: Argon2idParameters,
    historicalProfiles: readonly Argon2idParameters[] = [],
  ) {
    assertArgon2idParameters(parameters);
    for (const historical of historicalProfiles) assertArgon2idParameters(historical);
    this.#parameters = Object.freeze({ ...parameters });
    this.#supported = new Set([parameters, ...historicalProfiles].map(profileKey));
    const pepper = heldKeys(keys, 'password_pepper');
    if (pepper?.keys.has(pepper.activeVersion) !== true) {
      throw new CryptoConditionError('PEPPER_UNAVAILABLE');
    }
    this.#pepper = pepper;
    this.#dummy = {
      parameters: this.#parameters,
      pepperVersion: pepper.activeVersion,
      salt: randomBytes(ARGON2ID_SALT_BYTES),
      tag: randomBytes(ARGON2ID_TAG_BYTES),
    };
  }

  async hash(kind: HashedCredentialKind, secret: string): Promise<string> {
    const message = messageOf(secret);
    const context = contextOf(kind);
    const pepperVersion = this.#pepper.activeVersion;
    const pepper = this.#pepperAt(pepperVersion);

    const salt = randomBytes(ARGON2ID_SALT_BYTES);
    const tag = await argon2idTag({
      message,
      salt,
      parameters: this.#parameters,
      pepper,
      associatedData: context,
    });
    return encodeArgon2idHash({ parameters: this.#parameters, pepperVersion, salt, tag });
  }

  async verify(
    kind: HashedCredentialKind,
    secret: string,
    encodedHash: string,
  ): Promise<HashVerdict> {
    const message = messageOf(secret);
    const context = contextOf(kind);
    const stored = decodeArgon2idHash(encodedHash);
    if (stored === undefined) throw new CryptoConditionError('HASH_MALFORMED');
    if (!this.#supported.has(profileKey(stored.parameters))) {
      throw new CryptoConditionError('HASH_PROFILE_UNSUPPORTED');
    }
    const pepper = this.#pepperAt(stored.pepperVersion);

    const tag = await argon2idTag({
      message,
      salt: stored.salt,
      parameters: stored.parameters,
      pepper,
      associatedData: context,
    });
    const matches = timingSafeEqual(tag, stored.tag);
    return {
      matches,
      needsRehash:
        matches &&
        shouldRehash(stored, {
          parameters: this.#parameters,
          pepperVersion: this.#pepper.activeVersion,
        }),
    };
  }

  async verifyAgainstDummy(kind: HashedCredentialKind, secret: string): Promise<void> {
    const message = messageOf(secret);
    const context = contextOf(kind);
    const dummy = this.#dummy;
    const pepper = this.#pepperAt(dummy.pepperVersion);

    const tag = await argon2idTag({
      message,
      salt: dummy.salt,
      parameters: dummy.parameters,
      pepper,
      associatedData: context,
    });
    // The same comparison a real verification makes, and its result is not used.
    timingSafeEqual(tag, dummy.tag);
  }

  #pepperAt(version: number): Buffer {
    const pepper = this.#pepper.keys.get(version);
    if (pepper === undefined) throw new CryptoConditionError('PEPPER_UNAVAILABLE');
    return pepper;
  }
}

/**
 * The bytes of the secret. The input has passed the credential rule, so a violation here is a programming error and is thrown,
 * not returned: text that is not well-formed Unicode would be encoded to U+FFFD (two different texts, one hash), and a text of more
 * than the 128 code points the rule allows would make a derivation take input the rule exists to keep out. The messages are fixed
 * text.
 */
function messageOf(secret: unknown): Buffer {
  if (typeof secret !== 'string') throw new TypeError('A credential to hash is text.');
  if (!isWellFormedUnicode(secret)) {
    throw new TypeError('A credential to hash is well-formed Unicode: a lone surrogate was given.');
  }
  if (codePointCount(secret, CREDENTIAL_MAX_CODE_POINTS) > CREDENTIAL_MAX_CODE_POINTS) {
    throw new RangeError('A credential to hash is at most 128 code points: more was given.');
  }
  return Buffer.from(secret, 'utf8');
}

function contextOf(kind: unknown): Buffer {
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) {
    throw new TypeError('A credential to hash has a known kind.');
  }
  return Buffer.from(`${CONTEXT_PREFIX}${kind}`, 'ascii');
}
