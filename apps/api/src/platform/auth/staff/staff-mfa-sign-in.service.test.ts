import { describe, expect, it } from 'vitest';

import { MfaChallengeExpiredError } from '../mfa/mfa-challenge-errors.js';
import type { MfaChallengeStore, StoredChallenge } from '../mfa/mfa-challenge-store.js';
import type { MfaFactorStore, StoredFactor } from '../mfa/mfa-factor-store.js';
import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type {
  FailedAttempt,
  IdentityDirectory,
  PrincipalSummary,
} from '../ports/identity-directory.port.js';
import type { TotpVerdict, TotpVerifier } from '../ports/totp-verifier.port.js';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work.port.js';
import type { IssueSessionRequest, SessionIssuer } from '../sessions/session-issuer.js';
import type { TrustedBrowserStore } from '../trusted-browsers/trusted-browser-store.js';
import { StaffMfaSignInService } from './staff-mfa-sign-in.service.js';

/**
 * The second step of the staff sign-in against fakes that record what was asked of them (S0.33).
 *
 * The database tests prove the operation end to end. This file pins what they cannot reach by timing: **the order in which the locks
 * are taken** (SECURITY_DESIGN.md §13.10a: policy, identity, session, business; the session issue takes the identity first and then,
 * in the steps of this operation, the challenge's row, so this operation takes the identity first and the challenge second: the other
 * order is a deadlock waiting for two requests for one challenge to interleave, a rare interleaving that two concurrent requests will
 * usually not reach), and **each layer of the defences that back one another up**, one at a time, with the others made to say yes:
 * the check that the identity still holds the credential that was proved (the decision's, and the issue protocol's), the single use of a
 * time step (the verifier's, and the one conditional update that records it) and the single use of a challenge. A layer that a test of
 * the whole cannot tell from the one beside it is a layer a change can remove unseen.
 */

const IDENTITY = '0192f0a1-7b3c-7d2e-8f41-a5b6c7d8e9f0';
const CHALLENGE = '0192f0a1-7b3c-7d2e-8f41-a5b6c7d8e9f1';
const FACTOR = '0192f0a1-7b3c-7d2e-8f41-a5b6c7d8e9f2';
const STEP = 59_000_000;
const HANDLE = Object.freeze({}) as TransactionHandle;

const pending: StoredChallenge = {
  id: CHALLENGE,
  staffIdentityId: IDENTITY,
  credentialGeneration: 1,
  issuedAt: new Date('2026-10-21T08:00:00Z'),
  expiresAt: new Date('2026-10-21T08:05:00Z'),
  state: 'PENDING',
  attemptCount: 0,
};

const active: PrincipalSummary = {
  ref: { type: 'STAFF', id: IDENTITY },
  status: 'ACTIVE',
  credentialGeneration: 1,
  credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
  bundleId: '5eed0001-0000-4000-8000-000000000002',
  authorizedHubIds: [],
};

const factor: StoredFactor = {
  id: FACTOR,
  staffIdentityId: IDENTITY,
  ordinal: 1,
  factorType: 'TOTP',
  status: 'ACTIVE',
  enrolledAt: new Date('2026-10-02T09:00:00Z'),
  revokedAt: null,
  lastVerifiedCounter: null,
  createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
  revokedBy: null,
  revocationReasonCode: null,
  createdEpisodeId: null,
  revocationEpisodeId: null,
};

