import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeyHolding, KeyPurpose } from '../../config/key-material.js';
import type { CipherPurpose, SealedSecret, SecretCipher } from '../ports/secret-cipher.port.js';
import { CryptoConditionError } from './condition.js';
import { heldKeys } from './held-keys.js';

/** The purposes a sealed value can have, each with its own key purpose and the code the envelope authenticates it as. */
const PURPOSES: Readonly<
  Record<CipherPurpose, { readonly key: KeyPurpose; readonly code: number }>
> = Object.freeze({
  TOTP_SEED: { key: 'totp_seed', code: 1 },
  DELIVERY_PAYLOAD: { key: 'credential_delivery', code: 2 },
  REPLAY_SECRET: { key: 'idempotent_replay', code: 3 },
});

/**
 * The envelope layouts this adapter can open, and the one it writes. A layout is a number recorded with the envelope
 * (`SealedSecret.envelopeVersion`) and authenticated in its associated data, so a reader selects the layout from the stored
 * record and never by trial; a record that names another layout, or none, fails closed. A new layout takes a new number and is
 * added here beside the old one, which stays openable for the records that hold it. Layout 1 is the one described below.
 */
const CURRENT_ENVELOPE_VERSION = 1;
const SUPPORTED_ENVELOPE_VERSIONS: ReadonlySet<number> = new Set([1]);
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** What the cipher holds for one purpose: every version it must open, and the active key it seals under. */
interface HeldPurpose {
  readonly activeVersion: number;
  readonly active: Buffer;
  readonly keys: ReadonlyMap<number, Buffer>;
}

/**
 * Authenticated encryption of a value that must be recovered later (a TOTP seed, a queued message, a replayable enrolment
 * answer): AES-256-GCM, one versioned key per purpose, a fresh random 96-bit nonce for every seal (SECURITY_DESIGN.md §14.9).
 *
 * **What the envelope authenticates (layout 1).** The associated data is the envelope version (one byte), the purpose code (one
 * byte), the key version (four big-endian bytes) and then the caller's own context, which names the principal, operation and
 * record (`sealedContext`, which every caller uses so that the context is built one way). So a value moved to another row, opened
 * for another operation, opened as another purpose or re-labelled with another key version or layout does not authenticate,
 * whatever keys are configured: purpose separation does not rest on the keys being different alone.
 * `aes-gcm.secret-cipher.adapter.test.ts` recomputes a ciphertext outside the adapter to hold the layout still. The context is
 * required: a value sealed to no context would bind to no record.
 *
 * **Stored with the ciphertext.** A persistence task stores all four fields of the envelope: `envelopeVersion`, `keyVersion`,
 * `nonce` and `ciphertext` (which ends with the 16-byte tag). The context is not stored; it is derived again from the record.
 *
 * **Key versions.** `seal` uses the purpose's active version and records it in the envelope; `open` uses the version the envelope
 * names, so an old version stays available for exactly the records it must open and rotation adds a version instead of
 * replacing one. A version that is not held is `KEY_VERSION_UNKNOWN`, which is told apart from a value that failed to
 * authenticate, and an envelope version that is not supported is `ENVELOPE_VERSION_UNSUPPORTED`.
 *
 * **It is not composed without its keys.** Every purpose it serves needs a usable key (the purpose is held, and its active
 * version is among the versions held): otherwise construction fails with `PURPOSE_KEY_ABSENT`. There is no instance that starts and
 * then fails on each call (security-test-matrix.md GBT-V8, "fails to start, no degraded mode", for local custody).
 *
 * **It serves all three purposes unless it is told otherwise.** A process that handles one kind of value names it (`serves`): the
 * delivery worker is given the `credential_delivery` key and no other, because each purpose has its own access policy
 * (SECURITY_DESIGN.md §14.9) and a worker that can open a TOTP seed or a saved answer has a power it has no use for. The instance
 * then decodes and keeps the keys of the purposes it serves and no others, and a purpose it was not told to serve is refused
 * (`PURPOSE_KEY_ABSENT`, which is exactly what it holds for it). That is stated at composition, by the process, and is not a
 * degraded mode: it never serves part of what it was told to serve.
 *
 * **Nonces.** Random 96-bit nonces are safe for up to 2^32 seals under one key (NIST SP 800-38D section 8.3). A deployment seals
 * one seed per privileged identity and one payload per delivery, far below that, and a new key version starts the count again.
 *
 * It does not say why a value failed to authenticate, and no message holds anything that was supplied. It is local, in-process
 * work with no I/O (`independent`), and answers with a promise because a managed key service will not be. It is an adapter,
 * imported only by the composition root.
 */
export interface AesGcmSecretCipherOptions {
  /** The purposes this instance serves, one or more. All three when it is not told. */
  readonly serves?: readonly CipherPurpose[];
}

export class AesGcmSecretCipher implements SecretCipher {
  readonly #held: Readonly<Partial<Record<CipherPurpose, HeldPurpose>>>;

  constructor(keys: KeyHolding, options: AesGcmSecretCipherOptions = {}) {
    const held: Partial<Record<CipherPurpose, HeldPurpose>> = {};
    for (const purpose of servedPurposes(options.serves)) {
      const purposeKeys = heldKeys(keys, PURPOSES[purpose].key);
      const active = purposeKeys?.keys.get(purposeKeys.activeVersion);
      if (purposeKeys === undefined || active === undefined) {
        throw new CryptoConditionError('PURPOSE_KEY_ABSENT');
      }
      held[purpose] = { activeVersion: purposeKeys.activeVersion, active, keys: purposeKeys.keys };
    }
    this.#held = Object.freeze(held);
  }

