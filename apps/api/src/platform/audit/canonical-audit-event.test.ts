import { describe, expect, it } from 'vitest';

import { AUDIT_SERIALISATION_VERSION } from './audit-vocabulary.js';
import {
  CANONICAL_FIELDS,
  canonicalAuditEvent,
  type StoredAuditEvent,
} from './canonical-audit-event.js';

const STORED: StoredAuditEvent = {
  id: '019a0000-0000-7000-8000-000000000001',
  event_code: 'auth.session.failed',
  occurred_at: '2026-10-10T09:00:00.123456Z',
  recorded_at: '2026-10-10T09:00:00.234567Z',
  actor_type: 'SYSTEM',
  actor_id: null,
  actor_bundle: null,
  surface_context: 'SYSTEM',
  device_context: null,
  vendor_organization_id: null,
  responsible_hub_id: null,
  object_type: 'StaffIdentity',
  object_id: '33333333-3333-4333-8333-333333333333',
  correlation_id: 'request-1',
  previous_state: null,
  resulting_state: null,
  reason_code: null,
  reason_label: null,
  note: null,
  approval_id: null,
  before_after: null,
  related_ids: { b: [1, 2], a: { z: true, y: null } },
  detail: { cause: 'WRONG_PASSWORD', attempts: 3 },
  outcome: 'REJECTED',
  enhanced: false,
  serialisation_version: 1,
};

/**
 * The known answer for version 1: the exact bytes of the canonical form of `STORED`. A checkpoint hashes these bytes, so changing
 * them changes the hash of every event ever written under the version. A change of the form is a new version, never an edit
 * of this string.
 */
const KNOWN_ANSWER =
  '{"actor_bundle":null,"actor_id":null,"actor_type":"SYSTEM","approval_id":null,"before_after":null,"correlation_id":"request-1","detail":{"attempts":3,"cause":"WRONG_PASSWORD"},"device_context":null,"enhanced":false,"event_code":"auth.session.failed","id":"019a0000-0000-7000-8000-000000000001","note":null,"object_id":"33333333-3333-4333-8333-333333333333","object_type":"StaffIdentity","occurred_at":"2026-10-10T09:00:00.123456Z","outcome":"REJECTED","previous_state":null,"reason_code":null,"reason_label":null,"recorded_at":"2026-10-10T09:00:00.234567Z","related_ids":{"a":{"y":null,"z":true},"b":[1,2]},"responsible_hub_id":null,"resulting_state":null,"serialisation_version":1,"surface_context":"SYSTEM","vendor_organization_id":null}';

describe('the canonical serialisation of an audit event (version 1)', () => {
  // Break caught: any change to the bytes of the form, which would silently change every hash a checkpoint will hold.
  it('produces the exact bytes of the known answer', () => {
    expect(canonicalAuditEvent(STORED)).toBe(KNOWN_ANSWER);
  });

  // Break caught: the form depending on the order the database or a caller happens to list the keys in.
  it('does not depend on the order of the keys, at any depth', () => {
    const shuffled = Object.fromEntries(
      Object.entries(STORED).reverse(),
    ) as unknown as StoredAuditEvent;
    const nested = { ...STORED, related_ids: { a: { y: null, z: true }, b: [1, 2] } };

    expect(canonicalAuditEvent(shuffled)).toBe(KNOWN_ANSWER);
    expect(canonicalAuditEvent(nested)).toBe(KNOWN_ANSWER);
  });

  // Break caught: a field left out of the form, so that changing it would not change the hash (the event could be altered unseen).
  it('changes whenever any field changes', () => {
    const base = canonicalAuditEvent(STORED);
    const changed: Record<string, unknown> = {
      id: '019a0000-0000-7000-8000-000000000002',
      event_code: 'auth.session.issued',
      occurred_at: '2026-10-10T09:00:00.123457Z',
      recorded_at: '2026-10-10T09:00:00.234568Z',
      actor_type: 'STAFF',
      actor_id: '11111111-1111-4111-8111-111111111111',
      actor_bundle: 'Ops Staff',
      surface_context: 'OPS_PORTAL',
      device_context: { a: 1 },
      vendor_organization_id: '55555555-5555-4555-8555-555555555555',
      responsible_hub_id: '22222222-2222-4222-8222-222222222222',
      object_type: 'Session',
      object_id: null,
      correlation_id: 'request-2',
      previous_state: 'A',
      resulting_state: 'B',
      reason_code: 'R',
      reason_label: 'r',
      note: 'n',
      approval_id: '77777777-7777-4777-8777-777777777777',
      before_after: { a: 1 },
      related_ids: {},
      detail: {},
      outcome: 'SUCCEEDED',
      enhanced: true,
      serialisation_version: 2,
    };

    expect(Object.keys(changed).sort()).toEqual([...CANONICAL_FIELDS].sort());
    for (const [field, value] of Object.entries(changed)) {
      // The version is the form's own selector: a version this code does not define is refused (tested below), not rendered.
      if (field === 'serialisation_version') continue;
      expect(canonicalAuditEvent({ ...STORED, [field]: value }), field).not.toBe(base);
    }
  });

  // Break caught: a timestamp in a form that depends on the machine (a local zone, milliseconds only, a Date object).
  it('takes a timestamp only as the fixed UTC text with microseconds', () => {
    for (const bad of [
      '2026-10-10T09:00:00Z',
      '2026-10-10T09:00:00.123Z',
      '2026-10-10 09:00:00.123456+00',
      '2026-10-10T11:00:00.123456+02:00',
      new Date('2026-10-10T09:00:00.123Z'),
      null,
    ]) {
      expect(() => canonicalAuditEvent({ ...STORED, recorded_at: bad })).toThrow('recorded_at');
      expect(() => canonicalAuditEvent({ ...STORED, occurred_at: bad })).toThrow('occurred_at');
    }
  });

  // Break caught: a form silently produced for a version it does not define, which a checkpoint would then hash as if it were right.
  it('is the form of version 1 only', () => {
    expect(AUDIT_SERIALISATION_VERSION).toBe(1);
    expect(() => canonicalAuditEvent({ ...STORED, serialisation_version: 2 })).toThrow('version');
  });

  // Break caught: text that is not encoded the same way everywhere (a lone surrogate, which JSON.stringify must escape).
  it('escapes text by the JSON rules, a lone surrogate included', () => {
    // U+2028 is written by JSON.stringify as it is (JSON is a subset of ECMAScript since 2019); a lone surrogate is escaped.
    const lineSeparator = String.fromCodePoint(0x2028);
    const text = `a"b\\c${lineSeparator}\ud800d`;
    const form = canonicalAuditEvent({ ...STORED, note: text });

    expect(form).toContain(`"note":"a\\"b\\\\c${lineSeparator}\\ud800d"`);
    expect((JSON.parse(form) as { note: string }).note).toBe(text);
  });

  // Break caught: a value JSON cannot hold (NaN, a function, undefined) producing a form that cannot be read back.
  it('refuses a value that JSON cannot hold', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, 1n]) {
      expect(() => canonicalAuditEvent({ ...STORED, detail: { value: bad } })).toThrow('detail');
    }
  });
});
