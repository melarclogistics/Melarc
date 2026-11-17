import { describe, expect, it } from 'vitest';

import { countOfText, isCount, MAX_COUNT } from './count-range';

/**
 * The one range of a count of parcels: what the database holds and what the API takes (a four-byte whole number), judged the same by every parser and every form. The boundary is tested on
 * both sides and with the values a person or a broken server could send.
 */
describe('the largest count', () => {
  it('is the largest four-byte whole number, and a safe integer', () => {
    expect(MAX_COUNT).toBe(2 ** 31 - 1);
    expect(Number.isSafeInteger(MAX_COUNT)).toBe(true);
  });
});

describe('a count read from an answer', () => {
  it.each([0, 1, 100, 1000, 1_000_000, 10_000_000, MAX_COUNT - 1, MAX_COUNT])(
    'takes %i',
    (count) => {
      expect(isCount(count)).toBe(true);
    },
  );

  // Break caught: a ceiling lower than the database's (1,000,000 in the custody parser, 10,000,000 in the door-and-failure parser) that makes a count the server took unreadable.
  it('takes the counts the old ceilings refused', () => {
    expect(isCount(1_000_001)).toBe(true);
    expect(isCount(10_000_001)).toBe(true);
    expect(isCount(2_000_000_000)).toBe(true);
  });

  it.each([
    ['one above the largest', MAX_COUNT + 1],
    ['an unsafe integer', 2 ** 53],
    ['the largest number', Number.MAX_VALUE],
    ['infinity', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
    ['a fraction', 1.5],
    ['below zero', -1],
    ['a numeral', '12'],
    ['a boolean', true],
    ['nothing', null],
    ['an object', {}],
  ])('refuses %s', (_name, value) => {
    expect(isCount(value)).toBe(false);
  });

  it('keeps the least it is asked for', () => {
    expect(isCount(0, 1)).toBe(false);
    expect(isCount(1, 1)).toBe(true);
  });
});

describe('a count typed by a person', () => {
  it.each([
    ['0', 0],
    ['7', 7],
    ['007', 7],
    [' 42 ', 42],
    ['1000000', 1_000_000],
    ['1000001', 1_000_001],
    ['2147483647', MAX_COUNT],
  ])('reads %j as %i', (text, count) => {
    expect(countOfText(text)).toBe(count);
  });

  it.each([
    ['one above the largest', '2147483648'],
    ['a text of a huge number', '99999999999999999999999999'],
    ['an unsafe integer', '9007199254740993'],
    ['a sign', '+5'],
    ['a minus', '-5'],
    ['a decimal point', '5.0'],
    ['a decimal comma', '5,0'],
    ['an exponent', '1e3'],
    ['a thousands separator', '1 000'],
    ['hexadecimal', '0x10'],
    ['letters', 'five'],
    ['nothing', ''],
    ['blanks', '   '],
  ])('refuses %s (%j)', (_name, text) => {
    expect(countOfText(text)).toBeUndefined();
  });
});
