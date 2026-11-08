import { createSecretKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { locateContract } from '../../contract/locate-contract.js';
import {
  DEVICE_SIGNATURE_MAX_BYTES,
  DEVICE_SIGNATURE_MIN_BYTES,
  SIGNED_MESSAGE_PREFIX,
  parseDevicePublicKey,
  parseDeviceSignature,
  signedMessage,
  verifyDeviceSignature,
} from './device-key-protocol.js';

/**
 * The device-key protocol against its published vectors (SECURITY_DESIGN.md section 13.6: "Executable Android and Node vectors ... are
 * published, and the protocol counts as interoperable only when they pass on both sides"). The vectors are made by a program on the JDK the
 * verifier service is pinned to (`apps/api/test/vectors/GenerateDeviceKeyVectors.java`), an implementation independent of this one, and
 * each was checked there against its own intent before it was written. Here they are read back and held to the Node side.
 */
interface KeyVector {
  readonly name: string;
  readonly public_key: string;
  readonly valid: boolean;
  readonly why?: string;
}
interface SignatureVector extends KeyVector {
  readonly challenge: string;
  readonly signature: string;
}
interface Vectors {
  readonly format: string;
  readonly public_keys: KeyVector[];
  readonly signatures: SignatureVector[];
}

const ROOT = join(locateContract(import.meta.dirname), '..', '..');
const VECTORS = JSON.parse(
  readFileSync(join(ROOT, 'apps', 'api', 'test', 'vectors', 'device-key.v1.json'), 'utf8'),
) as Vectors;

const A = VECTORS.public_keys[0]?.public_key ?? '';
const CHALLENGE = Buffer.alloc(32, 7).toString('base64url');

describe('the published vectors', () => {
  // Break caught: an empty or reshaped file read as "all vectors passed".
  it('are the version-1 file with keys and signatures to hold the protocol to', () => {
    expect(VECTORS.format).toBe('melarc.device-key-vectors.v1');
    expect(VECTORS.public_keys.length).toBeGreaterThanOrEqual(15);
    expect(VECTORS.signatures.length).toBeGreaterThanOrEqual(25);
    expect(VECTORS.public_keys.filter((vector) => vector.valid)).toHaveLength(2);
    expect(VECTORS.signatures.filter((vector) => vector.valid).length).toBeGreaterThanOrEqual(3);
    expect(new Set(VECTORS.public_keys.map((vector) => vector.name)).size).toBe(
      VECTORS.public_keys.length,
    );
    expect(new Set(VECTORS.signatures.map((vector) => vector.name)).size).toBe(
      VECTORS.signatures.length,
    );
  });

  // Break caught: a key accepted that the protocol refuses (another curve, trailing data, a compressed or off-curve point, another spelling).
  it.each(VECTORS.public_keys.map((vector) => [vector.name, vector] as const))(
    'agree on the public key: %s',
    (_name, vector) => {
      const parsed = parseDevicePublicKey(vector.public_key);
      expect(parsed.ok, vector.why ?? '').toBe(vector.valid);
      if (parsed.ok) expect(parsed.canonical).toBe(vector.public_key);
    },
  );

  // Break caught: a signature accepted that the protocol refuses (a changed prefix or challenge, a double hash, P1363, a malformed DER
  // encoding, another key), or a valid one refused.
  it.each(VECTORS.signatures.map((vector) => [vector.name, vector] as const))(
    'agree on the signature: %s',
    (_name, vector) => {
      const key = parseDevicePublicKey(vector.public_key);
      if (!key.ok) throw new Error(`the vector's own key is refused: ${key.refusal}`);
      const bytes = parseDeviceSignature(vector.signature);
      const accepted = bytes !== null && verifyDeviceSignature(key.key, vector.challenge, bytes);
      expect(accepted, vector.why ?? '').toBe(vector.valid);
    },
  );
});

describe('the signed message', () => {
  // Break caught: a prefix, a separator or an encoding that drifts from the one the handset signs.
  it('is the prefix, one 0x0A byte and the canonical challenge text, in UTF-8', () => {
    const message = signedMessage(CHALLENGE);
    expect(SIGNED_MESSAGE_PREFIX).toBe('MELARC-RIDER-SIGNIN-V1');
    expect(message.toString('hex')).toBe(
      `${Buffer.from('MELARC-RIDER-SIGNIN-V1').toString('hex')}0a${Buffer.from(CHALLENGE).toString('hex')}`,
    );
    expect(message).toHaveLength(22 + 1 + 43);
  });

  it('refuses a challenge that is not 32 bytes in their one spelling, as a defect', () => {
    for (const challenge of [
      '',
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}B`,
      `${'A'.repeat(42)}=`,
    ]) {
      expect(() => signedMessage(challenge), challenge).toThrow(TypeError);
    }
  });
});

describe('a key and a signature made here', () => {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const registered = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signWith = (challenge: string, prefix = SIGNED_MESSAGE_PREFIX): string =>
    sign(
      'sha256',
      Buffer.concat([Buffer.from(prefix), Buffer.from([0x0a]), Buffer.from(challenge)]),
      { key: pair.privateKey, dsaEncoding: 'der' },
    ).toString('base64');

  // Break caught: the two sides agreeing only on the fixed vectors, so a real handset's keys (random, variable-length signatures) fail.
  it('are accepted, whatever the length of the signature', () => {
    const parsed = parseDevicePublicKey(registered);
    if (!parsed.ok)
      throw new Error(`a P-256 key made by this runtime is refused: ${parsed.refusal}`);
    const lengths = new Set<number>();
    for (let index = 0; index < 60; index += 1) {
      const challenge = Buffer.from(
        Array.from({ length: 32 }, (_, at) => (index * 7 + at * 13) % 256),
      ).toString('base64url');
      const text = signWith(challenge);
      const bytes = parseDeviceSignature(text);
      if (bytes === null) throw new Error('a signature made by this runtime is refused');
      lengths.add(bytes.length);
      expect(verifyDeviceSignature(parsed.key, challenge, bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThanOrEqual(DEVICE_SIGNATURE_MIN_BYTES);
      expect(bytes.length).toBeLessThanOrEqual(DEVICE_SIGNATURE_MAX_BYTES);
    }
    // The point of sixty signatures: DER signatures are not all one length.
    expect(lengths.size).toBeGreaterThan(1);
  });

  it('are refused when the signature is for another challenge or another purpose', () => {
    const parsed = parseDevicePublicKey(registered);
    if (!parsed.ok) throw new Error('the key is refused');
    const challenge = Buffer.alloc(32, 1).toString('base64url');
    const other = Buffer.alloc(32, 2).toString('base64url');
    const bytes = parseDeviceSignature(signWith(challenge));
    const foreign = parseDeviceSignature(signWith(challenge, 'MELARC-RIDER-ENROL-V1'));
    if (bytes === null || foreign === null) throw new Error('a signature is refused');
    expect(verifyDeviceSignature(parsed.key, challenge, bytes)).toBe(true);
    expect(verifyDeviceSignature(parsed.key, other, bytes)).toBe(false);
    expect(verifyDeviceSignature(parsed.key, challenge, foreign)).toBe(false);
  });
});

describe('the bounds on what is read', () => {
  it('reads a signature of 8 to 72 bytes in canonical standard base64 and nothing else', () => {
    expect(parseDeviceSignature(Buffer.alloc(8, 1).toString('base64'))).not.toBeNull();
    expect(parseDeviceSignature(Buffer.alloc(72, 1).toString('base64'))).not.toBeNull();
    expect(parseDeviceSignature(Buffer.alloc(7, 1).toString('base64'))).toBeNull();
    expect(parseDeviceSignature(Buffer.alloc(73, 1).toString('base64'))).toBeNull();
    for (const bad of [
      undefined,
      null,
      12,
      '',
      ' ',
      'AAAA AAAA AAAA',
      '====',
      'AAAAAAAAAAB=',
      'A'.repeat(100),
    ]) {
      expect(parseDeviceSignature(bad), String(bad)).toBeNull();
    }
  });

  // Break caught: the key type left unchecked. A 256-bit curve whose SubjectPublicKeyInfo is also 91 bytes passes the length gate, and only
  // the stack's reading of the key tells it from P-256 (the SM2 curve is one the runtime can make; the published vectors hold the JDK's
  // curves). No other elliptic-curve key has a 91-byte encoding, so the named-curve check beside it is defence in depth that no input reaches.
  it('refuses a key of another 256-bit curve whose encoding is also 91 bytes', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'SM2' }).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    expect(other).toHaveLength(91);
    expect(parseDevicePublicKey(other.toString('base64'))).toEqual({
      ok: false,
      refusal: 'NOT_AN_EC_KEY',
    });
  });

  // Break caught: a stack that cannot verify (a key of a kind it cannot use) read as a signature that did.
  it('treats a verification the stack cannot make as an invalid signature, not a valid one', () => {
    const bytes = parseDeviceSignature(Buffer.alloc(70, 1).toString('base64'));
    if (bytes === null) throw new Error('a signature of 70 bytes is refused');
    expect(
      verifyDeviceSignature(
        createSecretKey(Buffer.alloc(16, 1)),
        Buffer.alloc(32, 3).toString('base64url'),
        bytes,
      ),
    ).toBe(false);
  });

  it('refuses what is not a key by its class, and never the text', () => {
    expect(parseDevicePublicKey(undefined)).toEqual({ ok: false, refusal: 'FORMAT' });
    expect(parseDevicePublicKey(`${A.slice(0, 120)}XXXX`)).toMatchObject({ ok: false });
    const parsed = parseDevicePublicKey(A);
    expect(parsed.ok).toBe(true);
  });
});
