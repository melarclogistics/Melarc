import { beforeEach, describe, expect, it, vi } from 'vitest';

import { keyBytes, localKeys, purposeKeys } from '../../../test-support/key-config.js';
import type { Argon2idParameters } from './argon2-parameters.js';
import { argon2idTag } from './argon2id.js';
import { Argon2Hasher } from './argon2.hasher.adapter.js';

// The same real derivation, counted. What the design asks (SECURITY_DESIGN.md §13.4b, "Timing") is that every step that checks a
// credential does exactly one bounded Argon2id derivation, and that a refused one does none. Counting proves the number of
// derivations and nothing more: it does not prove equal work, because a hash made at an older profile is derived at that profile
// (it must verify at the cost it was made with) while the dummy is derived at the current one. Equal timing is a diagnostic and
// never the proof, and nothing here sleeps or hashes twice to make branches look alike.
vi.mock('./argon2id.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./argon2id.js')>();
  return { ...actual, argon2idTag: vi.fn(actual.argon2idTag) };
});

const CHEAP: Argon2idParameters = { memoryKiB: 64, passes: 1, parallelism: 1 };
const derivations = vi.mocked(argon2idTag);

beforeEach(() => {
  derivations.mockClear();
});

describe('the work Argon2Hasher does per call (S0.3a)', () => {
  it('derives once to hash, once to verify a match, once to verify a mismatch', async () => {
    const hasher = new Argon2Hasher(localKeys(), CHEAP);

    const encoded = await hasher.hash('STAFF_PASSWORD', 'a synthetic passphrase');
    expect(derivations).toHaveBeenCalledTimes(1);

    await hasher.verify('STAFF_PASSWORD', 'a synthetic passphrase', encoded);
    expect(derivations).toHaveBeenCalledTimes(2);

    await hasher.verify('STAFF_PASSWORD', 'another one', encoded);
    expect(derivations).toHaveBeenCalledTimes(3);
  });

  // Break caught: a dummy verification that is skipped or doubled.
  it('derives exactly once for a dummy verification, at the current profile, with the active pepper', async () => {
    const pepper = purposeKeys([1, 2], 2);
    const hasher = new Argon2Hasher(localKeys({ password_pepper: pepper }), CHEAP);

    await hasher.verifyAgainstDummy('VENDOR_SECRET', 'a guess');

    expect(derivations).toHaveBeenCalledTimes(1);
    const [input] = derivations.mock.calls[0] ?? [];
    expect(input?.parameters).toEqual(CHEAP);
    expect(Buffer.from(input?.pepper ?? []).equals(keyBytes(pepper, 2))).toBe(true);
    expect(Buffer.from(input?.message ?? []).toString('utf8')).toBe('a guess');
    expect(Buffer.from(input?.associatedData ?? []).toString('ascii')).toBe(
      'MELARC-CREDENTIAL-V1:VENDOR_SECRET',
    );
  });

  it('derives the same number of times for a real verification, a dummy one and a mismatch', async () => {
    const hasher = new Argon2Hasher(localKeys(), CHEAP);
    const encoded = await hasher.hash('STAFF_PASSWORD', 'a synthetic passphrase');

    const counts: number[] = [];
    for (const branch of [
      () => hasher.verify('STAFF_PASSWORD', 'a synthetic passphrase', encoded),
      () => hasher.verify('STAFF_PASSWORD', 'a wrong passphrase', encoded),
      () => hasher.verifyAgainstDummy('STAFF_PASSWORD', 'a wrong passphrase'),
    ]) {
      derivations.mockClear();
      await branch();
      counts.push(derivations.mock.calls.length);
    }

    expect(counts).toEqual([1, 1, 1]);
  });

  // The limit of that claim, stated as a test so that it is not read as more: during a cost migration a hash is derived at the
  // profile it was made with and the dummy at the current one, so the derivations are one each and not the same amount of work.
  it('derives a hash made at an older profile at that profile, and the dummy at the current one', async () => {
    const pepper = purposeKeys([1]);
    const older: Argon2idParameters = { memoryKiB: 64, passes: 1, parallelism: 1 };
    const current: Argon2idParameters = { memoryKiB: 128, passes: 2, parallelism: 1 };
    const stored = await new Argon2Hasher(localKeys({ password_pepper: pepper }), older).hash(
      'STAFF_PASSWORD',
      'a synthetic passphrase',
    );
    const hasher = new Argon2Hasher(localKeys({ password_pepper: pepper }), current, [older]);
    derivations.mockClear();

    await hasher.verify('STAFF_PASSWORD', 'a synthetic passphrase', stored);
    await hasher.verifyAgainstDummy('STAFF_PASSWORD', 'a synthetic passphrase');

    expect(derivations.mock.calls.map(([input]) => input.parameters)).toEqual([older, current]);
  });

  // Break caught: reading the parameters of a hash and starting the derivation before judging them.
  it('does no derivation at all for a hash it refuses to read, at an unsupported profile, or under a pepper version it does not hold', async () => {
    const pepper = purposeKeys([1]);
    const hasher = new Argon2Hasher(localKeys({ password_pepper: pepper }), CHEAP);
    const encoded = await hasher.hash('STAFF_PASSWORD', 'a synthetic passphrase');
    const unsupported = await new Argon2Hasher(localKeys({ password_pepper: pepper }), {
      memoryKiB: 96,
      passes: 3,
      parallelism: 1,
    }).hash('STAFF_PASSWORD', 'a synthetic passphrase');
    derivations.mockClear();

    await expect(
      hasher.verify('STAFF_PASSWORD', 'a synthetic passphrase', unsupported),
    ).rejects.toMatchObject({ condition: 'HASH_PROFILE_UNSUPPORTED' });

    await expect(hasher.verify('STAFF_PASSWORD', 'x', 'garbage')).rejects.toMatchObject({
      condition: 'HASH_MALFORMED',
    });
    await expect(
      hasher.verify(
        'STAFF_PASSWORD',
        'x',
        '$argon2id$v=19$m=1073741824,t=1,p=1,pv=1$AgICAgICAgICAgICAgICAg$' +
          'AwMD'.repeat(10) +
          'AwM',
      ),
    ).rejects.toMatchObject({ condition: 'HASH_MALFORMED' });
    await expect(
      hasher.verify('STAFF_PASSWORD', 'x', encoded.replace('pv=1', 'pv=7')),
    ).rejects.toMatchObject({ condition: 'PEPPER_UNAVAILABLE' });
    await expect(hasher.hash('STAFF_PASSWORD', 'abc\uD800')).rejects.toThrow(TypeError);
    await expect(hasher.hash('STAFF_PASSWORD', 'x'.repeat(129))).rejects.toThrow(RangeError);

    expect(derivations).not.toHaveBeenCalled();
  });
});
