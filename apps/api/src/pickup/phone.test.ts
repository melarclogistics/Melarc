import { describe, expect, it } from 'vitest';

import { normalisePhone } from './phone.js';

/**
 * The phone number of a pickup request (S1.14; domain-model.md section 3.4: "E.164 plus as-entered"; the contract: "E.164 or as entered;
 * normalised server-side"). A number is the identity of an ad-hoc sender (section 29.7), so two spellings of one number must meet and
 * two numbers must never.
 */
describe('normalising a phone number', () => {
  // Break caught: two spellings of one number failing to meet (an ad-hoc sender then minted twice), or a number rewritten into another.
  it.each([
    ['+233241234567', '+233241234567'],
    ['+233 24 123 4567', '+233241234567'],
    ['+233-24-123-4567', '+233241234567'],
    ['(+233) 24 123 4567', '+233241234567'],
    ['0241234567', '+233241234567'],
    ['024 123 4567', '+233241234567'],
    ['024-123-4567', '+233241234567'],
    ['233241234567', '+233241234567'],
    ['00233241234567', '+233241234567'],
    ['  +233241234567  ', '+233241234567'],
    ['+447911123456', '+447911123456'],
    ['+14155552671', '+14155552671'],
  ])('reads %j as %s', (entered, normalised) => {
    expect(normalisePhone(entered)).toBe(normalised);
  });

  // Break caught: text that is not a number accepted and stored as the identity of a person.
  it.each([
    '',
    '   ',
    '024',
    '024123456',
    '02412345678',
    '+0241234567',
    '+23324123456',
    '+2332412345678901',
    '+233 24 abc 4567',
    '024123456x',
    '++233241234567',
    '+233241234567; drop table',
    '12345',
    '0000000000',
    '+',
  ])('refuses %j', (entered) => {
    expect(normalisePhone(entered)).toBeUndefined();
  });

  // Break caught: a normal form that is not stable, so that normalising twice changes the number.
  it('is idempotent: a normalised number normalises to itself', () => {
    for (const entered of ['0241234567', '+233 24 123 4567', '233241234567', '+447911123456']) {
      const once = normalisePhone(entered);
      expect(once).toBeDefined();
      expect(normalisePhone(once ?? '')).toBe(once);
    }
  });
});
