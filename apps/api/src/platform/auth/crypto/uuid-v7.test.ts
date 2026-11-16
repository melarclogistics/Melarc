import { describe, expect, it, vi } from 'vitest';

import type { Clock } from '../ports/clock.port.js';
import { orderedUUIDv7, randomUUIDv7, uuidV7From } from './uuid-v7.js';

const clockAt = (iso: string): Clock => ({
  now: () => new Date(iso),
  monotonicMilliseconds: () => 0,
});

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const timestampOf = (uuid: string): number =>
  Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16);

describe('uuidV7From, the layout of RFC 9562 section 5.7', () => {
  // RFC 9562 Appendix A.6, the published UUIDv7 example: unix_ts_ms 0x017F22E279B0, rand_a 0xCC3 and rand_b
  // 0b01 8C4DC0C0C07398F give 017F22E2-79B0-7CC3-98C4-DC0C0C07398F. The random input below has the version and variant bits
  // "wrong" on purpose (0xFC and 0xD8), so the vector also proves that they are overwritten and not trusted.
  it('reproduces the RFC 9562 Appendix A.6 example', () => {
    const random = Buffer.from('000000000000fcc3d8c4dc0c0c07398f', 'hex');

    expect(uuidV7From(0x017f22e279b0, random)).toBe('017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
  });

  it('puts the 48-bit millisecond timestamp first, whatever bytes the random input holds there', () => {
    const noise = Buffer.alloc(16, 0xff);

    expect(uuidV7From(0, noise).slice(0, 13)).toBe('00000000-0000');
    expect(uuidV7From(1, noise).slice(0, 13)).toBe('00000000-0001');
    expect(uuidV7From(0xffff_ffff_ffff, Buffer.alloc(16, 0)).slice(0, 13)).toBe('ffffffff-ffff');
  });

  // Break caught: a version or variant nibble taken from the random input.
  it('sets the version to 7 and the variant to 10 for any random input', () => {
    for (const fill of [0x00, 0x0f, 0x10, 0x3f, 0x40, 0x7f, 0x80, 0xbf, 0xc0, 0xf0, 0xff]) {
      const uuid = uuidV7From(1_700_000_000_000, Buffer.alloc(16, fill));

      expect(uuid, `fill ${String(fill)}`).toMatch(FORMAT);
    }
  });

  it('keeps all 74 random bits: version and variant take the other 6 of 128', () => {
    const a = uuidV7From(5, Buffer.from('00000000000000000000000000000000', 'hex'));
    const b = uuidV7From(5, Buffer.from('00000000000000000000000000000001', 'hex'));
    const c = uuidV7From(5, Buffer.from('00000000000000100000000000000000', 'hex'));

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it.each([
    ['a negative time', -1],
    ['a time past 48 bits', 2 ** 48],
    ['a fraction', 1.5],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s', (_label, milliseconds) => {
    expect(() => uuidV7From(milliseconds, Buffer.alloc(16))).toThrow(RangeError);
  });

  it('refuses random input that is not 16 bytes', () => {
    expect(() => uuidV7From(1, Buffer.alloc(15))).toThrow(RangeError);
    expect(() => uuidV7From(1, Buffer.alloc(17))).toThrow(RangeError);
  });
});

describe('randomUUIDv7 (S0.3b): identity code reads time only through the injected clock (SECURITY_DESIGN.md §13.3a)', () => {
  it("writes the injected clock's instant into the identifier", () => {
    const uuid = randomUUIDv7(clockAt('2022-02-22T19:22:22.000Z'));

    expect(uuid).toMatch(FORMAT);
    expect(timestampOf(uuid)).toBe(Date.parse('2022-02-22T19:22:22.000Z'));
  });

  // Break caught: reading the machine's clock instead of the injected one, so a test that fixes time still gets today's.
  it("follows the clock it is given, past and future alike, and not the machine's", () => {
    for (const iso of [
      '1970-01-01T00:00:00.000Z',
      '2000-01-01T00:00:00.000Z',
      '2099-12-31T23:59:59.999Z',
    ]) {
      expect(timestampOf(randomUUIDv7(clockAt(iso)))).toBe(Date.parse(iso));
    }
  });

  it('reads the clock once for each identifier', () => {
    const now = vi.fn(() => new Date('2026-10-09T12:00:00.000Z'));

    randomUUIDv7({ now });
    randomUUIDv7({ now });

    expect(now).toHaveBeenCalledTimes(2);
  });

  // The identifiers are "time-ordered so [they index] well as a primary key" (domain-model.md §3).
  it('sorts by time as text: a later millisecond is a greater identifier', () => {
    const instants = [0, 1, 999, 1000, 1_700_000_000_000, 1_700_000_000_001, 0xffff_ffff_ffff];
    const uuids = instants.map((ms) => randomUUIDv7({ now: () => new Date(ms) }));

    expect([...uuids].sort()).toEqual(uuids);
  });

  it('does not repeat, even when every identifier is made in one millisecond', () => {
    const clock = clockAt('2026-10-09T12:00:00.000Z');
    const uuids = new Set(Array.from({ length: 20_000 }, () => randomUUIDv7(clock)));

    expect(uuids.size).toBe(20_000);
  });

  // Break caught: a constant or low-entropy tail, which would make identifiers guessable (the model says they are not).
  it('is random after the timestamp: every free hex digit takes nearly all 16 values over 300 identifiers', () => {
    const clock = clockAt('2026-10-09T12:00:00.000Z');
    // After the 12 timestamp digits and the version digit come 3 free digits of rand_a, the variant digit, and 15 free digits.
    const tails = Array.from({ length: 300 }, () =>
      randomUUIDv7(clock).replaceAll('-', '').slice(13),
    );

    expect(tails.every((tail) => tail.length === 19)).toBe(true);
    for (let position = 0; position < 19; position += 1) {
      const seen = new Set(tails.map((tail) => tail.charAt(position)));
      if (position === 3) {
        // The variant digit: 10xx, so 8, 9, a or b, and all four turn up.
        expect([...seen].sort()).toEqual(['8', '9', 'a', 'b']);
      } else {
        expect(seen.size, `tail position ${String(position)}`).toBeGreaterThanOrEqual(14);
      }
    }
  });

  it('refuses a clock that gives an instant a UUIDv7 cannot hold', () => {
    expect(() => randomUUIDv7({ now: () => new Date(Number.NaN) })).toThrow(RangeError);
    expect(() => randomUUIDv7({ now: () => new Date(-1) })).toThrow(RangeError);
    expect(() => randomUUIDv7({ now: () => new Date(2 ** 48) })).toThrow(RangeError);
  });
});

describe('orderedUUIDv7, identifiers that sort in the order they are made', () => {
  // Break caught: two identifiers made in the same millisecond that are not in the order of the calls (a handover's vendors drawn in an order that changes from read to read, against the contract's "in the order the
  // handover opened them"): the clock stands still and fifty identifiers still sort as they were made; each is a UUIDv7 of the clock's time or a millisecond on.
  it('keeps the order of the calls when the clock does not move, one millisecond on for each', () => {
    const next = orderedUUIDv7(clockAt('2026-11-16T09:00:00.000Z'));
    const made = Array.from({ length: 50 }, () => next());

    expect(made).toEqual(made.toSorted());
    expect(new Set(made).size).toBe(50);
    for (const [at, uuid] of made.entries()) {
      expect(uuid).toMatch(FORMAT);
      expect(timestampOf(uuid)).toBe(Date.parse('2026-11-16T09:00:00.000Z') + at);
    }
  });

  // Break caught: a generator that steps ahead of a clock that has moved on (its identifiers drifting into the future for good), or one that follows a clock that steps back (an identifier out of order).
  it('follows a clock that moves on and never goes back', () => {
    let now = Date.parse('2026-11-16T09:00:00.000Z');
    const next = orderedUUIDv7({ now: () => new Date(now) });
    const first = next();
    const second = next();
    now += 5_000;
    const third = next();
    now -= 60_000;
    const fourth = next();

    expect([first, second, third, fourth]).toEqual([first, second, third, fourth].toSorted());
    expect(timestampOf(second) - timestampOf(first)).toBe(1);
    expect(timestampOf(third)).toBe(Date.parse('2026-11-16T09:00:05.000Z'));
    expect(timestampOf(fourth)).toBe(timestampOf(third) + 1);
  });
});
