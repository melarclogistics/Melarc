import { describe, expect, it } from 'vitest';

import { clearIdentifierIn } from './clear-identifier.js';

/**
 * Whether a database row holds an identifier in clear (the limiter's table must hold a keyed digest and no identifier; SECURITY_DESIGN.md
 * section 14.12). The row is text, and most of it is hexadecimal: a uuid and a digest. A short word made only of the letters a to f, such as
 * "ada", turns up inside a random digest of 64 characters about once in 60 rows, so looking for the word as a substring fails the run by
 * chance. This is the row that failed the database job of the hosted run of 13 October 2026, whose digest happens to hold "ada".
 */
const IDENTIFIERS = ['example.test', 'ada', 'grace', 'stored-check'] as const;

/** The row of the failing run, as Postgres prints it: the digest "\x43de97…695adae98…" holds "ada" and no identifier. */
const CHANCE_ROW =
  '(b80b1877-f857-4868-a196-2d92179a1247,rate_limit_staff_signin,"\\\\x43de97a5bd165b9ee0700b10405695adae98d536d72f906fa8999825c0323007",1,"2026-10-13 11:32:48.560764+00")';

describe('clearIdentifierIn', () => {
  // Break caught: the substring check that failed the run. The text does hold "ada" (inside the digest), so the old assertion failed
  // with no identifier stored anywhere; the check must say there is none.
  it('finds no identifier in the row whose digest happens to contain "ada"', () => {
    expect(CHANCE_ROW).toContain('ada');

    expect(clearIdentifierIn(CHANCE_ROW, IDENTIFIERS)).toBeUndefined();
  });

  // Break caught: the other places a hexadecimal run can hold the letters by chance: the start, the end, either side of a digit, and
  // the groups of a uuid. None of them is an identifier.
  it.each([
    '(00000000-0000-0000-0000-000000000000,b,"\\\\xada0",1,"t")',
    '(00000000-0000-0000-0000-000000000000,b,"\\\\x0ada",1,"t")',
    '(00000000-0000-0000-0000-000000000000,b,"\\\\xada",1,"t")',
    '(ada00000-0ada-0ada-0ada-0000000ada00,b,"\\\\x00",1,"t")',
    '(00000000-0000-0000-0000-000000000000,b,"\\\\xdeadbeefada",1,"t")',
  ])('finds no identifier where the letters sit inside a hexadecimal run: %s', (row) => {
    expect(clearIdentifierIn(row, IDENTIFIERS)).toBeUndefined();
  });

  // Break caught: a check so loose that a stored identifier passes. An identifier on its own in a column, after a separator, before one,
  // joined to other words, in another case or as part of an address is a leak.
  it.each([
    ['a column of its own', '(00000000-0000-0000-0000-000000000000,b,ada,1,"t")', 'ada'],
    ['a quoted column', '(00000000-0000-0000-0000-000000000000,b,"ada",1,"t")', 'ada'],
    [
      'the start of a key',
      '(00000000-0000-0000-0000-000000000000,ada:rate,"\\\\x00",1,"t")',
      'ada',
    ],
    ['the end of a key', '(00000000-0000-0000-0000-000000000000,rate:ada,"\\\\x00",1,"t")', 'ada'],
    [
      'a name with an underscore',
      '(00000000-0000-0000-0000-000000000000,ada_signin,"\\\\x00",1,"t")',
      'ada',
    ],
    ['another case', '(00000000-0000-0000-0000-000000000000,b,Ada,1,"t")', 'ada'],
    [
      'an address',
      '(00000000-0000-0000-0000-000000000000,ada@example.test,"\\\\x00",1,"t")',
      'example.test',
    ],
    [
      'a domain alone',
      '(00000000-0000-0000-0000-000000000000,b,example.test,1,"t")',
      'example.test',
    ],
    [
      'a name that cannot be hexadecimal',
      '(00000000-0000-0000-0000-000000000000,grace,"\\\\x00",1,"t")',
      'grace',
    ],
    [
      'a name with a hyphen',
      '(00000000-0000-0000-0000-000000000000,stored-check,"\\\\x00",1,"t")',
      'stored-check',
    ],
  ])('finds the identifier in %s', (_label, row, expected) => {
    expect(clearIdentifierIn(row, IDENTIFIERS)).toBe(expected);
  });

  it('says which identifier it found, the first of those given', () => {
    expect(clearIdentifierIn('(x,grace,ada,1)', ['ada', 'grace'])).toBe('ada');
  });

  it('finds nothing in a row when it is given nothing to look for', () => {
    expect(clearIdentifierIn('(x,ada,1)', [])).toBeUndefined();
  });

  // Break caught: an identifier given to the check that is itself a pattern ("." as "any character", "+" as a quantifier), so that it
  // matches rows it should not or misses the ones it should.
  it('takes each identifier literally', () => {
    expect(clearIdentifierIn('(x,exampleXtest,1)', ['example.test'])).toBeUndefined();
    expect(clearIdentifierIn('(x,a+b,1)', ['a+b'])).toBe('a+b');
  });
});
