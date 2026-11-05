import { describe, expect, it } from 'vitest';

import { CODE_ALPHABET, hubCodeOf, operationalCode } from './operational-code.js';

/**
 * The operational code of a record (S1.14; domain-model.md section 2, `MSC-DEC-202`): `HUB-TT-XXXXXX`, three letters of the hub, the two
 * of the record type and six characters of the confusion-free alphabet, read aloud on phone calls between Ops, riders and vendors.
 */
const CONTRACT_PATTERN = /^[A-Z]{3}-(PR|MF|IN|OR|DR)-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

describe('the hub code', () => {
  // Break caught: a code that is not three capital letters, so a code the contract's pattern refuses.
  it.each([
    ['Accra', 'ACC'],
    ['Kumasi', 'KUM'],
    ['  tema  ', 'TEM'],
    ['Sao Tome', 'SAO'],
    ['São Tomé', 'SAO'],
    ['a-b c', 'ABC'],
    ['Zion 12 Hub', 'ZIO'],
  ])('is the first three letters of %j, capitalised: %s', (name, code) => {
    expect(hubCodeOf(name)).toBe(code);
  });

  // Break caught: a name that cannot give three letters producing a short or numeric prefix, which would mint codes no hub owns.
  it.each(['', 'Ho', '12', '--', '   '])(
    'refuses %j, which has fewer than three letters',
    (name) => {
      expect(() => hubCodeOf(name)).toThrow(RangeError);
    },
  );
});

describe('an operational code', () => {
  // Break caught: a code that fails the contract's pattern (the pattern is the contract), or uses a character read wrongly aloud.
  it('matches the contract pattern and uses no 0, O, 1, I or L', () => {
    for (let at = 0; at < 500; at += 1) {
      const code = operationalCode('ACC', 'PR');
      expect(code).toMatch(CONTRACT_PATTERN);
      expect(code.slice(7)).not.toMatch(/[01OIL]/);
    }
  });

  it('is the hub code, the record type and six characters drawn by index from the alphabet', () => {
    const draws: number[] = [];
    const code = operationalCode('KUM', 'MF', (bound) => {
      draws.push(bound);
      return draws.length - 1;
    });
    expect(code).toBe('KUM-MF-234567');
    expect(draws).toEqual(Array.from({ length: 6 }, () => CODE_ALPHABET.length));
  });

  // Break caught: a modulo of random bytes favouring the first characters (31 does not divide 256), or an alphabet that is not the
  // 31 confusion-free symbols.
  it('draws each character uniformly by index, from exactly the 31 symbols', () => {
    expect(CODE_ALPHABET).toBe('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
    expect(CODE_ALPHABET).toHaveLength(31);
    expect(new Set(CODE_ALPHABET).size).toBe(31);
  });

  it('refuses a hub code that is not three capital letters, and a record type that is not one of the five', () => {
    expect(() => operationalCode('ac', 'PR')).toThrow(RangeError);
    expect(() => operationalCode('ACCR', 'PR')).toThrow(RangeError);
    expect(() => operationalCode('ACC', 'XX' as never)).toThrow(RangeError);
  });
});
