import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../auth/ports/audit-writer.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import {
  ENHANCED_CODES,
  EVENT_REQUIREMENTS,
  NO_DIFF_CODES,
  diffRuleFor,
} from './audit-classification.js';
import { AuditRefusedError, buildAuditRecord } from './audit-record.js';

/**
 * Whether an event carries a before and after depends on the change it records, not on its tier (audit.md §6; G2 follow-up). The
 * blanket rule it replaces ("every enhanced success needs any non-empty object") refused events whose catalogue entry names no
 * change and invited a made-up diff; the opposite blanket ("an event may omit its diff") would have let a privileged change go
 * unrecorded.
 */

const AUDIT_MD = readFileSync(
  resolve(import.meta.dirname, '../../../../../contracts/audit.md'),
  'utf8',
).replaceAll('\r', '');

const ID = '019a0000-0000-7000-8000-000000000001';
const NOW = new Date('2026-10-11T09:00:00.000Z');
const STAFF_ID = '11111111-1111-4111-8111-111111111111';
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

const DIFF = { state: { from: 'BEFORE', to: 'AFTER' } };
const enhanced = (code: string, over: Partial<AuditEventInput> = {}): AuditEventInput => ({
  code,
  enhanced: true,
  outcome: 'SUCCEEDED',
  object: { type: 'Session', id: OBJECT_ID },
  ...over,
});

describe('the events that record no change carry mandatory evidence and no before and after', () => {
  /** Each one with the facts of its own that the catalogue makes mandatory, and no diff. */
  const WITHOUT_DIFF: Record<(typeof NO_DIFF_CODES)[number], AuditEventInput> = {
    'auth.hub_boundary.crossed': enhanced('auth.hub_boundary.crossed', {
      object: { type: 'HUB', id: HUB },
      responsibleHubId: HUB,
      relatedIds: { operation_id: 'listOrders' },
    }),
    'auth.mfa.completed': enhanced('auth.mfa.completed'),
    'auth.mfa.failed': enhanced('auth.mfa.failed', { outcome: 'REJECTED' }),
    'payment.ledger.exported': enhanced('payment.ledger.exported'),
    'payment.ledger.export_retrieval_authorized': enhanced(
      'payment.ledger.export_retrieval_authorized',
    ),
    'dispatch.run.rollback': enhanced('dispatch.run.rollback', { outcome: 'FAILED' }),
  };

  // Break caught: a blanket "every enhanced success needs a non-empty object", which refuses these and invites a placeholder.
  it.each(NO_DIFF_CODES)('accepts %s with its own evidence and no before and after', (code) => {
    const record = build(WITHOUT_DIFF[code]);

    expect(record.enhanced).toBe(true);
    expect(record.beforeAfter).toBeNull();
  });

  // Break caught: a change invented for an event that changed nothing, which the ledger can never take back.
  it.each(NO_DIFF_CODES)(
    'refuses %s with a before and after, which would be a change that did not happen',
    (code) => {
      expect(refusalOf(() => build({ ...WITHOUT_DIFF[code], beforeAfter: DIFF })).field).toBe(
        'beforeAfter',
      );
    },
  );

  // Break caught: the exemption widening to the facts the read must keep.
  it('keeps the read’s hub, object and operation mandatory', () => {
    const read = WITHOUT_DIFF['auth.hub_boundary.crossed'];

    expect(refusalOf(() => build({ ...read, responsibleHubId: undefined })).field).toBe(
      'responsibleHubId',
    );
    expect(refusalOf(() => build({ ...read, relatedIds: {} })).field).toBe('relatedIds');
    expect(refusalOf(() => build({ ...read, object: { type: 'HUB', id: null } })).field).toBe(
      'object.id',
    );
    expect(refusalOf(() => build({ ...read, enhanced: false })).field).toBe('enhanced');
  });
});

