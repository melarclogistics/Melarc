import { describe, expect, it } from 'vitest';

import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type { SessionSelector, SessionStore } from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { endForAuthority, relatedIdsOfFloor, type BelowFloor } from './session-authority.js';

/**
 * Ending a session because its authority was reduced (S0.26; SECURITY_DESIGN.md section 13.10a), on fakes: that it ends the one session
 * it was given, records it once with the facts of the floor, and records nothing for a session something else had already ended. The
 * judgement of which floor a session is below, and the same on a real database, are `authority.db.test.ts`.
 */
const SESSION = '11111111-1111-4111-8111-111111111111';
const BUNDLE = '22222222-2222-4222-8222-222222222222';
const HANDLE = {} as TransactionHandle;

const BUNDLE_FLOOR: BelowFloor = {
  kind: 'BUNDLE',
  bundleId: BUNDLE,
  revision: 4,
  reductionFloor: 4,
};
const FIXED_FLOOR: BelowFloor = { kind: 'FIXED', principalType: 'VENDOR', minimumRevision: 3 };

function harness(ends: readonly string[]) {
  const terminated: { selector: SessionSelector; reason: string }[] = [];
  const written: AuditEventInput[] = [];
  const sessions: Pick<SessionStore, 'terminate'> = {
    terminate: (_handle, selector, reason) => {
      terminated.push({ selector, reason });
      return Promise.resolve(ends);
    },
  };
  const audit: AuditWriter = {
    write: (_handle, event) => {
      written.push(event);
      return Promise.resolve();
    },
  };
  return { dependencies: { sessions, audit }, terminated, written };
}

describe('endForAuthority', () => {
  // Break caught: a session ended for the wrong reason, or by a selector wider than the one session it was given.
  it('ends the one session it was given, with AUTHORITY_CHANGED', async () => {
    const run = harness([SESSION]);

    expect(await endForAuthority(HANDLE, run.dependencies, SESSION, BUNDLE_FLOOR)).toBe(true);

    expect(run.terminated).toEqual([
      { selector: { by: 'session', sessionId: SESSION }, reason: 'AUTHORITY_CHANGED' },
    ]);
  });

  // Break caught: an ended session with no record, or a record that is not the enhanced event with the floor's facts and the
  // before and after the catalogue requires.
  it.each([
    ['a bundle floor', BUNDLE_FLOOR, { bundle_id: BUNDLE, revision: 4, reduction_floor: 4 }],
    ['a fixed-policy floor', FIXED_FLOOR, { principal_type: 'VENDOR', minimum_revision: 3 }],
  ])(
    'records it once as an enhanced auth.session.authority_revoked, for %s',
    async (_label, floor, related) => {
      const run = harness([SESSION]);

      await endForAuthority(HANDLE, run.dependencies, SESSION, floor);

      expect(run.written).toEqual([
        {
          code: 'auth.session.authority_revoked',
          enhanced: true,
          outcome: 'SUCCEEDED',
          object: { type: 'Session', id: SESSION },
          reason: { code: 'AUTHORITY_CHANGED', label: 'Authority changed' },
          relatedIds: related,
          beforeAfter: { session: 'ACTIVE_TO_TERMINATED' },
        },
      ]);
      expect(relatedIdsOfFloor(floor)).toEqual(related);
    },
  );

  // Break caught: a second event for a session that a reduction, a sign-out or another request ended first, which would put two facts
  // in the append-only ledger for one ending. It answers "this call did not end it" and writes nothing.
  it('records nothing for a session that something else had already ended', async () => {
    const run = harness([]);

    expect(await endForAuthority(HANDLE, run.dependencies, SESSION, BUNDLE_FLOOR)).toBe(false);

    expect(run.written).toEqual([]);
  });
});
