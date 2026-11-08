import { describe, expect, it } from 'vitest';

import { timestampOf } from './timestamps.js';

describe('timestampOf', () => {
  // Break caught: a database instant read as the machine's local time, or with its fraction misplaced.
  it.each([
    ['2026-10-11 15:05:25.945+00', '2026-10-11T15:05:25.945Z'],
    ['2026-10-11 15:05:27.537988+00', '2026-10-11T15:05:27.537Z'],
    ['2026-10-11 15:05:27+00', '2026-10-11T15:05:27.000Z'],
    ['2026-10-11 15:05:27.5+00', '2026-10-11T15:05:27.500Z'],
    ['2026-10-11 15:05:27.05+00', '2026-10-11T15:05:27.050Z'],
    ['2026-10-11 20:35:27.250+05:30', '2026-10-11T15:05:27.250Z'],
    ['2026-10-11 07:05:27.250-08', '2026-10-11T15:05:27.250Z'],
    ['2026-10-11 07:35:27.250-07:30', '2026-10-11T15:05:27.250Z'],
    ['2026-10-11 15:05:27.999999+00', '2026-10-11T15:05:27.999Z'],
  ])('reads %s as %s, to the millisecond below it', (text, iso) => {
    expect(timestampOf(text).toISOString()).toBe(iso);
  });

  it('returns a date it is given as it is', () => {
    const date = new Date('2026-10-11T15:05:25.945Z');

    expect(timestampOf(date)).toBe(date);
  });

  // Break caught: a value that is not a timestamp becoming an invalid date that every later comparison treats as false.
  it.each([
    '',
    'not a time',
    '2026-10-11',
    '2026-10-11 15:05:25',
    '2026-10-11T15:05:25.945Z',
    '2026-13-11 15:05:25+00',
    '2026-10-32 15:05:25+00',
    '2026-10-11 25:05:25+00',
    'infinity',
    '-infinity',
  ])('refuses %j', (text) => {
    expect(() => timestampOf(text)).toThrow(TypeError);
  });

  it('refuses a value that is neither a date nor text', () => {
    expect(() => timestampOf(1_760_000_000_000 as never)).toThrow(TypeError);
    expect(() => timestampOf(null as never)).toThrow(TypeError);
    expect(() => timestampOf(new Date(Number.NaN))).toThrow(TypeError);
  });
});
