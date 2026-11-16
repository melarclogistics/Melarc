import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { problemOf, PROBLEM_COPY } from './problem-copy';
import { LOCK_WORDS, RECEIVING_COPY, RECEIVING_WORDS } from './receiving-copy';

/** What no floor screen says: the words of the people who built the system (OB-S1-111). */
const FORBIDDEN =
  /\b(?:intakes?|adjudicat\w*|itemi[sz]\w*|reconciliation|advisory|locks?\b(?! is)|the server|server)\b/i;

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
  'getHubIntake',
  'acquireIntakeLock',
  'submitBlindCount',
  'recordIntakeCondition',
  'adjudicateDiscrepancy',
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
    ['getHubIntake', /see what has been handed over at a hub/],
    ['recordParcelArrival', /check in the parcels received at a hub/],
    ['finishCheckIn', /check in the parcels received at a hub/],
    ['addExtraParcel', /check in the parcels received at a hub/],
    ['floor:recordIntakeCondition', /check in the parcels received at a hub/],
    ['recordIntakeCondition', /check in the parcels received at a hub/],
    ['acquireIntakeLock', /check in the parcels received at a hub/],
    ['submitBlindCount', /check in the parcels received at a hub/],
    ['createEvidence', /check in the parcels received at a hub/],
  ])('names the capability of %s and never a key', (operation, words) => {
    const message = problemOf(refused('PERMISSION_DENIED', 403), { operation }).message;
    expect(message).toMatch(words);
    expect(message).not.toMatch(/\bhub\.[a-z_]+|permission|\brole\b|Ops Staff|Senior Ops/i);
  });

  // Break caught: a decision refused to an officer who is told to ask an administrator for access: a senior officer decides, and an administrator cannot decide for them.
  it('tells an officer without the decision that a senior officer decides, and never to ask an administrator', () => {
    const message = problemOf(refused('PERMISSION_DENIED', 403), {
      operation: 'adjudicateDiscrepancy',
    }).message;
    expect(message).toBe('A senior officer decides this. Ask one to open this page.');
    expect(message).not.toMatch(/administrator/i);
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
    ['recordIntakeCondition', 'intake_not_counted', /has not been counted yet/],
    [
      'recordIntakeCondition',
      'itemization_started',
      /Listing the orders for this vendor has started/,
    ],
    ['recordIntakeCondition', 'condition_already_recorded', /recorded once/],
    [
      'recordIntakeCondition',
      'stale',
      /changed after you opened it, so the damage was not recorded/,
    ],
    ['submitBlindCount', 'already_counted', /Someone else counted this vendor first/],
    ['submitBlindCount', 'photo_check_in', /photographed at the door.*Open the run/],
    ['submitBlindCount', 'stale', /changed after you opened it, so your count was not recorded/],
    ['adjudicateDiscrepancy', 'not_awaiting_resolution', /not waiting for a decision/],
    ['adjudicateDiscrepancy', 'not_written_off', /Write them off first/],
    ['adjudicateDiscrepancy', 'vendor_already_told', /already recorded that the vendor was told/],
    [
      'adjudicateDiscrepancy',
      'stale',
      /changed after you opened it, so the decision was not recorded/,
    ],
  ])('words %s by the rule %s', (operation, rule, words) => {
    expect(problemOf(conflict(rule), { operation }).message).toMatch(words);
  });

  // Break caught (surfaces/ops-portal.md section 9): the second receiver given a bare failure: the words say someone else counted first, that nothing was changed, and where the count they kept is.
  it('tells the receiver who counted second what happened and where to look', () => {
    const message = problemOf(conflict('already_counted'), {
      operation: 'submitBlindCount',
    }).message;
    expect(message).toContain(
      'Someone else counted this vendor first, so your count was not kept and nothing was changed.',
    );
    expect(message).toContain('open it to see it');
    expect(message).toContain('Only the first count is kept');
  });

  // Break caught: any other conflict of the blind count and the decision told in words of the system's builders, or without what to do next.
  it('tells any other conflict of the count, the damage and the decision in words of its own, with what to do next', () => {
    for (const operation of [
      'submitBlindCount',
      'recordIntakeCondition',
      'adjudicateDiscrepancy',
    ]) {
      expect(problemOf(conflict(undefined), { operation }).message).toMatch(
        /no longer as you saw it.*Refresh the page/,
      );
    }
  });

  it('says a vendor that cannot be told whether someone else is checking it in leaves the receiver able to carry on', () => {
    expect(problemOf(refused(undefined, 503), { operation: 'acquireIntakeLock' }).message).toMatch(
      /You can carry on/,
    );
  });

  // Break caught: a note the ledger would not keep repeated back to the officer, or told without saying what to change.
  it.each(['recordIntakeCondition', 'adjudicateDiscrepancy'])(
    'tells a refused note of %s at the note and never repeats it',
    (operation) => {
      const failure = new OperationFailure(refused('VALIDATION_FAILED', 400), [
        { in: 'body', pointer: '/note', rule: 'format' },
      ]);
      expect(problemOf(failure, { operation }).message).toBe(
        'Check the note marked below: it was not accepted as written.',
      );
    },
  );

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
      problemOf(refused('REASON_REQUIRED', 422), { operation: 'recordIntakeCondition' }).message,
    ).toMatch(/needs a photo/);
    expect(
      problemOf(refused('REASON_REQUIRED', 422), { operation: 'adjudicateDiscrepancy' }).message,
    ).toMatch(/A reason is needed/);
    expect(
      problemOf(refused('EVIDENCE_NOT_STORED', 422), { operation: 'addExtraParcel' }).message,
    ).toMatch(/not stored yet/);
    expect(
      problemOf(refused('EVIDENCE_UPLOAD_EXPIRED', 422), {
        operation: 'completeEvidenceUpload',
      }).message,
    ).toMatch(/time to send this photo ran out/);
  });
});

