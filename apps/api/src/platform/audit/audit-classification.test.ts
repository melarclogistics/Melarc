import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../auth/ports/audit-writer.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import {
  CONDITIONAL_CODES,
  ENHANCED_CODES,
  EVENT_REQUIREMENTS,
  tierOf,
} from './audit-classification.js';
import { AUDIT_EVENT_CODES } from './audit-event-codes.js';
import { AuditRefusedError, buildAuditRecord } from './audit-record.js';

const AUDIT_MD = readFileSync(
  resolve(import.meta.dirname, '../../../../../contracts/audit.md'),
  'utf8',
).replaceAll('\r', '');

const ID = '019a0000-0000-7000-8000-000000000001';
const NOW = new Date('2026-10-11T09:00:00.000Z');
const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const HUB = '44444444-4444-4444-8444-444444444444';

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: STAFF_ID,
  surface: 'OPS_PORTAL',
  correlationId: 'request-1',
};
const AUTHENTICATION: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: '66666666-6666-4666-8666-666666666666',
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'request-2',
};
// The bootstrap seed writes the two administrators under the `bootstrap` capability; the reference seed (`seed`) writes no identity.
const BOOTSTRAP: SecurityContext = { ...AUTHENTICATION, taskCapability: 'bootstrap' };
const REFERENCE_SEED: SecurityContext = { ...AUTHENTICATION, taskCapability: 'seed' };

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

/** The catalogue rows of audit.md section 5, with the text of each row. */
function documentedRows(): { code: string; row: string }[] {
  return AUDIT_MD.split('\n')
    .map((line) => ({
      line,
      code: /^\|\s*`([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)`\s*\|/.exec(line)?.[1],
    }))
    .filter((entry): entry is { line: string; code: string } => entry.code !== undefined)
    .map(({ line, code }) => ({ code, row: line }));
}

