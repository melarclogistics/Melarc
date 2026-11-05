import { createHmac, hkdfSync } from 'node:crypto';

import type { KeyHolding } from '../../config/key-material.js';
import { CryptoConditionError } from './condition.js';
import { heldKeys } from './held-keys.js';

/** One digest of a code, and the version of the key it was made under. */
export interface HandshakeDigest {
  readonly version: number;
  /** 32 bytes: HMAC-SHA-256. */
  readonly bytes: Buffer;
}

// The two keys of the purpose: a code key, which makes the code of a generation, and a digest key, which makes the digest the database keeps. They are
// two keys so that a digest (which the database holds, and a backup carries) is not a function of the same key that makes the code, and so that the
// worker, which needs to make codes to text them, is never asked for a digest key by its own code. The labels are persisted formats: a change is a new
// label and a new generation of every code in flight, never an edit.
const CODE_LABEL = 'melarc.handshake.code.v1';
const DIGEST_LABEL = 'melarc.handshake.digest.v1';
/** A code is 4 to 8 digits: a shorter one is a coin toss, and 8 digits of a 64-bit reading keep the bias below a part in a billion. */
const MIN_LENGTH = 4;
const MAX_LENGTH = 8;
/** The generation is a counter that the database keeps in a 32-bit column. */
const MAX_GENERATION = 2_147_483_647;

interface VersionKeys {
  readonly code: Buffer;
  readonly digest: Buffer;
}

function derived(master: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), label, 32));
}

/**
 * The collection handshake's code, **derived and never stored** (S1.27; `AC-SLICE-001-23`; SECURITY_DESIGN.md §14.9). The code of a stop's
 * generation is made from the stop and the generation under a key of the `credential_delivery` purpose, which is where a secret that is sent to
 * a person is kept: the API makes it to show the rider and the worker makes it to text it, and the database keeps only a keyed digest of it
 * (`code_digest`), which is all that checking a submitted code needs. So **nothing at rest holds a code, in clear or sealed**, and a code that
 * leaves the process leaves in the one response that shows it or in the one text that carries it, which no log, metric or audit event repeats.
 *
 * - **A code is as guessable as its key is findable, and no more than the attempts allow.** The database counts the wrong attempts and ends the code
 *   at `handshake_max_wrong_attempts`, so a four-digit code is not enumerated by anyone who does not hold the key, and anyone who does has no use for
 *   the attempts.
 * - **Rotation overlaps**, as the limiter's digest does: a digest is made under every version held, so a code made before a rotation still verifies
 *   after it, and the key version a code was made under is kept beside it for the one who must derive the code again.
 * - **The digest binds the stop**, so a code (or a digest of one) for another stop never verifies here.
 */
export class HandshakeCodes {
  readonly #keys: ReadonlyMap<number, VersionKeys>;
  readonly activeVersion: number;

  constructor(config: KeyHolding) {
    const held = heldKeys(config, 'credential_delivery');
    if (held === undefined) throw new CryptoConditionError('PURPOSE_KEY_ABSENT');
    if (!held.keys.has(held.activeVersion)) throw new CryptoConditionError('KEY_VERSION_UNKNOWN');
    this.#keys = new Map(
      [...held.keys]
        .sort(([a], [b]) => a - b)
        .map(([version, master]) => [
          version,
          { code: derived(master, CODE_LABEL), digest: derived(master, DIGEST_LABEL) },
        ]),
    );
    this.activeVersion = held.activeVersion;
  }

  /** The key versions held, ascending. */
  get versions(): readonly number[] {
    return [...this.#keys.keys()];
  }

  /** The code of the `generation` of the handshake of `stopId`, under `version`: `length` digits, leading zeros kept. */
  codeFor(stopId: string, generation: number, version: number, length: number): string {
    if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
      throw new RangeError('A handshake code is four to eight digits.');
    }
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) {
      throw new RangeError('The generation of a handshake code is a positive whole number.');
    }
    const keys = this.#keys.get(version);
    if (keys === undefined) throw new CryptoConditionError('KEY_VERSION_UNKNOWN');
    const mac = createHmac('sha256', keys.code)
      .update(`${stopId}\u0000${String(generation)}`)
      .digest();
    const reading = BigInt(`0x${mac.subarray(0, 8).toString('hex')}`);
    return (reading % 10n ** BigInt(length)).toString().padStart(length, '0');
  }

  /** The digest of `code` for `stopId` under one key version. */
  digestOfVersion(stopId: string, code: string, version: number): Buffer {
    const keys = this.#keys.get(version);
    if (keys === undefined) throw new CryptoConditionError('KEY_VERSION_UNKNOWN');
    return createHmac('sha256', keys.digest).update(`${stopId}\u0000${code}`).digest();
  }

  /** The digests of `code` for `stopId` under every version held, ascending: what the database compares a stored digest with. */
  digestsOf(stopId: string, code: string): readonly HandshakeDigest[] {
    return this.versions.map((version) => ({
      version,
      bytes: this.digestOfVersion(stopId, code, version),
    }));
  }
}
