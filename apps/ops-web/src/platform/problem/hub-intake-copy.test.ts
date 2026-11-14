import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { HUB_INTAKE_COPY } from './hub-intake-copy';
import { problemOf, PROBLEM_COPY } from './problem-copy';

/**
 * The words of the receiving screens (S1.35), in the one table the Ops Portal keeps, keyed by operation, context and code. The tests pin that each refused act names its own capability and no key or role, that a
 * conflict which declares a rule is worded by the rule (and that the two conflicts of two receivers who count are told at length, because the lock is advisory), that a refused note says what to change and never
 * repeats it, and that no wording draws the rider's declared number or names an officer.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });
const conflict = (rule: string | undefined): OperationFailure =>
  new OperationFailure(refused('STATE_CONFLICT', 409), [], rule === undefined ? {} : { rule });

const OPERATIONS = [
  'listHubIntakes',
  'getHubIntake',
  'acquireIntakeLock',
  'submitBlindCount',
  'recordIntakeCondition',
  'adjudicateDiscrepancy',
  'createEvidence',
  'completeEvidenceUpload',
  'createEvidenceRetrievalAuthorization',
];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of HUB_INTAKE_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation these screens do not call', () => {
    for (const rule of HUB_INTAKE_COPY) expect(OPERATIONS, rule.text).toContain(rule.operation);
  });

  // Break caught: an operation of these screens with no words of its own, so a refusal of it is told as a generic failure.
  it('has words for every operation of these screens, the intake’s photo among them', () => {
    for (const operation of OPERATIONS) {
      expect(
        HUB_INTAKE_COPY.some(
          (rule) =>
            rule.operation === operation &&
            rule.code === undefined &&
            (rule.context === undefined || rule.context === 'intake'),
        ),
        operation,
      ).toBe(true);
    }
  });

  it('has no two rules for the same place, here or in the rest of the table', () => {
    const place = (rule: { operation?: string; context?: string; code?: string }) =>
      `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`;
    const mine = HUB_INTAKE_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(
      PROBLEM_COPY.filter((rule) => !HUB_INTAKE_COPY.includes(rule)).map(place),
    );
    for (const each of mine) expect(others.has(each), each).toBe(false);
  });
});

describe('the words of the refusals of authority', () => {
  // Break caught (PRODUCT_DESIGN_DIRECTION section 6.5): a refusal that names a key, or the wrong act, so that an administrator is asked to grant the wrong access.
  it.each([
    ['listHubIntakes', /see hub intakes/],
    ['getHubIntake', /see hub intakes/],
    ['acquireIntakeLock', /count the parcels received at a hub/],
    ['submitBlindCount', /count the parcels received at a hub/],
    ['recordIntakeCondition', /count the parcels received at a hub/],
    ['adjudicateDiscrepancy', /decide a discrepancy found at receiving/],
  ])('names the capability of %s and never a key', (operation, words) => {
    const message = problemOf(refused('PERMISSION_DENIED', 403), { operation }).message;
    expect(message).toMatch(words);
    expect(message).not.toMatch(/\bhub\.[a-z_]+|permission|\brole\b|Ops Staff|Senior Ops/i);
  });

  // Break caught: the adjudication refused as a lack of access alone, when what an officer needs to know is that a senior officer decides it.
  it('says that a senior officer decides the adjudication, in plain words', () => {
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), { operation: 'adjudicateDiscrepancy' }).message,
    ).toBe(
      'A senior officer decides this. Your account can’t decide a discrepancy found at receiving. Ask an administrator for access.',
    );
  });

  it('words a photo of an intake in the key that reads the intake, and a stop’s photo in its own words', () => {
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), {
        operation: 'createEvidenceRetrievalAuthorization',
        context: 'intake',
      }).message,
    ).toBe('Your account can’t see hub intakes. Ask an administrator for access.');
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), {
        operation: 'createEvidenceRetrievalAuthorization',
      }).message,
    ).toMatch(/see pickup runs/);
  });
});

describe('the words of two receivers who count', () => {
  // Break caught (surfaces/ops-portal.md section 9): the second receiver given a bare failure: the words say another receiver counted first, that nothing was changed, and that a lock never stops a second count.
  it('tells the receiver who counted second what happened and where to look', () => {
    const message = problemOf(conflict('already_counted'), {
      operation: 'submitBlindCount',
    }).message;
    expect(message).toContain(
      'Another receiver counted this intake first, so your count was not kept and nothing was changed.',
    );
    expect(message).toContain('open it to see it');
    expect(message).toContain('never stops a second count, and the first one is kept');
  });

  it('tells a stale version, and any other conflict, in words of its own', () => {
    expect(problemOf(conflict('stale'), { operation: 'submitBlindCount' }).message).toMatch(
      /changed after you opened it, so your count was not recorded/,
    );
    expect(problemOf(conflict(undefined), { operation: 'submitBlindCount' }).message).toMatch(
      /no longer as you saw it/,
    );
  });

  it.each([
    ['recordIntakeCondition', 'intake_not_counted', /has not been counted yet/],
    ['recordIntakeCondition', 'itemization_started', /Itemising this intake has begun/],
    ['recordIntakeCondition', 'condition_already_recorded', /already been recorded/],
    ['adjudicateDiscrepancy', 'not_awaiting_resolution', /not waiting for a decision/],
    ['createEvidence', 'intake_not_counted', /not been counted yet/],
  ])('words %s by the rule %s', (operation, rule, words) => {
    expect(problemOf(conflict(rule), { operation }).message).toMatch(words);
  });
});

describe('the words of the notes and the photos', () => {
  // Break caught: a note the ledger would not keep repeated back to the officer, or told without saying what to change.
  it.each(['recordIntakeCondition', 'adjudicateDiscrepancy'])(
    'tells a refused note of %s at the note and never repeats it',
    (operation) => {
      const failure = new OperationFailure(refused('VALIDATION_FAILED', 400), [
        { in: 'body', pointer: '/note', rule: 'format' },
      ]);
      const message = problemOf(failure, { operation }).message;
      expect(message).toBe('Check the note marked below: it was not accepted as written.');
    },
  );

  it('tells a photo that is needed, and one that is not stored, in plain words', () => {
    expect(
      problemOf(refused('REASON_REQUIRED', 422), { operation: 'recordIntakeCondition' }).message,
    ).toMatch(/need a photo/);
    expect(
      problemOf(refused('EVIDENCE_NOT_STORED', 422), { operation: 'recordIntakeCondition' })
        .message,
    ).toMatch(/not stored yet/);
    expect(
      problemOf(refused('EVIDENCE_UPLOAD_EXPIRED', 422), { operation: 'completeEvidenceUpload' })
        .message,
    ).toMatch(/time to send this photo ran out/);
  });

  it('says a lock that cannot be confirmed leaves the receiver able to count', () => {
    expect(problemOf(refused(undefined, 503), { operation: 'acquireIntakeLock' }).message).toMatch(
      /You can still count it/,
    );
  });

  // Break caught: wording that draws the rider's declared number, names an officer, or shows a key or a role.
  it('names no officer, no key and no role, and does not say the declared number', () => {
    for (const rule of HUB_INTAKE_COPY) {
      expect(rule.text, rule.text).not.toMatch(
        /\b(?:hub\.[a-z_.]+|Ops Staff|Platform Admin|Senior Ops)\b/,
      );
      // The only number a sentence may carry is the 0 of a count's lower bound: no figure of a count is ever drawn by the words.
      expect(rule.text, rule.text).not.toMatch(/\b[1-9]\d*\b/);
    }
  });
});
