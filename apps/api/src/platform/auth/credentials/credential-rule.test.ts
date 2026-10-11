import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_MAX_CODE_POINTS,
  CREDENTIAL_MIN_CODE_POINTS,
  normaliseNewCredential,
  normalisePresentedCredential,
  type CredentialCheck,
} from './credential-rule.js';

// Synthetic strings only: nothing here is, or resembles, a real credential.
const FFI = 'ﬃ'; // LATIN SMALL LIGATURE FFI: one code point that NFKC expands to the three letters "ffi"
const GRIN = '\u{1F600}'; // one code point, two UTF-16 units; NFKC leaves it alone
const E_DECOMPOSED = 'é'; // two code points; NFKC composes them to the one code point U+00E9
const E_COMPOSED = 'é';

const accepted = (check: CredentialCheck): string => {
  if (!check.ok) throw new Error(`expected the credential to be accepted, got ${check.refusal}`);
  return check.credential;
};

describe('the credential rule (SECURITY_DESIGN.md §13.4a)', () => {
  it('states the bounds of the design: 12 to 128 code points', () => {
    expect(CREDENTIAL_MIN_CODE_POINTS).toBe(12);
    expect(CREDENTIAL_MAX_CODE_POINTS).toBe(128);
  });
});

describe('a credential being created (setup and recovery completion)', () => {
  // Break caught: an off-by-one at either bound, or a minimum that is not enforced where the credential is made.
  it.each([
    [11, false],
    [12, true],
    [13, true],
    [127, true],
    [128, true],
    [129, false],
  ])('judges %i characters as sent: accepted is %s', (length, isAccepted) => {
    const check = normaliseNewCredential('k'.repeat(length));

    expect(check.ok).toBe(isAccepted);
    if (!check.ok) {
      expect(check).toEqual({
        ok: false,
        refusal: length < 12 ? 'TOO_SHORT' : 'TOO_LONG',
        counted: 'AS_SENT',
      });
    }
  });

  // Break caught: counting UTF-16 units, which would refuse twelve astral characters as 24 and accept six as 12.
  it('counts Unicode code points, not UTF-16 units', () => {
    expect(accepted(normaliseNewCredential(GRIN.repeat(12)))).toBe(GRIN.repeat(12));
    expect(accepted(normaliseNewCredential(GRIN.repeat(128)))).toBe(GRIN.repeat(128));
    expect(normaliseNewCredential(GRIN.repeat(11))).toEqual({
      ok: false,
      refusal: 'TOO_SHORT',
      counted: 'AS_SENT',
    });
    expect(normaliseNewCredential(GRIN.repeat(129))).toEqual({
      ok: false,
      refusal: 'TOO_LONG',
      counted: 'AS_SENT',
    });
  });

  describe('the U+FB03 arithmetic of the 12 and 128 bounds', () => {
    // The design's own example: four ligatures are 4 code points as sent and 12 once normalised, so the schema's bound refuses them
    // first, and normalisation is never moved ahead of it (§13.4a).
    it('refuses four ligatures as sent, though they are twelve letters once normalised', () => {
      expect(FFI.repeat(4).normalize('NFKC')).toBe('ffi'.repeat(4));
      expect(Array.from(FFI.repeat(4).normalize('NFKC'))).toHaveLength(12);

      expect(normaliseNewCredential(FFI.repeat(4))).toEqual({
        ok: false,
        refusal: 'TOO_SHORT',
        counted: 'AS_SENT',
      });
    });

    it('accepts twelve ligatures, which are 36 letters once normalised, and hands back the normalised text', () => {
      expect(accepted(normaliseNewCredential(FFI.repeat(12)))).toBe('ffi'.repeat(12));
    });

    // Break caught: applying the 128 bound only to the text as sent. 43 ligatures are 43 as sent and 129 once normalised.
    it('refuses 43 ligatures, which are 43 as sent and 129 once normalised, and accepts 42, which are 126', () => {
      expect(accepted(normaliseNewCredential(FFI.repeat(42)))).toBe('ffi'.repeat(42));
      expect(normaliseNewCredential(FFI.repeat(43))).toEqual({
        ok: false,
        refusal: 'TOO_LONG',
        counted: 'AFTER_NFKC',
      });
    });

    it('lands exactly on 128 normalised, and one past it', () => {
      const atTheBound = FFI.repeat(42) + 'xy'; // 44 as sent, 126 + 2 = 128 normalised
      const pastIt = FFI.repeat(42) + 'xyz'; // 45 as sent, 129 normalised

      expect(accepted(normaliseNewCredential(atTheBound))).toBe('ffi'.repeat(42) + 'xy');
      expect(normaliseNewCredential(pastIt)).toEqual({
        ok: false,
        refusal: 'TOO_LONG',
        counted: 'AFTER_NFKC',
      });
    });
  });

  // Break caught: the minimum applied to the text as sent only, so that characters which compose into fewer code points pass.
  it('applies the minimum after normalisation too: six decomposed letters are twelve as sent and six once composed', () => {
    const decomposed = E_DECOMPOSED.repeat(6);

    expect(Array.from(decomposed)).toHaveLength(12);
    expect(normaliseNewCredential(decomposed)).toEqual({
      ok: false,
      refusal: 'TOO_SHORT',
      counted: 'AFTER_NFKC',
    });
    expect(accepted(normaliseNewCredential(E_DECOMPOSED.repeat(12)))).toBe(E_COMPOSED.repeat(12));
  });

  describe('what is never done to the text', () => {
    // Break caught: a trim, which would make "twelve letters and a space" differ from what the person typed and set, and so from
    // what they type at sign-in.
    it('keeps leading, trailing and inner spaces, and counts them', () => {
      const text = ' k' + 'k'.repeat(9) + ' ';

      expect(text).toHaveLength(12);
      expect(accepted(normaliseNewCredential(text))).toBe(text);
      expect(accepted(normaliseNewCredential(' '.repeat(12)))).toBe(' '.repeat(12));
      expect(accepted(normaliseNewCredential('two words and more spaces'))).toBe(
        'two words and more spaces',
      );
    });

    // Break caught: a case fold, which would make "Passphrase" and "passphrase" one credential.
    it('keeps case, and keeps letters whose case folding differs from their own', () => {
      expect(accepted(normaliseNewCredential('AbCdEfGhIjKlMn'))).toBe('AbCdEfGhIjKlMn');
      expect(accepted(normaliseNewCredential('STRASSE-ß-İ-xx'))).toBe('STRASSE-ß-İ-xx');
    });

    // The rule has no composition requirement: no mandatory case, digit or symbol.
    it('asks for no mix of case, digits or symbols', () => {
      expect(accepted(normaliseNewCredential('abcdefghijkl'))).toBe('abcdefghijkl');
      expect(accepted(normaliseNewCredential('ABCDEFGHIJKL'))).toBe('ABCDEFGHIJKL');
      expect(accepted(normaliseNewCredential('123456789012'))).toBe('123456789012');
      expect(accepted(normaliseNewCredential('!!!!!!!!!!!!'))).toBe('!!!!!!!!!!!!');
    });
  });

  describe('NFKC, the same at set time and at sign-in', () => {
    it('hands back NFKC text', () => {
      const text = accepted(normaliseNewCredential('Ｐａｓｓｗｏｒｄ１２３４'));

      expect(text).toBe('Password1234');
      expect(text).toBe(text.normalize('NFKC'));
    });

    it('turns a no-break space into the ordinary space it looks like', () => {
      expect(accepted(normaliseNewCredential('twelve chars!'))).toBe('twelve chars!');
    });

    // Break caught: normalising only one side, so a passphrase that looks the same would verify differently.
    it('gives the same text for a composed and a decomposed spelling, at both entry points', () => {
      const composed = `caf${E_COMPOSED} au lait!`;
      const decomposed = `café au lait!`;

      expect(composed).not.toBe(decomposed);
      expect(accepted(normaliseNewCredential(decomposed))).toBe(
        accepted(normaliseNewCredential(composed)),
      );
      expect(accepted(normalisePresentedCredential(decomposed))).toBe(
        accepted(normaliseNewCredential(composed)),
      );
    });
  });

  // Break caught: a lone surrogate passing through to a UTF-8 encoder that turns it into U+FFFD (§13.4a: never silently encoded to
  // different bytes).
  it.each([
    ['a lone high surrogate', 'k'.repeat(11) + '\uD800'],
    ['a lone low surrogate', 'k'.repeat(11) + '\uDC00'],
    ['a lone surrogate in the middle', 'k'.repeat(6) + '\uD83D' + 'k'.repeat(6)],
    ['a reversed pair', 'k'.repeat(10) + '\uDE00\uD83D'],
  ])('refuses %s, however long the rest is', (_label, text) => {
    expect(normaliseNewCredential(text)).toEqual({ ok: false, refusal: 'MALFORMED_UNICODE' });
  });

  // Break caught: a refusal that carries the value, which would put a credential into whatever logs or serialises the result.
  it('names the refusal and never the value', () => {
    const sentinel = 'sentinel-credential-value-0123456789';
    const tooLong = normaliseNewCredential(sentinel.repeat(5));
    const tooShort = normaliseNewCredential('short');

    expect(Object.keys(tooLong).sort()).toEqual(['counted', 'ok', 'refusal']);
    expect(Object.keys(tooShort).sort()).toEqual(['counted', 'ok', 'refusal']);
    expect(JSON.stringify(tooLong)).not.toContain('sentinel');
    expect(JSON.stringify(tooShort)).not.toContain('short');
  });
});

