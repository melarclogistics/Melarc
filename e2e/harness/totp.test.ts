import { describe, expect, it } from 'vitest';

import {
  Authenticator,
  STEP_MS,
  base32Decode,
  base32Encode,
  hotp,
  totp,
  type Sleep,
} from './totp.ts';

// RFC 6238, appendix B: the secret "12345678901234567890" (SHA-1), six digits.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('hotp and totp', () => {
  // Break caught: a code that is not the one every authenticator app shows for the same key and time, so that a journey could never be
  // signed in by a code it computed. The values are those of RFC 4226 appendix D and RFC 6238 appendix B.
  it('computes the codes of the RFCs', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((counter) => hotp(RFC_SECRET, counter))).toEqual([
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
    ]);
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
    expect(totp(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totp(RFC_SECRET, 1_234_567_890_000)).toBe('005924');
  });
});

describe('base32', () => {
  // Break caught: the key an authenticator app is given being read as another key. The setup key of the screen is shown in groups of
  // four, in upper case, and an app ignores the spaces.
  it('decodes a key as written on the screen, in groups and in either case', () => {
    const key = base32Encode(RFC_SECRET);
    expect(key).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(key)).toEqual(RFC_SECRET);
    expect(base32Decode('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ')).toEqual(RFC_SECRET);
    expect(base32Decode(key.toLowerCase())).toEqual(RFC_SECRET);
  });

  it('refuses a character that is not in the alphabet', () => {
    expect(() => base32Decode('GEZD1NBV')).toThrow(/base32/);
    expect(() => base32Decode('')).toThrow(/base32/);
  });
});

/** A clock the test moves, and a sleep that moves it. */
function clock(start: number) {
  const state = { now: start, slept: [] as number[] };
  const sleep: Sleep = (ms) => {
    state.slept.push(ms);
    state.now += ms;
    return Promise.resolve();
  };
  return { state, now: () => state.now, sleep };
}

const KEY = base32Encode(RFC_SECRET);
// The middle of a step, so that nothing below depends on a boundary.
const MIDDLE = 40 * STEP_MS + 10_000;

describe('Authenticator', () => {
  // Break caught: a code the server would refuse as a replay. The server keeps the last step it accepted for a factor and takes only a
  // later one, so a second sign-in in the same step must use a later step's code, not the same one again.
  it('never offers the same step twice, and takes the earliest step the server still accepts', async () => {
    const time = clock(MIDDLE);
    const app = new Authenticator(KEY, { now: time.now, sleep: time.sleep });

    const offered = [await app.next(), await app.next(), await app.next()];

    // Ten seconds into step 40: the steps 39, 40 and 41 are all accepted, and they are offered in that order.
    expect(offered).toEqual([39, 40, 41].map((step) => totp(RFC_SECRET, step * STEP_MS)));
    expect(time.state.slept).toEqual([]);
  });

  // Break caught: a code made for the step before the present one when the present one is nearly over, which the server (a step ahead
  // by the time the code arrives) would take as two behind and refuse.
  it('does not use the step before the present one near the end of the present one', async () => {
    const time = clock(41 * STEP_MS - 2_000);
    const app = new Authenticator(KEY, { now: time.now, sleep: time.sleep });

    expect(await app.next()).toBe(totp(RFC_SECRET, 40 * STEP_MS));
  });

  // Break caught: a fourth code requested in one step being the same as an earlier one, or being offered at once although no later step
  // is accepted yet: the helper waits for the clock instead.
  it('waits for the next step when every step the server accepts has been used', async () => {
    const time = clock(MIDDLE);
    const app = new Authenticator(KEY, { now: time.now, sleep: time.sleep });
    await app.next();
    await app.next();
    await app.next();

    const fourth = await app.next();

    expect(time.state.slept.length).toBeGreaterThan(0);
    // The clock is now in the step after the one it began in, and the code is the one for the step after 41: later than every offer.
    expect(Math.floor(time.state.now / STEP_MS)).toBe(41);
    expect(fourth).toBe(totp(RFC_SECRET, 42 * STEP_MS));
  });

  // Break caught: a "wrong code" that is in fact valid, which would let a test of a refusal sign in.
  it('offers a wrong code that no step near the present accepts', () => {
    const time = clock(MIDDLE);
    const app = new Authenticator(KEY, { now: time.now, sleep: time.sleep });
    const accepted = new Set(
      [-3, -2, -1, 0, 1, 2, 3].map((offset) => totp(RFC_SECRET, MIDDLE + offset * STEP_MS)),
    );

    for (let at = 0; at < 20; at += 1) {
      const wrong = app.wrong();
      expect(wrong).toMatch(/^[0-9]{6}$/);
      expect(accepted.has(wrong)).toBe(false);
    }
  });

  // Break caught: a key or a code appearing in an error message, a log or a failed assertion.
  it('shows nothing of its key when printed', () => {
    const app = new Authenticator(KEY, { now: () => MIDDLE, sleep: () => Promise.resolve() });
    expect(JSON.stringify(app)).not.toContain(KEY);
    expect(String(app)).not.toContain(KEY);
    expect(JSON.stringify(Object.values(app))).not.toContain(KEY);
  });
});