describe('the events that record a change carry it, and only when it took effect', () => {
  const DIFF_EVENTS = ENHANCED_CODES.filter(
    (code) =>
      !(NO_DIFF_CODES as readonly string[]).includes(code) &&
      code !== 'auth.mfa.reset' &&
      !Object.hasOwn(EVENT_REQUIREMENTS, code),
  );

  // Break caught: an event that records a privileged change accepted without it (the opposite blanket: any event may omit its diff).
  it('refuses a successful change without its before and after, for every event that records one', () => {
    expect(DIFF_EVENTS.length).toBeGreaterThan(50);
    for (const code of DIFF_EVENTS) {
      expect(refusalOf(() => build(enhanced(code))).field, code).toBe('beforeAfter');
      expect(refusalOf(() => build(enhanced(code, { beforeAfter: {} }))).field, code).toBe(
        'beforeAfter',
      );
      expect(build(enhanced(code, { beforeAfter: DIFF })).beforeAfter, code).toEqual(DIFF);
      expect(
        build(enhanced(code, { outcome: 'RECONCILED', beforeAfter: DIFF })).enhanced,
        code,
      ).toBe(true);
    }
  });

  // Break caught: a rejected, failed or replayed attempt made to carry a change it did not make.
  it('asks for no before and after of an attempt that changed nothing, and refuses one', () => {
    for (const code of DIFF_EVENTS.slice(0, 12)) {
      for (const outcome of ['REJECTED', 'FAILED', 'REPLAYED'] as const) {
        expect(build(enhanced(code, { outcome })).beforeAfter, `${code} ${outcome}`).toBeNull();
        expect(
          refusalOf(() => build(enhanced(code, { outcome, beforeAfter: DIFF }))).field,
          `${code} ${outcome}`,
        ).toBe('beforeAfter');
      }
    }
  });

  // Break caught: the rule decided by the tier alone. An ordinary event is not held to a diff, and may carry one.
  it('does not ask an ordinary event for a before and after, and lets it carry one', () => {
    const ordinary: AuditEventInput = {
      code: 'auth.lockout.applied',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'StaffIdentity', id: OBJECT_ID },
    };

    expect(build(ordinary).beforeAfter).toBeNull();
    expect(
      build({ ...ordinary, beforeAfter: { locked: { from: false, to: true } } }).beforeAfter,
    ).not.toBeNull();
  });
});

