import { createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from '../ports/clock.port.js';
import type { TotpVerdict } from '../ports/totp-verifier.port.js';
import { Rfc6238TotpVerifier } from './rfc6238.totp-verifier.adapter.js';

// The comparison is counted, as for the token service: the real function, wrapped.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const comparisons = vi.mocked(timingSafeEqual);

/** A clock that reads this many milliseconds after the Unix epoch. */
const clockAt = (milliseconds: number): Clock => ({
  now: () => new Date(milliseconds),
  monotonicMilliseconds: () => {
    throw new Error('TOTP reads the wall clock and never the monotonic one');
  },
});
const atSeconds = (seconds: number): Rfc6238TotpVerifier =>
  new Rfc6238TotpVerifier(clockAt(seconds * 1000));

// RFC 4226 Appendix D and RFC 6238 Appendix B use this key. It is 20 bytes, the length of every seed this service makes.
const SEED = Buffer.from('12345678901234567890', 'ascii');
// The six-digit codes of steps 0 to 9 for that key: RFC 4226 Appendix D, because a step is the HOTP counter when T0 is 0.
const STEP_CODES = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
  '399871',
  '520489',
];
const codeOf = (step: number): string => STEP_CODES[step] ?? 'out-of-table';

/**
 * The six-digit code of a step, worked out with the library's HMAC and RFC 4226 section 5.3 written out again here, so that a
 * fixture or a new seed can be checked without trusting the code under test.
 */
function independentCode(seed: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', seed).update(counter).digest();
  const truncated = mac.readUInt32BE(mac.readUInt8(19) & 0x0f) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, '0');
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

beforeEach(() => {
  comparisons.mockClear();
});

