import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { problemOf, PROBLEM_COPY } from './problem-copy';
import { LOCK_WORDS, RECEIVING_COPY } from './receiving-copy';

/**
 * The words of the receiving screens of a run (S1.35c), in the one table the Ops Portal keeps. The tests pin that each refused act names its own capability and no key or role, that a conflict which declares a rule
 * is worded by the rule, that **no wording speaks in the voice of the system's builders** (*intake*, *adjudicate*, *itemise*, *reconciliation*, *advisory lock*, *the server*: OB-S1-111), that an officer is never told
 * to ask an administrator for what a senior officer decides, and that the lock's line says who opened the check-in and when and never *Held by you* for a lock that was not confirmed.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });
const conflict = (rule: string | undefined): OperationFailure =>
  new OperationFailure(refused('STATE_CONFLICT', 409), [], rule === undefined ? {} : { rule });

const OPERATIONS = [
  'listReceivingRuns',
  'getReceivingRun',
  'listMissingParcels',
  'getEvidenceLimits',
  'recordParcelArrival',
  'finishCheckIn',
  'addExtraParcel',
  'correctIntakeCount',
  'floor:recordIntakeCondition',
  'floor:createEvidence',
  'floor:completeEvidenceUpload',
];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of RECEIVING_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation these screens do not call', () => {
    for (const rule of RECEIVING_COPY) expect(OPERATIONS, rule.text).toContain(rule.operation);
  });

  // Break caught: an operation of these screens with no words of its own, so a refusal of it is told as a generic failure.
  it('has words for every operation of these screens', () => {
    for (const operation of OPERATIONS) {
      expect(
        RECEIVING_COPY.some(
          (rule) =>
            rule.operation === operation && rule.code === undefined && rule.context === undefined,
        ),
        operation,
      ).toBe(true);
    }
  });

  it('has no two rules for the same place, here or in the rest of the table', () => {
    const place = (rule: { operation?: string; context?: string; code?: string }) =>
      `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`;
    const mine = RECEIVING_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(
      PROBLEM_COPY.filter((rule) => !RECEIVING_COPY.includes(rule)).map(place),
    );
    for (const each of mine) expect(others.has(each), each).toBe(false);
  });
});

describe('the words of the refusals of authority', () => {
  // Break caught (PRODUCT_DESIGN_DIRECTION section 6.5): a refusal that names a key, or the wrong act, so that an administrator is asked to grant the wrong access.
  it.each([
    ['listReceivingRuns', /see what has been handed over at a hub/],
    ['getReceivingRun', /see what has been handed over at a hub/],
    ['listMissingParcels', /see what has been handed over at a hub/],
    ['recordParcelArrival', /count the parcels received at a hub/],
    ['finishCheckIn', /count the parcels received at a hub/],
    ['addExtraParcel', /count the parcels received at a hub/],
    ['floor:recordIntakeCondition', /count the parcels received at a hub/],
    ['floor:createEvidence', /count the parcels received at a hub/],
  ])('names the capability of %s and never a key', (operation, words) => {
    const message = problemOf(refused('PERMISSION_DENIED', 403), { operation }).message;
    expect(message).toMatch(words);
    expect(message).not.toMatch(/\bhub\.[a-z_]+|permission|\brole\b|Ops Staff|Senior Ops/i);
  });

  // Break caught: a correction refused to an officer who is told to ask an administrator for access: a senior officer makes it, and the words say so.
  it('tells an officer without the decision that a senior officer makes the correction, and never to ask an administrator', () => {
    const message = problemOf(refused('PERMISSION_DENIED', 403), {
      operation: 'correctIntakeCount',
    }).message;
    expect(message).toBe('A senior officer makes corrections. Ask one to open this page.');
    expect(message).not.toMatch(/administrator/i);
  });
});

describe('the words of the conflicts', () => {
  it.each([
    ['finishCheckIn', 'count_changed', /number of parcels expected .* has changed/],
    ['finishCheckIn', 'has_extra_parcels', /not “all here”/],
    ['finishCheckIn', 'check_in_finished', /finished already/],
    ['finishCheckIn', 'blind_count_intake', /no photos to check against/],
    ['finishCheckIn', 'stale', /changed after you opened it/],
    ['recordParcelArrival', 'check_in_finished', /missing list/],
    ['recordParcelArrival', 'blind_count_intake', /no photos to check against/],
    ['addExtraParcel', 'check_in_finished', /senior officer can correct/],
    ['floor:recordIntakeCondition', 'condition_already_recorded', /recorded once/],
    ['floor:recordIntakeCondition', 'parcel_not_arrived', /not been checked in/],
    ['correctIntakeCount', 'itemization_started', /can no longer be corrected/],
  ])('words %s by the rule %s', (operation, rule, words) => {
    expect(problemOf(conflict(rule), { operation }).message).toMatch(words);
  });

  it('tells any other conflict in words of its own, with what to do next', () => {
    for (const operation of ['recordParcelArrival', 'finishCheckIn', 'addExtraParcel']) {
      expect(problemOf(conflict(undefined), { operation }).message).toMatch(
        /no longer as you saw it.*Refresh the page/,
      );
    }
  });

  it('tells a photo that is needed, and one that is not stored, in plain words', () => {
    expect(
      problemOf(refused('REASON_REQUIRED', 422), { operation: 'floor:recordIntakeCondition' })
        .message,
    ).toMatch(/need a photo/);
    expect(
      problemOf(refused('EVIDENCE_NOT_STORED', 422), { operation: 'addExtraParcel' }).message,
    ).toMatch(/not stored yet/);
    expect(
      problemOf(refused('EVIDENCE_UPLOAD_EXPIRED', 422), {
        operation: 'floor:completeEvidenceUpload',
      }).message,
    ).toMatch(/time to send this photo ran out/);
  });
});

describe('the voice of the floor', () => {
  // Break caught (OB-S1-111): a word of the system's builders on a floor screen.
  it('has no word the floor does not use, in any rule or in the lock’s words', () => {
    const forbidden =
      /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|locks?\b(?! is)|the server|server)\b/i;
    for (const rule of RECEIVING_COPY) {
      expect(rule.text, rule.text).not.toMatch(forbidden);
    }
    for (const text of [
      LOCK_WORDS.opened('Ama Owusu', '09:12'),
      LOCK_WORDS.openedByYou('09:12'),
      LOCK_WORDS.nobody,
      LOCK_WORDS.cannotCheck,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  // Break caught: wording that names an officer, a key or a role.
  it('names no officer, no key and no role', () => {
    for (const rule of RECEIVING_COPY) {
      expect(rule.text, rule.text).not.toMatch(
        /\b(?:hub\.[a-z_.]+|Ops Staff|Platform Admin|Senior Ops)\b/,
      );
    }
  });

  // The only figures a sentence may carry are the bounds the words state (a lookup of at least 2 characters, a count above 0): no number of parcels is ever drawn by the words.
  it('carries no figure of a count', () => {
    for (const rule of RECEIVING_COPY) {
      expect(rule.text, rule.text).not.toMatch(/\b[13-9]\d*\b/);
    }
  });
});

describe('the lock’s line', () => {
  it('says who opened the check-in and when, and that it stops nobody', () => {
    expect(LOCK_WORDS.opened('Ama Owusu', '09:12')).toBe(
      'Ama Owusu opened this check-in at 09:12. It stops nobody.',
    );
    expect(LOCK_WORDS.openedByYou('09:12')).toBe(
      'You opened this check-in at 09:12. It stops nobody.',
    );
  });

  // Break caught (the review of Stage 6): a lock that could not be confirmed still told as the officer's.
  it('says when it cannot be checked, and never *Held by you*', () => {
    expect(LOCK_WORDS.cannotCheck).toMatch(/cannot check who else is checking this in right now/);
    expect(LOCK_WORDS.cannotCheck).not.toMatch(/held by you|you opened/i);
  });
});