interface Scenario {
  readonly challenge?: StoredChallenge;
  readonly identity?: PrincipalSummary;
  readonly factor?: StoredFactor;
  readonly verify?: (last: number | null) => TotpVerdict;
  /** What the conditional update that records a time step says (true: this request was the first to present it). */
  readonly stepRecorded?: boolean;
  /** What the consuming update says (true: this request was the first to use the challenge). */
  readonly consumed?: boolean;
  /** The lock is not in force at the decision and is in force by the time the session is issued (another request set it between). */
  readonly lockedInTheIssue?: boolean;
  /** The nth question about the lock (1 is the decision's, 2 the issue's, 3 the refusal's) and every later one finds it in force. */
  readonly lockedFromQuestion?: number;
  /** What the identity is when it is locked again after the decision (the refusal of a lost race is a transaction of its own). */
  readonly identityThen?: PrincipalSummary;
  /** What the challenge is when it is locked again after the decision. */
  readonly challengeThen?: StoredChallenge;
  /** Whether the challenge's time has passed when it is locked again after the decision. */
  readonly expiredThen?: boolean;
  /** What counting a failure against the credential answers. */
  readonly failedAttempt?: FailedAttempt;
  /** The consuming statement fails with this (the table's guard refusing it, or any other failure), instead of answering. */
  readonly consumeError?: Error;
  /** The trusted browsers the sixth one gives way to (the oldest of five). */
  readonly replacedIds?: readonly string[];
  /** Whether the role bundle is privileged when the session is issued (true unless a test says it stopped being). */
  readonly privileged?: boolean;
}

const accepted = (): TotpVerdict => ({ outcome: 'ACCEPTED', step: STEP });

/** A sentinel that no refusal looks like: the issue was reached and every step passed. */
class SessionWasIssued extends Error {}

const BROWSER = '0192f0a1-7b3c-7d2e-8f41-a5b6c7d8e9f3';
const OLDEST = '0192f0a1-7b3c-7d2e-8f41-a5b6c7d8e9f4';

function serviceWith(
  calls: string[],
  scenario: Scenario = {},
): {
  service: StaffMfaSignInService;
  verified: (number | null)[];
  events: AuditEventInput[];
  issued: IssueSessionRequest<unknown>[];
} {
  const verified: (number | null)[] = [];
  const events: AuditEventInput[] = [];
  const issued: IssueSessionRequest<unknown>[] = [];
  const record =
    <T>(name: string, value: T) =>
    (): Promise<T> => {
      calls.push(name);
      return Promise.resolve(value);
    };
  const unitOfWork: UnitOfWork = {
    run: (_context, work) => work(HANDLE),
    databaseNow: () => Promise.resolve(new Date()),
  };
  let lockQuestions = 0;
  let identityLocks = 0;
  const countedOnce: FailedAttempt = {
    counted: true,
    failedAttemptCount: 1,
    tipped: false,
    lockedUntil: null,
  };
  const directory: Pick<
    IdentityDirectory,
    'lockIdentity' | 'isCredentialLocked' | 'recordFailedAttempt' | 'clearFailedAttempts'
  > = {
    // The first lock is the decision's; a later one is the refusal of a lost race, a transaction of its own.
    lockIdentity: () => {
      calls.push('lockIdentity');
      identityLocks += 1;
      const first = scenario.identity ?? active;
      return Promise.resolve(identityLocks > 1 ? (scenario.identityThen ?? first) : first);
    },
    // The first question is the decision's; a later one is the issue's.
    isCredentialLocked: () => {
      calls.push('isCredentialLocked');
      lockQuestions += 1;
      const from = scenario.lockedFromQuestion ?? (scenario.lockedInTheIssue === true ? 2 : 0);
      return Promise.resolve(from > 0 && lockQuestions >= from);
    },
    recordFailedAttempt: record('recordFailedAttempt', scenario.failedAttempt ?? countedOnce),
    clearFailedAttempts: record('clearFailedAttempts', undefined),
  };
  let challengeLocks = 0;
  const challenges: Pick<
    MfaChallengeStore,
    'findById' | 'lockForDecision' | 'recordWrongCode' | 'consume' | 'end'
  > = {
    findById: record('findById', scenario.challenge ?? pending),
    // The first lock is the decision's; a later one is the refusal of a lost race.
    lockForDecision: () => {
      calls.push('lockForDecision');
      challengeLocks += 1;
      const first = scenario.challenge ?? pending;
      const later = challengeLocks > 1;
      return Promise.resolve({
        challenge: later ? (scenario.challengeThen ?? first) : first,
        expired: later && scenario.expiredThen === true,
      });
    },
    recordWrongCode: record('recordWrongCode', scenario.challenge ?? pending),
    consume: () => {
      calls.push('consume');
      return scenario.consumeError === undefined
        ? Promise.resolve(scenario.consumed ?? true)
        : Promise.reject(scenario.consumeError);
    },
    end: record('end', true),
  };
  const factors: Pick<MfaFactorStore, 'findActiveOf' | 'openSeed' | 'recordAcceptedStep'> = {
    findActiveOf: record('findActiveOf', scenario.factor ?? factor),
    openSeed: record('openSeed', new Uint8Array(20)),
    recordAcceptedStep: record('recordAcceptedStep', scenario.stepRecorded ?? true),
  };
  const trustedBrowsers: Pick<TrustedBrowserStore, 'issue'> = {
    issue: (_handle, request) => {
      calls.push('trustedBrowsers.issue');
      return Promise.resolve({
        browser: {
          id: BROWSER,
          staffIdentityId: request.staffIdentityId,
          factorId: request.factorId,
          label: request.label,
          createdAt: new Date('2026-10-21T08:00:00Z'),
          expiresAt: new Date('2026-10-28T08:00:00Z'),
          lastUsedAt: null,
          revokedAt: null,
          revocationCause: null,
        },
        replacedIds: scenario.replacedIds ?? [],
      });
    },
  };
  const totp: TotpVerifier = {
    newSeed: () => new Uint8Array(20),
    verify: (_seed, _code, last) => {
      verified.push(last);
      return (scenario.verify ?? accepted)(last);
    },
  };
  const audit: AuditWriter = {
    write: (_handle, event) => {
      calls.push('audit');
      events.push(event);
      return Promise.resolve();
    },
  };
  // The protocol, as far as this operation can tell: it runs the steps under the identity lock and, when they all pass, issues.
  const issuer: Pick<SessionIssuer, 'issue'> = {
    issue: async (input) => {
      calls.push('issue');
      issued.push(input);
      for (const step of input.steps ?? []) await step.run(HANDLE, active);
      throw new SessionWasIssued('every step passed');
    },
  };
  const service = new StaffMfaSignInService({
    unitOfWork,
    directory: directory as IdentityDirectory,
    challenges: challenges as MfaChallengeStore,
    factors: factors as MfaFactorStore,
    totp,
    issuer,
    audit,
    settings: { integer: () => Promise.resolve(5) },
    trustedBrowsers,
    tokens: { issue: () => ({ token: 'T'.repeat(43), hash: new Uint8Array(32) }) },
    isPrivileged: () => Promise.resolve(scenario.privileged ?? true),
  });
  return { service, verified, events, issued };
}

