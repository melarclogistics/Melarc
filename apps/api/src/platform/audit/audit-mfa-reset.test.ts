import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../auth/ports/audit-writer.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import { AuditRefusedError, buildAuditRecord } from './audit-record.js';

/**
 * The shape of `auth.mfa.reset` (`audit-mfa-reset.ts`; audit.md §5.4, "Facts of `auth.mfa.reset`"; state-machines.md §18). The
 * writer validates identifier types, closed states and the relations between the facts; it does not prove that an episode, a factor
 * or a grant exists or belongs to the target, which is the use case's under the identity's lock.
 */

const ID = '019a0000-0000-7000-8000-000000000001';
const NOW = new Date('2026-10-11T09:00:00.000Z');
const ADMIN = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const EPISODE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OLD_ONE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OLD_TWO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: ADMIN,
  surface: 'OPS_PORTAL',
  correlationId: 'request-1',
};

const build = (input: AuditEventInput, context: SecurityContext = STAFF) =>
  buildAuditRecord(input, context, NOW, ID);

const refusalOf = (run: () => unknown): AuditRefusedError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AuditRefusedError);
    return error as AuditRefusedError;
  }
  throw new Error('expected the event to be refused');
};

const base = {
  code: 'auth.mfa.reset',
  enhanced: true,
  outcome: 'SUCCEEDED',
  object: { type: 'StaffIdentity', id: TARGET },
} as const;

const UNAVAILABLE = {
  code: 'MFA_AUTHENTICATOR_UNAVAILABLE',
  label: 'The authenticator is unavailable',
};
const EXPIRED = { code: 'MFA_ENROLMENT_EXPIRED', label: 'The enrolment could not be completed' };
const REENROLMENT = { before: 'NONE', after: 'PENDING' } as const;

/** One valid example of each branch the state machine approves. */
const BRANCHES = {
  'a live factor is revoked': {
    ...base,
    reason: UNAVAILABLE,
    previousState: 'ACTIVE_FACTOR',
    resultingState: 'ISSUED',
    relatedIds: {
      episode_id: EPISODE,
      revoked_factor_id: FACTOR,
      new_grant_id: GRANT,
      superseded_grant_ids: [],
    },
    beforeAfter: {
      mfa_factor: { before: 'ACTIVE', after: 'REVOKED' },
      reenrolment_grant: REENROLMENT,
    },
  },
  'a stranded enrolment is revoked and two pending grants are superseded': {
    ...base,
    reason: EXPIRED,
    previousState: 'STRANDED_ENROLMENT',
    resultingState: 'ISSUED',
    relatedIds: {
      episode_id: EPISODE,
      revoked_factor_id: FACTOR,
      new_grant_id: GRANT,
      superseded_grant_ids: [OLD_ONE, OLD_TWO],
    },
    beforeAfter: {
      mfa_factor: { before: 'PENDING', after: 'REVOKED' },
      reenrolment_grant: REENROLMENT,
      superseded_grants: { before: 'PENDING', after: 'SUPERSEDED' },
    },
  },
  'an unfinished reset is resumed, with no factor to revoke': {
    ...base,
    reason: EXPIRED,
    previousState: 'UNFINISHED_RESET',
    resultingState: 'ISSUED',
    relatedIds: { episode_id: EPISODE, new_grant_id: GRANT, superseded_grant_ids: [] },
    beforeAfter: { reenrolment_grant: REENROLMENT },
  },
  'an unfinished reset is repeated while a usable grant exists, and nothing is issued': {
    ...base,
    reason: EXPIRED,
    previousState: 'UNFINISHED_RESET',
    resultingState: 'COALESCED',
    relatedIds: { episode_id: EPISODE, superseded_grant_ids: [] },
  },
} satisfies Record<string, AuditEventInput>;

const valid = BRANCHES['a live factor is revoked'];
const stranded = BRANCHES['a stranded enrolment is revoked and two pending grants are superseded'];
const unfinished = BRANCHES['an unfinished reset is resumed, with no factor to revoke'];
const coalesced =
  BRANCHES['an unfinished reset is repeated while a usable grant exists, and nothing is issued'];

