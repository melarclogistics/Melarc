import { describe, expect, it } from 'vitest';

import {
  AcquireTimeoutError,
  PoolClosedError,
  PoolSaturatedError,
} from '../database/connection-queue.js';
import {
  CommitOutcomeUnknownError,
  DatabaseDeadlineError,
  TransactionRolledBackError,
} from '../database/database-failures.js';
import {
  AuthenticationUnavailableError,
  FixedPolicyUnavailableError,
  SessionIssueRefusedError,
  SessionSnapshotUnreadableError,
} from '../auth/sessions/session-errors.js';
import { PolicyCoordinationError } from '../database/policy-lock/coordinate.js';
import { BudgetClosedError, BudgetExpiredError } from '../execution/execution-budget.js';
import { SettingInvalidError, SettingMissingError } from '../settings/settings-reader.js';
import { classifyFailure } from './operational-failure.js';

const cause = { cause: new Error('driver') };

/** One of each typed failure the pipeline reads from the rejection of the database layer. */
const OPERATIONAL: readonly [string, () => Error][] = [
  ['BudgetExpiredError', () => new BudgetExpiredError('request', 15_000)],
  ['DatabaseDeadlineError', () => new DatabaseDeadlineError('statement', '57014', cause)],
  ['PoolSaturatedError', () => new PoolSaturatedError(64)],
  ['AcquireTimeoutError', () => new AcquireTimeoutError(3_000)],
  ['PoolClosedError', () => new PoolClosedError()],
  // S0.24: the sessions and the policy locks. Each is a case where the work did not happen and the instance, not the caller, is the
  // reason (§13.10, §13.10a): the policy kept changing under a restart, the instance cannot be sure of the fixed policy of an audience,
  // it cannot read a session's snapshot, or no store is composed to judge a credential.
  ['PolicyCoordinationError', () => new PolicyCoordinationError('restarts-exhausted', 3)],
  ['FixedPolicyUnavailableError', () => new FixedPolicyUnavailableError('VENDOR', 'BELOW_FLOOR')],
  ['SessionSnapshotUnreadableError', () => new SessionSnapshotUnreadableError(2)],
  ['AuthenticationUnavailableError', () => new AuthenticationUnavailableError()],
  // The owner's decision B of 12 October 2026: a setting the runtime requires and cannot read, or cannot use, is the platform's
  // failure and not a business answer. It is the code-less 503, so no setting value or key reaches a caller.
  ['SettingMissingError', () => new SettingMissingError('session_idle_timeout_minutes')],
  [
    'SettingInvalidError',
    () =>
      new SettingInvalidError(
        'session_idle_timeout_minutes',
        'its value is not of its type object',
      ),
  ],
];

describe('classifyFailure: which failures are the platform’s generic operational failure', () => {
  // Break caught: one of the five typed failures falling through to an unexpected 500, which pages as a defect.
  it.each(OPERATIONAL)('reads %s as operational', (_name, make) => {
    expect(classifyFailure(make())).toEqual({ kind: 'operational' });
  });

  // Break caught: reading only the top of the chain. Inside the work, drizzle wraps what a statement throws and keeps it as the
  // cause, so the typed error is below the one the caller sees.
  it.each(OPERATIONAL)('finds %s below a wrapper', (_name, make) => {
    const wrapped = new Error('Failed query: select …', { cause: make() });
    const twice = new Error('could not save', { cause: wrapped });

    expect(classifyFailure(wrapped)).toEqual({ kind: 'operational' });
    expect(classifyFailure(twice)).toEqual({ kind: 'operational' });
  });

  // Break caught: a refusal of the issue protocol (a suspended identity, no credential) read as an operational failure, which would
  // tell a caller to retry what will never succeed. It is the sign-in's to map to its own answer.
  it('reads a session issue refusal as unexpected, for the sign-in to map and not as a retryable failure', () => {
    expect(classifyFailure(new SessionIssueRefusedError('PRINCIPAL_NOT_ACTIVE'))).toEqual({
      kind: 'unexpected',
    });
  });

  // Break caught: the three reasons collapsing into one, or the reason being lost on the way to the log.
  it.each(['budget-expired', 'connection-lost', 'unrecognized-completion'] as const)(
    'reads a commit that may have happened (%s) as an unknown outcome, never as operational',
    (reason) => {
      const unknown = new CommitOutcomeUnknownError(reason, cause);

      expect(classifyFailure(unknown)).toEqual({ kind: 'commit-outcome-unknown', reason });
    },
  );

  // Break caught: the more dangerous reading losing to the milder one. A commit that may have happened is what the caller must
  // not be told is a failure to try again, whatever else the chain holds.
  it('lets an unknown commit outcome win wherever it sits in the chain, and over an operational failure', () => {
    const unknown = new CommitOutcomeUnknownError('budget-expired', {
      cause: new BudgetExpiredError('transaction', 5_000),
    });
    const wrapped = new Error('save failed', { cause: unknown });
    // An operational failure ABOVE the unknown commit: the first typed error met is not the one that decides.
    const aboveIt = Object.assign(new PoolSaturatedError(8), { cause: unknown });
    const expected = { kind: 'commit-outcome-unknown', reason: 'budget-expired' };

    expect(classifyFailure(unknown)).toEqual(expected);
    expect(classifyFailure(wrapped)).toEqual(expected);
    expect(classifyFailure(aboveIt)).toEqual(expected);
    // Control: the same wrapper around an operational failure alone stays operational.
    expect(classifyFailure(new Error('outer', { cause: new PoolSaturatedError(8) }))).toEqual({
      kind: 'operational',
    });
  });

  // Break caught: a definite rollback, which is a defect of whoever wrote the work, being reported as an outage or as an unknown.
  it.each([
    ['a definite rollback', () => new TransactionRolledBackError()],
    ['a plain error', () => new Error('boom')],
    ['a client error carried as a status', () => Object.assign(new Error('x'), { status: 400 })],
    ['a closed budget', () => new BudgetClosedError('request')],
  ])('reads %s as unexpected', (_label, make) => {
    expect(classifyFailure(make())).toEqual({ kind: 'unexpected' });
  });

  // Break caught: a value that is not an error being read as one, or a thrown string crashing the filter.
  it.each([undefined, null, 'text', 42, {}, [], { cause: new PoolClosedError() }])(
    'reads %j, which is not an error, as unexpected',
    (value) => {
      expect(classifyFailure(value)).toEqual({ kind: 'unexpected' });
    },
  );

  // Break caught: a chain that loops, or one that is very long, being followed for ever.
  it('stops following causes: a cycle is read once and a deep chain only as far as the bound', () => {
    const loop = new Error('loop');
    Object.assign(loop, { cause: loop });
    let deep: Error = new PoolClosedError();
    for (let step = 0; step < 40; step += 1)
      deep = new Error(`level ${String(step)}`, { cause: deep });

    expect(classifyFailure(loop)).toEqual({ kind: 'unexpected' });
    expect(classifyFailure(deep)).toEqual({ kind: 'unexpected' });
  });
});