describe('the voice of the floor', () => {
  // Break caught (OB-S1-111): a word of the system's builders on a floor screen.
  it('has no word the floor does not use, in any rule or in the lock’s words', () => {
    for (const rule of RECEIVING_COPY) {
      expect(rule.text, rule.text).not.toMatch(FORBIDDEN);
    }
    for (const text of [
      LOCK_WORDS.opened('Ama Owusu', '09:12'),
      LOCK_WORDS.openedByYou('09:12'),
      LOCK_WORDS.nobody,
      LOCK_WORDS.cannotCheck,
    ]) {
      expect(text).not.toMatch(FORBIDDEN);
    }
  });

  // Break caught: the evidence steps said in the words of the people who built them ("This intake is no longer as you saw it") on a screen of the floor, because their words are the shared table's.
  it('has the evidence steps, which every screen that takes a photo shares, in the floor’s voice', () => {
    const evidence = PROBLEM_COPY.filter(
      (rule) => rule.operation === 'createEvidence' || rule.operation === 'completeEvidenceUpload',
    );
    expect(evidence.length).toBeGreaterThan(5);
    for (const rule of evidence) {
      expect(rule.text, rule.text).not.toMatch(FORBIDDEN);
      expect(rule.text, rule.text).not.toMatch(/\bPDF\b/);
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

/** Every sentence the words of the screens can say: each string, and each function called at the figures and names a floor meets (none, one, many, a name), so that a branch of a plural is read too. */
function sentencesOf(value: unknown, path = 'RECEIVING_WORDS'): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    return [0, 1, 12, 'Kente Crafts'].map((sample): [string, string] => {
      const said = fn(...Array.from({ length: fn.length }, () => sample));
      // A function of a name and a count given the one sample twice may hand the name back as it is: what it says is read as text all the same.
      if (typeof said !== 'string' && typeof said !== 'number')
        throw new Error(`${path} says a ${typeof said}, not a sentence`);
      return [`${path}(${String(sample)})`, String(said)];
    });
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, inner]) => sentencesOf(inner, `${path}.${key}`));
  }
  throw new Error(`${path} is not words`);
}

