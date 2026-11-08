import { describe, expect, it } from 'vitest';

import { RESERVED_SYSTEM_ACTOR_ID } from '../../staff/reserved-system-actor.js';
import type { AuditEventInput } from '../auth/ports/audit-writer.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import { RESERVED_SYSTEM_ACTOR_FACT } from './audit-bootstrap-resumed.js';
import { diffRuleFor, ENHANCED_CODES, NO_DIFF_CODES, tierOf } from './audit-classification.js';
import { AuditRefusedError, buildAuditRecord } from './audit-record.js';

/**
 * The shape of `auth.bootstrap.resumed` (`audit-bootstrap-resumed.ts`; audit.md §5.4; MIGRATION_AND_SEEDING.md §3.3a; AC-SLICE-000-93):
 * the enhanced summary of one committed resume of a stranded bootstrap administrator, written by `SYSTEM` (a null actor) in the
 * transaction of the change, with the reserved bootstrap actor as a named, validated fact, and a bounded, secret-free before and after
 * of the grants and factors the resume changed. The writer validates the shape and the agreement of the facts; that they are the
 * database's own changes is the resume function's, which derives them under the identity's lock (`bootstrap-functions.db.test.ts`).
 */

const ID = '019a0000-0000-7000-8000-000000000001';
const NOW = new Date('2026-10-21T09:00:00.000Z');
const IDENTITY = '22222222-2222-4222-8222-222222222222';
const GRANT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LAPSED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const FACTOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FACTOR_TWO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';

const BOOTSTRAP: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: '5eed0000-0000-4000-8000-0000000000b1',
  surface: 'SYSTEM',
  taskCapability: 'bootstrap',
  correlationId: 'bootstrap-run-1',
};
const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: '11111111-1111-4111-8111-111111111111',
  surface: 'OPS_PORTAL',
  correlationId: 'request-1',
};

const build = (input: AuditEventInput, context: SecurityContext = BOOTSTRAP) =>
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

const grant = (id: string, purpose: string, state: string) => ({ id, purpose, state });

/** The two branches, each as the resume function derives it. */
const BUNDLE_LOST = {
  code: 'auth.bootstrap.resumed',
  enhanced: true,
  outcome: 'SUCCEEDED',
  object: { type: 'StaffIdentity', id: IDENTITY },
  detail: { path: 'BUNDLE_LOST', purpose: 'BOOTSTRAP_SETUP', channel: 'PROVISIONING_CHANNEL' },
  relatedIds: {
    principal_id: IDENTITY,
    reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_ID,
    setup_grant_id: GRANT,
    superseded_grant_ids: [LOST],
    expired_grant_ids: [],
    revoked_factor_ids: [],
  },
  beforeAfter: {
    grants: {
      before: [grant(LOST, 'BOOTSTRAP_SETUP', 'PENDING')],
      after: [
        grant(LOST, 'BOOTSTRAP_SETUP', 'SUPERSEDED'),
        grant(GRANT, 'BOOTSTRAP_SETUP', 'PENDING'),
      ],
    },
    factors: { before: [], after: [] },
  },
} satisfies AuditEventInput;

const REENROLMENT = {
  code: 'auth.bootstrap.resumed',
  enhanced: true,
  outcome: 'SUCCEEDED',
  object: { type: 'StaffIdentity', id: IDENTITY },
  detail: { path: 'REENROLMENT', purpose: 'MFA_REENROLMENT', channel: 'PROVISIONING_CHANNEL' },
  relatedIds: {
    principal_id: IDENTITY,
    reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_ID,
    setup_grant_id: GRANT,
    superseded_grant_ids: [],
    expired_grant_ids: [LAPSED],
    revoked_factor_ids: [FACTOR, FACTOR_TWO],
  },
  beforeAfter: {
    grants: {
      before: [grant(LAPSED, 'MFA_ENROLMENT', 'PENDING')],
      after: [
        grant(LAPSED, 'MFA_ENROLMENT', 'EXPIRED'),
        grant(GRANT, 'MFA_REENROLMENT', 'PENDING'),
      ],
    },
    factors: {
      before: [
        { id: FACTOR, status: 'PENDING' },
        { id: FACTOR_TWO, status: 'PENDING' },
      ],
      after: [
        { id: FACTOR, status: 'REVOKED' },
        { id: FACTOR_TWO, status: 'REVOKED' },
      ],
    },
  },
} satisfies AuditEventInput;