describe('the facts of auth.mfa.reset (G2 follow-up)', () => {
  // Break caught: a branch the state machine approves refused, which would stop the first operation that writes it.
  it.each(Object.entries(BRANCHES))('accepts the example where %s', (_branch, event) => {
    const record = build(event);

    expect(record.eventCode).toBe('auth.mfa.reset');
    expect(record.enhanced).toBe(true);
    expect(record.resultingState).toBe(event.resultingState);
    expect(record.relatedIds).toEqual(event.relatedIds);
  });

  // Break caught: the two outcomes confused. A coalesced reset issued and revoked nothing and changed nothing, so it carries no diff;
  // an issued one changed a grant at least and carries the diff of it.
  it('distinguishes ISSUED from COALESCED: the first names a new grant and carries a diff, the second neither', () => {
    expect(build(unfinished).beforeAfter).toEqual({ reenrolment_grant: REENROLMENT });
    expect(build(coalesced).beforeAfter).toBeNull();
    expect(build(coalesced).relatedIds).not.toHaveProperty('new_grant_id');

    expect(
      refusalOf(() => build({ ...coalesced, beforeAfter: unfinished.beforeAfter })).field,
    ).toBe('beforeAfter');
    expect(
      refusalOf(() =>
        build({
          ...coalesced,
          relatedIds: { ...coalesced.relatedIds, new_grant_id: GRANT },
        }),
      ).field,
    ).toBe('relatedIds.new_grant_id');
    expect(
      refusalOf(() =>
        build({
          ...coalesced,
          relatedIds: { ...coalesced.relatedIds, superseded_grant_ids: [OLD_ONE] },
        }),
      ).field,
    ).toBe('relatedIds.superseded_grant_ids');
    // issuing nothing is possible only where a reset was already under way
    for (const [previousState, reason] of [
      ['ACTIVE_FACTOR', UNAVAILABLE],
      ['STRANDED_ENROLMENT', EXPIRED],
    ] as const) {
      expect(
        refusalOf(() => build({ ...coalesced, previousState, reason })).field,
        previousState,
      ).toBe('resultingState');
    }
  });

  // Break caught (the reported defect): an unrelated object accepted in place of the episode, the factor, the grants and the diff,
  // because a non-empty object was taken for the lineage.
  it('refuses unrelated objects substituted for the required facts', () => {
    expect(
      refusalOf(() =>
        build({ ...valid, relatedIds: { unrelated: true }, beforeAfter: { unrelated: true } }),
      ).field,
    ).toBe('relatedIds');
    expect(
      refusalOf(() => build({ ...valid, relatedIds: { ...valid.relatedIds, unrelated: true } }))
        .field,
    ).toBe('relatedIds');
    expect(refusalOf(() => build({ ...valid, beforeAfter: { unrelated: true } })).field).toBe(
      'beforeAfter',
    );
    expect(
      refusalOf(() => build({ ...valid, beforeAfter: { ...valid.beforeAfter, unrelated: true } }))
        .field,
    ).toBe('beforeAfter');
  });

  // Break caught: a required fact missing or malformed (an episode that is text, a grant that is not an identifier) accepted.
  it.each([
    ['no episode', { ...valid.relatedIds, episode_id: undefined }, 'relatedIds.episode_id'],
    [
      'an episode that is not an identifier',
      { ...valid.relatedIds, episode_id: 'episode-1' },
      'relatedIds.episode_id',
    ],
    [
      'an episode that is a number',
      { ...valid.relatedIds, episode_id: 7 },
      'relatedIds.episode_id',
    ],
    ['an episode that is null', { ...valid.relatedIds, episode_id: null }, 'relatedIds.episode_id'],
    [
      'no revoked factor for a live factor',
      { ...valid.relatedIds, revoked_factor_id: undefined },
      'relatedIds.revoked_factor_id',
    ],
    [
      'a revoked factor that is not an identifier',
      { ...valid.relatedIds, revoked_factor_id: 'f' },
      'relatedIds.revoked_factor_id',
    ],
    [
      'no new grant when one was issued',
      { ...valid.relatedIds, new_grant_id: undefined },
      'relatedIds.new_grant_id',
    ],
    [
      'a new grant that is not an identifier',
      { ...valid.relatedIds, new_grant_id: 'g' },
      'relatedIds.new_grant_id',
    ],
    [
      'no list of superseded grants',
      { ...valid.relatedIds, superseded_grant_ids: undefined },
      'relatedIds.superseded_grant_ids',
    ],
    [
      'a superseded list that is text',
      { ...valid.relatedIds, superseded_grant_ids: OLD_ONE },
      'relatedIds.superseded_grant_ids',
    ],
    [
      'a superseded grant that is not an identifier',
      { ...valid.relatedIds, superseded_grant_ids: ['x'] },
      'relatedIds.superseded_grant_ids',
    ],
    [
      'a superseded grant listed twice',
      { ...valid.relatedIds, superseded_grant_ids: [OLD_ONE, OLD_ONE] },
      'relatedIds.superseded_grant_ids',
    ],
    [
      'the new grant among the superseded',
      { ...valid.relatedIds, superseded_grant_ids: [GRANT] },
      'relatedIds.superseded_grant_ids',
    ],
  ] as const)('refuses %s', (_label, relatedIds, field) => {
    const defined = Object.fromEntries(
      Object.entries(relatedIds).filter(([, value]) => value !== undefined),
    );

    expect(refusalOf(() => build({ ...valid, relatedIds: defined })).field).toBe(field);
  });

  // Break caught: a factor named where none exists. An unfinished reset has no factor to revoke, and a coalesced one revokes none.
  it('allows the factor to be absent where none legitimately exists, and refuses it where one is named but cannot be', () => {
    expect(build(unfinished).relatedIds).not.toHaveProperty('revoked_factor_id');
    expect(
      refusalOf(() =>
        build({
          ...unfinished,
          relatedIds: { ...unfinished.relatedIds, revoked_factor_id: FACTOR },
        }),
      ).field,
    ).toBe('relatedIds.revoked_factor_id');
    expect(
      refusalOf(() =>
        build({ ...coalesced, relatedIds: { ...coalesced.relatedIds, revoked_factor_id: FACTOR } }),
      ).field,
    ).toBe('relatedIds.revoked_factor_id');
    expect(
      refusalOf(() =>
        build({
          ...unfinished,
          beforeAfter: {
            ...unfinished.beforeAfter,
            mfa_factor: { before: 'ACTIVE', after: 'REVOKED' },
          },
        }),
      ).field,
    ).toBe('beforeAfter.mfa_factor');
  });

  // Break caught: an empty list of superseded grants refused (it is the ordinary case), or a list that is not empty with no diff of it.
  it('accepts an empty list of superseded grants, and ties the diff to the list', () => {
    expect(build(valid).relatedIds).toMatchObject({ superseded_grant_ids: [] });
    expect(build(stranded).relatedIds).toMatchObject({ superseded_grant_ids: [OLD_ONE, OLD_TWO] });
    expect(
      refusalOf(() =>
        build({
          ...valid,
          beforeAfter: {
            ...valid.beforeAfter,
            superseded_grants: { before: 'PENDING', after: 'SUPERSEDED' },
          },
        }),
      ).field,
    ).toBe('beforeAfter.superseded_grants');
    expect(
      refusalOf(() =>
        build({
          ...stranded,
          beforeAfter: {
            mfa_factor: stranded.beforeAfter.mfa_factor,
            reenrolment_grant: REENROLMENT,
          },
        }),
      ).field,
    ).toBe('beforeAfter.superseded_grants');
  });

  // Break caught: the diff accepted with the wrong values (a factor left ACTIVE, a grant not issued), or in the wrong form.
  it.each([
    [
      'no diff of the grant',
      { mfa_factor: valid.beforeAfter.mfa_factor },
      'beforeAfter.reenrolment_grant',
    ],
    [
      'a grant that was not issued',
      { ...valid.beforeAfter, reenrolment_grant: { before: 'PENDING', after: 'PENDING' } },
      'beforeAfter.reenrolment_grant',
    ],
    ['no diff of the factor', { reenrolment_grant: REENROLMENT }, 'beforeAfter.mfa_factor'],
    [
      'a factor that stays ACTIVE',
      { ...valid.beforeAfter, mfa_factor: { before: 'ACTIVE', after: 'ACTIVE' } },
      'beforeAfter.mfa_factor',
    ],
    [
      'a live factor said to have been PENDING',
      { ...valid.beforeAfter, mfa_factor: { before: 'PENDING', after: 'REVOKED' } },
      'beforeAfter.mfa_factor',
    ],
    [
      'a factor diff that is text',
      { ...valid.beforeAfter, mfa_factor: 'REVOKED' },
      'beforeAfter.mfa_factor',
    ],
    [
      'a transition with an extra member',
      { ...valid.beforeAfter, mfa_factor: { before: 'ACTIVE', after: 'REVOKED', by: 'x' } },
      'beforeAfter.mfa_factor',
    ],
  ] as const)('refuses %s', (_label, beforeAfter, field) => {
    expect(refusalOf(() => build({ ...valid, beforeAfter })).field).toBe(field);
  });

  // Break caught: the reason of one branch accepted for another (the authenticator is unavailable only while a factor is live).
  it('requires the branch’s own reason', () => {
    expect(refusalOf(() => build({ ...valid, reason: EXPIRED })).field).toBe('reason.code');
    expect(refusalOf(() => build({ ...stranded, reason: UNAVAILABLE })).field).toBe('reason.code');
    expect(refusalOf(() => build({ ...unfinished, reason: UNAVAILABLE })).field).toBe(
      'reason.code',
    );
    expect(refusalOf(() => build({ ...valid, reason: undefined })).field).toBe('reason');
  });

  // Break caught: the target taken for something else, or the actor allowed to reset itself, or a refusal recorded as the act.
  it('names the target identity, which is not the actor, and only a success', () => {
    expect(
      refusalOf(() => build({ ...valid, object: { type: 'MfaFactor', id: TARGET } })).field,
    ).toBe('object');
    expect(
      refusalOf(() => build({ ...valid, object: { type: 'StaffIdentity', id: ADMIN } })).field,
    ).toBe('object');
    expect(
      refusalOf(() => build({ ...valid, object: { type: 'StaffIdentity', id: null } })).field,
    ).toBe('object.id');
    // a refusal is not this event: the attempt that was refused changed nothing and is not recorded under it
    const refused = { ...unfinished, outcome: 'REJECTED' } as AuditEventInput;
    const withoutDiff = Object.fromEntries(
      Object.entries(refused).filter(([key]) => key !== 'beforeAfter'),
    ) as unknown as AuditEventInput;
    expect(refusalOf(() => build(refused)).field).toBe('beforeAfter');
    expect(refusalOf(() => build(withoutDiff)).field).toBe('outcome');
  });

  // Break caught: a downgrade, and an actor that is not a Platform Admin's staff transaction.
  it('stays enhanced and a staff transaction', () => {
    expect(refusalOf(() => build({ ...valid, enhanced: false })).field).toBe('enhanced');
    const system: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: '66666666-6666-4666-8666-666666666666',
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: 'request-2',
    };
    expect(refusalOf(() => build(valid, system)).field).toBe('actor');
  });

  // Break caught: a secret carried into the event under a field the shape allows, or one named for a secret accepted as a fact.
  it('carries no secret: a field named for one is refused whatever the shape', () => {
    expect(
      refusalOf(() => build({ ...valid, relatedIds: { ...valid.relatedIds, setup_token: 'x' } }))
        .field,
    ).toBe('relatedIds');
    expect(refusalOf(() => build({ ...valid, detail: { totp_seed: 'x' } })).field).toBe('detail');
  });
});