describe('the words of the screens', () => {
  const sentences = sentencesOf(RECEIVING_WORDS);

  it('are many, and each is a sentence', () => {
    expect(sentences.length).toBeGreaterThan(80);
    for (const [path, said] of sentences) expect(said.trim(), path).not.toBe('');
  });

  // Break caught (OB-S1-111): a screen word of the system's builders, which no refusal check reaches because it is not a refusal.
  it('have no word the floor does not use, whatever the figures', () => {
    for (const [path, said] of sentences) expect(said, path).not.toMatch(FORBIDDEN);
  });

  // Break caught (PRODUCT_DESIGN_DIRECTION section 6.5): a sentence that names a key, a role or an administrator; an officer without the decision is told a senior officer decides.
  it('name no key, no role and no administrator', () => {
    for (const [path, said] of sentences) {
      expect(said, path).not.toMatch(
        /\bhub\.[a-z_.]+|Ops Staff|Platform Admin|Senior Ops|administrator/i,
      );
    }
  });

  // Break caught: a number typed into a sentence, which would be a count the words made up. Every figure in a sentence came in as an argument (12 or 1 or 0 here).
  it('hold no figure that was not given', () => {
    for (const [path, said] of sentences) {
      const figures = said.match(/\d+/g) ?? [];
      for (const figure of figures) expect(['0', '1', '12'], path).toContain(figure);
    }
  });

  // Break caught (the pictures' review, defect 12): "(optional)" typed into a label, drawn as bold as the label while the kit's "(required)" is muted. A field is optional in its help ("Optional. …"), as it
  // is in the product's other forms.
  it('say a field is optional in its help, and never in its label', () => {
    for (const [path, said] of sentences) expect(said, path).not.toMatch(/\(optional\)/i);
    for (const help of [
      RECEIVING_WORDS.extra.noteHelp,
      RECEIVING_WORDS.damage.noteHelp,
      RECEIVING_WORDS.blindDamage.noteHelp,
      RECEIVING_WORDS.decision.photosHelp,
    ]) {
      expect(help).toMatch(/^Optional\. /);
    }
  });

  // Break caught: the confirmation of "All N here" said another way, so that it is not the statement the officer is asked to make.
  it('say the confirmation of "All 12 here" as the owner worded it', () => {
    expect(RECEIVING_WORDS.vendor.allHere(12)).toBe('All 12 here');
    expect(RECEIVING_WORDS.allHere.title(12, 'Kente Crafts')).toBe(
      'Confirm 12 parcels from Kente Crafts?',
    );
    expect(RECEIVING_WORDS.allHere.body(12)).toBe(
      'I counted 12 parcels from this vendor on the table.',
    );
    expect(RECEIVING_WORDS.allHere.confirm(12)).toBe('Yes, all 12 are here');
  });

  it('say one parcel as one parcel', () => {
    expect(RECEIVING_WORDS.allHere.title(1, 'Kente Crafts')).toBe(
      'Confirm 1 parcel from Kente Crafts?',
    );
    expect(RECEIVING_WORDS.allHere.body(1)).toBe(
      'I counted 1 parcel from this vendor on the table.',
    );
    expect(RECEIVING_WORDS.allHere.confirm(1)).toBe('Yes, it is here');
    expect(RECEIVING_WORDS.vendor.allHere(1)).toBe('The parcel is here');
  });

  // Break caught: a condition that is not "not checked yet" until it is recorded ("Good condition" from a default).
  it('say a condition nobody recorded is not checked yet', () => {
    expect(RECEIVING_WORDS.states.conditionUnchecked).toBe('Condition not checked yet');
  });

  // Break caught: the rider's number in a sentence about a vendor that was counted blind before the count.
  it('say nothing of the rider’s number for a vendor not yet counted but that it is shown after', () => {
    expect(RECEIVING_WORDS.vendor.blind.explain).toMatch(/shown only after you have typed yours/);
    expect(RECEIVING_WORDS.vendor.blindPhotographed).not.toMatch(/\d/);
  });

  it('tell an officer a senior officer will decide, and never to ask for access to it', () => {
    expect(RECEIVING_WORDS.vendor.standing.RECONCILIATION_REQUIRED).toBe(
      'A senior officer will decide about this vendor.',
    );
    expect(RECEIVING_WORDS.summary.decisionFor('Kente Crafts')).toBe(
      'A senior officer will decide about Kente Crafts.',
    );
  });
});
