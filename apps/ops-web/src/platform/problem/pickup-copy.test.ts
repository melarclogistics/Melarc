import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { PICKUP_COPY } from './pickup-copy';
import { copyFor, problemOf, PROBLEM_COPY } from './problem-copy';

/**
 * The words of the pickup screens (S1.19), in the one table the Ops Portal keeps, keyed by operation, context and code (COMPONENT_PATTERNS
 * section 33). Proposed for the Product Owner to review with the composed screens. The tests pin that each refused act names its own permission
 * key and no role, that a rule is told as the rule with what to do next, and that no wording states an amount the screen was not given.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });

const OPERATIONS = [
  'listPickupRequests',
  'getPickupRequest',
  'findAdHocSender',
  'listVendorPickupLocations',
  'listVendorAccounts',
  'listReasonDefinitions',
  'createPickupRequest',
  'confirmPickupRequest',
  'cancelPickupRequest',
  'resolveCutoffException',
  'escalatePickupRequest',
  'extendPickupAttempts',
  'waiveCancellationCharge',
  'requestOnePackageException',
  'approveOnePackageException',
];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of PICKUP_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation the pickup screens do not call', () => {
    for (const rule of PICKUP_COPY) expect(OPERATIONS, rule.text).toContain(rule.operation);
  });

  it('has no two rules for the same place, here or in the rest of the table', () => {
    const place = (rule: { operation?: string; context?: string; code?: string }) =>
      `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`;
    const mine = PICKUP_COPY.map(place);
    expect(new Set(mine).size).toBe(mine.length);
    const others = new Set(PROBLEM_COPY.filter((rule) => !PICKUP_COPY.includes(rule)).map(place));
    for (const each of mine) expect(others.has(each), each).toBe(false);
  });
});

describe('the words of the refusals of authority', () => {
  // Break caught (ops-portal.md section 7): a refusal that names the wrong key, so an administrator is asked to grant the wrong permission.
  it.each([
    ['createPickupRequest', 'pickup.request.create'],
    ['confirmPickupRequest', 'pickup.request.confirm'],
    ['cancelPickupRequest', 'pickup.request.cancel'],
    ['resolveCutoffException', 'pickup.request.confirm'],
    ['escalatePickupRequest', 'pickup.failure.resolve'],
    ['extendPickupAttempts', 'pickup.attempt.extend'],
    ['waiveCancellationCharge', 'pickup.cancellation_charge.waive'],
    ['requestOnePackageException', 'pickup.exception.request'],
    ['approveOnePackageException', 'pickup.exception.approve'],
  ])(
    'tells a refusal of %s as what the account cannot do, in plain words and without the key %s',
    (operation, key) => {
      const problem = problemOf(refused('PERMISSION_DENIED', 403), { operation });

      expect(problem.kind).toBe('forbidden');
      expect(problem.message).toMatch(
        /^Your account can’t .+\. Ask an administrator for access\.$/,
      );
      expect(problem.message).not.toContain(key);
    },
  );

  it('tells a post-assignment cancellation without its further access as that, and never by a key', () => {
    const { message } = problemOf(refused('PERMISSION_DENIED', 403), {
      operation: 'cancelPickupRequest',
    });

    expect(message).toMatch(/once a rider is assigned/);
    expect(message).not.toMatch(/pickup\.request\./);
  });

  // Break caught (permissions.md section 6): the maker-checker refusal told as a lack of access, or by a role or a key, instead of as the rule: a different
  // approver decides.
  it('tells an approval of one’s own exception as the rule, and that a different approver decides', () => {
    const problem = problemOf(refused('SELF_APPROVAL_FORBIDDEN', 422), {
      operation: 'approveOnePackageException',
    });

    expect(problem).toMatchObject({ kind: 'forbidden', forbidden: 'approval-required' });
    expect(problem.message).toBe(
      'You requested this exception yourself, so a different approver has to decide it.',
    );
  });

  // The contract declares no higher-authority refusal of an extension: only a senior grant carries the key, and a caller without it is refused
  // as without the key.
  it('has no words for a refusal the extension does not declare', () => {
    expect(
      PICKUP_COPY.some(
        (rule) =>
          rule.operation === 'extendPickupAttempts' && rule.code === 'INSUFFICIENT_AUTHORITY',
      ),
    ).toBe(false);
  });

  it.each(['getPickupRequest', 'confirmPickupRequest', 'cancelPickupRequest'])(
    'tells a request in another hub as that, for %s',
    (operation) => {
      const problem = problemOf(refused('HUB_SCOPE_VIOLATION', 403), { operation });

      expect(problem).toMatchObject({ kind: 'forbidden', forbidden: 'outside-hubs' });
      expect(problem.message).toBe(
        'This pickup request belongs to a hub your session does not act in.',
      );
    },
  );
});

describe('the words of the rules', () => {
  it.each([
    ['createPickupRequest', 'SERVICE_DATE_NOT_PERMITTED', /Monday to Saturday/],
    ['createPickupRequest', 'SENDER_SUSPENDED', /suspended.*held, not cancelled/],
    ['createPickupRequest', 'VALUE_DECLARATION_REQUIRED', /acknowledgement/],
    ['createPickupRequest', 'DESTINATION_UNRESOLVED', /no default saved location/],
    ['createPickupRequest', 'SENDER_IDENTITY_AMBIGUOUS', /not both/],
    ['confirmPickupRequest', 'PICKUP_MINIMUM_NOT_MET', /one-package exception is approved/],
    // An extension is made on a confirmed request only: a pending one past the limit is told the way on it has.
    ['confirmPickupRequest', 'PICKUP_ATTEMPT_LIMIT_REACHED', /cannot be confirmed.*cancelled/],
    ['cancelPickupRequest', 'SOURCE_STILL_ACTIVE', /never active together/],
    ['cancelPickupRequest', 'PICKUP_ATTEMPT_LIMIT_REACHED', /^Nothing was cancelled/],
    ['waiveCancellationCharge', 'NO_CHARGE_APPLIED', /nothing to waive/],
  ])('%s %s says the rule', (operation, code, words) => {
    expect(problemOf(refused(code, 422), { operation }).message).toMatch(words);
  });

  // Break caught: the way on after a reschedule refused at the limit offered to a person who cannot take it, or a refusal left as a dead end.
  it('says what comes after a reschedule refused at the limit by whether the person can extend', () => {
    const next = (context: string) =>
      copyFor({ operation: 'cancelPickupRequest', context, code: 'PICKUP_ATTEMPT_LIMIT_REACHED' });

    expect(next('extend-held')).toMatch(/^Extend the attempts on this page/);
    expect(next('extend-not-held')).not.toMatch(/^Extend/);
    expect(next('extend-not-held')).toMatch(/an extension that an approver gives/);
    expect(next('extend-not-held')).not.toMatch(/pickup\.attempt\.extend/);
    for (const context of ['extend-held', 'extend-not-held']) {
      expect(next(context)).toMatch(/escalated, or cancelled without a new attempt/);
    }
  });

  // S1.18: a state conflict of an extension is the plain fact that there is nothing to extend now, or a change, and the way on is a reload.
  it.each([
    ['extendPickupAttempts', /^There is nothing to extend.*Reload/],
    ['escalatePickupRequest', /already escalated.*Reload/],
    ['approveOnePackageException', /no longer waiting for approval.*Reload/],
    ['requestOnePackageException', /already waiting or approved/],
  ])('tells a conflict on %s as what it means', (operation, words) => {
    const problem = problemOf(refused('STATE_CONFLICT', 409), { operation });

    expect(problem.kind).toBe('conflict');
    expect(problem.message).toMatch(words);
  });

  // Break caught: a note refused for what it holds, repeated back or told as a general failure.
  it.each(['escalatePickupRequest', 'extendPickupAttempts'])(
    'tells a note refused by %s as the note, without its words',
    (operation) => {
      expect(problemOf(refused('VALIDATION_FAILED', 400), { operation }).message).toBe(
        'Check the note marked below: it was not accepted as written.',
      );
    },
  );

  // Break caught: a concurrent change told as a bare refusal (ops-portal.md section 8: STATE_CONFLICT explains what changed).
  it.each(['confirmPickupRequest', 'cancelPickupRequest', 'waiveCancellationCharge'])(
    'says the request changed for a conflict on %s, and to read it again',
    (operation) => {
      const problem = problemOf(refused('STATE_CONFLICT', 409), { operation });

      expect(problem.kind).toBe('conflict');
      expect(problem.message).toMatch(/changed after you opened it.*Reload/);
    },
  );

  it('says what a lost booking may mean, and that a retry books nothing twice', () => {
    expect(copyFor({ operation: 'createPickupRequest', context: 'unknown-outcome' })).toMatch(
      /not booked twice/,
    );
  });

  // Break caught: a lost exception request offered as safe to send again, when the act takes no key: the request's read shows one that arrived.
  it('does not tell a lost exception request to try again blindly', () => {
    const text = copyFor({ operation: 'requestOnePackageException', context: 'unknown-outcome' });
    expect(text).toMatch(/Check the request before you send it again/);
    expect(text).toMatch(/waiting for an approver/);
    expect(text).not.toContain('pickup.exception.approve');
  });
});

describe('what no wording of these screens may be', () => {
  it('has rules for these screens', () => {
    expect(PICKUP_COPY.length).toBeGreaterThan(40);
  });

  // Break caught: a role named where the permission key belongs: roles are not the authority.
  it('names no role', () => {
    for (const rule of PICKUP_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /Ops Staff|Senior Ops|Platform Admin|Finance/,
      );
    }
  });

  // Break caught: wording that states an amount or a price, which the screen never computes and the copy table cannot know.
  it('states no amount and calls nothing a price or a total', () => {
    for (const rule of PICKUP_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /GH₵|cedi|\btotal\b|\bprice\b|\d+\.\d\d/i,
      );
    }
  });

  it('does not apologise or blame', () => {
    for (const rule of PICKUP_COPY) {
      expect(rule.text).not.toMatch(
        /sorry|oops|unfortunately|you failed|your fault|invalid input/i,
      );
    }
  });
});
