import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { keyBytes, localKeys, purposeKeys } from '../../../test-support/key-config.js';
import { CryptoConditionError } from './condition.js';
import { LimiterDigest, limiterDigestInput } from './limiter-digest.js';

const BUCKET = 'rate_limit_staff_signin';
const KEY = 'ama@example.test';

describe('the keyed digest of a rate-limit key', () => {
  // Break caught: a digest that is not the HMAC-SHA-256 of the namespaced input under the held key, recomputed here outside the code.
  it('is the HMAC-SHA-256 of the namespaced key under the version’s key', () => {
    const keys = purposeKeys([1]);
    const digest = new LimiterDigest(localKeys({ limiter_digest: keys }));

    const [only] = digest.digestsFor(BUCKET, KEY).all;
    const expected = createHmac('sha256', keyBytes(keys, 1))
      .update(limiterDigestInput(BUCKET, KEY))
      .digest();

    expect(only?.version).toBe(1);
    expect(only?.bytes.equals(expected)).toBe(true);
    expect(only?.bytes).toHaveLength(32);
  });

  // Break caught: the same key in two buckets sharing a digest, so that one bucket’s count would be read as another’s.
  it('is namespaced by bucket, and by nothing that can run into the key', () => {
    const digest = new LimiterDigest(localKeys());
    const of = (bucket: string, key: string) =>
      digest.digestsFor(bucket, key).active.bytes.toString('hex');

    expect(of('rate_limit_staff_signin', KEY)).not.toBe(of('rate_limit_vendor_signin', KEY));
    expect(of('rate_limit_staff_signin', 'a')).not.toBe(of('rate_limit_staff_signin', 'b'));
    // ("ab","c") and ("a","bc") are two inputs: the namespace separator cannot be forged from the key.
    expect(limiterDigestInput('ab', 'c').equals(limiterDigestInput('a', 'bc'))).toBe(false);
  });

  // Break caught: one version’s key being used for another, or the key purposes sharing keys (a purpose’s key derives nothing else’s).
  it('differs by key version and by key', () => {
    const digest = new LimiterDigest(localKeys({ limiter_digest: purposeKeys([1, 2]) }));
    const { all } = digest.digestsFor(BUCKET, KEY);

    expect(all.map((entry) => entry.version)).toEqual([1, 2]);
    expect(all[0]?.bytes.equals(all[1]?.bytes ?? Buffer.alloc(0))).toBe(false);
    expect(
      new LimiterDigest(localKeys())
        .digestsFor(BUCKET, KEY)
        .active.bytes.equals(all[0]?.bytes ?? Buffer.alloc(0)),
    ).toBe(false);
  });

  // Break caught: the overlap of a rotation lost: the old version’s digest not looked up while the new one is active.
  it('gives the digest of every held version, ascending, and names the active one', () => {
    const digest = new LimiterDigest(localKeys({ limiter_digest: purposeKeys([3, 1, 2], 3) }));
    const { active, all } = digest.digestsFor(BUCKET, KEY);

    expect(all.map((entry) => entry.version)).toEqual([1, 2, 3]);
    expect(active.version).toBe(3);
    expect(digest.activeVersion).toBe(3);
    expect(all.find((entry) => entry.version === 3)?.bytes.equals(active.bytes)).toBe(true);
  });

  // Break caught: a limiter composed without its key, which would hash everything under nothing (fail at composition, not per request).
  it('is not composed without a key for its purpose, or with an active version it does not hold', () => {
    const absent = () => new LimiterDigest(localKeys({}, ['limiter_digest']));
    expect(absent).toThrow(CryptoConditionError);
    expect(() => new LimiterDigest({ custody: 'describe' })).toThrow(CryptoConditionError);

    const unheld = { activeVersion: 9, versions: purposeKeys([1]).versions };
    expect(() => new LimiterDigest(localKeys({ limiter_digest: unheld }))).toThrow(
      expect.objectContaining({ condition: 'KEY_VERSION_UNKNOWN' }) as Error,
    );
  });

  // Break caught: the digest echoing or keeping its input, so that an identifier would reach a heap dump or an error.
  it('keeps no copy of the key it was given, and errors name nothing it was given', () => {
    const digest = new LimiterDigest(localKeys());
    const text = JSON.stringify(Object.values(digest));

    expect(text).not.toContain(KEY);
    expect(() => digest.digestsFor('', KEY)).toThrow(TypeError);
    try {
      digest.digestsFor(BUCKET, 7 as never);
    } catch (error) {
      expect((error as Error).message).not.toContain('7');
    }
  });
});
