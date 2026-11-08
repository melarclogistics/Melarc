import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { NOTIFICATION_COPY } from './notification-copy';
import { problemOf, PROBLEM_COPY } from './problem-copy';

/**
 * The words of the message log (S1.12e), in the one table the Ops Portal keeps, keyed by operation, context and code (COMPONENT_PATTERNS
 * section 33). Proposed for the Product Owner to review with the composed screens. The tests pin that the table holds them, that none is for
 * an operation the log does not call, that a refusal of authority is left to the screen (which names the key), and that no wording names a
 * number, a text or a code.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of NOTIFICATION_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation the log does not call', () => {
    for (const rule of NOTIFICATION_COPY)
      expect(rule.operation, rule.text).toBe('listNotifications');
  });

  it('has no two rules for the same place, here or in the rest of the table', () => {
    const place = (rule: { operation?: string; context?: string; code?: string }) =>
      `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`;
    const mine = NOTIFICATION_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(
      PROBLEM_COPY.filter((rule) => !NOTIFICATION_COPY.includes(rule)).map(place),
    );
    for (const each of mine) expect(others.has(each), each).toBe(false);
  });
});

describe('the words of a failure to read the log', () => {
  it.each([
    ['a fault', refused('INTERNAL_ERROR', 500), 'The messages could not be loaded.'],
    ['no answer', new ApiError({ kind: 'network' }), 'The messages could not be loaded.'],
    [
      'a choice the server did not accept',
      refused('VALIDATION_FAILED', 400),
      'That choice of messages was not accepted. Choose from the lists to start again.',
    ],
  ])('tells %s in approved words', (_label, error, message) => {
    expect(problemOf(error, { operation: 'listNotifications' }).message).toBe(message);
  });

  // The screen names the key itself (`ReadState` is given `notification.read`); the table has no sentence about a role to offer.
  it('tells a refusal of authority as one, in the words every read has, and names no role', () => {
    const problem = problemOf(refused('PERMISSION_DENIED', 403), {
      operation: 'listNotifications',
    });

    expect(problem).toMatchObject({ kind: 'forbidden', forbidden: 'permission-missing' });
    expect(problem.message).not.toMatch(/Ops Staff|Senior Ops|Platform Admin|Finance/);
  });

  // Break caught: a diagnostic of the server, or a number, a text or a code, worded into a failure.
  it('names no number, no text and no code', () => {
    for (const rule of NOTIFICATION_COPY) {
      expect(rule.text, rule.text).not.toMatch(/\+?\d{4,}|\bcode\b|\bOTP\b|phone number/i);
    }
  });
});