describe('Rfc6238TotpVerifier (S0.3c): six digits, 30-second steps, SHA-1, one step either side', () => {
  describe('the published vectors', () => {
    // RFC 6238 Appendix B, SHA-1 rows. The RFC lists eight-digit values; the contract's code is six digits, which is the same
    // truncation modulo 10^6 and so the last six digits of the RFC's.
    it.each([
      [59, 1, '94287082'],
      [1111111109, 37037036, '07081804'],
      [1111111111, 37037037, '14050471'],
      [1234567890, 41152263, '89005924'],
      [2000000000, 66666666, '69279037'],
      [20000000000, 666666666, '65353130'],
    ])('at %i seconds (step %i) accepts the code ending %s', (seconds, step, eight) => {
      const verdict = atSeconds(seconds).verify(SEED, eight.slice(2), null);

      expect(verdict).toEqual({ outcome: 'ACCEPTED', step });
    });

    it('keeps the leading zero: 081804 is a code and 81804 is not', () => {
      const verifier = atSeconds(1111111109);

      expect(verifier.verify(SEED, '081804', null)).toEqual({
        outcome: 'ACCEPTED',
        step: 37037036,
      });
      expect(verifier.verify(SEED, '81804', null)).toEqual({ outcome: 'REJECTED' });
    });
  });

  describe('the window of one step either side of the current one', () => {
    // Step 5 is 150 to 179 seconds. The codes of steps 3 and 7 are outside the window; 4, 5 and 6 are inside.
    it.each([
      [3, 'REJECTED'],
      [4, 'ACCEPTED'],
      [5, 'ACCEPTED'],
      [6, 'ACCEPTED'],
      [7, 'REJECTED'],
    ])('at step 5, the code of step %i is %s', (step, outcome) => {
      const verdict = atSeconds(165).verify(SEED, codeOf(step), null);

      expect(verdict.outcome).toBe(outcome);
      if (verdict.outcome === 'ACCEPTED') expect(verdict.step).toBe(step);
    });

    // Break caught: a window that is half a step off, or that rounds time instead of flooring it.
    it('moves exactly at the step boundary: 149.999 seconds is step 4 and 150.000 is step 5', () => {
      // At 149.999 s the window is steps 3 to 5, so the code of step 6 is refused; at 150.000 s it is steps 4 to 6.
      expect(new Rfc6238TotpVerifier(clockAt(149_999)).verify(SEED, codeOf(6), null).outcome).toBe(
        'REJECTED',
      );
      expect(new Rfc6238TotpVerifier(clockAt(150_000)).verify(SEED, codeOf(6), null).outcome).toBe(
        'ACCEPTED',
      );
      // And the other edge: at 179.999 s the window is still steps 4 to 6, and at 180.000 s it is steps 5 to 7.
      expect(new Rfc6238TotpVerifier(clockAt(179_999)).verify(SEED, codeOf(4), null).outcome).toBe(
        'ACCEPTED',
      );
      expect(new Rfc6238TotpVerifier(clockAt(180_000)).verify(SEED, codeOf(4), null).outcome).toBe(
        'REJECTED',
      );
    });

    it('has no step before the first: at the epoch only steps 0 and 1 can match, and nothing throws', () => {
      const verifier = atSeconds(0);

      expect(verifier.verify(SEED, codeOf(0), null)).toEqual({ outcome: 'ACCEPTED', step: 0 });
      expect(verifier.verify(SEED, codeOf(1), null)).toEqual({ outcome: 'ACCEPTED', step: 1 });
      expect(verifier.verify(SEED, codeOf(2), null)).toEqual({ outcome: 'REJECTED' });
    });

    it('rejects a code that belongs to no step in the window', () => {
      expect(atSeconds(165).verify(SEED, '000000', null)).toEqual({ outcome: 'REJECTED' });
      expect(atSeconds(165).verify(SEED, '999999', null)).toEqual({ outcome: 'REJECTED' });
    });

    it('rejects the right code for another seed', () => {
      expect(atSeconds(165).verify(Buffer.alloc(20, 7), codeOf(5), null)).toEqual({
        outcome: 'REJECTED',
      });
    });
  });

  describe('single use: the caller keeps the last accepted step and passes it back', () => {
    it('accepts a step that is newer than the last accepted one', () => {
      expect(atSeconds(165).verify(SEED, codeOf(5), 4)).toEqual({ outcome: 'ACCEPTED', step: 5 });
      expect(atSeconds(165).verify(SEED, codeOf(6), 4)).toEqual({ outcome: 'ACCEPTED', step: 6 });
    });

    // Break caught: a replay check that compares for inequality, or that tests only the current step.
    it.each([
      ['the same step', 5, 5, 5],
      ['an older step than the last accepted one', 4, 5, 4],
      ['a step far older than the last accepted one', 4, 9, 4],
    ])(
      'refuses %s as REPLAYED, and says which step matched',
      (_label, matchedStep, last, reported) => {
        const verdict = atSeconds(165).verify(SEED, codeOf(matchedStep), last);

        expect(verdict).toEqual({ outcome: 'REPLAYED', step: reported });
      },
    );

    it('lets one code be used once: accepted, then replayed when the step it returned is passed back', () => {
      const verifier = atSeconds(165);

      const first = verifier.verify(SEED, codeOf(5), null);
      expect(first).toEqual({ outcome: 'ACCEPTED', step: 5 });

      const again = verifier.verify(
        SEED,
        codeOf(5),
        first.outcome === 'ACCEPTED' ? first.step : null,
      );
      expect(again).toEqual({ outcome: 'REPLAYED', step: 5 });
    });

    it('lets the next step through after one is used, and not the one before it', () => {
      const verifier = atSeconds(165);

      expect(verifier.verify(SEED, codeOf(6), 5)).toEqual({ outcome: 'ACCEPTED', step: 6 });
      expect(verifier.verify(SEED, codeOf(5), 6)).toEqual({ outcome: 'REPLAYED', step: 5 });
      expect(verifier.verify(SEED, codeOf(4), 6)).toEqual({ outcome: 'REPLAYED', step: 4 });
    });

    it('does not turn a wrong code into a replay', () => {
      expect(atSeconds(165).verify(SEED, '000000', 9)).toEqual({ outcome: 'REJECTED' });
    });

    // A synthetic seed (the SHA-1 of "melarc-test-fixture-891957") found by search, whose codes for steps 999 and 1001 are the
    // same six digits, 729229, while step 1000 is 257644. A code that fits two steps of one window must be recorded as the later
    // one: recording the earlier would let the same code in again two steps later.
    describe('a code that fits two steps of the window', () => {
      const COLLIDING = Buffer.from('f37d59d13725b1b377d63ba5905ac0fb0a5aacda', 'hex');
      const at1000 = new Rfc6238TotpVerifier(clockAt(1000 * 30 * 1000 + 5000));

      // The collision is shown with arithmetic done here and not with the verifier: steps 999 and 1001 give the same code, and
      // step 1000 a different one. Without this, every other test of this block would still pass if only step 1001 matched.
      it('is a fixture that really collides', () => {
        expect(independentCode(COLLIDING, 999)).toBe('729229');
        expect(independentCode(COLLIDING, 1001)).toBe('729229');
        expect(independentCode(COLLIDING, 1000)).toBe('257644');
        expect(at1000.verify(COLLIDING, '257644', null)).toEqual({
          outcome: 'ACCEPTED',
          step: 1000,
        });
        expect(at1000.verify(COLLIDING, '729229', 998)).toEqual({
          outcome: 'ACCEPTED',
          step: 1001,
        });
      });

      // Break caught: choosing the first match, which would record step 999 and accept 729229 again at step 1001.
      it('is accepted at the later of its steps', () => {
        expect(at1000.verify(COLLIDING, '729229', null)).toEqual({
          outcome: 'ACCEPTED',
          step: 1001,
        });
        expect(at1000.verify(COLLIDING, '729229', 999)).toEqual({
          outcome: 'ACCEPTED',
          step: 1001,
        });
        expect(at1000.verify(COLLIDING, '729229', 1000)).toEqual({
          outcome: 'ACCEPTED',
          step: 1001,
        });
      });

      it('cannot be used twice once that step is recorded', () => {
        expect(at1000.verify(COLLIDING, '729229', 1001)).toEqual({
          outcome: 'REPLAYED',
          step: 1001,
        });
        // Two steps later, when step 999 has left the window and 1001 is still in it.
        const later = new Rfc6238TotpVerifier(clockAt(1002 * 30 * 1000 + 5000));
        expect(later.verify(COLLIDING, '729229', 1001)).toEqual({
          outcome: 'REPLAYED',
          step: 1001,
        });
      });
    });

    it.each([
      ['a negative step', -1],
      ['a fraction', 2.5],
      ['not a number', Number.NaN],
      ['a step past the safe integers', 2 ** 53],
      ['text', '5'],
    ])('refuses %s as the last accepted step', (_label, last) => {
      expect(() => atSeconds(165).verify(SEED, codeOf(5), last as unknown as number)).toThrow(
        RangeError,
      );
    });
  });

  describe('a code that is not six ASCII digits is simply rejected', () => {
    // Break caught: a code that is parsed leniently (parseInt, a trim, a length that is only checked from above).
    it.each([
      ['an empty string', ''],
      ['five digits', '28708'],
      ['seven digits', '2870820'],
      ['letters', 'abcdef'],
      ['digits and a letter', '28708a'],
      ['a leading space', ' 287082'],
      ['a trailing space', '287082 '],
      ['a trailing newline', '287082\n'],
      ['a sign', '+87082'],
      ['a decimal point', '287.82'],
      ['an exponent', '2.87e5'],
      ['hexadecimal', '0x7082'],
      ['full-width digits', '２８７０８２'],
      ['Arabic-Indic digits', '٢٨٧٠٨٢'],
      ['a number, not text', 287082 as unknown as string],
      ['undefined', undefined as unknown as string],
      ['null', null as unknown as string],
      ['a very long string', '2'.repeat(100_000)],
    ])('rejects %s, even though the digits would match', (_label, code) => {
      expect(atSeconds(59).verify(SEED, code, null)).toEqual({ outcome: 'REJECTED' });
    });

    it('compares nothing for a code that cannot match', () => {
      atSeconds(59).verify(SEED, '28708', null);
      atSeconds(59).verify(SEED, 'abcdef', null);

      expect(comparisons).not.toHaveBeenCalled();
    });
  });

  describe('a seed this service did not make', () => {
    // Break caught: a seed of any length accepted, so a seed lost to a decryption fault (empty) would let codes be predicted.
    it.each([
      ['empty', Buffer.alloc(0)],
      ['19 bytes', Buffer.alloc(19, 1)],
      ['21 bytes', Buffer.alloc(21, 1)],
      ['32 bytes', Buffer.alloc(32, 1)],
      ['null', null],
      ['undefined', undefined],
      ['text', '12345678901234567890'],
      ['a plain array of numbers', Array.from({ length: 20 }, () => 1)],
    ])('raises SEED_MALFORMED for a seed that is %s', (_label, seed) => {
      const thrown = thrownBy(() =>
        atSeconds(59).verify(seed as unknown as Uint8Array, '287082', null),
      );

      expect(thrown).toMatchObject({ name: 'CryptoConditionError', condition: 'SEED_MALFORMED' });
    });

    it('does not put the seed into the error', () => {
      const seed = Buffer.from('SENTINEL-seed-bytes!', 'ascii');

      const thrown = thrownBy(() => atSeconds(59).verify(seed.subarray(0, 19), '287082', null));

      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).not.toContain('SENTINEL');
      expect(JSON.stringify(thrown)).not.toContain('SENTINEL');
      expect(String((thrown as Error).stack)).not.toContain('SENTINEL');
    });
  });

  describe('newSeed', () => {
    it('makes 20 random bytes, the length of the SHA-1 output the RFC recommends for the shared secret', () => {
      const seed = atSeconds(0).newSeed();

      expect(seed).toBeInstanceOf(Uint8Array);
      expect(seed).toHaveLength(20);
    });

    it('is random in every byte and never repeats', () => {
      const verifier = atSeconds(0);
      const seeds = Array.from({ length: 200 }, () => Buffer.from(verifier.newSeed()));

      expect(new Set(seeds.map((seed) => seed.toString('hex'))).size).toBe(200);
      for (let position = 0; position < 20; position += 1) {
        const seen = new Set(seeds.map((seed) => seed.readUInt8(position)));
        expect(seen.size, `byte ${String(position)}`).toBeGreaterThan(60);
      }
    });

    // The current code of a new seed, worked out here with the library's HMAC and not with the verifier's own code (RFC 4226
    // section 5.3), then offered to the verifier.
    it('makes a seed whose current code the verifier accepts', () => {
      const seconds = 1_700_000_000;
      const verifier = atSeconds(seconds);
      const seed = Buffer.from(verifier.newSeed());
      const step = Math.floor(seconds / 30);

      const verdict = verifier.verify(seed, independentCode(seed, step), null);

      expect(verdict.outcome).toBe('ACCEPTED');
      // The later step wins if the code happens to fit the next one as well (about 1 in 1,000,000).
      expect([step, step + 1]).toContain(verdict.outcome === 'ACCEPTED' ? verdict.step : -1);
    });
  });

  describe('time comes only from the injected clock', () => {
    it('reads the wall clock once for each verification, and never the monotonic clock', () => {
      const now = vi.fn(() => new Date(165_000));
      const monotonic = vi.fn(() => 0);
      const clock: Clock = { now, monotonicMilliseconds: monotonic };
      const verifier = new Rfc6238TotpVerifier(clock);

      verifier.verify(SEED, codeOf(5), null);
      verifier.verify(SEED, codeOf(4), null);

      expect(now).toHaveBeenCalledTimes(2);
      expect(monotonic).not.toHaveBeenCalled();
    });

    // Break caught: reading the machine's clock instead of the injected one, which these vectors (taken in 1970 to 2603)
    // would not survive.
    it("follows the clock it is given and not the machine's", () => {
      const verifier = new Rfc6238TotpVerifier(clockAt(59_000));
      expect(verifier.verify(SEED, '287082', null).outcome).toBe('ACCEPTED');

      const sameVerifierLater = new Rfc6238TotpVerifier(clockAt(20_000_000_000_000));
      expect(sameVerifierLater.verify(SEED, '287082', null).outcome).toBe('REJECTED');
    });

    it('works with a clock that moves between calls', () => {
      let milliseconds = 59_000;
      const verifier = new Rfc6238TotpVerifier({ now: () => new Date(milliseconds) });

      expect(verifier.verify(SEED, codeOf(1), null)).toEqual({ outcome: 'ACCEPTED', step: 1 });
      milliseconds += 3 * 30_000;
      expect(verifier.verify(SEED, codeOf(1), null).outcome).toBe('REJECTED');
    });

    it('fails, and does not guess, when the clock gives no usable instant', () => {
      for (const bad of [new Date(Number.NaN), new Date(-86_400_000)]) {
        const verifier = new Rfc6238TotpVerifier({ now: () => bad });

        expect(() => verifier.verify(SEED, codeOf(1), null)).toThrow(RangeError);
      }
    });
  });

  describe('constant-time comparison of the code', () => {
    // Break caught: stopping at the first matching step, which makes the time depend on which step the code belonged to.
    it('compares the submitted code with the code of every step in the window, whichever matches', () => {
      for (const step of [4, 5, 6]) {
        comparisons.mockClear();

        atSeconds(165).verify(SEED, codeOf(step), null);

        expect(comparisons).toHaveBeenCalledTimes(3);
      }
      comparisons.mockClear();
      atSeconds(165).verify(SEED, '000000', null);
      expect(comparisons).toHaveBeenCalledTimes(3);
    });

    it('compares only the steps that exist at the start of time', () => {
      atSeconds(0).verify(SEED, codeOf(0), null);

      expect(comparisons).toHaveBeenCalledTimes(2);
    });

    it('compares six-byte buffers', () => {
      atSeconds(165).verify(SEED, codeOf(5), null);

      for (const [left, right] of comparisons.mock.calls) {
        expect((left as Uint8Array).length).toBe(6);
        expect((right as Uint8Array).length).toBe(6);
      }
    });
  });

  // The plan's rule for every task that touches a secret (§3, "Secrets"): a sentinel test.
  describe('sentinel: it keeps no seed and shows none', () => {
    it('holds no state of its own beyond the clock, and prints and serialises as nothing secret', () => {
      const seed = Buffer.from('SENTINEL-seed-twenty', 'ascii');
      const verifier = atSeconds(59);
      verifier.verify(seed, '000000', null);
      const generated = Buffer.from(verifier.newSeed());

      const seen = [
        Object.prototype.toString.call(verifier),
        JSON.stringify(verifier),
        inspect(verifier, { showHidden: true, depth: 8 }),
      ];

      for (const text of seen) {
        expect(text).not.toContain('SENTINEL');
        expect(text).not.toContain(generated.toString('hex'));
        expect(text).not.toContain(generated.toString('base64'));
      }
    });

    it('returns a verdict that holds a step and an outcome, and nothing of the seed or the code', () => {
      const verdicts: TotpVerdict[] = [
        atSeconds(165).verify(SEED, codeOf(5), null),
        atSeconds(165).verify(SEED, codeOf(5), 5),
        atSeconds(165).verify(SEED, '000000', null),
      ];

      expect(verdicts.map((verdict) => Object.keys(verdict).sort())).toEqual([
        ['outcome', 'step'],
        ['outcome', 'step'],
        ['outcome'],
      ]);
    });
  });
});
