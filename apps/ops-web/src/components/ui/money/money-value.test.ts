import { describe, expect, it } from 'vitest';

import { formatMinor, isMinorAmount, pesewasFromCedis } from './money-value';

/**
 * Money is a whole number of pesewas on the wire and on the page (domain-model.md section 3.2). Both directions are done on the digits as text,
 * so the tests pin the amounts floating-point arithmetic gets wrong.
 */
describe('formatMinor: an amount the server sent, as a person reads it', () => {
  it.each([
    [2550, 'GH₵25.50'],
    [2000, 'GH₵20.00'],
    [5, 'GH₵0.05'],
    [50, 'GH₵0.50'],
    [0, 'GH₵0.00'],
    [100, 'GH₵1.00'],
    [125_000, 'GH₵1,250.00'],
    [123_456_789, 'GH₵1,234,567.89'],
    [-2550, '-GH₵25.50'],
  ])('shows %i pesewas as %s', (minor, text) => {
    expect(formatMinor(minor, 'GHS')).toBe(text);
  });

  // Break caught: an amount divided as a float, which shows 0.1 + 0.2 kinds of error on the largest amounts a page can hold.
  it('shows the largest whole amount without losing a digit', () => {
    expect(formatMinor(Number.MAX_SAFE_INTEGER, 'GHS')).toBe('GH₵90,071,992,547,409.91');
  });

  // Break caught: a fraction or an unsafe number drawn as if it were an amount: the contract never sends one, so it is a defect of the page.
  it.each([25.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'refuses %s, which is not a whole amount of minor units',
    (value) => {
      expect(() => formatMinor(value, 'GHS')).toThrow(RangeError);
    },
  );
});

describe('pesewasFromCedis: an amount a person typed, as the contract wants it', () => {
  it.each([
    ['25.50', 2550],
    ['25.5', 2550],
    ['25', 2500],
    ['0.1', 10],
    ['0.05', 5],
    ['0', 0],
    ['1,250.00', 125_000],
    ['1250', 125_000],
    ['  40  ', 4000],
    ['GH₵40', 4000],
    ['GH₵ 40.75', 4075],
    ['GHS 12', 1200],
    ['007', 700],
  ])('reads %j as %i pesewas', (text, pesewas) => {
    expect(pesewasFromCedis(text)).toBe(pesewas);
  });

  // Break caught: text that is not an amount taken for one, which would declare a value the person never meant.
  it.each([
    '',
    ' ',
    '-5',
    '+5',
    '25.505',
    '25.',
    '.5',
    '1,25',
    '12,34.00',
    'twenty',
    '2e3',
    '0x10',
    '25 50',
    '90071992547409.92',
  ])('refuses %j', (text) => {
    expect(pesewasFromCedis(text)).toBeUndefined();
  });

  it('tells a whole safe amount from anything else', () => {
    expect(isMinorAmount(0)).toBe(true);
    expect(isMinorAmount(2550)).toBe(true);
    expect(isMinorAmount(25.5)).toBe(false);
    expect(isMinorAmount('2550')).toBe(false);
    expect(isMinorAmount(null)).toBe(false);
  });
});
