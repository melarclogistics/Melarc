import { argon2Sync } from 'node:crypto';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { keyBytes, localKeys, purposeKeys } from '../../../test-support/key-config.js';
import type { PurposeKeys } from '../../config/key-material.js';
import { Secret } from '../../config/secret.js';
import { CRYPTO_CONDITIONS } from './condition.js';
import { DEVELOPMENT_QUALIFIED_ARGON2ID, type Argon2idParameters } from './argon2-parameters.js';
import { decodeArgon2idHash, encodeArgon2idHash } from './argon2-hash-format.js';
import { Argon2Hasher } from './argon2.hasher.adapter.js';

// A cheap cost keeps the suite quick; the development-qualified cost is exercised once, below, and by the vectors of argon2id.test.ts.
const CHEAP: Argon2idParameters = { memoryKiB: 64, passes: 1, parallelism: 1 };
const COSTLIER: Argon2idParameters = { memoryKiB: 128, passes: 2, parallelism: 1 };
const SECRET = 'a synthetic passphrase for tests';
const KINDS = ['STAFF_PASSWORD', 'VENDOR_SECRET', 'RIDER_PIN'] as const;

const hasherWithPepper = (versions: readonly number[], active?: number, parameters = CHEAP) => {
  const pepper = purposeKeys(versions, active);
  return { pepper, hasher: new Argon2Hasher(localKeys({ password_pepper: pepper }), parameters) };
};

const decoded = (encoded: string) => {
  const hash = decodeArgon2idHash(encoded);
  if (hash === undefined) throw new Error('the hasher wrote a hash its own decoder refuses');
  return hash;
};