describe('the branches of the events whose answer depends on what happened', () => {
  const recovery = (over: Partial<AuditEventInput> = {}): AuditEventInput => ({
    code: 'auth.recovery.requested',
    enhanced: true,
    enhancedBasis: 'ADMINISTRATOR_INITIATED',
    outcome: 'SUCCEEDED',
    object: { type: 'RecoveryRequest', id: OBJECT_ID },
    resultingState: 'ISSUED',
    relatedIds: { initiated_by: STAFF_ID },
    ...over,
  });

  // Break caught: a recovery request that created a request and queued a job recorded as if it changed nothing, or a coalesced one
  // (no request, no link, no job) given a change.
  it('requires the diff of an administrator-initiated recovery that was ISSUED, and forbids one on COALESCED', () => {
    expect(refusalOf(() => build(recovery())).field).toBe('beforeAfter');
    expect(
      build(recovery({ beforeAfter: { recovery_request: { before: 'NONE', after: 'ISSUED' } } }))
        .enhanced,
    ).toBe(true);

    expect(build(recovery({ resultingState: 'COALESCED' })).beforeAfter).toBeNull();
    expect(
      refusalOf(() => build(recovery({ resultingState: 'COALESCED', beforeAfter: DIFF }))).field,
    ).toBe('beforeAfter');
  });

  // Break caught: the self-service branch, which is not enhanced, held to a diff as if it were.
  it('leaves the diff of a self-service recovery optional, and still forbids one on COALESCED', () => {
    const selfService = (over: Partial<AuditEventInput> = {}): AuditEventInput =>
      recovery({ enhanced: false, enhancedBasis: 'SELF_SERVICE', ...over });

    expect(build(selfService(), AUTHENTICATION).beforeAfter).toBeNull();
    expect(build(selfService({ beforeAfter: DIFF }), AUTHENTICATION).beforeAfter).toEqual(DIFF);
    expect(
      build(selfService({ resultingState: 'COALESCED' }), AUTHENTICATION).beforeAfter,
    ).toBeNull();
  });

  // Break caught: the admin revocation of a session recorded as an ordinary termination (it sits outside the table row that lists the
  // event without a tier), or an ordinary sign-out held to the enhanced rules.
  it('makes an administrator’s revocation of a session enhanced, with its diff, and leaves a sign-out ordinary', () => {
    const terminated = (over: Partial<AuditEventInput> = {}): AuditEventInput => ({
      code: 'auth.session.terminated',
      enhanced: false,
      enhancedBasis: 'ROUTINE_TERMINATION',
      outcome: 'SUCCEEDED',
      object: { type: 'Session', id: OBJECT_ID },
      reason: { code: 'SIGNED_OUT', label: 'Signed out' },
      ...over,
    });
    const revocation = (over: Partial<AuditEventInput> = {}): AuditEventInput =>
      terminated({
        enhanced: true,
        enhancedBasis: 'ADMINISTRATIVE_REVOCATION',
        reason: { code: 'ADMIN_REVOKED', label: 'Revoked by an administrator' },
        ...over,
      });

    expect(build(terminated()).enhanced).toBe(false);
    expect(refusalOf(() => build(terminated({ enhanced: true }))).field).toBe('enhanced');
    expect(refusalOf(() => build(revocation())).field).toBe('beforeAfter');
    expect(
      build(revocation({ beforeAfter: { session: { before: 'ACTIVE', after: 'TERMINATED' } } }))
        .enhanced,
    ).toBe(true);
    // an administrator is a staff transaction, and the sign-in service is not one
    expect(
      refusalOf(() =>
        build(
          revocation({ beforeAfter: { session: { before: 'ACTIVE', after: 'TERMINATED' } } }),
          AUTHENTICATION,
        ),
      ).field,
    ).toBe('enhancedBasis');
    expect(refusalOf(() => build(revocation({ enhancedBasis: undefined }))).field).toBe(
      'enhancedBasis',
    );
    expect(refusalOf(() => build(terminated({ reason: undefined }))).field).toBe('reason');
  });

  // Break caught: the rule function and the writer disagreeing, which is how a table of cases stops being the rule.
  it('states the rule as one function', () => {
    const rule = (code: string, over: Record<string, unknown> = {}) =>
      diffRuleFor({ code, enhanced: true, outcome: 'SUCCEEDED', ...over });

    expect(rule('staff.identity.suspended')).toBe('REQUIRED');
    expect(rule('staff.identity.suspended', { outcome: 'REJECTED' })).toBe('ABSENT');
    expect(rule('auth.hub_boundary.crossed')).toBe('ABSENT');
    expect(rule('auth.mfa.reset', { resultingState: 'ISSUED' })).toBe('REQUIRED');
    expect(rule('auth.mfa.reset', { resultingState: 'COALESCED' })).toBe('ABSENT');
    expect(rule('auth.recovery.requested', { enhanced: false })).toBe('OPTIONAL');
    expect(rule('auth.lockout.applied', { enhanced: false })).toBe('OPTIONAL');
  });
});

describe('the document and the code agree about which events carry no before and after', () => {
  // Break caught: the list in audit.md section 6 and the list the writer applies drifting apart in either direction.
  it('names in section 6 exactly the events the writer holds to no diff', () => {
    const line = AUDIT_MD.split('\n').find((candidate) =>
      candidate.includes('record no change of business state, and carry no `before_after`'),
    );
    expect(line).toBeDefined();
    const named = [...(line ?? '').matchAll(/`([a-z_]+\.[a-z_]+\.[a-z_]+)`/g)].map(
      (match) => match[1],
    );

    expect(named.toSorted()).toEqual([...NO_DIFF_CODES].toSorted());
  });
});
