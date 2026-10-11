import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { keyBytes, localKeys, purposeKeys } from '../../../test-support/key-config.js';
import type { PurposeKeys } from '../../config/key-material.js';
import { Secret } from '../../config/secret.js';
import type { CipherPurpose, SealedSecret } from '../ports/secret-cipher.port.js';
import { AesGcmSecretCipher } from './aes-gcm.secret-cipher.adapter.js';
import { sealedContext } from './sealed-context.js';

const PURPOSES = [
  'TOTP_SEED',
  'DELIVERY_PAYLOAD',
  'REPLAY_SECRET',
] as const satisfies readonly CipherPurpose[];
const KEY_OF = {
  TOTP_SEED: 'totp_seed',
  DELIVERY_PAYLOAD: 'credential_delivery',
  REPLAY_SECRET: 'idempotent_replay',
} as const;
const PURPOSE_CODE = { TOTP_SEED: 1, DELIVERY_PAYLOAD: 2, REPLAY_SECRET: 3 } as const;

const CONTEXT = sealedContext({ principal: 'staff-1', operation: 'mfa.enrol', record: 'factor-1' });
const PLAINTEXT = Buffer.from('twenty bytes of seed', 'ascii');

const cipher = (
  overrides: Parameters<typeof localKeys>[0] = {},
  without: Parameters<typeof localKeys>[1] = [],
) => new AesGcmSecretCipher(localKeys(overrides, without));

/** Seals, flips one bit, and says what the cipher answers. */
async function openAltered(
  subject: AesGcmSecretCipher,
  sealed: SealedSecret,
  change: Partial<SealedSecret>,
  context: Uint8Array = CONTEXT,
): Promise<unknown> {
  try {
    return await subject.open('TOTP_SEED', { ...sealed, ...change }, context);
  } catch (error) {
    return error;
  }
}

const flipped = (bytes: Uint8Array, index: number): Uint8Array => {
  const copy = Buffer.from(bytes);
  copy.writeUInt8(copy.readUInt8(index) ^ 0x01, index);
  return copy;
};