  seal(
    purpose: CipherPurpose,
    plaintext: Uint8Array,
    authenticatedData: Uint8Array,
  ): Promise<SealedSecret> {
    return new Promise((resolve) => {
      resolve(this.#seal(purpose, plaintext, authenticatedData));
    });
  }

  open(
    purpose: CipherPurpose,
    sealed: SealedSecret,
    authenticatedData: Uint8Array,
  ): Promise<Uint8Array> {
    return new Promise((resolve) => {
      resolve(this.#open(purpose, sealed, authenticatedData));
    });
  }

  /** The keys of a purpose this instance serves; a purpose it was not told to serve has no key here. */
  #heldFor(purpose: CipherPurpose): HeldPurpose {
    const held = this.#held[purpose];
    if (held === undefined) throw new CryptoConditionError('PURPOSE_KEY_ABSENT');
    return held;
  }

  #seal(
    purpose: CipherPurpose,
    plaintext: Uint8Array,
    authenticatedData: Uint8Array,
  ): SealedSecret {
    const { code } = known(purpose);
    const context = contextOf(authenticatedData);
    if (!(plaintext instanceof Uint8Array)) throw new TypeError('A value to seal is bytes.');
    const held = this.#heldFor(purpose);

    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', held.active, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(CURRENT_ENVELOPE_VERSION, code, held.activeVersion, context));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      envelopeVersion: CURRENT_ENVELOPE_VERSION,
      keyVersion: held.activeVersion,
      nonce: new Uint8Array(nonce),
      ciphertext: new Uint8Array(ciphertext),
    };
  }

  #open(purpose: CipherPurpose, sealed: SealedSecret, authenticatedData: Uint8Array): Uint8Array {
    const { code } = known(purpose);
    const context = contextOf(authenticatedData);
    const held = this.#heldFor(purpose);
    // The envelope is read from a row, so what is in it is not trusted, but an envelope that is not even an object was not read
    // from one.
    const envelope: unknown = sealed;
    if (typeof envelope !== 'object' || envelope === null) {
      throw new TypeError('A sealed value is an envelope.');
    }
    const envelopeVersion: unknown = Reflect.get(envelope, 'envelopeVersion');
    const keyVersion: unknown = Reflect.get(envelope, 'keyVersion');
    const nonce: unknown = Reflect.get(envelope, 'nonce');
    const ciphertext: unknown = Reflect.get(envelope, 'ciphertext');

    // The layout is judged first, because it says how everything after it is to be read. A record with none fails closed.
    if (typeof envelopeVersion !== 'number' || !SUPPORTED_ENVELOPE_VERSIONS.has(envelopeVersion)) {
      throw new CryptoConditionError('ENVELOPE_VERSION_UNSUPPORTED');
    }
    const key = typeof keyVersion === 'number' ? held.keys.get(keyVersion) : undefined;
    if (typeof keyVersion !== 'number' || key === undefined) {
      throw new CryptoConditionError('KEY_VERSION_UNKNOWN');
    }
    if (
      !(nonce instanceof Uint8Array) ||
      nonce.length !== NONCE_BYTES ||
      !(ciphertext instanceof Uint8Array) ||
      ciphertext.length < TAG_BYTES
    ) {
      throw new CryptoConditionError('AUTHENTICATION_FAILED');
    }

    try {
      const split = ciphertext.length - TAG_BYTES;
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
      // The version that is authenticated is the one the envelope names, and it has already been found to be a supported one.
      decipher.setAAD(associatedData(envelopeVersion, code, keyVersion, context));
      decipher.setAuthTag(ciphertext.subarray(split));
      // GCM yields plaintext before it has checked the tag: nothing leaves this function until `final` has succeeded.
      const plaintext = Buffer.concat([
        decipher.update(ciphertext.subarray(0, split)),
        decipher.final(),
      ]);
      return new Uint8Array(plaintext);
    } catch {
      // Why it failed (the key, the context, the nonce, the tag, the bytes) is not told: it is the same answer for all of them.
      throw new CryptoConditionError('AUTHENTICATION_FAILED');
    }
  }
}

/** The purposes to serve: the list given, once each, or all of them when none is given. Anything else is a defect of the caller. */
function servedPurposes(serves: unknown): CipherPurpose[] {
  const all = Object.keys(PURPOSES) as CipherPurpose[];
  if (serves === undefined) return all;
  if (
    !Array.isArray(serves) ||
    serves.length === 0 ||
    serves.some((purpose) => typeof purpose !== 'string' || !Object.hasOwn(PURPOSES, purpose))
  ) {
    throw new TypeError('A cipher serves one or more of the purposes it knows.');
  }
  return [...new Set(serves as CipherPurpose[])];
}

function known(purpose: unknown): { readonly key: KeyPurpose; readonly code: number } {
  if (typeof purpose !== 'string' || !Object.hasOwn(PURPOSES, purpose)) {
    throw new TypeError('A sealed value has a known purpose.');
  }
  return PURPOSES[purpose as CipherPurpose];
}

function contextOf(authenticatedData: unknown): Uint8Array {
  if (!(authenticatedData instanceof Uint8Array) || authenticatedData.length === 0) {
    throw new TypeError('A sealed value is bound to a context, which is bytes and is not empty.');
  }
  return authenticatedData;
}

/** Layout 1: envelope version, purpose code, key version (four big-endian bytes), then the caller's context. */
function associatedData(
  envelopeVersion: number,
  purposeCode: number,
  keyVersion: number,
  context: Uint8Array,
): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt8(envelopeVersion, 0);
  header.writeUInt8(purposeCode, 1);
  header.writeUInt32BE(keyVersion, 2);
  return Buffer.concat([header, context]);
}