const complete = (service: StaffMfaSignInService): Promise<unknown> =>
  service.completeSignIn({ challengeId: CHALLENGE, code: '123456' });

describe('the trusted browser of the second step (staff-authentication.md §5.8), against fakes that record what was asked', () => {
  const remember = (service: StaffMfaSignInService): Promise<unknown> =>
    service.completeSignIn({
      challengeId: CHALLENGE,
      code: '123456',
      trustBrowser: true,
      browserLabel: 'Chrome on Windows',
    });

  // Break caught: a trusted browser made before the proofs are spent, so that a refusal after it (a race for the challenge or the step)
  // could leave one behind, or one made by a request that did not ask for it.
  it('makes the trusted browser after the code is spent and the count cleared, in the transaction of the session, and records both events', async () => {
    const calls: string[] = [];
    const { service, events, issued } = serviceWith(calls, { replacedIds: [OLDEST] });

    await expect(remember(service)).rejects.toBeInstanceOf(SessionWasIssued);

    const order = ['consume', 'recordAcceptedStep', 'clearFailedAttempts', 'trustedBrowsers.issue'];
    expect(order.map((name) => calls.indexOf(name))).toEqual(
      order.map((name) => calls.indexOf(name)).toSorted((a, b) => a - b),
    );
    expect(order.every((name) => calls.includes(name))).toBe(true);
    expect(issued).toHaveLength(1);
    expect(issued[0]?.secondFactor).toBe('TOTP');
    expect(events.map((event) => event.code)).toEqual([
      'auth.mfa.completed',
      'auth.trusted_browser.revoked',
      'auth.trusted_browser.issued',
    ]);
    expect(events[1]).toMatchObject({
      actor: { type: 'STAFF', id: IDENTITY },
      relatedIds: { trusted_browser_id: OLDEST },
      detail: { cause: 'REPLACED' },
    });
    expect(events[2]).toMatchObject({
      actor: { type: 'STAFF', id: IDENTITY },
      relatedIds: { trusted_browser_id: BROWSER, factor_id: FACTOR },
      detail: { label: 'Chrome on Windows' },
    });
    // the events carry no credential
    expect(JSON.stringify(events)).not.toContain('T'.repeat(43));
  });

  it('makes none unless the person asked, and none for a request that does not say', async () => {
    const calls: string[] = [];
    const { service, events } = serviceWith(calls);

    await expect(complete(service)).rejects.toBeInstanceOf(SessionWasIssued);
    await expect(
      service.completeSignIn({ challengeId: CHALLENGE, code: '123456', trustBrowser: false }),
    ).rejects.toBeInstanceOf(SessionWasIssued);

    expect(calls).not.toContain('trustedBrowsers.issue');
    expect(events.every((event) => !event.code.startsWith('auth.trusted_browser'))).toBe(true);
  });

  // Break caught: a trusted browser issued although the challenge was spent by another request, or the code's step was already accepted
  // (a replay), or the credential was locked in the meantime.
  it.each([
    ['a challenge another request consumed', { consumed: false }],
    ['a step another request recorded', { stepRecorded: false }],
    ['a lock set since the decision', { lockedInTheIssue: true }],
  ] as const)('makes none for %s', async (_name, scenario) => {
    const calls: string[] = [];
    const { service, events } = serviceWith(calls, scenario);

    await expect(remember(service)).rejects.not.toBeInstanceOf(SessionWasIssued);

    expect(calls).not.toContain('trustedBrowsers.issue');
    expect(events.every((event) => !event.code.startsWith('auth.trusted_browser'))).toBe(true);
  });

  // Break caught: a role that stopped being privileged between the two steps failing the sign-in with a refused insert (a 500 for a person who
  // proved their code) instead of being signed in as it is, with no trusted browser.
  it('makes none for a role that is no longer privileged, and still reaches the session', async () => {
    const calls: string[] = [];
    const { service, events } = serviceWith(calls, { privileged: false });

    await expect(remember(service)).rejects.toBeInstanceOf(SessionWasIssued);

    expect(calls).toContain('issue');
    expect(calls).not.toContain('trustedBrowsers.issue');
    expect(events.every((event) => !event.code.startsWith('auth.trusted_browser'))).toBe(true);
  });

  // Break caught: a wrong code that remembers the browser anyway.
  it('makes none for a wrong code', async () => {
    const calls: string[] = [];
    const { service } = serviceWith(calls, {
      verify: () => ({ outcome: 'REJECTED' }) as unknown as TotpVerdict,
    });

    await expect(remember(service)).rejects.toMatchObject({ code: 'MFA_PROOF_INVALID' });

    expect(calls).not.toContain('issue');
    expect(calls).not.toContain('trustedBrowsers.issue');
  });
});

