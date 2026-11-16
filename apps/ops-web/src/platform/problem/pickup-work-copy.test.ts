import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { OperationFailure } from '../api/api-response';
import { MANIFEST_COPY } from './manifest-copy';
import { PICKUP_COPY } from './pickup-copy';
import { PICKUP_WORK_COPY } from './pickup-work-copy';
import { problemOf, PROBLEM_COPY } from './problem-copy';

/**
 * The words of the screens of the door and the failure (S1.30), in the one table the Ops Portal keeps, keyed by operation, context and code. Proposed for the Product Owner to review with the
 * composed screens. The tests pin that each refused act names its own capability and no key or role, that a refusal which declares a rule is worded by the rule, that a refused note
 * says what to change and never repeats it, and that no wording draws a code, a digest or a phone number, or names an officer.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });

const conflict = (rule: string | undefined): OperationFailure =>
  new OperationFailure(refused('STATE_CONFLICT', 409), [], rule === undefined ? {} : { rule });

const OPERATIONS = [
  'listPickupFailures',
  'listHandshakesForOps',
  'listCollectionShortfalls',
  'listCollectionDisputes',
  'listPickupStopEvidence',
  'createEvidenceRetrievalAuthorization',
  'authoriseHandshakeOverride',
  'resolveHandshake',
  'authoriseParcelPhotoException',
];

const ACTS = ['authoriseHandshakeOverride', 'resolveHandshake', 'authoriseParcelPhotoException'];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of PICKUP_WORK_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation these screens do not call', () => {
    for (const rule of PICKUP_WORK_COPY) expect(OPERATIONS, rule.text).toContain(rule.operation);
  });

  // Break caught: an operation of these screens with no words of its own, so a refusal of it is told as a generic failure.
  it('has words for every operation of these screens', () => {
    for (const operation of OPERATIONS) {
      expect(
        PICKUP_WORK_COPY.some(
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
    const mine = PICKUP_WORK_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(
      PROBLEM_COPY.filter((rule) => !PICKUP_WORK_COPY.includes(rule)).map(place),
    );
    for (const each of mine) expect(others.has(each), each).toBe(false);
    expect(
      PICKUP_WORK_COPY.some((rule) => PICKUP_COPY.includes(rule) || MANIFEST_COPY.includes(rule)),
    ).toBe(false);
  });
});

describe('the words of the refusals of authority', () => {
  // Break caught (PRODUCT_DESIGN_DIRECTION section 6.5): a refusal that names a key, or the wrong act, so that an administrator is asked to grant the wrong access.
  it.each([
    ['listPickupFailures', /escalate or reschedule a failed pickup/, 'pickup.failure.resolve'],
    [
      'listHandshakesForOps',
      /work the handshakes, short counts and photo exceptions/,
      'pickup.handshake.override',
    ],
    [
      'listCollectionShortfalls',
      /work the handshakes, short counts and photo exceptions/,
      'pickup.handshake.override',
    ],
    ['listCollectionDisputes', /see collection disputes/, 'pickup.read'],
    ['listPickupStopEvidence', /see pickup runs/, 'pickup.read'],
    ['createEvidenceRetrievalAuthorization', /see pickup runs/, 'pickup.read'],
    [
      'authoriseHandshakeOverride',
      /work the handshakes, short counts and photo exceptions/,
      'pickup.handshake.override',
    ],
    ['resolveHandshake', /resolve a pickup’s handshake by hand/, 'pickup.handshake.resolve'],
    [
      'authoriseParcelPhotoException',
      /work the handshakes, short counts and photo exceptions/,
      'pickup.handshake.override',
    ],
  ])(
    'tells a refusal of %s as what the account cannot do, without the key',
    (operation, words, key) => {
      const problem = problemOf(refused('PERMISSION_DENIED', 403), { operation });

      expect(problem.kind).toBe('forbidden');
      expect(problem.message).toMatch(/Your account can’t /);
      expect(problem.message).toMatch(words);
      expect(problem.message).toMatch(/Ask an administrator for access\.$/);
      expect(problem.message).not.toContain(key);
    },
  );

  // Break caught (surfaces/ops-portal.md section 7): the refusal of a hand resolution told as any other missing access, so the officer is not told who decides it.
  it('tells a refusal of a resolution by hand as a senior officer’s decision', () => {
    const problem = problemOf(refused('PERMISSION_DENIED', 403), { operation: 'resolveHandshake' });

    expect(problem.message).toMatch(/^A senior officer decides this./);
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), { operation: 'authoriseHandshakeOverride' })
        .message,
    ).not.toMatch(/senior officer/);
  });

  it('tells a stop of another hub as that, for each operation that names one', () => {
    for (const operation of [
      'listPickupStopEvidence',
      'createEvidenceRetrievalAuthorization',
      ...ACTS,
    ]) {
      const problem = problemOf(refused('HUB_SCOPE_VIOLATION', 403), { operation });

      expect(problem.forbidden, operation).toBe('outside-hubs');
      expect(problem.message, operation).toMatch(/hub your account does not work in/);
    }
  });
});

describe('a refusal of an act that declares its rule is worded by the rule', () => {
  // Break caught: six different reasons for a refused handshake all told as "this changed", so the officer reloads what cannot work.
  it.each([
    [
      'authoriseHandshakeOverride',
      'stop_not_arrived',
      /has not arrived at this stop, or the stop is already closed/,
    ],
    ['authoriseHandshakeOverride', 'run_not_in_progress', /run is not in progress/],
    ['authoriseHandshakeOverride', 'handshake_closed', /already ended/],
    ['resolveHandshake', 'handshake_not_started', /No code has been asked for/],
    ['resolveHandshake', 'code_live', /has not run out yet/],
    ['resolveHandshake', 'handshake_changed', /changed since the list was read/],
    ['authoriseParcelPhotoException', 'stop_not_arrived', /has not arrived at this stop/],
    ['authoriseParcelPhotoException', 'collection_recorded', /already recorded the count/],
    [
      'authoriseParcelPhotoException',
      'exception_exists',
      /already been let through without photos/,
    ],
  ])('tells %s refused by %s as that', (operation, rule, words) => {
    const problem = problemOf(conflict(rule), { operation });

    expect(problem.kind).toBe('conflict');
    expect(problem.rule).toBe(rule);
    expect(problem.message).toMatch(words);
    expect(problem.message).not.toContain(rule);
    // Not the operation's general conflict: the rule is what says what to do next.
    expect(problem.message).not.toBe(problemOf(conflict(undefined), { operation }).message);
  });

  // Break caught: a rule the table has no words for hiding the conflict's general words, or showing the rule itself.
  it.each(ACTS)(
    'tells a rule it has no words for as the operation’s own conflict, and never shows the rule (%s)',
    (operation) => {
      const problem = problemOf(conflict('some_new_rule'), { operation });

      expect(problem.message).toBe(problemOf(conflict(undefined), { operation }).message);
      expect(problem.message).not.toContain('some_new_rule');
    },
  );

  it('tells a count that was never recorded as that, for the two acts that need one', () => {
    for (const operation of ['authoriseHandshakeOverride', 'resolveHandshake']) {
      const problem = problemOf(refused('COLLECTION_NOT_RECORDED', 422), { operation });

      expect(problem.message, operation).toMatch(/has not recorded a count at this stop yet/);
    }
  });
});

describe('the words of a note that was not accepted', () => {
  // Break caught: a missing note told as a refused one, so the officer is sent to look for a mistake that is only an empty field.
  it.each(ACTS)('tells a missing note for %s as a note to write', (operation) => {
    const problem = problemOf(refused('REASON_REQUIRED', 422), { operation });

    expect(problem.kind).toBe('invalid');
    expect(problem.message).toBe('Write a note saying why.');
  });

  // Break caught: a refused note that repeats its words (the ledger refused it because of what they hold, and an officer's note is staff's own).
  it.each(ACTS)(
    'tells a refused note for %s by where it is and never by what it says (%s)',
    (operation) => {
      const failure = new OperationFailure(refused('VALIDATION_FAILED', 400), [
        { in: 'body', pointer: '/note', rule: 'format' },
      ]);
      const problem = problemOf(failure, { operation });

      expect(problem.message).toBe('Check the note marked below: it was not accepted as written.');
      expect(problem.violations).toEqual([{ in: 'body', pointer: '/note', rule: 'format' }]);
    },
  );
});

describe('the words of the lists that are filtered', () => {
  const refusedParameter = (pointer: string) =>
    new OperationFailure(refused('VALIDATION_FAILED', 400), [
      { in: 'query', pointer, rule: 'type' },
    ]);

  // Break caught: a refused filter worded as a refused page (or the other way round), so the way on offered is the wrong one.
  it.each(OPERATIONS.slice(0, 4))(
    'tells a filter of %s as a filter and a page as a page',
    (operation) => {
      const filter = problemOf(refusedParameter('/open'), { operation });
      const page = problemOf(refusedParameter('/page_token'), { operation, context: 'cursor' });

      expect(filter.message).toBe(
        'That filter was not accepted. Choose one of the views of the list.',
      );
      expect(page.message).toMatch(/That page of the list could not be opened/);
      expect(page.message).toMatch(/Go back to the first page/);
      expect(page.message).not.toBe(filter.message);
    },
  );
});

describe('what no wording of these screens may be', () => {
  it('has rules for these screens', () => {
    expect(PICKUP_WORK_COPY.length).toBeGreaterThan(40);
  });

  // Break caught: a role named where the capability belongs: roles are not the authority.
  it('names no role and no key', () => {
    for (const rule of PICKUP_WORK_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /Ops Staff|Senior Ops|Platform Admin|Finance|\bpickup\.[a-z_.]+/,
      );
    }
  });

  // Break caught: wording that draws a code, a digest or a phone number (the answers carry none, and a refusal that repeated one would show what the page must never show).
  it('draws no code, no digest and no phone number', () => {
    for (const rule of PICKUP_WORK_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /\bdigest\b|\bhash\b|\+233|\bphone number\b|\b\d{6}\b/i,
      );
    }
  });

  it('does not apologise or blame', () => {
    for (const rule of PICKUP_WORK_COPY) {
      expect(rule.text).not.toMatch(
        /sorry|oops|unfortunately|you failed|your fault|invalid input/i,
      );
    }
  });
});
