import { describe, expect, it } from 'vitest';

import { initialsOf } from './initials-of';

describe('initialsOf', () => {
  // Break caught: the letters of an avatar read from the wrong words (the first two letters of the first word, the middle word of three), a name
  // kept in the case it was typed, a name with a letter outside A to Z (the names of Ghana are written with them: `Ɔbaa`, `Ɛ`, and the accents of
  // the names of the other languages the portal is used in) given no initial, a hyphenated first name given two, or a name with no letter in it,
  // an empty one, or none at all, given anything but nothing. (The eleven cases first written for the side menu, kept when it was replaced, and the
  // letters of Akan.)
  it.each([
    ['Ama Mensah', 'AM'],
    ['ama mensah', 'AM'],
    ['Kofi', 'K'],
    ['Ama Kofi Mensah', 'AM'],
    ['  Ama   Mensah  ', 'AM'],
    ['élodie dupont', 'ÉD'],
    ['Ama-Esi Mensah', 'AM'],
    ['', ''],
    ['   ', ''],
    ['123 456', ''],
    [null, ''],
    ['Ɔbaa Mensah', 'ƆM'],
    ['Kwame Ɛbo', 'KƐ'],
  ])('reads %j as %j', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});
