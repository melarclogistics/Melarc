import { describe, expect, it } from 'vitest';

import { ApiException } from '../http/api-exception.js';
import { requiredNote } from './required-note.js';

/**
 * The note Ops gives for a decision or a request (S1.15 `resolveCutoffException`, S1.16 `requestOnePackageException`): "mandatory (blank is
 * REASON_REQUIRED)" in the contract. It is judged before the transaction, blank first, and then by the audit's own screening, so that a note
 * accepted here is a note the ledger will keep.
 */
interface Refusal {
  readonly status: number;
  readonly code: string;
  readonly pointer?: string;
  readonly rule?: string;
}

function refusal(note: string, field?: string): Refusal {
  try {
    requiredNote(note, field);
  } catch (error) {
    if (!(error instanceof ApiException)) throw error;
    const violation = (
      error.details as { violations?: { pointer: string; rule: string }[] } | undefined
    )?.violations?.[0];
    return {
      status: error.getStatus(),
      code: error.code,
      ...(violation === undefined ? {} : { pointer: violation.pointer, rule: violation.rule }),
    };
  }
  throw new Error('the note was accepted');
}

describe('the note of a decision or a request', () => {
  // Break caught: a note of nothing accepted as a reason (the audit record exists to say why), or reported as a malformed body.
  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab and spaces', ' \t '],
    ['a line break', '\n'],
  ])(
    'is REASON_REQUIRED when it is %s, even where the audit would call the text malformed',
    (_name, note) => {
      expect(refusal(note)).toEqual({ status: 422, code: 'REASON_REQUIRED' });
    },
  );

  // Break caught: a note the ledger will not keep accepted here, so the act fails as an unexplained 500 after it has begun.
  it.each([
    ['an international number', 'Call him on +233244123456', 'format'],
    ['an address', 'Write to ama@example.com', 'format'],
    ['a control character', 'two\nlines', 'format'],
    ['more than the ledger keeps', 'x'.repeat(1001), 'maxLength'],
  ])('is a validation failure naming the note when it holds %s', (_name, note, rule) => {
    expect(refusal(note)).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
      pointer: '/note',
      rule,
    });
  });

  it('is returned as it was given, not trimmed, when it is fit to keep', () => {
    expect(requiredNote('  Vendor asked by phone  ')).toBe('  Vendor asked by phone  ');
  });

  it('names the field it was asked about', () => {
    expect(refusal('x'.repeat(1001), '/recipient/note').pointer).toBe('/recipient/note');
  });
});
