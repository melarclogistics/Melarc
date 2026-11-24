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
