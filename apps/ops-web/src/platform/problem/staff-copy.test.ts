import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { copyFor, problemOf, PROBLEM_COPY } from './problem-copy';

/**
 * The words of the six identity screens (S0.44), in the one table the Ops Portal keeps, keyed by operation, context and code
 * (COMPONENT_PATTERNS section 33). Proposed here for the Product Owner to review with the composed screens. The tests pin what each
 * refusal says, that the three refusals of authority stay three different sentences, and that none of the wording can name a role, show a
 * credential or repeat a value.
 */
const refused = (code: string | undefined, status: number): ApiError =>
  new ApiError({ kind: 'http', status, ...(code === undefined ? {} : { code }) });

describe('the words of the reads', () => {
  it.each([
    ['listStaffIdentities', undefined, 500, 'The staff list could not be loaded.'],
    [
      'listStaffIdentities',
      'VALIDATION_FAILED',
      400,
      'That search was not accepted. Use at most 128 characters.',
    ],
    ['getStaffIdentity', undefined, 500, 'This profile could not be loaded.'],
    [
      'getStaffIdentity',
      'NOT_FOUND',
      404,
      'This profile could not be found. It may have been removed, or the link may be wrong.',
    ],
    [
      'listAssignableStaffRoleBundles',
      undefined,
      500,
      'The roles could not be loaded, so a profile cannot be created now.',
    ],
    ['listSessions', undefined, 500, 'The sessions could not be loaded.'],
    ['listSessions', 'NOT_FOUND', 404, 'That person could not be found.'],
  ])('%s %s %s says %j', (operation, code, status, message) => {
    expect(problemOf(refused(code, status), { operation }).message).toBe(message);
  });
});

describe('the words of creating a profile', () => {
  it('says a duplicate address is already a profile, as the refusal of the whole request', () => {
    expect(
      problemOf(refused('WORK_EMAIL_IN_USE', 409), { operation: 'createStaffIdentity' }),
    ).toMatchObject({
      kind: 'refused',
      message: 'A profile with this email address already exists.',
    });
  });

  // Break caught: a field refused in words that belong to another field, or in the server's.
  it.each([
    ['work_email', 'VALIDATION_FAILED', 'Enter an email address, for example name@example.com.'],
    ['full_name', 'VALIDATION_FAILED', 'Enter the person’s full name.'],
    [
      'phone',
      'VALIDATION_FAILED',
      'Enter the number with its country code, for example +233 24 000 0000.',
    ],
    ['role_bundle_id', 'VALIDATION_FAILED', 'Choose a role from the list.'],
    ['primary_hub_id', 'VALIDATION_FAILED', 'Choose one of your hubs.'],
    [
      'primary_hub_id',
      'HUB_SCOPE_VIOLATION',
      'You cannot place a profile in that hub. Choose one of your hubs.',
    ],
  ])('words %s for %s', (context, code, message) => {
    expect(copyFor({ operation: 'createStaffIdentity', context, code })).toBe(message);
  });

  it('says what a lost answer may mean', () => {
    expect(copyFor({ operation: 'createStaffIdentity', context: 'unknown-outcome' })).toBe(
      'We could not confirm whether the profile was created. You can try again: if it was already created, it is not created twice.',
    );
  });
});

describe('the words of deciding a profile', () => {
  // Break caught (ops-portal.md section 7): three refusals of authority told as one, so that nobody can tell which fix to ask for.
  it('tells the three refusals of authority in three different sentences', () => {
    const said = (code: string): string =>
      problemOf(refused(code, 403), { operation: 'approveStaffIdentity' }).message;

    expect(said('SELF_APPROVAL_FORBIDDEN')).toBe(
      'Only a Platform Admin can approve or reject a profile they made. Ask a different approver to decide this one.',
    );
    expect(said('INSUFFICIENT_AUTHORITY')).toBe(
      'This role needs a higher authority to decide. Ask a Platform Admin.',
    );
    expect(said('PERMISSION_DENIED')).toBe(
      'Your session does not hold the permission to approve or reject profiles (staff.identity.approve).',
    );
    expect(
      new Set([
        said('SELF_APPROVAL_FORBIDDEN'),
        said('INSUFFICIENT_AUTHORITY'),
        said('PERMISSION_DENIED'),
      ]).size,
    ).toBe(3);
  });

  it('keeps the kinds of the refusals, so the screen can tell them apart', () => {
    expect(
      problemOf(refused('SELF_APPROVAL_FORBIDDEN', 422), { operation: 'approveStaffIdentity' }),
    ).toMatchObject({ kind: 'forbidden', forbidden: 'approval-required' });
    expect(
      problemOf(refused('INSUFFICIENT_AUTHORITY', 403), { operation: 'approveStaffIdentity' }),
    ).toMatchObject({ kind: 'forbidden', forbidden: 'insufficient-authority' });
    expect(
      problemOf(refused('HUB_SCOPE_VIOLATION', 403), { operation: 'approveStaffIdentity' }),
    ).toMatchObject({ kind: 'forbidden', forbidden: 'outside-hubs' });
  });

  it('says the record changed, and perhaps who changed it', () => {
    expect(
      problemOf(refused('STATE_CONFLICT', 409), { operation: 'approveStaffIdentity' }),
    ).toMatchObject({
      kind: 'conflict',
      message:
        'This profile changed after you opened it, perhaps because someone else has already decided it. Reload it to see where it stands.',
    });
  });
});

