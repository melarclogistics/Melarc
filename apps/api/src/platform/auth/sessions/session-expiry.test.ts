import { describe, expect, it } from 'vitest';

import type { AuditEventInput, AuditWriter } from '../ports/audit-writer.port.js';
import type { SessionStore } from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';
import { endForExpiry } from './session-expiry.js';

/**
 * Ending a session because its time ran out (S0.34; AC-SLICE-000-35; SECURITY_DESIGN.md section 15.4), on fakes: that it asks the store
 * to judge and end the one session it was given, records the ending once, ordinary and by the system, with the bound that ran out,
 * and records nothing for a session the store did not end. The statement that judges, on a real database, is `session-store.db.test.ts`
 * and the whole request is `session-authentication.db.test.ts`.
 */
const SESSION = '11111111-1111-4111-8111-111111111111';
const HANDLE = {} as TransactionHandle;

function harness(ends: boolean) {
  const asked: { sessionId: string; idleMinutes: number | null }[] = [];
  const written: AuditEventInput[] = [];
  const sessions: Pick<SessionStore, 'expire'> = {
    expire: (_handle, sessionId, idleMinutes) => {
      asked.push({ sessionId, idleMinutes });
      return Promise.resolve(ends);
    },
  };
  const audit: AuditWriter = {
    write: (_handle, event) => {
      written.push(event);
      return Promise.resolve();
    },
  };
  return { dependencies: { sessions, audit }, asked, written };
}

describe('endForExpiry', () => {
  // Break caught: the expiry judged on what the request read and not by the store, or asked of a session other than the one given.
  it('asks the store to judge and end the one session it was given, with its idle limit', async () => {
    const run = harness(true);

    expect(await endForExpiry(HANDLE, run.dependencies, SESSION, 30, 'IDLE')).toBe(true);
    expect(await endForExpiry(HANDLE, run.dependencies, SESSION, null, 'ABSOLUTE')).toBe(true);

    expect(run.asked).toEqual([
      { sessionId: SESSION, idleMinutes: 30 },
      { sessionId: SESSION, idleMinutes: null },
    ]);
  });

  // Break caught: an ending with no record, a record that is the enhanced event, or one that names the wrong bound or carries a person.
  it.each(['IDLE', 'ABSOLUTE'] as const)(
    'records it once as an ordinary auth.session.terminated with the reason EXPIRED, naming the bound %s',
    async (cause) => {
      const run = harness(true);

      await endForExpiry(HANDLE, run.dependencies, SESSION, cause === 'IDLE' ? 30 : null, cause);

      expect(run.written).toEqual([
        {
          code: 'auth.session.terminated',
          enhanced: false,
          enhancedBasis: 'ROUTINE_TERMINATION',
          outcome: 'SUCCEEDED',
          object: { type: 'Session', id: SESSION },
          reason: { code: 'EXPIRED', label: 'Expired' },
          detail: { cause },
        },
      ]);
    },
  );

  // Break caught: a second event for a session that a sign-out or a revocation ended first, or that was recorded as active while the
  // expiry waited: it answers "this call did not end it" and writes nothing.
  it('records nothing for a session the store did not end', async () => {
    const run = harness(false);

    expect(await endForExpiry(HANDLE, run.dependencies, SESSION, 30, 'IDLE')).toBe(false);

    expect(run.written).toEqual([]);
  });
});