/** A resume that ended nothing and revoked nothing: the identity had no lapsed grant and no stale factor. */
const REENROLMENT_PLAIN = {
  ...REENROLMENT,
  relatedIds: {
    ...REENROLMENT.relatedIds,
    expired_grant_ids: [],
    revoked_factor_ids: [],
  },
  beforeAfter: {
    grants: { before: [], after: [grant(GRANT, 'MFA_REENROLMENT', 'PENDING')] },
    factors: { before: [], after: [] },
  },
} satisfies AuditEventInput;

const BRANCHES = {
  'the lost bundle: the unconsumed secret is superseded': BUNDLE_LOST,
  'the re-enrolment: a lapsed grant is ended and two stale factors are revoked': REENROLMENT,
  'the re-enrolment with nothing to end and nothing to revoke': REENROLMENT_PLAIN,
} satisfies Record<string, AuditEventInput>;

describe('auth.bootstrap.resumed is a catalogue event of the enhanced tier, with no no-diff exemption', () => {
  it('is enhanced, and a successful one requires a before and after', () => {
    expect(ENHANCED_CODES).toContain('auth.bootstrap.resumed');
    expect(tierOf('auth.bootstrap.resumed')).toBe('ENHANCED');
    expect(NO_DIFF_CODES).not.toContain('auth.bootstrap.resumed');
    expect(
      diffRuleFor({ code: 'auth.bootstrap.resumed', enhanced: true, outcome: 'SUCCEEDED' }),
    ).toBe('REQUIRED');
  });

  // Break caught: the pinned copy of the reserved actor drifting from the value the staff domain, the SQL and the documents hold.
  it('names the same reserved actor as the staff domain', () => {
    expect(RESERVED_SYSTEM_ACTOR_FACT).toBe(RESERVED_SYSTEM_ACTOR_ID);
  });
});