describe('AesGcmSecretCipher (S0.3d)', () => {
  describe('seal and open', () => {
    it.each(PURPOSES)('round-trips a value sealed for %s', async (purpose) => {
      const subject = cipher();

      const sealed = await subject.seal(purpose, PLAINTEXT, CONTEXT);
      const opened = await subject.open(purpose, sealed, CONTEXT);

      expect(Buffer.from(opened).equals(PLAINTEXT)).toBe(true);
    });

    it.each([
      ['nothing', Buffer.alloc(0)],
      ['one byte', Buffer.from([0x00])],
      ['32 zero bytes', Buffer.alloc(32)],
      ['a kilobyte of random bytes', randomBytes(1024)],
      ['UTF-8 text', Buffer.from('café \u{1F600}', 'utf8')],
    ])('round-trips %s', async (_label, value) => {
      const subject = cipher();

      const opened = await subject.open(
        'TOTP_SEED',
        await subject.seal('TOTP_SEED', value, CONTEXT),
        CONTEXT,
      );

      expect(Buffer.from(opened).equals(value)).toBe(true);
    });

    it('makes an envelope of its layout version, the active key version, a 12-byte nonce, and the ciphertext with its 16-byte tag', async () => {
      const subject = cipher({ totp_seed: purposeKeys([1, 2, 3], 2) });

      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      expect(sealed.envelopeVersion).toBe(1);
      expect(sealed.keyVersion).toBe(2);
      expect(sealed.nonce).toHaveLength(12);
      expect(sealed.ciphertext).toHaveLength(PLAINTEXT.length + 16);
    });

    // The envelope format is a contract with every row already stored: this recomputes the ciphertext outside the adapter, from
    // the library and the documented layout, so a change to the layout fails here and not on the first record it cannot open.
    // The associated data is the envelope version (1), the purpose code, the key version as four big-endian bytes, and then the
    // caller's own context. Break caught: a purpose or a version that is not authenticated.
    it.each(PURPOSES)(
      'authenticates the envelope version, the %s purpose, the key version and the context',
      async (purpose) => {
        const keys = purposeKeys([1, 2], 2);
        const subject = new AesGcmSecretCipher(localKeys({ [KEY_OF[purpose]]: keys }));

        const sealed = await subject.seal(purpose, PLAINTEXT, CONTEXT);

        const associated = Buffer.concat([
          Buffer.from([1, PURPOSE_CODE[purpose], 0, 0, 0, 2]),
          CONTEXT,
        ]);
        const independent = createCipheriv('aes-256-gcm', keyBytes(keys, 2), sealed.nonce, {
          authTagLength: 16,
        });
        independent.setAAD(associated);
        const expected = Buffer.concat([
          independent.update(PLAINTEXT),
          independent.final(),
          independent.getAuthTag(),
        ]);
        expect(Buffer.from(sealed.ciphertext).equals(expected)).toBe(true);
      },
    );

    // Break caught: a fixed or counter nonce, which under one key would reveal the XOR of two plaintexts and forge tags.
    it('uses a fresh random nonce every time', async () => {
      const subject = cipher();

      const seals = await Promise.all(
        Array.from({ length: 2000 }, () => subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT)),
      );

      expect(new Set(seals.map((s) => Buffer.from(s.nonce).toString('hex'))).size).toBe(2000);
      expect(new Set(seals.map((s) => Buffer.from(s.ciphertext).toString('hex'))).size).toBe(2000);
    });

    it('does not carry the plaintext, the key or the context in the envelope', async () => {
      const keys = purposeKeys([1]);
      const subject = new AesGcmSecretCipher(localKeys({ totp_seed: keys }));
      const secret = Buffer.from('SENTINEL-plaintext-0123456789', 'ascii');

      const sealed = await subject.seal('TOTP_SEED', secret, CONTEXT);
      const everything = Buffer.concat([sealed.nonce, sealed.ciphertext]);

      expect(everything.includes(secret)).toBe(false);
      expect(everything.includes(Buffer.from(CONTEXT))).toBe(false);
      expect(everything.includes(keyBytes(keys, 1))).toBe(false);
    });

    it('changes none of the buffers it is given, and hands back buffers of its own', async () => {
      const subject = cipher();
      const plaintext = Buffer.from(PLAINTEXT);
      const context = Buffer.from(CONTEXT);

      const sealed = await subject.seal('TOTP_SEED', plaintext, context);
      const opened = await subject.open('TOTP_SEED', sealed, context);
      opened.fill(0);
      const again = await subject.open('TOTP_SEED', sealed, context);

      expect(plaintext.equals(PLAINTEXT)).toBe(true);
      expect(context.equals(CONTEXT)).toBe(true);
      expect(Buffer.from(again).equals(PLAINTEXT)).toBe(true);
      expect(opened.buffer).not.toBe(sealed.ciphertext.buffer);
      expect(opened.byteLength).toBe(opened.buffer.byteLength);
    });
  });

  describe('a value that was changed does not open: AUTHENTICATION_FAILED, and the same message whatever was changed', () => {
    // Break caught: an unauthenticated mode, a tag that is not checked, or a check that stops early.
    it('refuses a single flipped bit anywhere in the ciphertext or its tag', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      const answers = await Promise.all(
        Array.from({ length: sealed.ciphertext.length }, (_, index) =>
          openAltered(subject, sealed, { ciphertext: flipped(sealed.ciphertext, index) }),
        ),
      );

      expect(
        answers.every(
          (a) => a instanceof Error && 'condition' in a && a.condition === 'AUTHENTICATION_FAILED',
        ),
      ).toBe(true);
      expect(new Set(answers.map((a) => (a as Error).message)).size).toBe(1);
    });

    it('refuses a single flipped bit of the nonce', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      for (let index = 0; index < 12; index += 1) {
        const answer = await openAltered(subject, sealed, { nonce: flipped(sealed.nonce, index) });
        expect(answer).toMatchObject({ condition: 'AUTHENTICATION_FAILED' });
      }
    });

    it.each([
      [
        'a ciphertext with a byte appended',
        (s: SealedSecret) => ({ ciphertext: Buffer.concat([s.ciphertext, Buffer.from([0])]) }),
      ],
      [
        'a ciphertext with its last byte removed',
        (s: SealedSecret) => ({ ciphertext: s.ciphertext.subarray(0, s.ciphertext.length - 1) }),
      ],
      ['a ciphertext shorter than a tag', () => ({ ciphertext: Buffer.alloc(15) })],
      ['an empty ciphertext', () => ({ ciphertext: Buffer.alloc(0) })],
      ['a nonce of 11 bytes', (s: SealedSecret) => ({ nonce: s.nonce.subarray(0, 11) })],
      [
        'a nonce of 13 bytes',
        (s: SealedSecret) => ({ nonce: Buffer.concat([s.nonce, Buffer.from([0])]) }),
      ],
      ['an empty nonce', () => ({ nonce: Buffer.alloc(0) })],
      ['a nonce that is text', () => ({ nonce: 'abcdefghijkl' as unknown as Uint8Array })],
      [
        'a ciphertext that is text',
        () => ({ ciphertext: 'abcdefghijklmnopqrstuvwxyz' as unknown as Uint8Array }),
      ],
    ])('refuses %s', async (_label, change) => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      const answer = await openAltered(subject, sealed, change(sealed));

      expect(answer).toMatchObject({
        name: 'CryptoConditionError',
        condition: 'AUTHENTICATION_FAILED',
      });
    });

    it('does not say why: the message is fixed and holds nothing that was supplied', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', Buffer.from('SENTINEL-seed'), CONTEXT);

      const answer = await openAltered(subject, sealed, {
        ciphertext: flipped(sealed.ciphertext, 0),
      });

      expect(String(answer)).not.toContain('SENTINEL');
      expect((answer as Error).message).toBe('The sealed value did not authenticate.');
    });
  });

  describe('the context: a sealed value moved to another row does not open', () => {
    it('opens only with the context it was sealed with', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      for (const other of [
        sealedContext({ principal: 'staff-2', operation: 'mfa.enrol', record: 'factor-1' }),
        sealedContext({ principal: 'staff-1', operation: 'mfa.reset', record: 'factor-1' }),
        sealedContext({ principal: 'staff-1', operation: 'mfa.enrol', record: 'factor-2' }),
        flipped(CONTEXT, 0),
        flipped(CONTEXT, CONTEXT.length - 1),
        Buffer.concat([CONTEXT, Buffer.from([0])]),
        CONTEXT.subarray(1),
      ]) {
        await expect(subject.open('TOTP_SEED', sealed, other)).rejects.toMatchObject({
          condition: 'AUTHENTICATION_FAILED',
        });
      }
      await expect(subject.open('TOTP_SEED', sealed, Buffer.from(CONTEXT))).resolves.toBeDefined();
    });

    // The envelope binds a context, so a call that gives none is a fault, not a value sealed for nothing.
    it('refuses to seal or open with no context at all', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(subject.seal('TOTP_SEED', PLAINTEXT, new Uint8Array(0))).rejects.toThrow(
        TypeError,
      );
      await expect(subject.open('TOTP_SEED', sealed, new Uint8Array(0))).rejects.toThrow(TypeError);
    });
  });

  describe("purpose separation: no purpose's key decrypts another's (SECURITY_DESIGN.md §14.9)", () => {
    it.each([
      ['TOTP_SEED', 'DELIVERY_PAYLOAD'],
      ['TOTP_SEED', 'REPLAY_SECRET'],
      ['DELIVERY_PAYLOAD', 'TOTP_SEED'],
      ['DELIVERY_PAYLOAD', 'REPLAY_SECRET'],
      ['REPLAY_SECRET', 'TOTP_SEED'],
      ['REPLAY_SECRET', 'DELIVERY_PAYLOAD'],
    ] as const)('a value sealed for %s does not open as %s', async (sealedFor, openedAs) => {
      const subject = cipher();
      const sealed = await subject.seal(sealedFor, PLAINTEXT, CONTEXT);

      await expect(subject.open(openedAs, sealed, CONTEXT)).rejects.toMatchObject({
        condition: 'AUTHENTICATION_FAILED',
      });
    });

    it('uses a key of its own for each purpose', async () => {
      const keys = {
        totp_seed: purposeKeys([1]),
        credential_delivery: purposeKeys([1]),
        idempotent_replay: purposeKeys([1]),
      };
      const subject = new AesGcmSecretCipher(localKeys(keys));

      for (const purpose of PURPOSES) {
        const sealed = await subject.seal(purpose, PLAINTEXT, CONTEXT);
        const associated = Buffer.concat([
          Buffer.from([1, PURPOSE_CODE[purpose], 0, 0, 0, 1]),
          CONTEXT,
        ]);
        // Opened outside the cipher with the key of its own purpose it opens, and with another purpose's key it does not.
        const own = openWith(keyBytes(keys[KEY_OF[purpose]], 1), sealed, associated);
        expect(own?.equals(PLAINTEXT)).toBe(true);
        for (const other of PURPOSES.filter((p) => p !== purpose)) {
          expect(openWith(keyBytes(keys[KEY_OF[other]], 1), sealed, associated)).toBeUndefined();
        }
      }
    });

    // Break caught: a purpose that is only a different key, so a configuration that reused one key (which loadConfig refuses,
    // but a hand-built one can do) would let one purpose's records open as another's.
    it('keeps the purposes apart even when two of them are given the very same key', async () => {
      const shared = purposeKeys([1]);
      const subject = new AesGcmSecretCipher(
        localKeys({ totp_seed: shared, credential_delivery: shared, idempotent_replay: shared }),
      );
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(subject.open('DELIVERY_PAYLOAD', sealed, CONTEXT)).rejects.toMatchObject({
        condition: 'AUTHENTICATION_FAILED',
      });
      await expect(subject.open('REPLAY_SECRET', sealed, CONTEXT)).rejects.toMatchObject({
        condition: 'AUTHENTICATION_FAILED',
      });
      await expect(subject.open('TOTP_SEED', sealed, CONTEXT)).resolves.toBeDefined();
    });
  });

  // The envelope records which layout it has, so that a future reader selects the layout from what is stored and never by trial
  // (SECURITY_DESIGN.md §14.9: "an encrypted envelope is versioned"). Only layout 1 exists; anything else fails closed, and the
  // version that is authenticated is the one the envelope names.
  describe('the envelope version', () => {
    it('is recorded with the envelope: layout 1', async () => {
      const sealed = await cipher().seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      expect(sealed.envelopeVersion).toBe(1);
    });

    // Break caught: an envelope read without checking its layout, so a record written by a later layout would be run through
    // this one and fail as a tamper, or worse, authenticate under the wrong rules.
    it.each([
      ['zero', 0],
      ['a later layout', 2],
      ['a negative number', -1],
      ['a fraction', 1.5],
      ['not a number', Number.NaN],
      ['infinity', Number.POSITIVE_INFINITY],
      ['text', '1' as unknown as number],
      ['null', null as unknown as number],
      ['absent', undefined as unknown as number],
    ])(
      'fails closed with ENVELOPE_VERSION_UNSUPPORTED for %s as the envelope version',
      async (_label, envelopeVersion) => {
        const subject = cipher();
        const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

        await expect(
          subject.open('TOTP_SEED', { ...sealed, envelopeVersion }, CONTEXT),
        ).rejects.toMatchObject({
          name: 'CryptoConditionError',
          condition: 'ENVELOPE_VERSION_UNSUPPORTED',
        });
      },
    );

    it('refuses an envelope stored before the version was recorded, which has no such field', async () => {
      const subject = cipher();
      const { keyVersion, nonce, ciphertext } = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(
        subject.open(
          'TOTP_SEED',
          { keyVersion, nonce, ciphertext } as unknown as SealedSecret,
          CONTEXT,
        ),
      ).rejects.toMatchObject({ condition: 'ENVELOPE_VERSION_UNSUPPORTED' });
    });

    it('judges the layout before the key version, and before any decryption', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(
        subject.open('TOTP_SEED', { ...sealed, envelopeVersion: 2, keyVersion: 99 }, CONTEXT),
      ).rejects.toMatchObject({ condition: 'ENVELOPE_VERSION_UNSUPPORTED' });
    });

    it('is not what a tamper is reported as: a supported layout with a changed ciphertext is still AUTHENTICATION_FAILED', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(
        subject.open(
          'TOTP_SEED',
          { ...sealed, ciphertext: flipped(sealed.ciphertext, 0) },
          CONTEXT,
        ),
      ).rejects.toMatchObject({ condition: 'AUTHENTICATION_FAILED' });
    });
  });

  describe('key versions and rotation (SECURITY_DESIGN.md §14.9, §15.5)', () => {
    // The rotation proof the plan asks for: old version decrypts, new version encrypts.
    it('opens what an older version sealed, and seals new values under the active one', async () => {
      const keys = purposeKeys([1]);
      const before = new AesGcmSecretCipher(localKeys({ totp_seed: keys }));
      const old = await before.seal('TOTP_SEED', PLAINTEXT, CONTEXT);
      expect(old.keyVersion).toBe(1);

      // The deployment adds version 2 and makes it active; version 1 stays held for the records it must still open.
      const rotated: PurposeKeys = {
        activeVersion: 2,
        versions: { ...keys.versions, ...purposeKeys([2]).versions },
      };
      const after = new AesGcmSecretCipher(localKeys({ totp_seed: rotated }));

      const openedOld = await after.open('TOTP_SEED', old, CONTEXT);
      expect(Buffer.from(openedOld).equals(PLAINTEXT)).toBe(true);

      const fresh = await after.seal('TOTP_SEED', PLAINTEXT, CONTEXT);
      expect(fresh.keyVersion).toBe(2);
      expect(Buffer.from(await after.open('TOTP_SEED', fresh, CONTEXT)).equals(PLAINTEXT)).toBe(
        true,
      );
    });

    it('re-seals lazily: open under the old version, seal under the new, and the old envelope is no longer needed', async () => {
      const keys = purposeKeys([1]);
      const before = new AesGcmSecretCipher(localKeys({ totp_seed: keys }));
      const old = await before.seal('TOTP_SEED', PLAINTEXT, CONTEXT);
      const rotated: PurposeKeys = {
        activeVersion: 2,
        versions: { ...keys.versions, ...purposeKeys([2]).versions },
      };
      const after = new AesGcmSecretCipher(localKeys({ totp_seed: rotated }));
      const onlyNew = new AesGcmSecretCipher(
        localKeys({ totp_seed: { activeVersion: 2, versions: purposeKeysOf(rotated, 2) } }),
      );

      const reSealed = await after.seal(
        'TOTP_SEED',
        await after.open('TOTP_SEED', old, CONTEXT),
        CONTEXT,
      );

      expect(reSealed.keyVersion).toBe(2);
      // Once every record is re-sealed, version 1 can be dropped from the configuration.
      expect(
        Buffer.from(await onlyNew.open('TOTP_SEED', reSealed, CONTEXT)).equals(PLAINTEXT),
      ).toBe(true);
    });

    // A version that is no longer held says so, in its own condition, and not as a failed authentication: the two have different
    // causes and different fixes (restore a key, or find the tampering).
    it('raises KEY_VERSION_UNKNOWN for a version that is not held', async () => {
      const first = new AesGcmSecretCipher(localKeys({ totp_seed: purposeKeys([1]) }));
      const sealed = await first.seal('TOTP_SEED', PLAINTEXT, CONTEXT);
      const withoutVersionOne = cipher({ totp_seed: purposeKeys([2]) });

      await expect(withoutVersionOne.open('TOTP_SEED', sealed, CONTEXT)).rejects.toMatchObject({
        name: 'CryptoConditionError',
        condition: 'KEY_VERSION_UNKNOWN',
      });
    });

    it('raises KEY_VERSION_UNKNOWN when a node that has not been given the new key meets a new envelope', async () => {
      const keys = purposeKeys([1]);
      const rotated: PurposeKeys = {
        activeVersion: 2,
        versions: { ...keys.versions, ...purposeKeys([2]).versions },
      };
      const sealedByNew = await new AesGcmSecretCipher(localKeys({ totp_seed: rotated })).seal(
        'TOTP_SEED',
        PLAINTEXT,
        CONTEXT,
      );
      const lagging = new AesGcmSecretCipher(localKeys({ totp_seed: keys }));

      await expect(lagging.open('TOTP_SEED', sealedByNew, CONTEXT)).rejects.toMatchObject({
        condition: 'KEY_VERSION_UNKNOWN',
      });
    });

    it.each([
      ['zero', 0],
      ['a negative version', -1],
      ['a fraction', 1.5],
      ['not a number', Number.NaN],
      ['infinity', Number.POSITIVE_INFINITY],
      ['a version past the safe integers', 2 ** 53],
      ['text', '1' as unknown as number],
      ['nothing', undefined as unknown as number],
    ])('raises KEY_VERSION_UNKNOWN for %s as the version', async (_label, keyVersion) => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(
        subject.open('TOTP_SEED', { ...sealed, keyVersion }, CONTEXT),
      ).rejects.toMatchObject({
        condition: 'KEY_VERSION_UNKNOWN',
      });
    });

    // Break caught: a version label that is not authenticated, so an envelope could be re-labelled to be tried under another key.
    it('does not open an envelope that has been re-labelled with another held version', async () => {
      const subject = cipher({ totp_seed: purposeKeys([1, 2], 1) });
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);
      expect(sealed.keyVersion).toBe(1);

      await expect(
        subject.open('TOTP_SEED', { ...sealed, keyVersion: 2 }, CONTEXT),
      ).rejects.toMatchObject({
        condition: 'AUTHENTICATION_FAILED',
      });
    });
  });

  // GBT-V8 and GBT-V9 (security-test-matrix.md, Family V) are written for a KMS. Managed key custody is not built (plan OB-36, a
  // prerequisite of release gate G3), so what this adapter can show of them is their local analogue. V8, "KMS unavailable |
  // Application | Start up | Fails to start. No degraded mode": key material that is not there stops the cipher from being
  // composed at all, whichever of its purposes is missing. V9, "KMS unavailable at runtime | Fails closed": a value that cannot be
  // opened never yields plaintext and never falls back (the tests of key versions and of tampering above); with local custody
  // the keys are in process memory, so there is no runtime unavailability to show beyond those.
  describe('key material it cannot find: no degraded mode (the local analogue of GBT-V8 and GBT-V9)', () => {
    const ABSENT = [
      ['no key custody at all', () => new AesGcmSecretCipher({ custody: 'describe' })],
      ['no key for the TOTP seed purpose', () => cipher({}, ['totp_seed'])],
      ['no key for the delivery purpose', () => cipher({}, ['credential_delivery'])],
      ['no key for the replay purpose', () => cipher({}, ['idempotent_replay'])],
      [
        'an active version the purpose does not hold',
        () => cipher({ totp_seed: { activeVersion: 9, versions: purposeKeys([1]).versions } }),
      ],
    ] as const;

    // Break caught: a cipher that constructs and then fails per call, or that serves the purposes it has keys for and fails the
    // rest: both start degraded.
    it.each(ABSENT)('is not constructed with %s: PURPOSE_KEY_ABSENT at start', (_label, build) => {
      expect(thrownBy(build)).toMatchObject({
        name: 'CryptoConditionError',
        condition: 'PURPOSE_KEY_ABSENT',
      });
    });

    it('needs only its own three purposes: the pepper and the limiter key may be absent', async () => {
      const subject = cipher({}, ['password_pepper', 'limiter_digest']);

      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      expect(Buffer.from(await subject.open('TOTP_SEED', sealed, CONTEXT)).equals(PLAINTEXT)).toBe(
        true,
      );
    });

    // GBT-V8's local analogue at start: a cipher is not composed on key material that is not a canonical 32-byte key.
    it('is not constructed on key material that is not a canonical key, and does not repeat it', () => {
      const keys = localKeys({
        totp_seed: { activeVersion: 1, versions: { 1: new Secret('SENTINEL-not-a-key') } },
      });

      expect(() => new AesGcmSecretCipher(keys)).toThrow(TypeError);
      expect(thrownText(() => new AesGcmSecretCipher(keys))).not.toContain('SENTINEL');
    });
  });

  describe('input it should never be given', () => {
    it.each([
      'constructor',
      '__proto__',
      'toString',
      'totp_seed',
      'TOTP',
      '',
      'LIMITER_DIGEST',
      'PASSWORD_PEPPER',
    ])('refuses the purpose "%s"', async (purpose) => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(subject.seal(purpose as CipherPurpose, PLAINTEXT, CONTEXT)).rejects.toThrow(
        TypeError,
      );
      await expect(subject.open(purpose as CipherPurpose, sealed, CONTEXT)).rejects.toThrow(
        TypeError,
      );
    });

    it('refuses a plaintext, a context or an envelope of the wrong type', async () => {
      const subject = cipher();
      const sealed = await subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT);

      await expect(
        subject.seal('TOTP_SEED', 'text' as unknown as Uint8Array, CONTEXT),
      ).rejects.toThrow(TypeError);
      await expect(
        subject.seal('TOTP_SEED', PLAINTEXT, 'text' as unknown as Uint8Array),
      ).rejects.toThrow(TypeError);
      await expect(
        subject.open('TOTP_SEED', sealed, 'text' as unknown as Uint8Array),
      ).rejects.toThrow(TypeError);
      await expect(
        subject.open('TOTP_SEED', null as unknown as SealedSecret, CONTEXT),
      ).rejects.toThrow(TypeError);
      await expect(
        subject.open('TOTP_SEED', 'sealed' as unknown as SealedSecret, CONTEXT),
      ).rejects.toThrow(TypeError);
    });

    it('answers with a rejected promise, never by throwing before it returns one', async () => {
      const subject = cipher();

      const pending = [
        subject.seal('NOPE' as CipherPurpose, PLAINTEXT, CONTEXT),
        subject.open('TOTP_SEED', null as unknown as SealedSecret, CONTEXT),
      ];

      await Promise.allSettled(pending);
      expect(pending.every((p) => p instanceof Promise)).toBe(true);
    });
  });

  // S0.18: the delivery worker is given one key purpose and no other (SECURITY_DESIGN.md section 14.9: each purpose has its own access
  // policy). A cipher is told which purposes it serves; it holds those keys and no others, and says so for the rest.
  describe('a cipher told to serve some of its purposes (the delivery worker holds one key)', () => {
    const OTHERS = ['totp_seed', 'idempotent_replay', 'limiter_digest', 'password_pepper'] as const;
    const workerCipher = () =>
      new AesGcmSecretCipher(localKeys({}, OTHERS), { serves: ['DELIVERY_PAYLOAD'] });

    // Break caught: a cipher told to serve one purpose that still insists on the keys of the others, or cannot seal and open its own.
    it('is composed with the one key it serves, and round-trips that purpose', async () => {
      const subject = workerCipher();

      const sealed = await subject.seal('DELIVERY_PAYLOAD', PLAINTEXT, CONTEXT);

      expect(
        Buffer.from(await subject.open('DELIVERY_PAYLOAD', sealed, CONTEXT)).equals(PLAINTEXT),
      ).toBe(true);
    });

    // Break caught: a purpose it does not serve being sealed or opened, whatever it holds; the answer is the one the port gives for a
    // purpose with no key, because that is what the cipher holds for it.
    it.each(['TOTP_SEED', 'REPLAY_SECRET'] as const)(
      'refuses to seal or open %s, which it does not serve',
      async (purpose) => {
        const subject = workerCipher();
        const sealed = await subject.seal('DELIVERY_PAYLOAD', PLAINTEXT, CONTEXT);

        await expect(subject.seal(purpose, PLAINTEXT, CONTEXT)).rejects.toMatchObject({
          condition: 'PURPOSE_KEY_ABSENT',
        });
        await expect(subject.open(purpose, sealed, CONTEXT)).rejects.toMatchObject({
          condition: 'PURPOSE_KEY_ABSENT',
        });
      },
    );

    // Break caught: the keys of the purposes it does not serve being decoded and kept because the configuration happens to carry them.
    it('does not use the key of a purpose it does not serve, though the configuration carries it', async () => {
      const subject = new AesGcmSecretCipher(localKeys(), { serves: ['DELIVERY_PAYLOAD'] });

      await expect(subject.seal('TOTP_SEED', PLAINTEXT, CONTEXT)).rejects.toMatchObject({
        condition: 'PURPOSE_KEY_ABSENT',
      });
    });

    // Break caught: a cipher composed without the key of the purpose it was told to serve, which would fail on every call.
    it('is not composed when the key of a purpose it serves is not held', () => {
      expect(
        thrownBy(
          () =>
            new AesGcmSecretCipher(localKeys({}, ['credential_delivery']), {
              serves: ['DELIVERY_PAYLOAD'],
            }),
        ),
      ).toMatchObject({ name: 'CryptoConditionError', condition: 'PURPOSE_KEY_ABSENT' });
    });

    // Break caught: a list that serves nothing (a cipher that is composed and can do nothing), that names a purpose that does not
    // exist, or that is not a list.
    it.each([
      ['nothing', []],
      ['a purpose that does not exist', ['NOPE']],
      ['one that does and one that does not', ['DELIVERY_PAYLOAD', 'NOPE']],
      ['a name from the prototype', ['constructor']],
      ['text instead of a list', 'DELIVERY_PAYLOAD'],
    ])('refuses to serve %s', (_label, serves) => {
      expect(
        () =>
          new AesGcmSecretCipher(localKeys(), {
            serves: serves as unknown as readonly CipherPurpose[],
          }),
      ).toThrow(TypeError);
    });

    it('serves a purpose once however often it is named', async () => {
      const subject = new AesGcmSecretCipher(localKeys({}, OTHERS), {
        serves: ['DELIVERY_PAYLOAD', 'DELIVERY_PAYLOAD'],
      });

      const sealed = await subject.seal('DELIVERY_PAYLOAD', PLAINTEXT, CONTEXT);

      expect(
        Buffer.from(await subject.open('DELIVERY_PAYLOAD', sealed, CONTEXT)).equals(PLAINTEXT),
      ).toBe(true);
    });

    // Break caught: a value sealed by the worker's cipher and a full cipher not being the same thing: both are the delivery purpose
    // under the one key, and the API opens what the worker's cipher sealed (and the worker what the API sealed).
    it('opens what a cipher serving every purpose sealed, and the other way round', async () => {
      const keys = localKeys();
      const full = new AesGcmSecretCipher(keys);
      const narrow = new AesGcmSecretCipher(keys, { serves: ['DELIVERY_PAYLOAD'] });

      const fromFull = await full.seal('DELIVERY_PAYLOAD', PLAINTEXT, CONTEXT);
      const fromNarrow = await narrow.seal('DELIVERY_PAYLOAD', PLAINTEXT, CONTEXT);

      expect(
        Buffer.from(await narrow.open('DELIVERY_PAYLOAD', fromFull, CONTEXT)).equals(PLAINTEXT),
      ).toBe(true);
      expect(
        Buffer.from(await full.open('DELIVERY_PAYLOAD', fromNarrow, CONTEXT)).equals(PLAINTEXT),
      ).toBe(true);
    });
  });

  // The plan's rule for every task that touches a secret (§3, "Secrets"): a sentinel test.
  describe('sentinel: nothing secret leaves it', () => {
    it('keeps the plaintext, the context and every key out of what it throws, prints and serialises', async () => {
      const keys = localKeys();
      const keyTexts = Object.values(keys.purposes).flatMap((p) =>
        Object.values(p.versions).map((s) => s.reveal()),
      );
      const subject = new AesGcmSecretCipher(keys);
      const plaintext = Buffer.from('SENTINEL-plaintext-seed', 'ascii');
      const context = sealedContext({
        principal: 'SENTINEL-principal',
        operation: 'SENTINEL-op',
        record: 'SENTINEL-rec',
      });
      const sealed = await subject.seal('TOTP_SEED', plaintext, context);
      const seen: string[] = [
        Object.prototype.toString.call(subject),
        JSON.stringify(subject),
        inspect(subject, { showHidden: true, depth: 8 }),
      ];

      const attempts: (() => Promise<unknown>)[] = [
        () =>
          subject.open(
            'TOTP_SEED',
            { ...sealed, ciphertext: flipped(sealed.ciphertext, 0) },
            context,
          ),
        () => subject.open('DELIVERY_PAYLOAD', sealed, context),
        () => subject.open('TOTP_SEED', { ...sealed, keyVersion: 99 }, context),
        () =>
          subject.open(
            'TOTP_SEED',
            sealed,
            sealedContext({ principal: 'SENTINEL-other', operation: 'o', record: 'r' }),
          ),
        () => subject.seal('NOT_A_PURPOSE' as CipherPurpose, plaintext, context),
        () => new AesGcmSecretCipher({ custody: 'describe' }).seal('TOTP_SEED', plaintext, context),
        () =>
          new AesGcmSecretCipher(
            localKeys({
              totp_seed: { activeVersion: 1, versions: { 1: new Secret('SENTINEL-not-a-key') } },
            }),
          ).seal('TOTP_SEED', plaintext, context),
      ];
      for (const attempt of attempts) {
        try {
          await attempt();
        } catch (error) {
          seen.push(
            String(error),
            error instanceof Error ? (error.stack ?? '') : '',
            JSON.stringify(error),
          );
        }
      }

      for (const text of seen) {
        expect(text).not.toContain('SENTINEL');
        for (const keyText of keyTexts) expect(text).not.toContain(keyText);
      }
      expect(seen.length).toBeGreaterThan(15);
    });
  });
});

/** Opens a value outside the cipher, with a key and the associated data given, or undefined when it does not authenticate. */
function openWith(
  key: Uint8Array,
  sealed: SealedSecret,
  associated: Uint8Array,
): Buffer | undefined {
  const split = sealed.ciphertext.length - 16;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, { authTagLength: 16 });
    decipher.setAAD(associated);
    decipher.setAuthTag(sealed.ciphertext.subarray(split));
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, split)), decipher.final()]);
  } catch {
    return undefined;
  }
}

function purposeKeysOf(keys: PurposeKeys, version: number): Record<number, Secret> {
  const secret = keys.versions[version];
  if (secret === undefined) throw new Error('the test configuration holds no such version');
  return { [version]: secret };
}

/** What a call throws, or undefined. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

function thrownText(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return `${String(error)}${error instanceof Error ? (error.stack ?? '') : ''}`;
  }
  return '';
}