describe('a credential presented at sign-in: bounded, not policed', () => {
  it('sets no minimum: an empty or one-character credential is simply a wrong credential', () => {
    expect(accepted(normalisePresentedCredential(''))).toBe('');
    expect(accepted(normalisePresentedCredential('x'))).toBe('x');
    expect(accepted(normalisePresentedCredential(FFI.repeat(4)))).toBe('ffi'.repeat(4));
  });

  it('accepts up to 128 code points and normalises them', () => {
    expect(accepted(normalisePresentedCredential('k'.repeat(128)))).toBe('k'.repeat(128));
    expect(accepted(normalisePresentedCredential(GRIN.repeat(128)))).toBe(GRIN.repeat(128));
    expect(accepted(normalisePresentedCredential(`${E_DECOMPOSED}x`))).toBe(`${E_COMPOSED}x`);
  });

  it('refuses 129 as sent', () => {
    expect(normalisePresentedCredential('k'.repeat(129))).toEqual({
      ok: false,
      refusal: 'TOO_LONG',
      counted: 'AS_SENT',
    });
  });

  // Break caught: hashing an input that expands past the bound (§13.4a: answered INVALID_CREDENTIALS without being hashed), which
  // would let a short request buy an expensive hash.
  it('refuses a value that expands past 128 once normalised, so that the caller never hashes it', () => {
    expect(normalisePresentedCredential(FFI.repeat(42))).toMatchObject({ ok: true });
    expect(normalisePresentedCredential(FFI.repeat(43))).toEqual({
      ok: false,
      refusal: 'TOO_LONG',
      counted: 'AFTER_NFKC',
    });
    // The most an NFKC expansion can do to 128 characters is still bounded work: U+FDFA becomes 18 code points.
    expect(normalisePresentedCredential('ﷺ'.repeat(128))).toEqual({
      ok: false,
      refusal: 'TOO_LONG',
      counted: 'AFTER_NFKC',
    });
  });

  it('refuses malformed Unicode in the same way as at creation', () => {
    expect(normalisePresentedCredential('abc\uD800def')).toEqual({
      ok: false,
      refusal: 'MALFORMED_UNICODE',
    });
    expect(normalisePresentedCredential('\uDC00')).toEqual({
      ok: false,
      refusal: 'MALFORMED_UNICODE',
    });
  });

  it('does not trim or fold case, here either', () => {
    expect(accepted(normalisePresentedCredential('  Mixed Case  '))).toBe('  Mixed Case  ');
  });
});