describe('the second step of the staff sign-in, against fakes that record what was asked (S0.33)', () => {
  // Break caught: the challenge locked before the identity, which can deadlock against the session issue of a request for the same
  // challenge (see above).
  it('locks the identity first and the challenge second', async () => {
    const calls: string[] = [];
    const consumed: StoredChallenge = { ...pending, state: 'CONSUMED' };

    await expect(
      complete(serviceWith(calls, { challenge: consumed }).service),
    ).rejects.toMatchObject({
      code: 'CHALLENGE_UNUSABLE',
    });

    expect(calls.indexOf('lockIdentity')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('lockForDecision')).toBeGreaterThan(calls.indexOf('lockIdentity'));
    // and the challenge is read, without a lock, before either: it names the identity to lock
    expect(calls.indexOf('findById')).toBeLessThan(calls.indexOf('lockIdentity'));
  });

  // Break caught: the decision no longer compares the credential the challenge was issued on with the one the identity holds, leaving
  // the protocol's check under the lock as the only one. The decision's check ends the challenge before a code is looked at.
  it('refuses INVALID_CREDENTIALS and ends the challenge, before any code is verified, for a credential that was replaced', async () => {
    const calls: string[] = [];
    const replaced: PrincipalSummary = { ...active, credentialGeneration: 2 };
    const { service, verified } = serviceWith(calls, { identity: replaced });

    await expect(complete(service)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(calls).toContain('end');
    expect(calls).not.toContain('issue');
    expect(verified).toEqual([]);
  });

  // Break caught: the verifier is given no last accepted step, which leaves the conditional update that records a step as the only
  // thing standing against a replay. The update is made to say yes here, so the verifier is the layer on trial.
  it('refuses a code whose step the factor has already accepted, on the verifier’s word alone, and counts it as a wrong code', async () => {
    const calls: string[] = [];
    const replayed = (last: number | null): TotpVerdict =>
      last !== null && last >= STEP ? { outcome: 'REPLAYED', step: STEP } : accepted();
    const { service, verified } = serviceWith(calls, {
      factor: { ...factor, lastVerifiedCounter: String(STEP) },
      verify: replayed,
      stepRecorded: true,
    });

    await expect(complete(service)).rejects.toMatchObject({ code: 'MFA_PROOF_INVALID' });

    expect(verified).toEqual([STEP]);
    expect(calls).not.toContain('issue');
    expect(calls.filter((call) => call === 'recordWrongCode')).toHaveLength(1);
    expect(calls.filter((call) => call === 'recordFailedAttempt')).toHaveLength(1);
  });

  // Break caught: a lost race for the time step is raised as an internal error (a 500) instead of answered as the replay it is. The
  // verifier is made to say yes here, so the conditional update that records the step is the layer on trial.
  it('answers MFA_PROOF_INVALID, and counts it, when another request recorded the step between the decision and the issue', async () => {
    const calls: string[] = [];
    const { service } = serviceWith(calls, { verify: accepted, stepRecorded: false });

    await expect(complete(service)).rejects.toMatchObject({ code: 'MFA_PROOF_INVALID' });

    expect(calls).toContain('recordAcceptedStep');
    // the identity's count is not cleared by a refusal, and no session was issued
    expect(calls).not.toContain('clearFailedAttempts');
    expect(calls.filter((call) => call === 'recordWrongCode')).toHaveLength(1);
    expect(calls.filter((call) => call === 'recordFailedAttempt')).toHaveLength(1);
  });

  // Break caught: a lost race for the challenge is raised as an internal error, or the step is recorded although the challenge was
  // spent by another request (the proof would be spent by a request that is refused).
  it('answers CHALLENGE_UNUSABLE, and records no time step, when another request consumed the challenge first', async () => {
    const calls: string[] = [];
    const { service } = serviceWith(calls, { consumed: false });

    await expect(complete(service)).rejects.toMatchObject({ code: 'CHALLENGE_UNUSABLE' });

    expect(calls).toContain('consume');
    expect(calls).not.toContain('recordAcceptedStep');
    expect(calls).not.toContain('recordWrongCode');
  });

  /**
   * A challenge that could not be consumed was spent, ended or past its time, and which of them it was is judged again under the locks
   * of the refusal's own transaction (the audit of 21 October 2026, A06): a challenge that lapsed is answered as expired and ended as
   * such, never as one that is merely unusable; the table's guard refusing the consumption is the same answer once the issue rolled back.
   */
  describe('the refusal of a challenge it could not consume', () => {
    const afterConsume = (calls: string[]): string[] => calls.slice(calls.indexOf('consume'));

    it('answers CHALLENGE_UNUSABLE, and ends nothing, when another request consumed or ended it', async () => {
      const calls: string[] = [];
      const { service } = serviceWith(calls, {
        consumed: false,
        challengeThen: { ...pending, state: 'CONSUMED' },
      });

      await expect(complete(service)).rejects.toMatchObject({ code: 'CHALLENGE_UNUSABLE' });

      expect(afterConsume(calls)).not.toContain('end');
      expect(calls).not.toContain('recordAcceptedStep');
    });

    // Break caught: a challenge whose time ran out after the decision answered as "unusable" and left PENDING.
    it('answers CHALLENGE_EXPIRED, and ends it as expired, when its time ran out after the decision', async () => {
      const calls: string[] = [];
      const { service } = serviceWith(calls, { consumed: false, expiredThen: true });

      await expect(complete(service)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });

      expect(afterConsume(calls)).toContain('end');
      expect(calls).not.toContain('recordAcceptedStep');
      expect(calls).not.toContain('recordWrongCode');
    });

    it('answers CHALLENGE_EXPIRED, and ends nothing again, when another request already ended it as expired', async () => {
      const calls: string[] = [];
      const { service } = serviceWith(calls, {
        consumed: false,
        challengeThen: { ...pending, state: 'EXPIRED' },
      });

      await expect(complete(service)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });

      expect(afterConsume(calls)).not.toContain('end');
    });

    // Break caught: the guard's refusal of the consumption escaping as an internal error, or answered as anything but the expiry.
    it('answers CHALLENGE_EXPIRED, and ends it, when the table’s guard refused the consumption', async () => {
      const calls: string[] = [];
      const { service } = serviceWith(calls, {
        consumeError: new MfaChallengeExpiredError(),
        expiredThen: true,
      });

      await expect(complete(service)).rejects.toMatchObject({ code: 'CHALLENGE_EXPIRED' });

      expect(afterConsume(calls)).toContain('end');
      expect(calls).not.toContain('recordAcceptedStep');
      expect(calls).not.toContain('clearFailedAttempts');
      expect(calls).not.toContain('recordWrongCode');
    });

    // Break caught (the audit: "do not swallow"): any other failure of the consumption, an unknown commit among them, answered as a refusal.
    it('raises every other failure of the consumption as it was, and answers nothing', async () => {
      const calls: string[] = [];
      const failure = new Error('the database failed');
      const { service } = serviceWith(calls, { consumeError: failure });

      await expect(complete(service)).rejects.toBe(failure);

      expect(afterConsume(calls)).not.toContain('end');
      expect(calls.filter((call) => call === 'audit')).toHaveLength(0);
    });
  });

  // Break caught: the lost-race refusal counting the wrong code on the challenge before it holds the identity, the opposite order to
  // every other path (identity, then challenge), which can deadlock against a request that holds the identity and asks for the
  // challenge. The refusal is a transaction of its own, so it takes the identity's lock again before it counts.
  it('takes the identity’s lock before it counts a replay it lost the race for', async () => {
    const calls: string[] = [];
    const { service } = serviceWith(calls, { verify: accepted, stepRecorded: false });

    await expect(complete(service)).rejects.toMatchObject({ code: 'MFA_PROOF_INVALID' });

    const refusal = calls.slice(calls.indexOf('recordAcceptedStep'));
    expect(refusal.indexOf('lockIdentity')).toBeGreaterThanOrEqual(0);
    expect(refusal.indexOf('lockIdentity')).toBeLessThan(refusal.indexOf('recordWrongCode'));
    expect(refusal.indexOf('lockIdentity')).toBeLessThan(refusal.indexOf('recordFailedAttempt'));
  });

  // Break caught: the lock read once, at the decision, so that a correct code whose request was already in flight when the fifth
  // failure set the lock is given its session, and the issue clears the lock it never saw. The lock is judged again in the issue.
  it('answers CREDENTIAL_LOCKED, and spends no proof, when the lock was set between the decision and the issue', async () => {
    const calls: string[] = [];
    const { service } = serviceWith(calls, { lockedInTheIssue: true });

    await expect(complete(service)).rejects.toMatchObject({ code: 'CREDENTIAL_LOCKED' });

    expect(calls.filter((call) => call === 'isCredentialLocked')).toHaveLength(2);
    expect(calls).not.toContain('consume');
    expect(calls).not.toContain('recordAcceptedStep');
    expect(calls).not.toContain('clearFailedAttempts');
    expect(calls).not.toContain('recordWrongCode');
  });

  /**
   * The refusal of a lost race is a transaction of its own, so what the decision judged is judged again before it counts (the audit of
   * 21 October 2026, A03): a replay is counted on the identity's credential and on the challenge only if the identity can still sign
   * in as the credential the challenge was issued on and the challenge is still live and unspent.
   */
  describe('the refusal of a replay it lost the race for', () => {
    const lost = { verify: accepted, stepRecorded: false } as const;
    const nothingCounted = (calls: string[]): void => {
      expect(calls).not.toContain('recordWrongCode');
      expect(calls).not.toContain('recordFailedAttempt');
      expect(calls).not.toContain('clearFailedAttempts');
    };

    // Break caught: the count of a proof of an old credential given to the credential that replaced it.
    it.each([
      ['replaced', { ...active, credentialGeneration: 2 }],
      ['suspended', { ...active, status: 'SUSPENDED' }],
      ['offboarded', { ...active, status: 'OFFBOARDED' }],
    ] as const)(
      'counts nothing, and ends the challenge, when the identity was %s since the decision',
      async (_what, then) => {
        const calls: string[] = [];
        const { service } = serviceWith(calls, { ...lost, identityThen: then });

        await expect(complete(service)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

        nothingCounted(calls);
        expect(calls.slice(calls.indexOf('recordAcceptedStep'))).toContain('end');
      },
    );

    // Break caught: a wrong code counted on a challenge that another request consumed, ended or let lapse.
    it.each([
      ['consumed', { ...pending, state: 'CONSUMED' }, false, 'CHALLENGE_UNUSABLE'],
      ['ended', { ...pending, state: 'UNUSABLE' }, false, 'CHALLENGE_UNUSABLE'],
      ['past its time', pending, true, 'CHALLENGE_EXPIRED'],
    ] as const)(
      'counts nothing when the challenge was %s since the decision',
      async (_what, challengeThen, expiredThen, code) => {
        const calls: string[] = [];
        const { service } = serviceWith(calls, { ...lost, challengeThen, expiredThen });

        await expect(complete(service)).rejects.toMatchObject({ code });

        nothingCounted(calls);
      },
    );

    it('announces a lock that was set since the decision, and counts nothing', async () => {
      const calls: string[] = [];
      const { service } = serviceWith(calls, { ...lost, lockedFromQuestion: 3 });

      await expect(complete(service)).rejects.toMatchObject({ code: 'CREDENTIAL_LOCKED' });

      nothingCounted(calls);
    });

    it('counts a replay of a decision that still stands, once on the identity and once on the challenge', async () => {
      const calls: string[] = [];
      const { service } = serviceWith(calls, lost);

      await expect(complete(service)).rejects.toMatchObject({ code: 'MFA_PROOF_INVALID' });

      expect(calls.filter((call) => call === 'recordFailedAttempt')).toHaveLength(1);
      expect(calls.filter((call) => call === 'recordWrongCode')).toHaveLength(1);
    });
  });

  // Break caught: a wrong code counted on the challenge although the failure was counted on no credential (the generation the count was
  // made against is not the identity's), or one answered as an ordinary wrong code.
  it('ends the challenge and counts nothing when the credential the code was checked against is stale', async () => {
    const calls: string[] = [];
    const { service } = serviceWith(calls, {
      verify: () => ({ outcome: 'REJECTED' }),
      failedAttempt: { counted: false, reason: 'STALE' },
    });

    await expect(complete(service)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    expect(calls).not.toContain('recordWrongCode');
    expect(calls).toContain('end');
  });

  // The control of the four above: with every layer saying yes the fakes do reach the issue, so a refusal in those tests is a layer
  // refusing and never the fakes failing before it.
  it('reaches the issue when every layer says yes', async () => {
    const calls: string[] = [];

    await expect(complete(serviceWith(calls).service)).rejects.toBeInstanceOf(SessionWasIssued);

    expect(calls.indexOf('consume')).toBeLessThan(calls.indexOf('recordAcceptedStep'));
    expect(calls.indexOf('recordAcceptedStep')).toBeLessThan(calls.indexOf('clearFailedAttempts'));
  });
});