describe('the facts of auth.bootstrap.resumed (the owner’s adoption of 21 October 2026, A07)', () => {
  // Break caught: a branch the resume approves refused, which would stop the command that writes it.
  it.each(Object.entries(BRANCHES))('accepts the example where %s', (_branch, event) => {
    const record = build(event);

    expect(record.eventCode).toBe('auth.bootstrap.resumed');
    expect(record.enhanced).toBe(true);
    expect(record.outcome).toBe('SUCCEEDED');
    expect(record.objectType).toBe('StaffIdentity');
    expect(record.objectId).toBe(IDENTITY);
    expect(record.beforeAfter).not.toBeNull();
    expect(record.relatedIds).toMatchObject({ reserved_system_actor_id: RESERVED_SYSTEM_ACTOR_ID });
  });

  // Break caught: the reserved actor written as the actor, which the writer's convention forbids (`actor_id` is null for SYSTEM), or
  // dropped from the facts, which loses the provenance AC-SLICE-000-93 asks for.
  it('records a SYSTEM actor with no id, and the reserved actor only as a named fact', () => {
    const record = build(BUNDLE_LOST);

    expect(record.actorType).toBe('SYSTEM');
    expect(record.actorId).toBeNull();
    expect(JSON.stringify(record.relatedIds)).toContain(RESERVED_SYSTEM_ACTOR_ID);
    expect(
      refusalOf(() =>
        build({ ...BUNDLE_LOST, actor: { type: 'SYSTEM', id: RESERVED_SYSTEM_ACTOR_ID } }),
      ).field,
    ).toBe('actor');
  });

  // Break caught: the event written by anyone but the system's bootstrap, or by a person's transaction.
  it('is refused in the transaction of a person, and as an ordinary event', () => {
    expect(refusalOf(() => build(BUNDLE_LOST, STAFF)).field).toBe('actor');
    expect(refusalOf(() => build({ ...BUNDLE_LOST, enhanced: false })).field).toBe('enhanced');
  });

  // Break caught: an event for a refusal or a failure; a refused resume writes none.
  it.each(['REJECTED', 'FAILED', 'REPLAYED'] as const)(
    'is refused with the outcome %s',
    (outcome) => {
      expect(() => build({ ...BUNDLE_LOST, outcome })).toThrow(AuditRefusedError);
    },
  );

  describe('what it records of the identity and the act', () => {
    it('refuses any object but the identity that was resumed', () => {
      expect(() => build({ ...BUNDLE_LOST, object: { type: 'SetupGrant', id: GRANT } })).toThrow(
        AuditRefusedError,
      );
      expect(() => build({ ...BUNDLE_LOST, object: { type: 'StaffIdentity', id: null } })).toThrow(
        AuditRefusedError,
      );
    });

    it('requires the principal of the facts to be the object', () => {
      const other = '33333333-3333-4333-8333-333333333333';
      expect(
        refusalOf(() =>
          build({ ...BUNDLE_LOST, relatedIds: { ...BUNDLE_LOST.relatedIds, principal_id: other } }),
        ).field,
      ).toBe('relatedIds.principal_id');
    });

    it.each([
      ['an unknown path', { ...BUNDLE_LOST.detail, path: 'RESET' }],
      ['a purpose that is not the path’s', { ...BUNDLE_LOST.detail, purpose: 'MFA_REENROLMENT' }],
      ['a channel that is not the provisioning one', { ...BUNDLE_LOST.detail, channel: 'EMAIL' }],
      ['a fact it does not define', { ...BUNDLE_LOST.detail, note: 'x' }],
      ['a missing channel', { path: 'BUNDLE_LOST', purpose: 'BOOTSTRAP_SETUP' }],
    ])('refuses %s in the detail', (_what, detail) => {
      expect(() => build({ ...BUNDLE_LOST, detail })).toThrow(AuditRefusedError);
    });

    it('requires the closed set of keys in related_ids: none missing, none added', () => {
      for (const key of Object.keys(BUNDLE_LOST.relatedIds)) {
        const rest = Object.fromEntries(
          Object.entries(BUNDLE_LOST.relatedIds).filter(([name]) => name !== key),
        );
        expect(() => build({ ...BUNDLE_LOST, relatedIds: rest }), key).toThrow(AuditRefusedError);
      }
      expect(() =>
        build({ ...BUNDLE_LOST, relatedIds: { ...BUNDLE_LOST.relatedIds, extra_id: GRANT } }),
      ).toThrow(AuditRefusedError);
    });

    // Break caught: the reserved actor compared by shape only, so that any UUID passes as "the reserved actor".
    it('refuses a reserved actor that is not the reserved one', () => {
      expect(
        refusalOf(() =>
          build({
            ...BUNDLE_LOST,
            relatedIds: {
              ...BUNDLE_LOST.relatedIds,
              reserved_system_actor_id: '33333333-3333-4333-8333-333333333333',
            },
          }),
        ).field,
      ).toBe('relatedIds.reserved_system_actor_id');
    });
  });

  describe('the grants and factors it names', () => {
    it.each([
      ['a new grant that is also an ended one', { setup_grant_id: LOST }],
      ['a grant both superseded and expired', { expired_grant_ids: [LOST] }],
      ['a repeated superseded grant', { superseded_grant_ids: [LOST, LOST] }],
      ['an identifier that is not a UUID', { superseded_grant_ids: ['nope'] }],
      ['a list that is not a list', { revoked_factor_ids: FACTOR }],
    ])('refuses %s', (_what, change) => {
      expect(() =>
        build({ ...BUNDLE_LOST, relatedIds: { ...BUNDLE_LOST.relatedIds, ...change } }),
      ).toThrow(AuditRefusedError);
    });

    // Break caught: the lost-bundle path writing what only the re-enrolment does, or the reverse.
    it('lets the lost-bundle path supersede exactly one grant and nothing else', () => {
      for (const change of [
        { superseded_grant_ids: [] },
        { superseded_grant_ids: [LOST, LAPSED] },
        { expired_grant_ids: [LAPSED] },
        { revoked_factor_ids: [FACTOR] },
      ]) {
        expect(() =>
          build({ ...BUNDLE_LOST, relatedIds: { ...BUNDLE_LOST.relatedIds, ...change } }),
        ).toThrow(AuditRefusedError);
      }
    });

    it('lets the re-enrolment end lapsed grants and revoke factors, and supersede none', () => {
      expect(() =>
        build({
          ...REENROLMENT,
          relatedIds: { ...REENROLMENT.relatedIds, superseded_grant_ids: [LOST] },
        }),
      ).toThrow(AuditRefusedError);
    });

    it('lists the identifiers in ascending order, as the function does', () => {
      expect(() =>
        build({
          ...REENROLMENT,
          relatedIds: { ...REENROLMENT.relatedIds, revoked_factor_ids: [FACTOR_TWO, FACTOR] },
        }),
      ).toThrow(AuditRefusedError);
    });
  });

  describe('the before and after it carries', () => {
    const changed = (beforeAfter: unknown): AuditEventInput =>
      ({ ...REENROLMENT, beforeAfter }) as AuditEventInput;
    const grants = REENROLMENT.beforeAfter.grants;
    const factors = REENROLMENT.beforeAfter.factors;

    // Break caught: an event with no before and after, or one that the no-diff list excuses.
    it('is required, and is not the empty object', () => {
      const without: AuditEventInput = {
        code: REENROLMENT.code,
        enhanced: REENROLMENT.enhanced,
        outcome: REENROLMENT.outcome,
        object: REENROLMENT.object,
        detail: REENROLMENT.detail,
        relatedIds: REENROLMENT.relatedIds,
      };
      expect(refusalOf(() => build(without)).field).toBe('beforeAfter');
      expect(refusalOf(() => build(changed({}))).field).toBe('beforeAfter');
    });

    it.each([
      ['no grants', { factors }],
      ['no factors', { grants }],
      [
        'a key it does not define',
        { grants, factors, identity: { before: 'ACTIVE', after: 'ACTIVE' } },
      ],
      [
        'a change of the identity that did not happen',
        { grants, factors, status: { before: 'ACTIVE', after: 'ACTIVE' } },
      ],
      ['grants that are not before and after', { grants: { before: grants.before }, factors }],
      ['grants with another key', { grants: { ...grants, during: [] }, factors }],
    ])('refuses %s', (_what, beforeAfter) => {
      expect(() => build(changed(beforeAfter))).toThrow(AuditRefusedError);
    });

    // Break caught: a before and after that does not describe the change the facts name.
    it.each([
      [
        'an issued grant that is missing after',
        { grants: { before: grants.before, after: [grants.after[0]] }, factors },
      ],
      [
        'an issued grant that is not pending',
        {
          grants: {
            before: grants.before,
            after: [grants.after[0], grant(GRANT, 'MFA_REENROLMENT', 'CONSUMED')],
          },
          factors,
        },
      ],
      [
        'an issued grant of another purpose than the detail’s',
        {
          grants: {
            before: grants.before,
            after: [grants.after[0], grant(GRANT, 'BOOTSTRAP_SETUP', 'PENDING')],
          },
          factors,
        },
      ],
      [
        'an ended grant that did not end in the state the facts say',
        {
          grants: {
            before: grants.before,
            after: [grant(LAPSED, 'MFA_ENROLMENT', 'SUPERSEDED'), grants.after[1]],
          },
          factors,
        },
      ],
      [
        'an ended grant that was not pending before',
        {
          grants: { before: [grant(LAPSED, 'MFA_ENROLMENT', 'CONSUMED')], after: grants.after },
          factors,
        },
      ],
      [
        'a grant that the facts do not name',
        {
          grants: {
            before: [...grants.before, grant(LOST, 'MFA_ENROLMENT', 'PENDING')],
            after: [grant(LOST, 'MFA_ENROLMENT', 'EXPIRED'), ...grants.after],
          },
          factors,
        },
      ],
      [
        'a factor that is not revoked after',
        {
          grants,
          factors: { before: factors.before, after: factors.before },
        },
      ],
      [
        'a factor that the facts do not name',
        {
          grants,
          factors: {
            before: [{ id: LOST, status: 'PENDING' }],
            after: [{ id: LOST, status: 'REVOKED' }],
          },
        },
      ],
      [
        'a factor that was active before',
        {
          grants,
          factors: {
            before: [
              { id: FACTOR, status: 'ACTIVE' },
              { id: FACTOR_TWO, status: 'PENDING' },
            ],
            after: factors.after,
          },
        },
      ],
      [
        'an object with a key it does not define',
        {
          grants: {
            before: [{ ...grants.before[0], hash: 'x' }],
            after: grants.after,
          },
          factors,
        },
      ],
    ])('refuses %s', (_what, beforeAfter) => {
      expect(() => build(changed(beforeAfter))).toThrow(AuditRefusedError);
    });
  });

  describe('what it never holds', () => {
    // Break caught: a secret, a hash, an address or a name reaching the ledger through the facts of this event.
    it.each([
      [
        'a token hash in the detail',
        { detail: { ...BUNDLE_LOST.detail, token_hash: 'a'.repeat(64) } },
      ],
      [
        'an address in the detail',
        { detail: { ...BUNDLE_LOST.detail, contact: 'kofi@melarc.example' } },
      ],
      [
        'a secret named in the related facts',
        { relatedIds: { ...BUNDLE_LOST.relatedIds, secret: 'x' } },
      ],
      [
        'an address as a value',
        { relatedIds: { ...BUNDLE_LOST.relatedIds, principal_id: 'kofi@melarc.example' } },
      ],
    ])('refuses %s', (_what, change) => {
      expect(() => build({ ...BUNDLE_LOST, ...change })).toThrow(AuditRefusedError);
    });

    it('stores a record that carries no custodian, address, secret or token', () => {
      const text = JSON.stringify(build(REENROLMENT));
      expect(text).not.toMatch(/@|secret|token|password|seed/i);
    });
  });
});