/** What a call throws, or undefined. */
function thrownBy(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('Argon2Hasher (S0.3a)', () => {
  describe('hash', () => {
    it('writes an encoded Argon2id hash that carries its parameters and the active pepper version', async () => {
      const { hasher } = hasherWithPepper([1, 2], 2);

      const encoded = await hasher.hash('STAFF_PASSWORD', SECRET);

      expect(encoded).toMatch(
        /^\$argon2id\$v=19\$m=64,t=1,p=1,pv=2\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
      );
    });

    // Break caught: a fixed or derived salt, which would make two people with one passphrase one hash.
    it('uses a new salt every time', async () => {
      const { hasher } = hasherWithPepper([1]);

      const first = decoded(await hasher.hash('STAFF_PASSWORD', SECRET));
      const second = decoded(await hasher.hash('STAFF_PASSWORD', SECRET));

      expect(Buffer.from(first.salt).equals(second.salt)).toBe(false);
      expect(Buffer.from(first.tag).equals(second.tag)).toBe(false);
    });

    // The format is a contract with every hash already stored: this recomputes the tag outside the adapter, from the library and
    // the published inputs, and so pins how the pepper and the credential kind are applied. Changing either would orphan every
    // stored hash, so it should fail loudly here and not at sign-in.
    // Break caught: a pepper hashed into the message instead of the Argon2 secret input, or a kind that is not in the context.
    it.each(KINDS)(
      'applies the pepper as the Argon2 secret input and %s as the associated data',
      async (kind) => {
        const { hasher, pepper } = hasherWithPepper([1, 2], 2);

        const stored = decoded(await hasher.hash(kind, SECRET));
        const recomputed = argon2Sync('argon2id', {
          message: Buffer.from(SECRET, 'utf8'),
          nonce: stored.salt,
          parallelism: 1,
          tagLength: 32,
          memory: 64,
          passes: 1,
          secret: keyBytes(pepper, 2),
          associatedData: Buffer.from(`MELARC-CREDENTIAL-V1:${kind}`, 'ascii'),
        });

        expect(Buffer.from(stored.tag).equals(recomputed)).toBe(true);
        expect(stored.pepperVersion).toBe(2);
      },
    );

    it('hashes the UTF-8 bytes of the text it is given, without normalising it', async () => {
      const { hasher } = hasherWithPepper([1]);
      const composed = 'café au lait';
      const decomposed = 'café au lait';

      const encoded = await hasher.hash('STAFF_PASSWORD', decomposed);

      // The credential rule normalises before the hasher is called (SECURITY_DESIGN.md §13.4a); the hasher must not do it again.
      await expect(hasher.verify('STAFF_PASSWORD', decomposed, encoded)).resolves.toMatchObject({
        matches: true,
      });
      await expect(hasher.verify('STAFF_PASSWORD', composed, encoded)).resolves.toMatchObject({
        matches: false,
      });
    });

    it('hashes an empty text without failing: a short guess is just a wrong credential', async () => {
      const { hasher } = hasherWithPepper([1]);

      const encoded = await hasher.hash('RIDER_PIN', '');

      await expect(hasher.verify('RIDER_PIN', '', encoded)).resolves.toMatchObject({
        matches: true,
      });
      await expect(hasher.verify('RIDER_PIN', ' ', encoded)).resolves.toMatchObject({
        matches: false,
      });
    });

    it('runs at the development-qualified cost', async () => {
      const hasher = new Argon2Hasher(localKeys(), DEVELOPMENT_QUALIFIED_ARGON2ID);

      const encoded = await hasher.hash('STAFF_PASSWORD', SECRET);

      expect(encoded).toContain('$m=65536,t=2,p=1,pv=1$');
      await expect(hasher.verify('STAFF_PASSWORD', SECRET, encoded)).resolves.toEqual({
        matches: true,
        needsRehash: false,
      });
    }, 30_000);
  });

  describe('verify', () => {
    it.each(KINDS)('accepts the right secret and refuses another, for %s', async (kind) => {
      const { hasher } = hasherWithPepper([1]);
      const encoded = await hasher.hash(kind, SECRET);

      await expect(hasher.verify(kind, SECRET, encoded)).resolves.toEqual({
        matches: true,
        needsRehash: false,
      });
      await expect(hasher.verify(kind, `${SECRET}!`, encoded)).resolves.toEqual({
        matches: false,
        needsRehash: false,
      });
    });

    // Break caught: a kind that is not part of the hash, so a vendor's secret hash could be moved into a staff record and the same
    // text would sign in there.
    it('does not accept a hash made for one kind as a hash for another', async () => {
      const { hasher } = hasherWithPepper([1]);
      const encoded = await hasher.hash('VENDOR_SECRET', SECRET);

      for (const other of ['STAFF_PASSWORD', 'RIDER_PIN'] as const) {
        await expect(hasher.verify(other, SECRET, encoded)).resolves.toMatchObject({
          matches: false,
        });
      }
    });

    // Break caught: a pepper that does not take part, so a copy of the database alone would be enough to test guesses.
    it("does not accept a hash made under another deployment's pepper", async () => {
      const ours = hasherWithPepper([1]).hasher;
      const theirs = hasherWithPepper([1]).hasher;
      const encoded = await theirs.hash('STAFF_PASSWORD', SECRET);

      await expect(ours.verify('STAFF_PASSWORD', SECRET, encoded)).resolves.toMatchObject({
        matches: false,
      });
    });

    it('refuses a hash whose salt or tag has been altered', async () => {
      const { hasher } = hasherWithPepper([1]);
      const stored = decoded(await hasher.hash('STAFF_PASSWORD', SECRET));

      const otherSalt = Buffer.from(stored.salt);
      otherSalt.writeUInt8(otherSalt.readUInt8(0) ^ 1, 0);
      const otherTag = Buffer.from(stored.tag);
      otherTag.writeUInt8(otherTag.readUInt8(31) ^ 1, 31);

      for (const altered of [
        { ...stored, salt: otherSalt },
        { ...stored, tag: otherTag },
      ]) {
        await expect(
          hasher.verify('STAFF_PASSWORD', SECRET, encodeArgon2idHash(altered)),
        ).resolves.toMatchObject({ matches: false, needsRehash: false });
      }
    });

    it('verifies a hash at the parameters it was made with, when they are a supported historical profile', async () => {
      const older = hasherWithPepper([1], 1, CHEAP);
      const newer = new Argon2Hasher(localKeys({ password_pepper: older.pepper }), COSTLIER, [
        CHEAP,
      ]);
      const encoded = await older.hasher.hash('STAFF_PASSWORD', SECRET);

      await expect(newer.verify('STAFF_PASSWORD', SECRET, encoded)).resolves.toMatchObject({
        matches: true,
      });
      await expect(newer.verify('STAFF_PASSWORD', 'wrong', encoded)).resolves.toMatchObject({
        matches: false,
      });
    });
  });

  describe('rehash on success', () => {
    it('is not needed for a hash made at the current parameters and pepper version', async () => {
      const { hasher } = hasherWithPepper([1]);

      const verdict = await hasher.verify(
        'STAFF_PASSWORD',
        SECRET,
        await hasher.hash('STAFF_PASSWORD', SECRET),
      );

      expect(verdict).toEqual({ matches: true, needsRehash: false });
    });

    // The rule itself is `rehash-policy.ts`, tested on its own; these show that the Hasher applies it to what it verified.
    it.each([
      ['more memory', { memoryKiB: 128, passes: 1, parallelism: 1 }],
      ['more passes', { memoryKiB: 64, passes: 2, parallelism: 1 }],
    ])('is needed when the current profile has %s and the same lanes', async (_label, current) => {
      const older = hasherWithPepper([1], 1, CHEAP);
      const hasher = new Argon2Hasher(localKeys({ password_pepper: older.pepper }), current, [
        CHEAP,
      ]);
      const encoded = await older.hasher.hash('STAFF_PASSWORD', SECRET);

      await expect(hasher.verify('STAFF_PASSWORD', SECRET, encoded)).resolves.toEqual({
        matches: true,
        needsRehash: true,
      });
    });

    // Break caught: "any difference", which would let an instance on an older configuration replace a stronger hash with its own
    // weaker one. The hash still verifies; it is just not rewritten.
    it.each([
      ['less memory', { memoryKiB: 32, passes: 2, parallelism: 1 }],
      ['fewer passes', { memoryKiB: 128, passes: 1, parallelism: 1 }],
      ['more lanes', { memoryKiB: 256, passes: 2, parallelism: 2 }],
    ])(
      'is not needed when the current profile has %s: a migration only goes forward',
      async (_label, current) => {
        const stored = { memoryKiB: 64, passes: 2, parallelism: 1 };
        const maker = hasherWithPepper([1], 1, stored);
        const hasher = new Argon2Hasher(localKeys({ password_pepper: maker.pepper }), current, [
          stored,
        ]);
        const encoded = await maker.hasher.hash('STAFF_PASSWORD', SECRET);

        await expect(hasher.verify('STAFF_PASSWORD', SECRET, encoded)).resolves.toEqual({
          matches: true,
          needsRehash: false,
        });
      },
    );

    // Both directions of a rolling deployment, with both instances holding both pepper versions: the new one (higher cost, pepper
    // 2) moves what the old one wrote forward, and the old one leaves what the new one wrote alone, so nothing is taken back
    // and forth.
    describe('a rolling deployment, in both directions', () => {
      const OLD_COST: Argon2idParameters = { memoryKiB: 64, passes: 1, parallelism: 1 };
      const NEW_COST: Argon2idParameters = { memoryKiB: 128, passes: 2, parallelism: 1 };
      const both = { ...purposeKeys([1]).versions, ...purposeKeys([2]).versions };
      const instances = () => ({
        oldInstance: new Argon2Hasher(
          localKeys({ password_pepper: { activeVersion: 1, versions: both } }),
          OLD_COST,
          [NEW_COST],
        ),
        newInstance: new Argon2Hasher(
          localKeys({ password_pepper: { activeVersion: 2, versions: both } }),
          NEW_COST,
          [OLD_COST],
        ),
      });

      it('moves a hash the old instance wrote forward when the new instance verifies it', async () => {
        const { oldInstance, newInstance } = instances();
        const written = await oldInstance.hash('STAFF_PASSWORD', SECRET);

        await expect(newInstance.verify('STAFF_PASSWORD', SECRET, written)).resolves.toEqual({
          matches: true,
          needsRehash: true,
        });
      });

      it('leaves a hash the new instance wrote alone when the old instance verifies it', async () => {
        const { oldInstance, newInstance } = instances();
        const written = await newInstance.hash('STAFF_PASSWORD', SECRET);

        await expect(oldInstance.verify('STAFF_PASSWORD', SECRET, written)).resolves.toEqual({
          matches: true,
          needsRehash: false,
        });
      });

      it('settles after one move', async () => {
        const { oldInstance, newInstance } = instances();
        let stored = await oldInstance.hash('STAFF_PASSWORD', SECRET);
        const moves: boolean[] = [];

        for (const verifier of [newInstance, oldInstance, newInstance, oldInstance]) {
          const verdict = await verifier.verify('STAFF_PASSWORD', SECRET, stored);
          moves.push(verdict.needsRehash);
          if (verdict.needsRehash) stored = await verifier.hash('STAFF_PASSWORD', SECRET);
        }

        expect(moves).toEqual([true, false, false, false]);
        expect(decoded(stored).pepperVersion).toBe(2);
        expect(decoded(stored).parameters).toEqual(NEW_COST);
      });
    });

    // Break caught: advising a rehash on a failure, which would let a wrong guess ask for a new hash.
    it('is never advised for a secret that does not match', async () => {
      const older = hasherWithPepper([1], 1, CHEAP);
      const newer = new Argon2Hasher(localKeys({ password_pepper: older.pepper }), COSTLIER, [
        CHEAP,
      ]);
      const encoded = await older.hasher.hash('STAFF_PASSWORD', SECRET);

      await expect(newer.verify('STAFF_PASSWORD', 'wrong', encoded)).resolves.toEqual({
        matches: false,
        needsRehash: false,
      });
    });

    // GBT-V10 (security-test-matrix.md, Family V): the pepper is rotated to a new version; an existing user signs in with an
    // existing password and it succeeds under the recorded pepper_version, and may rehash.
    describe('when the pepper is rotated (GBT-V10)', () => {
      it('signs an existing user in under the version recorded in the hash, and a rehash moves them to the new version', async () => {
        const pepper = purposeKeys([1]);
        const before = new Argon2Hasher(localKeys({ password_pepper: pepper }), CHEAP);
        const stored = await before.hash('STAFF_PASSWORD', SECRET);
        expect(decoded(stored).pepperVersion).toBe(1);

        // The deployment adds version 2 and makes it active; version 1 stays held for the hashes it must still verify.
        const rotated: PurposeKeys = {
          activeVersion: 2,
          versions: { ...pepper.versions, ...purposeKeys([2]).versions },
        };
        const after = new Argon2Hasher(localKeys({ password_pepper: rotated }), CHEAP);

        const verdict = await after.verify('STAFF_PASSWORD', SECRET, stored);
        expect(verdict).toEqual({ matches: true, needsRehash: true });

        const rehashed = await after.hash('STAFF_PASSWORD', SECRET);
        expect(decoded(rehashed).pepperVersion).toBe(2);
        await expect(after.verify('STAFF_PASSWORD', SECRET, rehashed)).resolves.toEqual({
          matches: true,
          needsRehash: false,
        });
      });

      // The failure the design warns about (§14.9): dropping a version that hashes still use must be loud, because turning it
      // into "wrong password" would lock out every user of that version at once with no signal why.
      it('raises PEPPER_UNAVAILABLE, and does not answer "wrong password", when the version a hash was made under is no longer held', async () => {
        const first = hasherWithPepper([1]);
        const stored = await first.hasher.hash('STAFF_PASSWORD', SECRET);
        const withoutVersionOne = hasherWithPepper([2]).hasher;

        await expect(
          withoutVersionOne.verify('STAFF_PASSWORD', SECRET, stored),
        ).rejects.toMatchObject({
          name: 'CryptoConditionError',
          condition: 'PEPPER_UNAVAILABLE',
        });
      });
    });
  });

  // The ceilings of ARGON2ID_LIMITS stay absolute, but they are wide: a stored hash is derived only at a profile that is
  // explicitly supported, the current one or a listed historical one, so the resources a verification can ask for are the ones
  // that were planned for (S0.16 budgets for the largest supported profile).
  describe('the cost profiles it supports', () => {
    const HISTORICAL: Argon2idParameters = { memoryKiB: 96, passes: 3, parallelism: 1 };

    const hashedAt = async (parameters: Argon2idParameters, pepper: PurposeKeys) =>
      new Argon2Hasher(localKeys({ password_pepper: pepper }), parameters).hash(
        'STAFF_PASSWORD',
        SECRET,
      );

    // Break caught: deriving at whatever cost a stored hash declares within the ceilings, and reporting the result as a wrong
    // password.
    it('raises HASH_PROFILE_UNSUPPORTED for a well-formed hash at a profile it does not support, and not "wrong password"', async () => {
      const pepper = purposeKeys([1]);
      const stored = await hashedAt(HISTORICAL, pepper);
      const hasher = new Argon2Hasher(localKeys({ password_pepper: pepper }), CHEAP);

      await expect(hasher.verify('STAFF_PASSWORD', SECRET, stored)).rejects.toMatchObject({
        name: 'CryptoConditionError',
        condition: 'HASH_PROFILE_UNSUPPORTED',
      });
    });

    it('supports the current profile and every historical one it is given', async () => {
      const pepper = purposeKeys([1]);
      const hasher = new Argon2Hasher(localKeys({ password_pepper: pepper }), COSTLIER, [
        CHEAP,
        HISTORICAL,
      ]);

      for (const parameters of [COSTLIER, CHEAP, HISTORICAL]) {
        const stored = await hashedAt(parameters, pepper);
        await expect(hasher.verify('STAFF_PASSWORD', SECRET, stored)).resolves.toMatchObject({
          matches: true,
        });
      }
    });

    it('writes new hashes at the current profile only, whatever else it supports', async () => {
      const hasher = new Argon2Hasher(localKeys(), COSTLIER, [CHEAP, HISTORICAL]);

      expect(decoded(await hasher.hash('STAFF_PASSWORD', SECRET)).parameters).toEqual(COSTLIER);
    });

    it('compares profiles by value, so a hash at the same numbers is supported', async () => {
      const pepper = purposeKeys([1]);
      const stored = await hashedAt({ ...HISTORICAL }, pepper);
      const hasher = new Argon2Hasher(localKeys({ password_pepper: pepper }), CHEAP, [
        { memoryKiB: 96, passes: 3, parallelism: 1 },
      ]);

      await expect(hasher.verify('STAFF_PASSWORD', SECRET, stored)).resolves.toMatchObject({
        matches: true,
      });
    });

    it('is not composed with a historical profile the limits do not allow', () => {
      expect(
        () =>
          new Argon2Hasher(localKeys(), CHEAP, [{ memoryKiB: 65537, passes: 1, parallelism: 1 }]),
      ).toThrow(RangeError);
      expect(
        () => new Argon2Hasher(localKeys(), CHEAP, [{ memoryKiB: 64, passes: 0, parallelism: 1 }]),
      ).toThrow(RangeError);
    });
  });

  describe('verifyAgainstDummy', () => {
    it('does the work of one verification and returns nothing', async () => {
      const { hasher } = hasherWithPepper([1]);

      await expect(hasher.verifyAgainstDummy('STAFF_PASSWORD', SECRET)).resolves.toBeUndefined();
      await expect(hasher.verifyAgainstDummy('RIDER_PIN', '')).resolves.toBeUndefined();
    });
  });

  describe('the pepper it cannot find', () => {
    const NO_PEPPER = [
      ['no key custody at all', () => new Argon2Hasher({ custody: 'describe' }, CHEAP)],
      [
        'a configuration that never held the purpose',
        () => new Argon2Hasher(localKeys({}, ['password_pepper']), CHEAP),
      ],
      [
        'an active version the purpose does not hold',
        () =>
          new Argon2Hasher(
            localKeys({
              password_pepper: { activeVersion: 9, versions: purposeKeys([1]).versions },
            }),
            CHEAP,
          ),
      ],
    ] as const;

    // GBT-V8 (security-test-matrix.md, Family V: "KMS unavailable | Application | Start up | Fails to start. No degraded mode") is
    // written for a KMS, and managed custody is not built (plan OB-36). Its local analogue is that key material that cannot be
    // found stops the adapter from being composed at all: there is no instance that starts and then fails on each call.
    // Break caught: an adapter that constructs on no pepper and fails closed per call, which is a degraded mode.
    it.each(NO_PEPPER)(
      'is not constructed with %s: PEPPER_UNAVAILABLE at start',
      (_label, build) => {
        expect(thrownBy(build)).toMatchObject({
          name: 'CryptoConditionError',
          condition: 'PEPPER_UNAVAILABLE',
        });
      },
    );

    it('needs only the pepper purpose: the other four may be absent', async () => {
      const keys = localKeys({}, [
        'totp_seed',
        'credential_delivery',
        'idempotent_replay',
        'limiter_digest',
      ]);
      const hasher = new Argon2Hasher(keys, CHEAP);

      const encoded = await hasher.hash('STAFF_PASSWORD', SECRET);

      await expect(hasher.verify('STAFF_PASSWORD', SECRET, encoded)).resolves.toMatchObject({
        matches: true,
      });
    });
  });

  describe('a stored hash it did not write', () => {
    // Break caught: reading a hash leniently, or reaching the library with what it declares, so that a tampered row (or a
    // hash of another system) can ask for a terabyte of memory or be taken as a match.
    it.each([
      ['an empty string', ''],
      ['text that is not a hash', 'not a hash'],
      [
        'an argon2i hash',
        '$argon2i$v=19$m=64,t=1,p=1,pv=1$AgICAgICAgICAgICAgICAg$' + 'AwMD'.repeat(10) + 'AwM',
      ],
      [
        'a hash that asks for a terabyte',
        '$argon2id$v=19$m=1073741824,t=1,p=1,pv=1$AgICAgICAgICAgICAgICAg$' +
          'AwMD'.repeat(10) +
          'AwM',
      ],
      [
        'a hash with no pepper version',
        '$argon2id$v=19$m=64,t=1,p=1$AgICAgICAgICAgICAgICAg$' + 'AwMD'.repeat(10) + 'AwM',
      ],
    ])('raises HASH_MALFORMED for %s, without doing any hashing', async (_label, text) => {
      const { hasher } = hasherWithPepper([1]);

      await expect(hasher.verify('STAFF_PASSWORD', SECRET, text)).rejects.toMatchObject({
        name: 'CryptoConditionError',
        condition: 'HASH_MALFORMED',
      });
    });
  });

  describe('input it should never be given (the credential rule has already run)', () => {
    it('refuses text that is not well-formed Unicode instead of encoding it to different bytes', async () => {
      const { hasher } = hasherWithPepper([1]);
      const encoded = await hasher.hash('STAFF_PASSWORD', SECRET);

      for (const text of ['abc\uD800', '\uDC00abc', 'a\uDE00\uD83Db']) {
        await expect(hasher.hash('STAFF_PASSWORD', text)).rejects.toThrow(TypeError);
        await expect(hasher.verify('STAFF_PASSWORD', text, encoded)).rejects.toThrow(TypeError);
        await expect(hasher.verifyAgainstDummy('STAFF_PASSWORD', text)).rejects.toThrow(TypeError);
      }
    });

    // The credential rule lets at most 128 code points through (SECURITY_DESIGN.md §13.4a), so the hasher refuses more, counted in
    // code points and not in bytes. Break caught: a byte cap, which lets 129 to 512 plain characters past a rule that refuses
    // them.
    it('refuses more than the credential rule can allow: more than 128 code points', async () => {
      const { hasher } = hasherWithPepper([1]);
      const longest = '\u{1F600}'.repeat(128);

      expect(Buffer.byteLength(longest, 'utf8')).toBe(512);
      await expect(hasher.hash('STAFF_PASSWORD', longest)).resolves.toContain('$argon2id$');
      await expect(hasher.hash('STAFF_PASSWORD', 'x'.repeat(128))).resolves.toContain('$argon2id$');
      await expect(hasher.hash('STAFF_PASSWORD', `${longest}x`)).rejects.toThrow(RangeError);
      await expect(hasher.hash('STAFF_PASSWORD', 'x'.repeat(129))).rejects.toThrow(RangeError);
      await expect(hasher.hash('STAFF_PASSWORD', '\u{1F600}'.repeat(129))).rejects.toThrow(
        RangeError,
      );
      await expect(hasher.verifyAgainstDummy('STAFF_PASSWORD', 'x'.repeat(200))).rejects.toThrow(
        RangeError,
      );
      await expect(
        hasher.verifyAgainstDummy('STAFF_PASSWORD', 'x'.repeat(100_000)),
      ).rejects.toThrow(RangeError);
    });

    it('refuses a kind that is not one of the three, and a secret that is not text', async () => {
      const { hasher } = hasherWithPepper([1]);

      await expect(hasher.hash('ADMIN_TOKEN' as never, SECRET)).rejects.toThrow(TypeError);
      await expect(hasher.hash('STAFF_PASSWORD', 12345 as never)).rejects.toThrow(TypeError);
      await expect(hasher.hash('STAFF_PASSWORD', undefined as never)).rejects.toThrow(TypeError);
    });
  });

  describe('construction', () => {
    // Break caught: starting with a cost the algorithm or the limits refuse, which would fail at the first sign-in instead of at
    // start.
    it('refuses parameters the limits do not allow', () => {
      expect(
        () => new Argon2Hasher(localKeys(), { memoryKiB: 65537, passes: 1, parallelism: 1 }),
      ).toThrow(RangeError);
      expect(
        () => new Argon2Hasher(localKeys(), { memoryKiB: 64, passes: 0, parallelism: 1 }),
      ).toThrow(RangeError);
    });

    it('refuses key material that is not a canonical 32-byte key, and does not repeat it', () => {
      const keys = localKeys({
        password_pepper: { activeVersion: 1, versions: { 1: new Secret('SENTINEL-not-a-key') } },
      });

      expect(() => new Argon2Hasher(keys, CHEAP)).toThrow(TypeError);
      try {
        new Argon2Hasher(keys, CHEAP);
      } catch (error) {
        expect(String(error)).not.toContain('SENTINEL');
      }
    });
  });

  describe('the conditions it raises are declared ones', () => {
    it('are all among the conditions of the cryptographic adapters', () => {
      for (const name of ['PEPPER_UNAVAILABLE', 'HASH_MALFORMED']) {
        expect(CRYPTO_CONDITIONS).toContain(name);
      }
    });
  });

  // The plan's rule for every task that touches a secret (§3, "Secrets"): a sentinel test.
  describe('sentinel: nothing secret leaves it', () => {
    it('keeps the secret, the pepper and the stored hash out of what it returns, throws, prints and serialises', async () => {
      const sentinel = 'SENTINEL-secret-9f3a1c0b-synthetic-credential';
      const pepper = purposeKeys([1]);
      const pepperText = pepper.versions[1]?.reveal() ?? '';
      const hasher = new Argon2Hasher(localKeys({ password_pepper: pepper }), CHEAP);
      const encoded = await hasher.hash('STAFF_PASSWORD', sentinel);
      const seen: string[] = [
        encoded,
        Object.prototype.toString.call(hasher),
        JSON.stringify(hasher),
        inspect(hasher, { showHidden: true, depth: 8 }),
      ];

      const attempts: (() => Promise<unknown>)[] = [
        () => hasher.verify('STAFF_PASSWORD', sentinel, `garbage-${sentinel}`),
        () => hasher.hash('STAFF_PASSWORD', `${sentinel}\uD800`),
        () => hasher.hash('NOT_A_KIND' as never, sentinel),
        () => hasher.verify('STAFF_PASSWORD', sentinel, encoded.replace('pv=1', 'pv=7')),
        () =>
          new Argon2Hasher(
            localKeys({
              password_pepper: { activeVersion: 1, versions: { 1: new Secret(`${sentinel}-key`) } },
            }),
            CHEAP,
          ).hash('STAFF_PASSWORD', sentinel),
        () => new Argon2Hasher({ custody: 'describe' }, CHEAP).hash('STAFF_PASSWORD', sentinel),
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
        expect(text).not.toContain(pepperText);
      }
      expect(seen.length).toBeGreaterThan(8);
    });
  });
});
