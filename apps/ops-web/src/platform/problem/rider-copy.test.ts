import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { copyFor, problemOf, PROBLEM_COPY } from './problem-copy';
import { RIDER_COPY } from './rider-copy';

/**
 * The words of the rider screens (S0.60), in the one table the Ops Portal keeps, keyed by operation, context and code (COMPONENT_PATTERNS
 * section 33). Proposed here for the Product Owner to review with the composed screens. The tests pin what each refusal says, that each refused
 * act names its own permission, and that none of the wording can name a role, show a credential or promise what the API does not.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });

const OPERATIONS = [
  'listRiders',
  'getRider',
  'registerRiderDevice',
  'reregisterRiderDevice',
  'revokeRiderDevice',
];

describe('the words of the table', () => {
  it('are in the table the screens read', () => {
    for (const rule of RIDER_COPY) expect(PROBLEM_COPY).toContain(rule);
  });

  // Break caught: a rule written for a place nothing asks for, which is words nobody will ever read.
  it('has no rule for an operation the rider screens do not have', () => {
    for (const rule of RIDER_COPY) {
      expect(OPERATIONS, rule.text).toContain(rule.operation);
    }
  });

  it('has no two rules for the same place', () => {
    const places = RIDER_COPY.map(
      (rule) => `${rule.operation ?? ''}|${rule.context ?? ''}|${rule.code ?? ''}`,
    );
    expect(new Set(places).size).toBe(places.length);
  });
});

describe('the words of the reads', () => {
  it.each([
    ['listRiders', undefined, 500, 'The riders could not be loaded.'],
    [
      'listRiders',
      'VALIDATION_FAILED',
      400,
      'That search was not accepted. Use at most 128 characters.',
    ],
    ['getRider', undefined, 500, 'This rider could not be loaded.'],
    ['getRider', 'NOT_FOUND', 404, 'This rider could not be found.'],
    [
      'getRider',
      'HUB_SCOPE_VIOLATION',
      403,
      'This rider belongs to a hub your session does not act in.',
    ],
  ])('%s %s %s says %j', (operation, code, status, message) => {
    expect(problemOf(refused(code, status), { operation }).message).toBe(message);
  });
});

describe('the words of the acts on a rider’s device', () => {
  // Break caught (ops-portal.md section 7): a refusal of authority that names the wrong key, so that an administrator is asked to grant the
  // wrong permission.
  it.each([
    ['registerRiderDevice', 'staff.device.register'],
    ['reregisterRiderDevice', 'staff.device.reregister'],
    ['revokeRiderDevice', 'staff.device.revoke'],
  ])('tells a refusal of %s as the lack of %s', (operation, key) => {
    const problem = problemOf(refused('PERMISSION_DENIED', 403), { operation });

    expect(problem.message).toContain(`(${key})`);
    expect(problem.message).not.toMatch(/Ops Staff|Senior Ops|Platform Admin/);
  });

  it.each(OPERATIONS.slice(2))('tells a rider in another hub as that, for %s', (operation) => {
    const problem = problemOf(refused('HUB_SCOPE_VIOLATION', 403), { operation });

    expect(problem).toMatchObject({ kind: 'forbidden', forbidden: 'outside-hubs' });
    expect(problem.message).toMatch(/hub your session does not act in|own hub/);
  });

  it.each(OPERATIONS.slice(2))('tells a rider that is not there as that, for %s', (operation) => {
    expect(problemOf(refused('NOT_FOUND', 404), { operation }).message).toBe(
      'This rider could not be found.',
    );
  });

  // A refusal with no meaning of its own (a failed check of the request's origin, say) is worded as the operation's general failure.
  it.each(OPERATIONS.slice(2))(
    'words a refusal that has no words of its own as the operation’s own, for %s',
    (operation) => {
      const text = copyFor({ operation });

      expect(text).toBeDefined();
      expect(problemOf(refused('CSRF_VALIDATION_FAILED', 403), { operation }).message).toBe(text);
    },
  );

  // Break caught: a refusal of a request the officer wrote nothing in told as a mistake of theirs ("what was entered").
  it('does not tell a refusal of the registration as a mistake in what was entered', () => {
    expect(
      problemOf(refused('VALIDATION_FAILED', 400), { operation: 'registerRiderDevice' }).message,
    ).toBe('The code could not be made. Nothing was changed.');
  });

  it('says a first device cannot be registered, in the causes it has, and not as a replacement', () => {
    const problem = problemOf(refused('STATE_CONFLICT', 409), { operation: 'registerRiderDevice' });

    expect(problem.kind).toBe('conflict');
    expect(problem.message).toMatch(/already has an active device, or has had one revoked/);
    expect(problem.message).toMatch(/a replacement binds the rider again/);
  });

  it('says a replacement cannot be registered, in the causes it has, and not as a first device', () => {
    const problem = problemOf(refused('STATE_CONFLICT', 409), {
      operation: 'reregisterRiderDevice',
    });

    expect(problem.kind).toBe('conflict');
    expect(problem.message).toMatch(/changed after you opened this page/);
    expect(problem.message).toMatch(/register a first one instead/);
  });

  it('words the verification note by its own context, and not the reason’s', () => {
    expect(
      copyFor({
        operation: 'reregisterRiderDevice',
        context: 'verification-note',
        code: 'VALIDATION_FAILED',
      }),
    ).toBe(
      'Say how you verified the rider’s identity in person, in one line. Leave out email addresses and telephone numbers.',
    );
    expect(
      copyFor({
        operation: 'reregisterRiderDevice',
        context: 'verification-note',
        code: 'REASON_REQUIRED',
      }),
    ).toBe('Say how you verified the rider’s identity in person.');
  });

  // Break caught: a lost answer worded as a refusal, or one that promises a retry for an act that takes no key.
  it('says what a lost answer may mean, in the way out each act has', () => {
    expect(copyFor({ operation: 'registerRiderDevice', context: 'unknown-outcome' })).toBe(
      'We could not confirm whether the code was made. Try again: the same attempt is repeated safely, and no second code is made.',
    );
    const replaced = copyFor({ operation: 'reregisterRiderDevice', context: 'unknown-outcome' });
    expect(replaced).toMatch(/a new code ends any earlier one/);
    expect(replaced).not.toMatch(/Try again/);
  });
});

describe('what no wording of these screens may be', () => {
  it('has rules for these screens', () => {
    expect(RIDER_COPY.length).toBeGreaterThan(20);
  });

  // Break caught: wording that talks about a PIN, a key or a code's content as if the screen could show one. It says what was done and what
  // the officer can do; the credential itself is never anywhere near.
  it('never mentions a token, a secret, a key made by the handset, a hash or an address', () => {
    for (const rule of RIDER_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /token|secret|private key|public key|https?:|melarc-rider|#|hash/i,
      );
    }
  });

  // Break caught: a sentence that blames the person, apologises, or hides the next step.
  it('does not apologise or blame', () => {
    for (const rule of RIDER_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /sorry|oops|unfortunately|you failed|your fault|invalid input/i,
      );
    }
  });

  // Break caught: a role named where the permission key belongs: roles are not the authority (never authorize on role names).
  it('names no role', () => {
    for (const rule of RIDER_COPY) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /Ops Staff|Senior Ops|Platform Admin|\bRider Admin\b/,
      );
    }
  });
});
