import { describe, expect, it } from 'vitest';

import type { AuditEventInput } from '../auth/ports/audit-writer.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import { AUDIT_OBJECT_TYPES, AUDIT_SERIALISATION_VERSION } from './audit-vocabulary.js';
import { AuditRefusedError, buildAuditRecord } from './audit-record.js';

const ID = '019a0000-0000-7000-8000-000000000001';
const NOW = new Date('2026-10-10T09:00:00.000Z');
const STAFF_ID = '11111111-1111-4111-8111-111111111111';
const HUB = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: STAFF_ID.toUpperCase(),
  surface: 'OPS_PORTAL',
  correlationId: 'request-1',
};
const VENDOR: SecurityContext = {
  principalType: 'VENDOR',
  principalId: '44444444-4444-4444-8444-444444444444',
  surface: 'VENDOR_PWA',
  vendorOrganizationId: '55555555-5555-4555-8555-555555555555',
  correlationId: 'request-2',
};
const SYSTEM: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: '66666666-6666-4666-8666-666666666666',
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'request-3',
};

const EVENT: AuditEventInput = {
  code: 'auth.session.issued',
  enhanced: false,
  outcome: 'SUCCEEDED',
  object: { type: 'StaffIdentity', id: OBJECT_ID },
};

const build = (input: Partial<AuditEventInput> = {}, context: SecurityContext = STAFF) =>
  buildAuditRecord({ ...EVENT, ...input }, context, NOW, ID);

const refusal = (run: () => unknown): AuditRefusedError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AuditRefusedError);
    return error as AuditRefusedError;
  }
  throw new Error('expected the event to be refused');
};