describe('the words that are told whatever the act', () => {
  // Break caught (ops-portal.md section 7): a failed delivery told as a failure of the act, when nothing was changed and the act can be tried again.
  it.each(['approveStaffIdentity', 'reissueStaffCredentialSetup', 'resetStaffMfa'])(
    'tells a failed delivery for %s as nothing changed',
    (operation) => {
      const problem = problemOf(refused('CREDENTIAL_DELIVERY_FAILED', 422), { operation });

      expect(problem.message).toBe(
        'Nothing was changed. The message channel is not available yet, so the link could not be sent. You can try again once it is.',
      );
    },
  );

  it.each([
    ['approveStaffIdentity', 'This profile belongs to a hub your session does not act in.'],
    ['reissueStaffCredentialSetup', 'This profile belongs to a hub your session does not act in.'],
  ])('says a profile in another hub is in another hub for %s', (operation, message) => {
    expect(problemOf(refused('HUB_SCOPE_VIOLATION', 403), { operation }).message).toBe(message);
  });
});

describe('the words of sending a setup link again', () => {
  // The contract gives this act two reasons for STATE_CONFLICT and no version check: the profile already has a password (a first setup
  // link is for a profile that has none), or it is a bootstrap administrator (their address was never verified by an approval).
  it('says why a new setup link cannot be sent, in the two causes the contract gives', () => {
    expect(
      problemOf(refused('STATE_CONFLICT', 409), { operation: 'reissueStaffCredentialSetup' }),
    ).toMatchObject({
      kind: 'conflict',
      message:
        'A new setup link cannot be sent. This person has already set a password, or is a bootstrap administrator.',
    });
  });

  it('names the permission when it is missing', () => {
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), { operation: 'reissueStaffCredentialSetup' })
        .message,
    ).toBe(
      'Your session does not hold the permission to send setup links (staff.identity.approve).',
    );
  });
});

describe('the words of resetting an authenticator', () => {
  it('says a person cannot reset their own', () => {
    expect(
      problemOf(refused('SELF_APPROVAL_FORBIDDEN', 422), { operation: 'resetStaffMfa' }).message,
    ).toBe('You cannot reset your own authenticator. Another Platform Admin has to do it.');
  });

  it('says the record changed or cannot be reset as it stands', () => {
    expect(problemOf(refused('STATE_CONFLICT', 409), { operation: 'resetStaffMfa' }).message).toBe(
      'This profile changed after you opened it, or its authenticator cannot be reset as it stands. Reload it to see where it stands.',
    );
  });

  it('names the permission when it is missing', () => {
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), { operation: 'resetStaffMfa' }).message,
    ).toBe('Your session does not hold the permission to reset authenticators (staff.mfa.reset).');
  });
});

describe('the words of ending a session', () => {
  it('says plainly that the tier is not the session’s', () => {
    expect(
      problemOf(refused('INSUFFICIENT_AUTHORITY', 403), { operation: 'revokeSession' }).message,
    ).toBe(
      'Your session cannot end this person’s sessions. Staff and vendor sessions are ended by a Platform Admin.',
    );
    expect(
      problemOf(refused('INSUFFICIENT_AUTHORITY', 403), { operation: 'listSessions' }).message,
    ).toBe(
      'Your session cannot see this person’s sessions. Staff and vendor sessions are seen by a Platform Admin.',
    );
  });

  it('says a session that is gone is gone', () => {
    expect(problemOf(refused('NOT_FOUND', 404), { operation: 'revokeSession' }).message).toBe(
      'This session has already ended or no longer exists.',
    );
  });

  it('names the permission when it is missing', () => {
    expect(
      problemOf(refused('PERMISSION_DENIED', 403), { operation: 'revokeSession' }).message,
    ).toBe('Your session does not hold the permission to end sessions (staff.session.revoke).');
  });
});

describe('what no wording of these screens may be', () => {
  const identity = PROBLEM_COPY.filter((rule) =>
    [
      'listStaffIdentities',
      'getStaffIdentity',
      'listAssignableStaffRoleBundles',
      'createStaffIdentity',
      'approveStaffIdentity',
      'reissueStaffCredentialSetup',
      'resetStaffMfa',
      'listSessions',
      'revokeSession',
    ].includes(rule.operation ?? ''),
  );

  it('has rules for these screens', () => {
    expect(identity.length).toBeGreaterThan(30);
  });

  // Break caught: wording that talks about a password, a token or a link's address as if the screen could show one. It says what was
  // done and what the person can do; the credential itself is never anywhere near.
  it('never mentions a token, a secret or a link address', () => {
    for (const rule of identity) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /token|secret|https?:|#|hash/i,
      );
    }
  });

  // Break caught: a sentence that blames the person, apologises, or hides the next step.
  it('does not apologise or blame', () => {
    for (const rule of identity) {
      expect(rule.text, `${rule.operation ?? ''} ${rule.code ?? ''}`).not.toMatch(
        /sorry|oops|unfortunately|you failed|your fault|invalid input/i,
      );
    }
  });
});
