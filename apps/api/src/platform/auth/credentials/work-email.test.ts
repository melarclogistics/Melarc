import { describe, expect, it } from 'vitest';

import { canonicalWorkEmail } from './work-email.js';

const canonical = (raw: string): string => {
  const result = canonicalWorkEmail(raw);
  if (!result.ok) throw new Error(`expected a canonical form, got ${result.refusal}`);
  return result.email;
};

// Synthetic addresses on the reserved example domain.
describe('the work-email canonical form (domain-model.md §6.8: trimmed, NFKC, lower-cased as a whole)', () => {
  it('leaves an ordinary lower-case address as it is', () => {
    expect(canonical('alice@example.com')).toBe('alice@example.com');
  });

  // Break caught: no trim, so " alice@example.com" and "alice@example.com" are two staff members.
  it.each([
    ['spaces', '  alice@example.com  '],
    ['a tab and a newline', '\t\nalice@example.com\r\n'],
    ['a no-break space', ' alice@example.com '],
    ['a byte-order mark', '﻿alice@example.com'],
    ['an ideographic space', '　alice@example.com　'],
  ])('trims %s from both ends', (_label, raw) => {
    expect(canonical(raw)).toBe('alice@example.com');
  });

  it('does not touch whitespace inside the address', () => {
    expect(canonical('al ice@example.com')).toBe('al ice@example.com');
  });

  // Break caught: lower-casing only the domain, or only the local part.
  it('lower-cases the whole address, the local part as well as the domain', () => {
    expect(canonical('Alice.SMITH@Example.COM')).toBe('alice.smith@example.com');
    expect(canonical('ALICE@EXAMPLE.COM')).toBe('alice@example.com');
  });

  it('lower-cases without regard to the machine locale: capital I is always i', () => {
    expect(canonical('TITLE@EXAMPLE.COM')).toBe('title@example.com');
  });

  // Break caught: lower-casing without NFKC, so a full-width address and its ASCII form stay two identities.
  it('normalises to NFKC: full-width characters and ligatures become the characters they stand for', () => {
    const fullWidth = 'ＡＬＩＣＥ＠ＥＸＡＭＰＬＥ．ＣＯＭ';

    expect(canonical(fullWidth)).toBe('alice@example.com');
    expect(canonical('oﬃce@example.com')).toBe('office@example.com');
    expect(canonical('x@examⅠ.example')).toBe('x@exami.example');
  });

  it('gives one form to composed and decomposed spellings', () => {
    expect(canonical('josé@example.com')).toBe(canonical('josé@example.com'));
  });

  // Break caught: folding dots or plus tags the way some mail providers do (the design says no).
  it('does no dot or plus-tag folding', () => {
    expect(canonical('a.l.i.c.e@example.com')).toBe('a.l.i.c.e@example.com');
    expect(canonical('alice@example.com')).not.toBe(canonical('a.lice@example.com'));
    expect(canonical('alice+ops@example.com')).toBe('alice+ops@example.com');
    expect(canonical('alice+ops@example.com')).not.toBe(canonical('alice@example.com'));
  });

  // The address is canonicalised first and only then checked to be an email address (openapi.yaml, `StaffIdentity.work_email`),
  // so this function judges nothing about shape.
  it('does not judge whether the text is an email address', () => {
    expect(canonical('  Not An Email  ')).toBe('not an email');
    expect(canonical('')).toBe('');
  });

  it('is stable across ordinary addresses: canonicalising a canonical form changes nothing', () => {
    for (const raw of [
      'Alice@Example.com',
      '  BOB+tag@EXAMPLE.org ',
      'oﬃce@example.com',
      'josé@example.com',
    ]) {
      const once = canonical(raw);

      expect(canonical(once)).toBe(once);
    }
  });

  // Break caught: a lone surrogate reaching the unique index, where the driver would write U+FFFD and two different malformed
  // addresses would collide.
  it.each([
    ['a lone high surrogate', 'alice\uD800@example.com'],
    ['a lone low surrogate', '\uDC00alice@example.com'],
    ['a reversed pair', 'alice@example.com\uDE00\uD83D'],
  ])('refuses %s', (_label, raw) => {
    expect(canonicalWorkEmail(raw)).toEqual({ ok: false, refusal: 'MALFORMED_UNICODE' });
  });
});
