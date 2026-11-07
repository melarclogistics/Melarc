import { ApiError, BrowserTransportError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { StaleSessionError } from '../session/session-boundary';
import { lookupCopy, problemOf, type CopyRule } from './problem-copy';
import { DEFAULT_RATE_LIMIT_WAIT_SECONDS, RATE_LIMITED_MESSAGE } from './rate-limit';

const http = (status: number, code?: string, requestId?: string): ApiError =>
  new ApiError({
    kind: 'http',
    status,
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
  });

describe('problemOf: what a failed call is, for the person looking at the screen', () => {
  // Break caught: a refusal of one kind shown as another. The three refusals of authority are different bugs with different
  // fixes (errors-and-enums.md section 4), and the screen says a different thing for each.
  it.each([
    ['PERMISSION_DENIED', 'permission-missing'],
    ['INSUFFICIENT_AUTHORITY', 'insufficient-authority'],
    ['HUB_SCOPE_VIOLATION', 'outside-hubs'],
    ['SELF_APPROVAL_FORBIDDEN', 'approval-required'],
  ] as const)('reads %s as the forbidden state %s', (code, forbidden) => {
    const problem = problemOf(http(403, code));

    expect(problem.kind).toBe('forbidden');
    expect(problem.forbidden).toBe(forbidden);
    expect(problem.code).toBe(code);
  });

  it.each([
    [404, 'NOT_FOUND', 'not-found'],
    [409, 'STATE_CONFLICT', 'conflict'],
    [400, 'VALIDATION_FAILED', 'invalid'],
    [422, 'REASON_REQUIRED', 'invalid'],
    [422, 'REASON_NOT_ACTIVE', 'invalid'],
    [429, 'RATE_LIMITED', 'rate-limited'],
    [403, 'CSRF_VALIDATION_FAILED', 'refused'],
    [409, 'IDEMPOTENCY_KEY_CONFLICT', 'refused'],
    [422, 'SOME_CODE_THIS_BUILD_NEVER_HEARD_OF', 'refused'],
    [418, undefined, 'refused'],
  ] as const)('reads %i %s as %s', (status, code, kind) => {
    expect(problemOf(http(status, code)).kind).toBe(kind);
  });

  // Break caught: a session that ended being shown as an error. The boundary has already taken the person away; the screen
  // they were on says nothing, and a late answer for a session that has gone says nothing either.
  it.each(['SESSION_INVALID', 'SESSION_SUPERSEDED'])('reads %s as nothing to show', (code) => {
    expect(problemOf(http(401, code))).toMatchObject({ kind: 'session-ended', message: '' });
  });

  it('reads an answer to a request for a session that has changed as nothing to show', () => {
    expect(problemOf(new StaleSessionError())).toMatchObject({ kind: 'stale', message: '' });
  });

  // Break caught: a failure with no answer being worded as the server's refusal, which sends the person to the wrong remedy.
  it.each([
    ['no answer', new ApiError({ kind: 'network' })],
    ['an answer that is not the API’s', new ApiError({ kind: 'unexpected-response', status: 200 })],
    ['a server fault', http(500, 'INTERNAL_ERROR')],
    ['a bad gateway with no body', http(502)],
    ['a request the transport refused to send', new BrowserTransportError('Refusing to send')],
    ['a thing that is not an error at all', 'boom'],
  ])('reads %s as unavailable', (_label, error) => {
    expect(problemOf(error).kind).toBe('unavailable');
  });

  // Break caught: the diagnostic text of an error reaching a screen (surfaces/ops-portal.md section 8). The message of an
  // error is for engineers; the words are chosen here, from the code.
  it('never carries the message of the error it was given', () => {
    const secret = 'token=abc123 SELECT * FROM staff_identity';
    const errors = [new Error(secret), new TypeError(secret), http(500, 'INTERNAL_ERROR')];
    for (const error of errors) {
      error.message = secret;
      expect(JSON.stringify(problemOf(error))).not.toContain('abc123');
      expect(JSON.stringify(problemOf(error))).not.toContain('SELECT');
    }
  });

  it('keeps the request id, for a person to quote, when the call had one', () => {
    expect(problemOf(http(500, 'INTERNAL_ERROR', 'req-9f2')).reference).toBe('req-9f2');
    expect(problemOf(http(500, 'INTERNAL_ERROR')).reference).toBeUndefined();
  });

  it('gives every refusal a sentence, so a screen never shows an empty alert', () => {
    for (const error of [
      http(404, 'NOT_FOUND'),
      http(409, 'STATE_CONFLICT'),
      http(400, 'VALIDATION_FAILED'),
      http(429, 'RATE_LIMITED'),
      http(403, 'CSRF_VALIDATION_FAILED'),
      http(500),
      new ApiError({ kind: 'network' }),
    ]) {
      expect(problemOf(error).message.length).toBeGreaterThan(10);
    }
  });

  // Break caught: wording for a conflict that does not say what happened. STATE_CONFLICT must explain that the record changed.
  it('says that the record changed for a conflict', () => {
    expect(problemOf(http(409, 'STATE_CONFLICT')).message).toMatch(/changed/i);
  });

  // Break caught (A2 of the audit; surfaces/ops-portal.md section 8): the words of a request that was too fast drifting from the Product Owner's, or
  // worded as a fault, a lockout or a reason to leave.
  it('says, calmly and in the Product Owner’s own words, that a request was too fast', () => {
    expect(problemOf(http(429, 'RATE_LIMITED')).message).toBe(
      "You're going a little fast. Try again in a few seconds.",
    );
    expect(problemOf(http(429, 'RATE_LIMITED'), { operation: 'lookupRecords' }).message).toBe(
      RATE_LIMITED_MESSAGE,
    );
    expect(problemOf(http(429, 'RATE_LIMITED'), { operation: 'getQueueSummary' }).message).toBe(
      RATE_LIMITED_MESSAGE,
    );
  });
});

describe('problemOf: the wait that goes with a request that was too fast (A2 of the audit)', () => {
  const refused = (retryAfterSeconds?: number): OperationFailure =>
    new OperationFailure(http(429, 'RATE_LIMITED'), [], {}, retryAfterSeconds);

  // Break caught: the wait the API asked for ignored (the page would hold for a figure of its own), kept longer than the ceiling (an hour with
  // no reads), or missing when the API gave none (the page would not wait at all).
  it.each([
    [30, 30],
    [1, 1],
    [60, 60],
    [3600, 60],
    [undefined, 5],
  ] as const)('carries the wait of %s seconds that the API asked for as %s', (asked, kept) => {
    expect(problemOf(refused(asked))).toMatchObject({ kind: 'rate-limited', waitSeconds: kept });
  });

  // Break caught: a refusal that is not an OperationFailure (a plain ApiError) read as one with a wait, or left with none.
  it('carries the default wait for a refusal that was read without its headers', () => {
    expect(problemOf(http(429, 'RATE_LIMITED'))).toMatchObject({
      kind: 'rate-limited',
      waitSeconds: DEFAULT_RATE_LIMIT_WAIT_SECONDS,
    });
  });

  // Break caught: a wait given to a failure that is not a request that was too fast, which a screen would then hold its reads for.
  it('carries no wait for any other kind of failure', () => {
    for (const error of [
      http(409, 'STATE_CONFLICT'),
      http(500),
      new ApiError({ kind: 'network' }),
    ]) {
      expect(problemOf(error).waitSeconds).toBeUndefined();
    }
  });

  // Break caught: the sign-in screens losing their own words for a limit, which say what is true of an address that is not known to be anyone's.
  it('leaves the screens reached before sign-in their own words, with the wait beside them', () => {
    expect(problemOf(refused(), { operation: 'staffSignIn' })).toMatchObject({
      kind: 'rate-limited',
      message: 'Too many attempts. Wait a minute, then try again.',
      waitSeconds: DEFAULT_RATE_LIMIT_WAIT_SECONDS,
    });
  });
});

describe('the copy is keyed by operation, context and code', () => {
  // Break caught: one global message per code, which is wrong where the same code says different things on a password field and
  // on a reason select (COMPONENT_PATTERNS section 33).
  it('uses the most specific rule that matches, and a more specific one wins over a general one', () => {
    const rules: readonly CopyRule[] = [
      { code: 'VALIDATION_FAILED', text: 'generic' },
      { context: 'reason', code: 'VALIDATION_FAILED', text: 'context and code' },
      { operation: 'resetStaffMfa', code: 'VALIDATION_FAILED', text: 'operation and code' },
      {
        operation: 'resetStaffMfa',
        context: 'reason',
        code: 'VALIDATION_FAILED',
        text: 'operation, context and code',
      },
      { operation: 'resetStaffMfa', text: 'operation alone' },
    ];
    const lookup = (place: { operation?: string; context?: string; code?: string }) =>
      lookupCopy(rules, place);

    expect(
      lookup({ operation: 'resetStaffMfa', context: 'reason', code: 'VALIDATION_FAILED' }),
    ).toBe('operation, context and code');
    expect(lookup({ operation: 'resetStaffMfa', code: 'VALIDATION_FAILED' })).toBe(
      'operation and code',
    );
    expect(lookup({ context: 'reason', code: 'VALIDATION_FAILED' })).toBe('context and code');
    expect(lookup({ operation: 'other', code: 'VALIDATION_FAILED' })).toBe('generic');
    expect(lookup({ operation: 'resetStaffMfa', code: 'SOMETHING_ELSE' })).toBe('operation alone');
    expect(lookup({ operation: 'other', code: 'SOMETHING_ELSE' })).toBeUndefined();
  });

  it('does not let a rule for one operation speak for another', () => {
    const rules: readonly CopyRule[] = [{ operation: 'signOut', text: 'only for sign-out' }];

    expect(lookupCopy(rules, { operation: 'resetStaffMfa' })).toBeUndefined();
    expect(lookupCopy(rules, {})).toBeUndefined();
  });

  it('puts the place a call was made in the words', () => {
    const failure = new ApiError({ kind: 'network' });

    expect(problemOf(failure, { operation: 'signOut' }).message).toMatch(/still signed in/i);
    expect(problemOf(failure).message).not.toMatch(/signed in/i);
  });
});
