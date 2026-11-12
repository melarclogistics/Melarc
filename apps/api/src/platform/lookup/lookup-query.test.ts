import { describe, expect, it } from 'vitest';

import {
  likeLiteral,
  lookupQueryOf,
  maskedPhone,
  strategyOf,
  wordPrefixPatterns,
} from './lookup-query.js';

/**
 * What the text of a lookup is (`features/operations/global-lookup.md` section 5; `AC-LOOKUP-01` to `-04`, `-09`): the length it may have,
 * and which of the three questions it asks. Pure: no database, no session.
 */
describe('the query of a lookup', () => {
  // Break caught (AC-LOOKUP-01): a text the contract refuses being searched, or spaces counted as characters.
  it.each([
    undefined,
    null,
    7,
    {},
    '',
    ' ',
    'a',
    '  a  ',
    '\t\n',
    'x'.repeat(65),
    ` ${'x'.repeat(65)} `,
    // A NUL character is in no name, and the database refuses it in a text: it is a refused query, not a failed read.
    'ab\u0000cd',
    '\u0000\u0000',
    'kofi\u0000',
  ])('refuses %j', (raw) => {
    expect(lookupQueryOf(raw)).toBeUndefined();
  });

  it('accepts two characters and sixty-four, trims them and makes each run of white space one space', () => {
    expect(lookupQueryOf('ab')?.text).toBe('ab');
    expect(lookupQueryOf(` ${'x'.repeat(64)} `)?.text).toBe('x'.repeat(64));
    expect(lookupQueryOf('  Kofi \t  Mensah \n')?.text).toBe('Kofi Mensah');
    // The handler's own check, after the contract's (which counts the text as sent, 64 at most): the length is counted once trimmed and folded.
    expect(lookupQueryOf(`${'x'.repeat(31)}     ${'y'.repeat(32)}`)?.text).toBe(
      `${'x'.repeat(31)} ${'y'.repeat(32)}`,
    );
    expect(lookupQueryOf(`${'x'.repeat(32)}     ${'y'.repeat(32)}`)).toBeUndefined();
  });

  // Break caught (AC-LOOKUP-02): a code read only in upper case, or a name read as a code.
  it.each(['ACC-PR-7KQ2MZ', 'acc-pr-7kq2mz', '  Acc-Pr-7Kq2Mz  '])(
    'reads %j as an operational code',
    (raw) => {
      const query = lookupQueryOf(raw);
      expect(query?.code).toBe('ACC-PR-7KQ2MZ');
      expect(query?.codeType).toBe('PR');
      expect(strategyOf(query ?? failure())).toBe('code');
    },
  );

  it.each([
    'Kofi Mensah',
    'Ama-Bo',
    'ACC-PR',
    'ACC-PR-7KQ2M',
    'ACC-PR-7KQ2MZZ',
    'AC-PR-7KQ2MZ',
    'ACC_PR_7KQ2MZ',
  ])('does not read %j as an operational code', (raw) => {
    expect(lookupQueryOf(raw)?.code).toBeUndefined();
  });

  // Break caught (AC-LOOKUP-03): a number read only in one spelling, or a part of a number read as a whole.
  it.each([
    '024 111 2222',
    '0241112222',
    '233241112222',
    '+233 24 111 2222',
    '00233241112222',
    '(024) 111-2222',
  ])('reads %j as the phone +233241112222', (raw) => {
    const query = lookupQueryOf(raw);
    expect(query?.phone).toBe('+233241112222');
    expect(strategyOf(query ?? failure())).toBe('phone');
  });

  it.each([
    '024 111',
    '0241112',
    '024111222',
    '+233 24',
    '0241112222x',
    'call 0241112222',
    '2026',
    '+1',
  ])('does not read %j as a phone, and reads it as a name', (raw) => {
    const query = lookupQueryOf(raw);
    expect(query?.phone).toBeUndefined();
    expect(query === undefined ? undefined : strategyOf(query)).toBe('name');
  });

  // Break caught: a vendor's identifier looked for only as a name, or an eight-letter name no longer searched as a name.
  it('reads the eight characters of a vendor identifier in any case, and still searches the name', () => {
    const query = lookupQueryOf(' k7m2p9xq ');
    expect(query?.accountIdentifier).toBe('K7M2P9XQ');
    expect(strategyOf(query ?? failure())).toBe('name');
    // The alphabet leaves out 0, 1, O, I and L: "Kofi Mensah" and "OLIVIA11" are not identifiers.
    expect(lookupQueryOf('OLIVIA11')?.accountIdentifier).toBeUndefined();
    expect(lookupQueryOf('K7M2P9X')?.accountIdentifier).toBeUndefined();
  });

  it('asks one question of a text that could be two, in the order code, phone, name', () => {
    expect(
      strategyOf({ text: 'x', code: 'ACC-PR-AAAAAA', codeType: 'PR', phone: '+233241112222' }),
    ).toBe('code');
    expect(strategyOf({ text: 'x', phone: '+233241112222', accountIdentifier: 'K7M2P9XQ' })).toBe(
      'phone',
    );
    expect(strategyOf({ text: 'x', accountIdentifier: 'K7M2P9XQ' })).toBe('name');
  });
});

describe('the pattern of a name search', () => {
  // Break caught (AC-LOOKUP-04): the inside of a word matching, or a "%" or "_" or "\" of the person's text acting as a pattern.
  it('matches at the start of the name or of a word, and escapes what a pattern would read', () => {
    expect(wordPrefixPatterns('Kofi')).toEqual(['Kofi%', '% Kofi%']);
    expect(wordPrefixPatterns('50%_off\\')).toEqual(['50\\%\\_off\\\\%', '% 50\\%\\_off\\\\%']);
    expect(likeLiteral('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('the phone of a result', () => {
  // Break caught (AC-LOOKUP-09): a number shown in clear, or shown in a form of its own instead of the platform's.
  it('is masked as the platform masks a number it shows: the country part and the last three digits', () => {
    expect(maskedPhone('+233241112222')).toBe('+233******222');
    expect(maskedPhone('+233241112222')).not.toContain('2411');
    expect(maskedPhone('+14155552671')).toBe('+141*****671');
  });
});

function failure(): never {
  throw new Error('the query was refused');
}
