import { describe, expect, it } from 'vitest';

import { holdsPhoneNumber } from './phone-in-text.js';

describe('a phone number in the text of a note (Run G1, Part 1, item 5)', () => {
  // Break caught: a note that holds a number an officer naturally types ("the right number is 0244123456") reaching the append-only audit log because the screening recognised only `+` numbers. Each form is the
  // number as people in Ghana write it.
  it.each([
    ['a local number', '0244123456'],
    ['a local number in a sentence', 'the right number is 0244123456'],
    ['a local number in groups of a space', '024 412 3456'],
    ['a local number in groups of a hyphen', '024-412-3456'],
    ['a local number in groups of a dot', '024.412.3456'],
    ['a local number with the area in brackets', '(024) 412 3456'],
    ['a local number in groups of two spaces', '0244  123  456'],
    ['the international number without a plus', '233244123456'],
    ['the international number without a plus, in groups', '233 24 412 3456'],
    ['the international number with a plus', '+233244123456'],
    ['the international number with a plus, in groups', '+233 24 412 3456'],
    ['the international number with 00', '00233244123456'],
    ['a number of another country with a plus', 'call +14155550123'],
    ['full-width digits', '０２４４１２３４５６'],
    ['Arabic-Indic digits', '٠٢٤٤١٢٣٤٥٦'],
    ['a number after other digits', 'parcel 3, call 0244123456 tomorrow'],
    ['a second number joined to the first by one space', '0244123456 0201234567'],
    ['a number inside brackets of text', 'asked (0244123456) twice'],
    ['a number written right after another number', 'parcel 12 0244123456'],
    ['a number written right after a short group with a hyphen', 'ref 7-024-412-3456'],
    ['a number glued to a word', 'phone:0244123456'],
    // What a person (or a keyboard) writes for a separator besides the hyphen: a validator that reads only the ASCII forms is one a careful writer goes around (the security review of 0f5d34f).
    ['groups joined by an en dash', '024–412–3456'],
    ['groups joined by an em dash', '024—412—3456'],
    ['groups joined by a non-breaking hyphen', '024\u2011412\u20113456'],
    ['groups joined by a minus sign', '024\u2212412\u22123456'],
    ['groups joined by a slash', '024/412/3456'],
    ['groups joined by an underscore', '024_412_3456'],
    ['groups joined by a middle dot', '024·412·3456'],
    ['groups joined by a spaced hyphen', '024 - 412 - 3456'],
    ['groups joined by a spaced slash', '024 / 412 / 3456'],
    ['digits with a zero-width space between them', '024\u200B412\u200B3456'],
    ['digits with a soft hyphen between them', '024\u00AD412\u00AD3456'],
    [
      'digits with a zero-width joiner between them',
      '0\u200D2\u200D4\u200D4\u200D1\u200D2\u200D3\u200D4\u200D5\u200D6',
    ],
    ['the international number with a plus and spaced hyphens', '+233 - 24 - 412 - 3456'],
    ['the area in brackets and spaced hyphens', '(024) - 412 - 3456'],
    ['digits with a variation selector between them', '024\uFE0F412\uFE0F3456'],
    ['digits with a combining grapheme joiner between them', '024\u034F412\u034F3456'],
    ['digits with a Hangul filler between them', '024\u3164412\u3164 3456'],
    [
      'digits with combining marks on them',
      '0\u03012\u03014\u03014\u03011\u03012\u03013\u03014\u03015\u03016\u0301',
    ],
    ['groups joined by five separators', '024) - (412) - (3456'],
  ])('is found in %s', (_label, text) => {
    expect(holdsPhoneNumber(text), text).toBe(true);
  });

  // Break caught: a screening so wide that an officer cannot write an ordinary note: times, dates, amounts, counts, the codes of an order, a waybill's shorter number.
  it.each([
    ['a time', 'Called at 10.30 and again at 11.15'],
    ['a date', 'The vendor said 2026-11-24'],
    ['a date and a time', 'Spoke on 24/11/2026 at 10:30'],
    ['the code of an order', 'order ACC-OR-E5VMPB is for this parcel'],
    ['the code of an intake', 'vendor ACC-IN-7K3M9Q'],
    ['a count', '12 parcels of 3 boxes each'],
    ['a date with slashes', 'Spoke on 24/11/2026'],
    ['a fraction and a range', 'took 3/4 of the day, rooms 12 - 14'],
    ['a time with zero-width characters', 'at 10\u200B.\u200B30'],
    ['a range of rooms and a count with brackets', 'rooms 12 ... 14, parcels (3) of (5)'],
    ['an amount', 'Charged GH₵ 1,000,000 by mistake'],
    ['a short number', 'waybill 12345678'],
    ['nine digits', 'ref 244123456'],
    ['eleven digits', 'ref 02441234567'],
    ['thirteen digits that begin with 233', 'ref 2332441234567'],
    ['words only', 'The label cannot be read, waiting on WhatsApp'],
    ['nothing', ''],
  ])('is not found in %s', (_label, text) => {
    expect(holdsPhoneNumber(text), text).toBe(false);
  });
});
