import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUDIT_EVENT_CODES, isAuditEventCode } from './audit-event-codes.js';

const AUDIT_MD = readFileSync(
  resolve(import.meta.dirname, '../../../../../contracts/audit.md'),
  'utf8',
).replaceAll('\r', '');

/** The first cell of every table row whose first cell is a backticked `domain.object.verb`: the catalogue of section 5. */
function documentedCodes(): string[] {
  return AUDIT_MD.split('\n')
    .map((line) => /^\|\s*`([a-z_]+\.[a-z_0-9]+\.[a-z_0-9]+)`\s*\|/.exec(line)?.[1])
    .filter((code): code is string => code !== undefined);
}

describe('the audit event catalogue (audit.md section 5)', () => {
  // Break caught: the list drifting from the document in either direction, a code added to one and not the other.
  it('holds exactly the codes the document lists, in the document order', () => {
    expect([...AUDIT_EVENT_CODES]).toEqual(documentedCodes());
  });

  // Break caught: a duplicate row in the document being carried over (the document's own history records this defect once).
  it('lists no code twice', () => {
    expect(new Set(AUDIT_EVENT_CODES).size).toBe(AUDIT_EVENT_CODES.length);
  });

  // Break caught: a code that breaks the grammar of section 4 (domain.object.past-tense-verb) being accepted as an event.
  it('has only codes of the grammar domain.object.verb', () => {
    for (const code of AUDIT_EVENT_CODES) {
      expect(code, code).toMatch(/^[a-z]+\.[a-z0-9_]+\.[a-z0-9_]+$/);
    }
  });

  // Break caught: a guard that accepts a free string, or one that is not a string at all.
  it('knows a code by exact match, and nothing else', () => {
    expect(isAuditEventCode('auth.session.failed')).toBe(true);
    expect(isAuditEventCode('auth.session.failed ')).toBe(false);
    expect(isAuditEventCode('AUTH.SESSION.FAILED')).toBe(false);
    expect(isAuditEventCode('auth.session.invented')).toBe(false);
    expect(isAuditEventCode('')).toBe(false);
    expect(isAuditEventCode(undefined)).toBe(false);
    expect(isAuditEventCode(['auth.session.failed'])).toBe(false);
  });

  // Break caught: the identity events of the slice being absent from the list the writer honours.
  it('holds the identity events this slice records', () => {
    for (const code of [
      'auth.session.issued',
      'auth.session.failed',
      'auth.session.terminated',
      'auth.session.authority_revoked',
      'auth.lockout.applied',
      'auth.mfa.completed',
      'auth.mfa.failed',
      'auth.mfa.enrolled',
      'auth.mfa.reset',
      'auth.setup_grant.issued',
      'auth.recovery.requested',
      'auth.csrf.rejected',
      'auth.hub_boundary.crossed',
      'staff.identity.created',
      'staff.identity.approved',
    ]) {
      expect(isAuditEventCode(code), code).toBe(true);
    }
  });
});