describe('the tier of each event is the catalogue’s, read from the document (G2-06)', () => {
  // Break caught: the table of tiers drifting from the document, in either direction: an event the document makes enhanced written
  // as an ordinary one, or the other way round. The tier is read from the words of the row, as a person reads it.
  it('agrees with every catalogue row of audit.md about whether the event is enhanced, not, or depends on the act', () => {
    const disagreements: string[] = [];
    for (const { code, row } of documentedRows()) {
      const conditional =
        /enhanced when|\*\*enhanced\*\* when|writes it as an enhanced record/i.test(row);
      const explicitlyNot = /not enhanced/i.test(row);
      const mentions = /enhanced/i.test(row);
      const expected = conditional
        ? 'CONDITIONAL'
        : explicitlyNot
          ? 'STANDARD'
          : mentions
            ? 'ENHANCED'
            : 'STANDARD';
      if (tierOf(code as (typeof AUDIT_EVENT_CODES)[number]) !== expected) {
        disagreements.push(`${code}: the document says ${expected}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  // Break caught: the counts of the tiers stated nowhere and so wrong silently, which is how the document's own counts went wrong three times, and then written
  // into this test as numbers, which is the same drift one place over. They are derived here from the lists the writer honours, the three tiers are held to be
  // the whole catalogue (no code counted twice, none left out), and the document's own statement of them is checked against what is derived.
  it('derives the counts of the tiers from the writer’s lists, and the document states them', () => {
    const tiers = AUDIT_EVENT_CODES.map((code) => tierOf(code));
    const enhanced = tiers.filter((tier) => tier === 'ENHANCED').length;
    const conditional = tiers.filter((tier) => tier === 'CONDITIONAL').length;
    const standard = tiers.filter((tier) => tier === 'STANDARD').length;

    expect(enhanced).toBe(ENHANCED_CODES.length);
    expect(conditional).toBe(Object.keys(CONDITIONAL_CODES).length);
    expect(enhanced + conditional + standard).toBe(AUDIT_EVENT_CODES.length);
    expect(new Set(ENHANCED_CODES).size).toBe(ENHANCED_CODES.length);
    for (const code of Object.keys(CONDITIONAL_CODES)) {
      expect(ENHANCED_CODES as readonly string[]).not.toContain(code);
    }

    const stated = (pattern: RegExp): number => Number(pattern.exec(AUDIT_MD)?.[1]);
    expect(stated(/\*\*(\d+) codes\*\*/)).toBe(AUDIT_EVENT_CODES.length);
    expect(stated(/\*\*(\d+) are Enhanced\*\*/)).toBe(enhanced);
    expect(stated(/\*\*(\d+) are Enhanced or Standard by the act\*\*/)).toBe(conditional);
    expect(stated(/\*\*(\d+) are Standard\*\*/)).toBe(standard);
  });

  // Break caught (run 5, Stage 1.5): an old statement of a count surviving beside the new one, because the patterns above read one wording in one case. Line 523 once said
  // "81 are Enhanced" and, a few words on, "80 are enhanced ... 116 are ordinary", and the test read only the first. Every place the document says a number of the
  // tiers, in any case and in either of the words it has used for them, must say the derived number.
  it('has no statement of a count of the tiers, in any wording or case, that is not the derived count', () => {
    const tiers = AUDIT_EVENT_CODES.map((code) => tierOf(code));
    const derived = {
      enhanced: tiers.filter((tier) => tier === 'ENHANCED').length,
      conditional: tiers.filter((tier) => tier === 'CONDITIONAL').length,
      standard: tiers.filter((tier) => tier === 'STANDARD').length,
    };
    const statements: readonly [string, RegExp, number][] = [
      ['enhanced', /\b(\d+) are enhanced\b(?! or standard)/gi, derived.enhanced],
      [
        'conditional',
        /\b(\d+) (?:are enhanced or standard by the act|depend on the act)\b/gi,
        derived.conditional,
      ],
      ['standard', /\b(\d+) are (?:standard|ordinary)\b/gi, derived.standard],
    ];
    for (const [tier, pattern, count] of statements) {
      const found = [...AUDIT_MD.matchAll(pattern)].map((match) => Number(match[1]));
      // A check over nothing passes: the document states each of the three.
      expect(found.length, `the document states a count of the ${tier} codes`).toBeGreaterThan(0);
      expect(
        found.filter((number) => number !== count),
        `statements of the ${tier} count other than ${String(count)}`,
      ).toEqual([]);
    }
  });

  // Break caught: the document's count of its own codes going stale again (it read 188 when there were 190).
  it('states the number of codes the catalogue holds', () => {
    const stated = /\*\*(\d+) codes\b/.exec(AUDIT_MD)?.[1];
    expect(Number(stated)).toBe(AUDIT_EVENT_CODES.length);
  });

  // Break caught: a requirement for an event that is not in the catalogue (a typo that enforces nothing).
  it('has requirements only for codes of the catalogue', () => {
    for (const code of Object.keys(EVENT_REQUIREMENTS)) {
      expect(AUDIT_EVENT_CODES as readonly string[], code).toContain(code);
    }
  });

  // Break caught: a grammar claim the catalogue does not meet. The document says which identifiers end in a state or a condition and
  // not in a past-tense verb, and this reads the codes to check that the list is complete and holds no stranger.
  it('names, in the document, every code whose last part has no past-tense verb in it', () => {
    const participle = /(ed|en|nt|ld|et|un|wn)$/;
    const withoutVerb = AUDIT_EVENT_CODES.filter(
      (code) => !(code.split('.')[2] ?? '').split('_').some((word) => participle.test(word)),
    );
    const listed = /established identifiers[^:\n]*:([^\n]*)/i.exec(AUDIT_MD)?.[1] ?? '';
    const named = [...listed.matchAll(/`([a-z_.]+)`/g)].map((match) => match[1]);
    for (const code of withoutVerb) expect(named, code).toContain(code);
    for (const code of named) expect(AUDIT_EVENT_CODES as readonly string[], code).toContain(code);
  });
});

describe('the writer holds an event to its tier (G2-06)', () => {
  const plain: AuditEventInput = {
    code: 'auth.session.issued',
    enhanced: false,
    outcome: 'SUCCEEDED',
    object: { type: 'Session', id: OBJECT_ID },
  };

  // Break caught: a caller downgrading an event the catalogue makes enhanced (the reproduced defect: `auth.mfa.reset` accepted with
  // `enhanced: false`, no reason, no lineage and no before and after). Every one of the 76 is refused with `false`.
  it('refuses every mandatory enhanced event written as an ordinary one', () => {
    for (const code of ENHANCED_CODES) {
      const error = refusalOf(() => build({ ...plain, code, enhanced: false }));
      expect(error.field, code).toBe('enhanced');
    }
  });

  // Break caught: an ordinary event written as enhanced, which puts it into the retention and export treatment of the ones that
  // are, and weakens what "enhanced" means for whoever searches for them.
  it('refuses every ordinary event written as an enhanced one', () => {
    const ordinary = AUDIT_EVENT_CODES.filter((code) => tierOf(code) === 'STANDARD');
    for (const code of ordinary) {
      const error = refusalOf(() => build({ ...plain, code, enhanced: true }));
      expect(error.field, code).toBe('enhanced');
    }
  });

  // Break caught: the reproduced example, in its parts: the event accepted with the wrong tier, then with no reason, no lineage and no
  // before and after. Each omission is refused for its own field, and the complete event is accepted. (The shape of the facts, and
  // each branch of the reset, are in `audit-mfa-reset.test.ts`.)
  const reset: AuditEventInput = {
    code: 'auth.mfa.reset',
    enhanced: true,
    outcome: 'SUCCEEDED',
    object: { type: 'StaffIdentity', id: OBJECT_ID },
    reason: { code: 'MFA_AUTHENTICATOR_UNAVAILABLE', label: 'The authenticator is unavailable' },
    previousState: 'ACTIVE_FACTOR',
    resultingState: 'ISSUED',
    relatedIds: {
      episode_id: OTHER_ID,
      revoked_factor_id: '55555555-5555-4555-8555-555555555555',
      new_grant_id: '66666666-6666-4666-8666-666666666666',
      superseded_grant_ids: [],
    },
    beforeAfter: {
      mfa_factor: { before: 'ACTIVE', after: 'REVOKED' },
      reenrolment_grant: { before: 'NONE', after: 'PENDING' },
    },
  };
  it('accepts the complete reset and refuses each fact it leaves out, naming the field', () => {
    expect(build(reset).enhanced).toBe(true);

    const without = (key: keyof AuditEventInput): AuditEventInput =>
      Object.fromEntries(
        Object.entries(reset).filter(([name]) => name !== key),
      ) as unknown as AuditEventInput;
    expect(refusalOf(() => build(without('reason'))).field).toBe('reason');
    expect(refusalOf(() => build(without('previousState'))).field).toBe('previousState');
    expect(refusalOf(() => build(without('resultingState'))).field).toBe('resultingState');
    expect(refusalOf(() => build(without('relatedIds'))).field).toBe('relatedIds');
    expect(refusalOf(() => build(without('beforeAfter'))).field).toBe('beforeAfter');
    expect(refusalOf(() => build({ ...reset, enhanced: false })).field).toBe('enhanced');
    expect(refusalOf(() => build({ ...reset, previousState: 'ACTIVE' })).field).toBe(
      'previousState',
    );
    expect(refusalOf(() => build({ ...reset, resultingState: 'DONE' })).field).toBe(
      'resultingState',
    );
    expect(refusalOf(() => build({ ...reset, relatedIds: {} })).field).toBe('relatedIds');
    expect(refusalOf(() => build({ ...reset, beforeAfter: {} })).field).toBe('beforeAfter');
    // acted on another identity's factor: a Platform Admin, never the system
    expect(refusalOf(() => build(reset, AUTHENTICATION)).field).toBe('actor');
  });

  // Break caught: a change that took effect recorded with no before and after; and the opposite error, a refused or failed act made
  // to invent a change that did not happen.
  it('asks for the before and after of a change that took effect, and not of an act that changed nothing', () => {
    const suspended: AuditEventInput = {
      code: 'staff.identity.suspended',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'StaffIdentity', id: OBJECT_ID },
    };
    expect(refusalOf(() => build(suspended)).field).toBe('beforeAfter');
    expect(refusalOf(() => build({ ...suspended, outcome: 'RECONCILED' })).field).toBe(
      'beforeAfter',
    );
    for (const outcome of ['REJECTED', 'FAILED', 'REPLAYED'] as const) {
      expect(build({ ...suspended, outcome }).outcome, outcome).toBe(outcome);
    }
    expect(build({ ...suspended, beforeAfter: { status: 'ACTIVE_TO_SUSPENDED' } }).enhanced).toBe(
      true,
    );
  });

  // Break caught (audit finding A3, AC-SLICE-001-85): the widening of a bundle recorded as an ordinary event, with no grants that
  // changed, with no bundle and revision, or as the act of a person (the primitive writes it as the system). The complete event, in the
  // shape the primitive writes (migration 0078), is accepted, so the ledger holds one shape of it.
  it('holds permission.bundle.widened to its tier and to the facts the catalogue names for it', () => {
    const widened: AuditEventInput = {
      code: 'permission.bundle.widened',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'RoleBundle', id: OBJECT_ID },
      relatedIds: { bundle_id: OBJECT_ID, revision: 4, reduction_floor: 1 },
      beforeAfter: {
        grants: { before: ['dispatch.read|own|any|P'], after: ['dispatch.read|all|any|P'] },
      },
      detail: { bundle_name: 'Platform Admin', added: 0, widened: 1 },
    };
    expect(tierOf('permission.bundle.widened')).toBe('ENHANCED');
    expect(build(widened, AUTHENTICATION).relatedIds).toEqual({
      bundle_id: OBJECT_ID,
      revision: 4,
      reduction_floor: 1,
    });
    expect(refusalOf(() => build({ ...widened, enhanced: false }, AUTHENTICATION)).field).toBe(
      'enhanced',
    );
    expect(
      refusalOf(() => build({ ...widened, beforeAfter: undefined }, AUTHENTICATION)).field,
    ).toBe('beforeAfter');
    expect(refusalOf(() => build({ ...widened, relatedIds: {} }, AUTHENTICATION)).field).toBe(
      'relatedIds',
    );
    expect(
      refusalOf(() =>
        build({ ...widened, relatedIds: { bundle_id: OBJECT_ID, revision: 4 } }, AUTHENTICATION),
      ).field,
    ).toBe('relatedIds');
    // a person's act, never the system's
    expect(refusalOf(() => build(widened, STAFF)).field).toBe('actor');
    // the object is a bundle, an object type of the closed set
    expect(
      refusalOf(() =>
        build({ ...widened, object: { type: 'Bundle', id: OBJECT_ID } }, AUTHENTICATION),
      ).field,
    ).toBe('object.type');
  });

  // Break caught (task A3.4 of the audit follow-up): the widening of the Vendor's or the Rider's fixed policy recorded as an ordinary event, with no audience
  // or revision, with no before and after of the revision, or as the act of a person (the primitive writes it as the system); or a policy given an
  // identifier it does not have. The complete event, in the shape `melarc.change_fixed_policy` writes (migration 0079), is accepted.
  it('holds permission.fixed_policy.widened to its tier and to the facts the catalogue names for it', () => {
    const widened: AuditEventInput = {
      code: 'permission.fixed_policy.widened',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'FixedPermissionPolicy', id: null },
      relatedIds: { principal_type: 'VENDOR', revision: 3, minimum_revision: 1 },
      beforeAfter: { revision: { before: 2, after: 3 } },
    };
    expect(tierOf('permission.fixed_policy.widened')).toBe('ENHANCED');
    expect(build(widened, AUTHENTICATION).relatedIds).toEqual({
      principal_type: 'VENDOR',
      revision: 3,
      minimum_revision: 1,
    });
    expect(refusalOf(() => build({ ...widened, enhanced: false }, AUTHENTICATION)).field).toBe(
      'enhanced',
    );
    expect(
      refusalOf(() => build({ ...widened, beforeAfter: undefined }, AUTHENTICATION)).field,
    ).toBe('beforeAfter');
    expect(refusalOf(() => build({ ...widened, relatedIds: {} }, AUTHENTICATION)).field).toBe(
      'relatedIds',
    );
    expect(
      refusalOf(() =>
        build(
          { ...widened, relatedIds: { principal_type: 'VENDOR', revision: 3 } },
          AUTHENTICATION,
        ),
      ).field,
    ).toBe('relatedIds');
    // a person's act, never the system's
    expect(refusalOf(() => build(widened, STAFF)).field).toBe('actor');
    // the object is the policy, an object type of the closed set
    expect(
      refusalOf(() =>
        build({ ...widened, object: { type: 'FixedPolicy', id: null } }, AUTHENTICATION),
      ).field,
    ).toBe('object.type');
  });

  // Break caught: a read forced to fabricate a before and after (the placeholder the document's own wording invited), or a read
  // that records one anyway; and the read's other mandatory evidence dropped once the exemption exists.
  it('exempts the boundary read from a before and after, and keeps its hub, its object and its operation mandatory', () => {
    const crossed: AuditEventInput = {
      code: 'auth.hub_boundary.crossed',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'HUB', id: HUB },
      responsibleHubId: HUB,
      relatedIds: { operation_id: 'listOrders' },
    };
    expect(build(crossed).beforeAfter).toBeNull();
    expect(refusalOf(() => build({ ...crossed, beforeAfter: { read: 'nothing' } })).field).toBe(
      'beforeAfter',
    );
    expect(refusalOf(() => build({ ...crossed, responsibleHubId: undefined })).field).toBe(
      'responsibleHubId',
    );
    expect(refusalOf(() => build({ ...crossed, relatedIds: {} })).field).toBe('relatedIds');
    expect(refusalOf(() => build({ ...crossed, object: { type: 'HUB', id: null } })).field).toBe(
      'object.id',
    );
    expect(refusalOf(() => build({ ...crossed, enhanced: false })).field).toBe('enhanced');
    // a read of one record names the record and the hub of the record; the operation is for the list-level event
    expect(
      build({
        ...crossed,
        object: { type: 'StaffIdentity', id: OBJECT_ID },
        relatedIds: undefined,
      }).objectType,
    ).toBe('StaffIdentity');
  });

  // Break caught: the four events whose tier depends on the act accepted with no basis, with a basis that gives the other tier, with
  // a basis the transaction contradicts, or with a basis on an event that has none. Each basis fixes its tier.
  it.each([
    ['auth.recovery.requested', 'ADMINISTRATOR_INITIATED', true, STAFF],
    ['auth.recovery.requested', 'SELF_SERVICE', false, AUTHENTICATION],
    ['staff.identity.created', 'BOOTSTRAP_SEED', true, BOOTSTRAP],
    ['staff.identity.created', 'OPERATION', false, STAFF],
  ] as const)('holds %s to its basis %s: the tier is %s', (code, basis, enhanced, context) => {
    const extras =
      code === 'auth.recovery.requested'
        ? {
            resultingState: 'ISSUED',
            relatedIds: {
              principal_type: 'STAFF',
              principal_id: OTHER_ID,
              ...(enhanced ? { initiated_by: STAFF_ID } : {}),
            },
          }
        : {};
    const beforeAfter = enhanced ? { created: 'NONE_TO_PENDING_APPROVAL' } : undefined;
    const event: AuditEventInput = {
      code,
      enhanced,
      enhancedBasis: basis,
      outcome: 'SUCCEEDED',
      object: {
        type: code === 'staff.identity.created' ? 'StaffIdentity' : 'RecoveryRequest',
        id: OBJECT_ID,
      },
      ...extras,
      ...(beforeAfter === undefined ? {} : { beforeAfter }),
    };

    expect(build(event, context).enhanced).toBe(enhanced);
    expect(refusalOf(() => build({ ...event, enhanced: !enhanced }, context)).field).toBe(
      'enhanced',
    );
    expect(refusalOf(() => build({ ...event, enhancedBasis: undefined }, context)).field).toBe(
      'enhancedBasis',
    );
    expect(refusalOf(() => build({ ...event, enhancedBasis: 'WHATEVER' }, context)).field).toBe(
      'enhancedBasis',
    );
  });

  // Break caught: a basis taken on the caller’s word where the transaction can say otherwise: a staff member claiming a seed, a
  // self-service request recorded from a staff transaction, an administrator-initiated one recorded for the system.
  it('checks a basis against the transaction when the transaction can say', () => {
    const seed: AuditEventInput = {
      code: 'staff.identity.created',
      enhanced: true,
      enhancedBasis: 'BOOTSTRAP_SEED',
      outcome: 'SUCCEEDED',
      object: { type: 'StaffIdentity', id: OBJECT_ID },
      beforeAfter: { created: 'NONE_TO_PENDING_APPROVAL' },
    };
    expect(refusalOf(() => build(seed, STAFF)).field).toBe('enhancedBasis');
    expect(refusalOf(() => build(seed, AUTHENTICATION)).field).toBe('enhancedBasis');
    // The reference seed is not the bootstrap: a transaction under the seed capability cannot claim the bootstrap basis (S0.30).
    expect(refusalOf(() => build(seed, REFERENCE_SEED)).field).toBe('enhancedBasis');
    expect(build(seed, BOOTSTRAP).enhanced).toBe(true);
    const recovery: AuditEventInput = {
      code: 'auth.recovery.requested',
      enhanced: true,
      enhancedBasis: 'ADMINISTRATOR_INITIATED',
      outcome: 'SUCCEEDED',
      object: { type: 'RecoveryRequest', id: OBJECT_ID },
      resultingState: 'ISSUED',
      relatedIds: { principal_type: 'STAFF', principal_id: OTHER_ID, initiated_by: STAFF_ID },
      beforeAfter: { recovery: 'NONE_TO_ISSUED' },
    };
    expect(refusalOf(() => build(recovery, AUTHENTICATION)).field).toBe('enhancedBasis');
    expect(
      refusalOf(() => build({ ...recovery, enhanced: false, enhancedBasis: 'SELF_SERVICE' }, STAFF))
        .field,
    ).toBe('enhancedBasis');
    // a basis on an event that has none is not accepted as context for something else
    expect(refusalOf(() => build({ ...plain, enhancedBasis: 'SELF_SERVICE' })).field).toBe(
      'enhancedBasis',
    );
  });

  // Break caught (S0.50): a self-service recovery request refused for want of an initiator it cannot have, an administrator's recorded
  // without the administrator who initiated it (or naming someone else), or either recorded without the principal it is for.
  it('holds a recovery request to its principal, and to an initiator exactly when an administrator initiated it', () => {
    const selfService: AuditEventInput = {
      code: 'auth.recovery.requested',
      enhanced: false,
      enhancedBasis: 'SELF_SERVICE',
      outcome: 'SUCCEEDED',
      actor: { type: 'SYSTEM', id: null },
      object: { type: 'RecoveryRequest', id: OBJECT_ID },
      resultingState: 'ISSUED',
      relatedIds: { principal_type: 'STAFF', principal_id: OTHER_ID },
    };
    expect(build(selfService, AUTHENTICATION).relatedIds).toEqual({
      principal_type: 'STAFF',
      principal_id: OTHER_ID,
    });
    expect(
      refusalOf(() =>
        build(
          { ...selfService, relatedIds: { ...selfService.relatedIds, initiated_by: STAFF_ID } },
          AUTHENTICATION,
        ),
      ).field,
    ).toBe('relatedIds');
    expect(
      refusalOf(() =>
        build({ ...selfService, relatedIds: { principal_type: 'STAFF' } }, AUTHENTICATION),
      ).field,
    ).toBe('relatedIds');

    const administrator: AuditEventInput = {
      ...selfService,
      enhanced: true,
      enhancedBasis: 'ADMINISTRATOR_INITIATED',
      actor: undefined,
      relatedIds: { principal_type: 'VENDOR', principal_id: OTHER_ID, initiated_by: STAFF_ID },
      beforeAfter: { recovery_request: { before: 'NONE', after: 'ISSUED' } },
    };
    expect(build(administrator).relatedIds).toMatchObject({ initiated_by: STAFF_ID });
    for (const relatedIds of [
      { principal_type: 'VENDOR', principal_id: OTHER_ID } as Record<string, string>,
      { principal_type: 'VENDOR', principal_id: OTHER_ID, initiated_by: OTHER_ID },
      { principal_id: OTHER_ID, initiated_by: STAFF_ID },
    ]) {
      expect(refusalOf(() => build({ ...administrator, relatedIds })).field).toBe('relatedIds');
    }
  });

  // Break caught: the null object accepted everywhere. The contract's own table says the object is not null; the two events for
  // which there is none to name (an unknown principal's failed sign-in; a refusal before any session) are the documented cases.
  it('allows no object only for the two events that describe a case without one', () => {
    const nobody = { type: 'Session', id: null };
    for (const code of ['auth.session.failed', 'auth.csrf.rejected'] as const) {
      expect(build({ ...plain, code, object: nobody }).objectId, code).toBeNull();
    }
    for (const code of [
      'auth.session.issued',
      'auth.lockout.applied',
      'auth.credential.changed',
    ] as const) {
      const error = refusalOf(() => build({ ...plain, code, object: nobody }));
      expect(error.field, code).toBe('object.id');
    }
  });

  // Break caught: a reason the catalogue says is mandatory left out, or a lineage key it names left out.
  it('requires the reason and the keys the catalogue names for the identity events it is clear about', () => {
    const terminated: AuditEventInput = {
      ...plain,
      code: 'auth.session.terminated',
      enhancedBasis: 'ROUTINE_TERMINATION',
      reason: { code: 'SIGNED_OUT', label: 'Signed out' },
    };
    expect(build(terminated).reasonCode).toBe('SIGNED_OUT');
    expect(refusalOf(() => build({ ...terminated, reason: undefined })).field).toBe('reason');

    const revoked: AuditEventInput = {
      code: 'auth.session.authority_revoked',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'Session', id: OBJECT_ID },
      reason: { code: 'AUTHORITY_CHANGED', label: 'Authority changed' },
      relatedIds: { revision: 4, reduction_floor: 3 },
      beforeAfter: { session: 'ACTIVE_TO_TERMINATED' },
    };
    expect(build(revoked).enhanced).toBe(true);
    expect(build({ ...revoked, relatedIds: { minimum_revision: 9 } }).enhanced).toBe(true);
    expect(refusalOf(() => build({ ...revoked, relatedIds: { revision: 4 } })).field).toBe(
      'relatedIds',
    );
    expect(refusalOf(() => build({ ...revoked, reason: undefined })).field).toBe('reason');

    const approved: AuditEventInput = {
      code: 'staff.identity.approved',
      enhanced: true,
      outcome: 'SUCCEEDED',
      object: { type: 'StaffIdentity', id: OBJECT_ID },
      relatedIds: { created_by: STAFF_ID, approved_by: OTHER_ID },
      beforeAfter: { status: 'PENDING_APPROVAL_TO_ACTIVE' },
    };
    expect(build(approved).enhanced).toBe(true);
    expect(
      refusalOf(() => build({ ...approved, relatedIds: { approved_by: OTHER_ID } })).field,
    ).toBe('relatedIds');
    expect(
      refusalOf(() =>
        build({
          ...approved,
          code: 'staff.identity.rejected',
          relatedIds: undefined,
        }),
      ).field,
    ).toBe('reason');
  });
});