describe('the audit record: who, where and under what request', () => {
  // Break caught: a field the contract makes mandatory missing from the record, or a default that is not the contract's.
  it('makes a record from the event and the context of its transaction', () => {
    const record = build();

    expect(record).toMatchObject({
      id: ID,
      eventCode: 'auth.session.issued',
      occurredAt: NOW,
      actorType: 'STAFF',
      actorId: STAFF_ID,
      surfaceContext: 'OPS_PORTAL',
      correlationId: 'request-1',
      objectType: 'StaffIdentity',
      objectId: OBJECT_ID,
      outcome: 'SUCCEEDED',
      enhanced: false,
      serialisationVersion: AUDIT_SERIALISATION_VERSION,
      detail: {},
    });
    for (const absent of [
      'actorBundle',
      'deviceContext',
      'vendorOrganizationId',
      'responsibleHubId',
      'previousState',
      'resultingState',
      'reasonCode',
      'reasonLabel',
      'note',
      'approvalId',
      'beforeAfter',
      'relatedIds',
    ] as const) {
      expect(record[absent], absent).toBeNull();
    }
  });

  // Break caught: the actor's id copied from the principal of a SYSTEM context (a technical identifier, never a person).
  it('records a SYSTEM transaction as the system, with no actor id whatever the context carries', () => {
    expect(build({}, SYSTEM)).toMatchObject({ actorType: 'SYSTEM', actorId: null });
  });

  // Break caught: the vendor's actor type written as the principal type instead of the contract's VENDOR_ACCOUNT.
  it('records a vendor principal as a vendor account', () => {
    expect(build({}, VENDOR)).toMatchObject({
      actorType: 'VENDOR_ACCOUNT',
      actorId: VENDOR.principalId,
      surfaceContext: 'VENDOR_PWA',
    });
  });

  // Break caught: a human principal's transaction recording an act as somebody else, which would forge the ledger.
  it('lets a human principal record itself and nobody else', () => {
    expect(build({ actor: { type: 'STAFF', id: STAFF_ID } }).actorId).toBe(STAFF_ID);

    for (const other of [
      { type: 'STAFF', id: '99999999-9999-4999-8999-999999999999' },
      { type: 'RIDER', id: STAFF_ID },
      { type: 'SYSTEM', id: null },
    ] as const) {
      expect(refusal(() => build({ actor: other })).code).toBe('AUDIT_EVENT_REFUSED');
    }
  });

  // Break caught: a SYSTEM transaction unable to name the person it authenticated, or able to give the system an id.
  it('lets a SYSTEM transaction name the person it authenticated, and gives the system no id', () => {
    expect(build({ actor: { type: 'STAFF', id: STAFF_ID } }, SYSTEM)).toMatchObject({
      actorType: 'STAFF',
      actorId: STAFF_ID,
    });
    expect(build({ actor: { type: 'SYSTEM', id: null } }, SYSTEM).actorId).toBeNull();
    expect(refusal(() => build({ actor: { type: 'SYSTEM', id: STAFF_ID } }, SYSTEM)).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
    expect(refusal(() => build({ actor: { type: 'STAFF', id: null } }, SYSTEM)).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
    expect(refusal(() => build({ actor: { type: 'STAFF', id: 'not-a-uuid' } }, SYSTEM)).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
  });

  // Break caught (review of 10 October 2026, finding 5): the technical identifier of a SYSTEM transaction, which OB-47 keeps out of
  // `actor_id`, put there by a caller that names it as the person it authenticated.
  it('refuses to record the technical identifier of a SYSTEM transaction as a person, in any case', () => {
    for (const type of ['STAFF', 'RIDER', 'VENDOR_ACCOUNT'] as const) {
      for (const id of [SYSTEM.principalId, SYSTEM.principalId.toUpperCase()]) {
        expect(refusal(() => build({ actor: { type, id } }, SYSTEM)).code, `${type} ${id}`).toBe(
          'AUDIT_EVENT_REFUSED',
        );
      }
    }
  });

  // Break caught (review of 10 October 2026, finding 4): the correlation id stored as it came, so that an identifier the client
  // chose (the Idempotency-Key is client text) carries an address or a number into the append-only ledger past the screening.
  it('screens the correlation id like any other text: an address or a number is refused, an identifier is stored as it is', () => {
    for (const correlationId of ['ama@example.test', 'req +233201234567', '+14155550123']) {
      expect(refusal(() => build({}, { ...STAFF, correlationId })).code, correlationId).toBe(
        'AUDIT_DETAIL_REFUSED',
      );
    }
    for (const correlationId of [
      'request-1',
      '019a0000-0000-7000-8000-000000000001',
      'idem_4f9c2b7a-ba11',
    ]) {
      expect(build({}, { ...STAFF, correlationId }).correlationId).toBe(correlationId);
    }
  });

  // Break caught: an event code outside the catalogue being stored (the ledger would hold a free string).
  it('refuses a code that the catalogue does not hold', () => {
    for (const code of [
      'auth.session.invented',
      'AUTH.SESSION.FAILED',
      '',
      'auth.session.failed ',
    ]) {
      expect(refusal(() => build({ code })).code, code).toBe('AUDIT_EVENT_CODE_UNKNOWN');
    }
  });

  // Break caught: the closed object-type set not being closed.
  it('takes an object type from the closed set, and an id that is a uuid or none', () => {
    for (const type of AUDIT_OBJECT_TYPES) {
      expect(build({ object: { type, id: OBJECT_ID } }).objectType).toBe(type);
    }
    expect(build({ object: { type: 'HUB', id: HUB } }).objectType).toBe('HUB');
    // no object to name is allowed for the two events the catalogue describes it for (G2-06), and for no other
    expect(
      build({ code: 'auth.session.failed', object: { type: 'Session', id: null } }).objectId,
    ).toBeNull();
    expect(refusal(() => build({ object: { type: 'Session', id: null } })).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
    expect(refusal(() => build({ object: { type: 'Invented', id: OBJECT_ID } })).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
    expect(refusal(() => build({ object: { type: 'Session', id: 'session-1' } })).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
  });

  // Break caught: an outcome or a tier that is not a value of the contract, or a non-boolean tier read as true.
  it('takes an outcome from the contract and a real boolean for the tier', () => {
    for (const outcome of ['SUCCEEDED', 'REJECTED', 'FAILED', 'REPLAYED', 'RECONCILED'] as const) {
      expect(build({ outcome }).outcome).toBe(outcome);
    }
    expect(refusal(() => build({ outcome: 'OK' as never })).code).toBe('AUDIT_EVENT_REFUSED');
    expect(refusal(() => build({ enhanced: 'yes' as never })).code).toBe('AUDIT_EVENT_REFUSED');
    // the tier is the catalogue's (G2-06): an event it makes enhanced is written enhanced, with the before and after of the change
    expect(
      build({
        code: 'staff.identity.suspended',
        enhanced: true,
        beforeAfter: { status: 'ACTIVE_TO_SUSPENDED' },
      }).enhanced,
    ).toBe(true);
  });

  // Break caught: the act's own time replaced by the time of writing, and an unreadable date accepted.
  it('uses the time the act happened when it is given, and the writer’s otherwise', () => {
    const earlier = new Date('2026-10-10T05:00:00.000Z');

    expect(build({ occurredAt: earlier }).occurredAt).toEqual(earlier);
    expect(build().occurredAt).toEqual(NOW);
    expect(refusal(() => build({ occurredAt: new Date('nope') })).code).toBe('AUDIT_EVENT_REFUSED');
    expect(refusal(() => build({ occurredAt: '2026-10-10' as never })).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
  });

  // Break caught: identifiers stored in the case they arrived in, so one id reads as two.
  it('stores every identifier in lower case and refuses one that is not a uuid', () => {
    const record = build({
      responsibleHubId: HUB.toUpperCase(),
      vendorOrganizationId: VENDOR.vendorOrganizationId?.toUpperCase() ?? '',
      approvalId: OBJECT_ID.toUpperCase(),
    });
    expect(record.responsibleHubId).toBe(HUB);
    expect(record.vendorOrganizationId).toBe(VENDOR.vendorOrganizationId);
    expect(record.approvalId).toBe(OBJECT_ID);
    expect(refusal(() => build({ responsibleHubId: 'hub-1' })).code).toBe('AUDIT_EVENT_REFUSED');
  });

  // Break caught: a reason without its label snapshot (a timeline would then join to the live catalogue), or one without its code.
  it('snapshots the reason with its label, or records none', () => {
    const record = build({ reason: { code: 'DEVICE_LOST', label: 'Device lost' } });
    expect(record).toMatchObject({ reasonCode: 'DEVICE_LOST', reasonLabel: 'Device lost' });
    expect(refusal(() => build({ reason: { code: 'device lost', label: 'x' } })).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
    expect(refusal(() => build({ reason: { code: 'DEVICE_LOST', label: '' } })).code).toBe(
      'AUDIT_EVENT_REFUSED',
    );
  });

  // Break caught: a free-text state, which would let a transition read differently from the state machine's names.
  it('takes states in the form of the state machines', () => {
    const record = build({ previousState: 'PENDING_APPROVAL', resultingState: 'ACTIVE' });
    expect(record).toMatchObject({ previousState: 'PENDING_APPROVAL', resultingState: 'ACTIVE' });
    expect(refusal(() => build({ resultingState: 'active now' })).code).toBe('AUDIT_EVENT_REFUSED');
  });

  // Break caught: the input being changed or the record being open to change after it was made.
  it('does not change the event it is given, and returns a record nobody can change', () => {
    const input: AuditEventInput = {
      ...EVENT,
      detail: { cause: 'WRONG_PASSWORD' },
      relatedIds: { session_id: OBJECT_ID },
    };
    const before = JSON.stringify(input);
    const record = buildAuditRecord(input, STAFF, NOW, ID);

    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.detail)).toBe(true);
  });
});

describe('the audit record: what may be written into the facts', () => {
  const detailOf = (detail: AuditEventInput['detail']) => build({ detail }).detail;

  // Break caught: the facts a catalogue row names (cause, factor, kind of channel) not reaching the record.
  it('keeps plain facts as they are', () => {
    expect(
      detailOf({
        cause: 'WRONG_PASSWORD',
        factor: 'PASSWORD',
        attempts: 3,
        locked: true,
        until: null,
      }),
    ).toEqual({
      cause: 'WRONG_PASSWORD',
      factor: 'PASSWORD',
      attempts: 3,
      locked: true,
      until: null,
    });
  });

  // Break caught: a field named for a secret being stored at all (the key says what the value is, so the value must not be there).
  it('refuses a fact whose name says it is a secret', () => {
    for (const key of [
      'password',
      'new_password',
      'token',
      'setup_token',
      'recovery_token',
      'totp_seed',
      'secret',
      'authorization',
      'cookie',
      'csrf_token',
      'signature',
      'api_key',
      'private_key',
      'signed_url',
      'otp',
      'pin',
      'seed',
    ]) {
      expect(refusal(() => detailOf({ [key]: 'x' })).code, key).toBe('AUDIT_DETAIL_REFUSED');
    }
  });

  // Break caught: the refusal repeating the value it refused, which would put the secret into the error and the log.
  it('names the field it refused and never repeats a value', () => {
    const error = refusal(() => detailOf({ password: 'hunter2-planted' }));

    expect(error.message).not.toContain('hunter2');
    expect(error.message).toContain('detail');
  });

  // Break caught: a key that is not a plain name, which could carry data or break the stored form.
  it('refuses a name that is not a plain snake_case word', () => {
    for (const key of [
      'Cause',
      'cause-code',
      'cause code',
      '',
      '1cause',
      'a'.repeat(65),
      '__proto__',
    ]) {
      expect(refusal(() => detailOf({ [key]: 'x' })).code, key).toBe('AUDIT_DETAIL_REFUSED');
    }
  });

  // Break caught: a secret planted in a value under an innocent name reaching the ledger. Free text is scrubbed as logs are.
  it('removes a secret that travels inside a text value', () => {
    const detail = detailOf({
      cause: 'password=hunter2-planted',
      header: 'Bearer abcDEF123456789.planted-token',
      link: 'https://user:planted-pass@example.test/x',
    });

    const stored = JSON.stringify(detail);
    expect(stored).not.toContain('hunter2-planted');
    expect(stored).not.toContain('planted-token');
    expect(stored).not.toContain('planted-pass');
    expect(stored).toContain('[REDACTED]');
  });

  // Break caught: an address or a number written into the ledger ("never the address").
  it('refuses a value that is an email address or a telephone number', () => {
    for (const value of [
      'rider@example.test',
      'Name <a@b.co>',
      '+233201234567',
      'call +233201234567',
    ]) {
      expect(refusal(() => detailOf({ channel: value })).code, value).toBe('AUDIT_DETAIL_REFUSED');
    }
    expect(detailOf({ channel: 'EMAIL' })).toEqual({ channel: 'EMAIL' });
  });

  // Break caught: a value of a kind the ledger cannot hold faithfully (an object in a flat record, an unbounded number).
  it('refuses a value that is not text, a finite number, a boolean or null', () => {
    for (const value of [
      { a: 1 },
      [1],
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => 1,
    ]) {
      expect(refusal(() => detailOf({ cause: value as never })).code).toBe('AUDIT_DETAIL_REFUSED');
    }
  });

  // Break caught: unbounded facts, which would make an event as large as a request.
  it('bounds the number of facts, the length of a text and the whole', () => {
    const many = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`fact_${String(i)}`, 'x']),
    );
    expect(refusal(() => detailOf(many)).code).toBe('AUDIT_DETAIL_REFUSED');
    expect(refusal(() => detailOf({ cause: 'x'.repeat(513) })).code).toBe('AUDIT_DETAIL_REFUSED');
    expect(detailOf({ cause: 'x'.repeat(512) })).toEqual({ cause: 'x'.repeat(512) });
  });

  // Break caught: before/after and related ids escaping the screening that detail gets, or nesting without bound.
  it('screens the structured facts the same way, and bounds their depth', () => {
    const ok = build({
      beforeAfter: { status: { from: 'PENDING', to: 'ACTIVE' } },
      relatedIds: { session_id: OBJECT_ID, grants: [OBJECT_ID] },
      deviceContext: { model_class: 'HARDWARE_BACKED' },
    });
    expect(ok.beforeAfter).toEqual({ status: { from: 'PENDING', to: 'ACTIVE' } });
    expect(ok.relatedIds).toEqual({ session_id: OBJECT_ID, grants: [OBJECT_ID] });

    expect(refusal(() => build({ beforeAfter: { auth: { token: 'x' } } })).code).toBe(
      'AUDIT_DETAIL_REFUSED',
    );
    expect(
      refusal(() => build({ relatedIds: { a: { b: { c: { d: { e: { f: 1 } } } } } } })).code,
    ).toBe('AUDIT_DETAIL_REFUSED');
    const wide = { items: Array.from({ length: 400 }, () => 'x'.repeat(40)) };
    expect(refusal(() => build({ relatedIds: wide })).code).toBe('AUDIT_DETAIL_REFUSED');
    expect(refusal(() => build({ beforeAfter: [1] as never })).code).toBe('AUDIT_DETAIL_REFUSED');
  });

  // Break caught: free text in the note bypassing the screening, or unbounded.
  it('scrubs and bounds the note', () => {
    expect(build({ note: 'Called the vendor.' }).note).toBe('Called the vendor.');
    expect(build({ note: 'token=planted-note-secret' }).note).not.toContain('planted-note-secret');
    expect(refusal(() => build({ note: 'x'.repeat(1001) })).code).toBe('AUDIT_DETAIL_REFUSED');
    expect(refusal(() => build({ note: 'mail me at a@b.co' })).code).toBe('AUDIT_DETAIL_REFUSED');
  });

  // Break caught: a prototype key smuggled through the structured facts to change how the stored object reads.
  it('does not let a prototype key change the stored facts', () => {
    const polluted = JSON.parse('{"__proto__": {"polluted": true}}') as never;

    expect(refusal(() => build({ relatedIds: polluted })).code).toBe('AUDIT_DETAIL_REFUSED');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
