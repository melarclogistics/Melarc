import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresAuditWriter } from '../../src/platform/audit/postgres.audit-writer.adapter.js';
import type { AuditEventInput } from '../../src/platform/auth/ports/audit-writer.port.js';
import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import {
  SESSION_TERMINATION_REASONS,
  type SessionPrincipalType,
} from '../../src/platform/auth/ports/session-store.port.js';
import { PostgresSessionStore } from '../../src/platform/auth/sessions/postgres.session-store.adapter.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { insertSessionRow, sessionRow, type SessionRow } from './support/identities.js';
import { withHandle } from './support/handle.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.34 (migration 0023): what a signed-in principal may write to end its own session, against a real PostgreSQL, as the API's login
 * (`melarc_api_runtime`). Two policies change and nothing else: `session_update` admits a principal to end **the session it is acting
 * in** (never another, never for another reason, never to record activity), and `audit_event_insert` admits a Vendor and a Rider to
 * write **their own `auth.session.terminated`** (the narrow arms the owner approved on 11 October 2026, P-1: only their own events,
 * nothing under another actor, type, surface or code; neither reads, changes or removes a row of the ledger). The staff and
 * `authentication` arms stay as they were.
 */
const PRINCIPALS: readonly SessionPrincipalType[] = ['STAFF', 'VENDOR', 'RIDER'];
const SURFACE = { STAFF: 'OPS_PORTAL', VENDOR: 'VENDOR_PWA', RIDER: 'RIDER_ANDROID' } as const;
const ACTOR = { STAFF: 'STAFF', VENDOR: 'VENDOR_ACCOUNT', RIDER: 'RIDER' } as const;

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;
const store = new PostgresSessionStore(new SystemClock());
const writer = new PostgresAuditWriter(new SystemClock());

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

/** A principal's context, as the operation runner builds it: the principal, the surface and **the session that acts**. */
function acting(
  type: SessionPrincipalType,
  principalId: string,
  sessionId: string | undefined,
): SecurityContext {
  const base = {
    principalId,
    correlationId: 'sign-out-authority-test',
    ...(sessionId === undefined ? {} : { sessionId }),
  } as const;
  switch (type) {
    case 'STAFF':
      return { ...base, principalType: 'STAFF', surface: 'OPS_PORTAL' };
    case 'VENDOR':
      return {
        ...base,
        principalType: 'VENDOR',
        surface: 'VENDOR_PWA',
        vendorOrganizationId: randomUUID(),
      };
    case 'RIDER':
      return { ...base, principalType: 'RIDER', surface: 'RIDER_ANDROID', riderId: principalId };
  }
}

const system = (capability: 'authentication' | 'rate_limit'): SecurityContext => ({
  principalType: 'SYSTEM',
  principalId: randomUUID(),
  surface: 'SYSTEM',
  taskCapability: capability,
  correlationId: 'sign-out-authority-test',
});

/** A live session of a principal of the type, with what the table requires of that type. */
const sessionOf = (
  type: SessionPrincipalType,
  principalId: string = randomUUID(),
): Promise<SessionRow> =>
  insertSessionRow(
    admin,
    sessionRow({
      principalType: type,
      principalId,
      ...(type === 'STAFF' ? {} : { registeredDeviceId: randomUUID(), policyRevision: 1 }),
    }),
  );

async function stateOf(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
}

async function stored(id: string): Promise<{ terminated: boolean; reason: string | null }> {
  const result = await admin.query<{
    terminated_at: Date | null;
    termination_reason: string | null;
  }>('select terminated_at, termination_reason from session where id = $1', [id]);
  const row = result.rows[0];
  if (row === undefined) throw new Error('the session is not there');
  return { terminated: row.terminated_at !== null, reason: row.termination_reason };
}

describe.each(PRINCIPALS)('a %s principal ending its own session', (type) => {
  // Break caught: the policy not admitting a principal to end the session it acts in, so that sign-out could not commit.
  it('ends the session it is acting in with SIGNED_OUT, and the store says it did', async () => {
    const own = await sessionOf(type);

    const ended = await withHandle(built.service, acting(type, own.principalId, own.id), (handle) =>
      store.terminate(handle, { by: 'session', sessionId: own.id }, 'SIGNED_OUT'),
    );

    expect(ended).toEqual([own.id]);
    expect(await stored(own.id)).toEqual({ terminated: true, reason: 'SIGNED_OUT' });
  });

  // Break caught: an arm keyed on the principal alone, which would let a stolen session of one device end the others of the same
  // principal; the arm is the acting session and no more.
  it('does not end another session of the same principal, by id or by principal', async () => {
    const own = await sessionOf(type);
    const sibling = type === 'STAFF' ? await sessionOf(type, own.principalId) : undefined;
    const context = acting(type, own.principalId, own.id);

    const byId = await withHandle(built.service, context, (handle) =>
      store.terminate(
        handle,
        { by: 'session', sessionId: sibling?.id ?? randomUUID() },
        'SIGNED_OUT',
      ),
    );
    expect(byId).toEqual([]);
    if (sibling !== undefined)
      expect(await stored(sibling.id)).toEqual({ terminated: false, reason: null });

    const byPrincipal = await withHandle(built.service, context, (handle) =>
      store.terminate(
        handle,
        { by: 'principal', principalType: type, principalId: own.principalId },
        'SIGNED_OUT',
      ),
    );
    expect(byPrincipal).toEqual([own.id]);
    if (sibling !== undefined)
      expect(await stored(sibling.id)).toEqual({ terminated: false, reason: null });
  });

  // Break caught: a principal ending a session that is another principal's, or one of another type that has the same identifier.
  it('does not end the session of another principal, whatever the session id its context names', async () => {
    const mine = await sessionOf(type);
    const theirs = await sessionOf(type);
    const sameIdOtherType = await sessionOf(type === 'STAFF' ? 'RIDER' : 'STAFF', mine.principalId);

    const ended = await withHandle(
      built.service,
      acting(type, mine.principalId, theirs.id),
      (handle) => store.terminate(handle, { by: 'session', sessionId: theirs.id }, 'SIGNED_OUT'),
    );
    const endedOther = await withHandle(
      built.service,
      acting(type, mine.principalId, sameIdOtherType.id),
      (handle) =>
        store.terminate(handle, { by: 'session', sessionId: sameIdOtherType.id }, 'SIGNED_OUT'),
    );

    expect(ended).toEqual([]);
    expect(endedOther).toEqual([]);
    expect(await stored(theirs.id)).toEqual({ terminated: false, reason: null });
    expect(await stored(sameIdOtherType.id)).toEqual({ terminated: false, reason: null });
    expect(await stored(mine.id)).toEqual({ terminated: false, reason: null });
  });

  // Break caught: a context that names no session, or the wrong one, ending a session on the strength of the principal alone.
  it('ends nothing when its context names no session, or another one', async () => {
    const own = await sessionOf(type);
    const attempt = (sessionId: string | undefined) =>
      withHandle(built.service, acting(type, own.principalId, sessionId), (handle) =>
        store.terminate(handle, { by: 'session', sessionId: own.id }, 'SIGNED_OUT'),
      );

    expect(await attempt(undefined)).toEqual([]);
    expect(await attempt(randomUUID())).toEqual([]);
    expect(await stored(own.id)).toEqual({ terminated: false, reason: null });
  });

  // Break caught: the arm admitting any reason: a principal could then record that its session `EXPIRED` or was `ADMIN_REVOKED`.
  it.each(SESSION_TERMINATION_REASONS.filter((reason) => reason !== 'SIGNED_OUT'))(
    'refuses to end it with %s, which only the system or an administrator records (42501)',
    async (reason) => {
      const own = await sessionOf(type);

      const state = await stateOf(() =>
        withHandle(built.service, acting(type, own.principalId, own.id), (_handle, tx) =>
          tx.execute(
            sql`update session set terminated_at = now(), termination_reason = ${reason} where id = ${own.id}`,
          ),
        ),
      );

      expect(state).toBe('42501');
      expect(await stored(own.id)).toEqual({ terminated: false, reason: null });
    },
  );

  // Break caught: the arm becoming a way to write activity: a stolen session would then keep itself alive from its own context. The
  // guard (0026) answers before the policy does, as a BEFORE trigger precedes the check of the row it leaves; the session stays live.
  it('refuses to record activity on its own session (23514): the activity is the system’s write', async () => {
    const own = await sessionOf(type);

    const state = await stateOf(() =>
      withHandle(built.service, acting(type, own.principalId, own.id), (_handle, tx) =>
        tx.execute(
          sql`update session set last_activity_at = clock_timestamp() where id = ${own.id}`,
        ),
      ),
    );

    expect(state).toBe('23514');
    expect(await stored(own.id)).toEqual({ terminated: false, reason: null });
  });

  // Break caught (F05 of the audit of 22 October 2026): a sign-out that also writes the session's activity. The policy asks that the
  // row it leaves is ended with SIGNED_OUT; it cannot see the old row, so a guard that can does: the activity a principal's own
  // context may change is none.
  it('refuses to record activity in the same update that signs out, and leaves the session live (23514)', async () => {
    const own = await sessionOf(type);

    const state = await stateOf(() =>
      withHandle(built.service, acting(type, own.principalId, own.id), (_handle, tx) =>
        tx.execute(sql`
          update session set last_activity_at = clock_timestamp(), terminated_at = clock_timestamp(), termination_reason = 'SIGNED_OUT'
           where id = ${own.id}`),
      ),
    );

    expect(state).toBe('23514');
    expect(await stored(own.id)).toEqual({ terminated: false, reason: null });
  });

  // Break caught: the guard refusing the ordinary sign-out because it reads the activity as changed (it is written back as it was), or
  // refusing the system's own write of activity, which is the one writer of it.
  it('still signs out with the activity as it was, and leaves the system’s write of activity as it was', async () => {
    const own = await sessionOf(type);
    const activity = async () =>
      (
        await admin.query<{ at: Date }>(
          'select last_activity_at as at from session where id = $1',
          [own.id],
        )
      ).rows[0]?.at;
    const before = await activity();

    const moved = await withHandle(built.service, system('authentication'), (_handle, tx) =>
      tx.execute(sql`update session set last_activity_at = clock_timestamp() where id = ${own.id}`),
    );
    const ended = await withHandle(built.service, acting(type, own.principalId, own.id), (handle) =>
      store.terminate(handle, { by: 'session', sessionId: own.id }, 'SIGNED_OUT'),
    );

    expect(moved.rowCount).toBe(1);
    expect((await activity())?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    expect(ended).toEqual([own.id]);
    expect(await stored(own.id)).toEqual({ terminated: true, reason: 'SIGNED_OUT' });
  });

  // Break caught: an ended session that a principal could end again with another time or reason: the first record is the record.
  it('cannot touch the session again once it has ended', async () => {
    const own = await sessionOf(type);
    const context = acting(type, own.principalId, own.id);
    await withHandle(built.service, context, (handle) =>
      store.terminate(handle, { by: 'session', sessionId: own.id }, 'SIGNED_OUT'),
    );

    const again = await withHandle(built.service, context, (handle) =>
      store.terminate(handle, { by: 'session', sessionId: own.id }, 'SIGNED_OUT'),
    );

    expect(again).toEqual([]);
    expect(await stored(own.id)).toEqual({ terminated: true, reason: 'SIGNED_OUT' });
  });
});

describe('the authentication capability still ends any session for any reason, and no other capability does', () => {
  // Break caught: the new arms replacing the capability's, so that the authenticator could no longer mark an expiry (AC-35).
  it('ends a session as EXPIRED, which the request-time expiry of AC-SLICE-000-35 needs', async () => {
    const own = await sessionOf('STAFF');

    const ended = await withHandle(built.service, system('authentication'), (handle) =>
      store.terminate(handle, { by: 'session', sessionId: own.id }, 'EXPIRED'),
    );

    expect(ended).toEqual([own.id]);
    expect(await stored(own.id)).toEqual({ terminated: true, reason: 'EXPIRED' });
  });

  // Break caught: a capability other than authentication reaching the session table through the new arms.
  it('refuses every other capability, with nothing ended', async () => {
    const own = await sessionOf('STAFF');

    const ended = await withHandle(built.service, system('rate_limit'), (handle) =>
      store.terminate(handle, { by: 'session', sessionId: own.id }, 'SIGNED_OUT'),
    );

    expect(ended).toEqual([]);
    expect(await stored(own.id)).toEqual({ terminated: false, reason: null });
  });
});

/** The row a principal would write for its own sign-out, by the writer (which derives the actor, the surface and the organisation). */
const SIGN_OUT_EVENT = (sessionId: string): AuditEventInput => ({
  code: 'auth.session.terminated',
  enhanced: false,
  enhancedBasis: 'ROUTINE_TERMINATION',
  outcome: 'SUCCEEDED',
  object: { type: 'Session', id: sessionId },
  reason: { code: 'SIGNED_OUT', label: 'Signed out' },
});

interface RawEvent {
  readonly code: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly surface: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly reason: string | null;
  readonly outcome: string;
  readonly enhanced: boolean;
}

/**
 * The sign-out event a context would write, as the raw columns the policy names, with **one thing changed at a time**: the actor, the
 * surface, the code, the object (and its type), the reason, the outcome and the tier are each a column of its own, so a test that
 * changes one shows that column's check and no other's.
 */
const signOutRow = (
  context: SecurityContext,
  type: SessionPrincipalType,
  changes: Partial<RawEvent> = {},
): RawEvent => ({
  code: 'auth.session.terminated',
  actorType: ACTOR[type],
  actorId: context.principalId,
  surface: SURFACE[type],
  objectType: 'Session',
  objectId: context.sessionId ?? null,
  reason: 'SIGNED_OUT',
  outcome: 'SUCCEEDED',
  enhanced: false,
  ...changes,
});

const insertIn = async (tx: DatabaseTransaction, row: RawEvent): Promise<void> => {
  await tx.execute(sql`
    insert into audit_event (id, event_code, occurred_at, actor_type, actor_id, surface_context, object_type, object_id,
                             correlation_id, outcome, enhanced, serialisation_version, reason_code, reason_label)
    values (gen_random_uuid(), ${row.code}, now(), ${row.actorType}, ${row.actorId}::uuid, ${row.surface}, ${row.objectType},
            ${row.objectId}::uuid, 'sign-out-authority-test', ${row.outcome}, ${row.enhanced}, 1, ${row.reason},
            ${row.reason === null ? null : 'a reason'})`);
};

const insertRaw = (context: SecurityContext, row: RawEvent): Promise<void> =>
  withHandle(built.service, context, (_handle, tx) => insertIn(tx, row));

const countOf = async (code: string, actorId?: string): Promise<number> => {
  const result = await admin.query<{ n: number }>(
    `select count(*)::int as n from audit_event where event_code = $1 and ($2::uuid is null or actor_id = $2::uuid)`,
    [code, actorId ?? null],
  );
  return result.rows[0]?.n ?? 0;
};

describe.each(['VENDOR', 'RIDER'] as const)(
  'a %s principal writing its sign-out event (P-1)',
  (type) => {
    const other = type === 'VENDOR' ? 'RIDER' : 'VENDOR';

    // Break caught: the arm absent, so a vendor's or a rider's sign-out could not write its audit event in its own transaction.
    it('stores its own auth.session.terminated through the writer, as itself, on its own surface', async () => {
      const principalId = randomUUID();
      const sessionId = randomUUID();

      await withHandle(built.service, acting(type, principalId, sessionId), (handle) =>
        writer.write(handle, SIGN_OUT_EVENT(sessionId)),
      );

      const rows = await admin.query<{
        actor_type: string;
        actor_id: string;
        surface_context: string;
      }>(
        `select actor_type, actor_id, surface_context from audit_event where event_code = 'auth.session.terminated' and actor_id = $1`,
        [principalId],
      );
      expect(rows.rows).toEqual([
        { actor_type: ACTOR[type], actor_id: principalId, surface_context: SURFACE[type] },
      ]);
    });

    // Break caught: the arm not tying the row to the acting principal: one account writing the ledger as another.
    it('refuses an event under another actor identifier (42501)', async () => {
      const principalId = randomUUID();
      const victim = randomUUID();
      const context = acting(type, principalId, randomUUID());

      const state = await stateOf(() =>
        insertRaw(context, signOutRow(context, type, { actorId: victim })),
      );

      expect(state).toBe('42501');
      expect(await countOf('auth.session.terminated', victim)).toBe(0);
    });

    // Break caught: the arm admitting the actor type of another principal, or the system's (which has no actor identifier).
    it.each(['STAFF', other === 'VENDOR' ? 'VENDOR_ACCOUNT' : 'RIDER', 'SYSTEM'] as const)(
      'refuses an event whose actor type is %s (42501)',
      async (actorType) => {
        const principalId = randomUUID();
        const context = acting(type, principalId, randomUUID());

        const state = await stateOf(() =>
          insertRaw(
            context,
            signOutRow(context, type, {
              actorType,
              actorId: actorType === 'SYSTEM' ? null : principalId,
            }),
          ),
        );

        expect(state).toBe('42501');
        expect(await countOf('auth.session.terminated', principalId)).toBe(0);
      },
    );

    // Break caught: the arm admitting a surface the principal does not work through.
    it.each(['OPS_PORTAL', 'SYSTEM', SURFACE[other]] as const)(
      'refuses an event on the surface %s (42501)',
      async (surface) => {
        const principalId = randomUUID();
        const context = acting(type, principalId, randomUUID());

        const state = await stateOf(() =>
          insertRaw(context, signOutRow(context, type, { surface })),
        );

        expect(state).toBe('42501');
        expect(await countOf('auth.session.terminated', principalId)).toBe(0);
      },
    );

    // Break caught: the arm admitting any event code: a principal could write the ledger's security events (a sign-in, a revocation).
    it.each([
      'auth.sign_in.succeeded',
      'auth.session.authority_revoked',
      'auth.device.revoked',
      'auth.setup_grant.issued',
      'staff.identity.created',
    ])('refuses the code %s, which is not its sign-out (42501)', async (code) => {
      const principalId = randomUUID();
      const context = acting(type, principalId, randomUUID());

      const state = await stateOf(() => insertRaw(context, signOutRow(context, type, { code })));

      expect(state).toBe('42501');
      expect(await countOf(code, principalId)).toBe(0);
    });

    // The control of the refusals below: the row of an own, successful sign-out of the session the context acts in is accepted as raw
    // columns, so that each refusal is the one column it changes and nothing else.
    it('accepts the own, successful sign-out of the session the context acts in, as raw columns', async () => {
      const principalId = randomUUID();
      const context = acting(type, principalId, randomUUID());

      await insertRaw(context, signOutRow(context, type));

      expect(await countOf('auth.session.terminated', principalId)).toBe(1);
    });

    // Break caught (F04 of the audit of 22 October 2026): an event that names the right actor and surface but another session, so that a
    // principal could write that a session of someone else was signed out.
    it('refuses an event about a session other than the one the context acts in (42501)', async () => {
      const principalId = randomUUID();
      const context = acting(type, principalId, randomUUID());

      const state = await stateOf(() =>
        insertRaw(context, signOutRow(context, type, { objectId: randomUUID() })),
      );

      expect(state).toBe('42501');
      expect(await countOf('auth.session.terminated', principalId)).toBe(0);
    });

    // Break caught: a context that names no session (the setting is empty) satisfying a policy by an equality with nothing; an event
    // that names no object satisfying it by an equality of nothing with nothing.
    it('refuses an event when the context acts in no session, whatever object it names (42501)', async () => {
      const principalId = randomUUID();
      const context = acting(type, principalId, undefined);

      const named = await stateOf(() =>
        insertRaw(context, signOutRow(context, type, { objectId: randomUUID() })),
      );
      const none = await stateOf(() =>
        insertRaw(context, signOutRow(context, type, { objectId: null })),
      );

      expect([named, none]).toEqual(['42501', '42501']);
      expect(await countOf('auth.session.terminated', principalId)).toBe(0);
    });

    // Break caught: the event about something that is not a session (a staff identity, a factor, a grant) under the sign-out code.
    it.each(['StaffIdentity', 'MfaFactor', 'SetupGrant', 'HUB'])(
      'refuses an event whose object is a %s and not a session (42501)',
      async (objectType) => {
        const principalId = randomUUID();
        const context = acting(type, principalId, randomUUID());

        const state = await stateOf(() =>
          insertRaw(context, signOutRow(context, type, { objectType })),
        );

        expect(state).toBe('42501');
      },
    );

    // Break caught: a termination reason that only the system or an administrator records, or none at all, under the principal's own name.
    it.each([
      ['EXPIRED'],
      ['ADMIN_REVOKED'],
      ['AUTHORITY_CHANGED'],
      ['SUPERSEDED_BY_NEW_LOGIN'],
      [null],
    ])('refuses the reason %s, which is not a sign-out (42501)', async (reason) => {
      const principalId = randomUUID();
      const context = acting(type, principalId, randomUUID());

      const state = await stateOf(() => insertRaw(context, signOutRow(context, type, { reason })));

      expect(state).toBe('42501');
    });

    // Break caught: a sign-out recorded as refused or failed, or as an enhanced event, by the principal's own hand: the arm writes the
    // ordinary, successful termination and nothing else.
    it('refuses a sign-out that did not succeed, and one raised to the enhanced tier (42501)', async () => {
      const principalId = randomUUID();
      const context = acting(type, principalId, randomUUID());

      const rejected = await stateOf(() =>
        insertRaw(context, signOutRow(context, type, { outcome: 'REJECTED' })),
      );
      const enhanced = await stateOf(() =>
        insertRaw(context, signOutRow(context, type, { enhanced: true })),
      );

      expect([rejected, enhanced]).toEqual(['42501', '42501']);
    });

    // Break caught: a SELECT arm that came with the INSERT (P-1: "no SELECT is added"), or a grant that lets the row be changed.
    it('can neither read, change nor remove a row of the ledger', async () => {
      const principalId = randomUUID();
      const sessionId = randomUUID();
      await withHandle(built.service, acting(type, principalId, sessionId), (handle) =>
        writer.write(handle, SIGN_OUT_EVENT(sessionId)),
      );
      const context = acting(type, principalId, sessionId);

      const visible = await withHandle(built.service, context, async (_handle, tx) => {
        const result = await tx.execute(sql`select count(*)::int as n from audit_event`);
        return (result.rows[0] as { n: number }).n;
      });
      const update = await stateOf(() =>
        withHandle(built.service, context, (_handle, tx) =>
          tx.execute(sql`update audit_event set note = 'edited' where actor_id = ${principalId}`),
        ),
      );
      const remove = await stateOf(() =>
        withHandle(built.service, context, (_handle, tx) =>
          tx.execute(sql`delete from audit_event where actor_id = ${principalId}`),
        ),
      );

      expect(visible).toBe(0);
      expect(update).toBe('42501');
      expect(remove).toBe('42501');
      expect(await countOf('auth.session.terminated', principalId)).toBe(1);
    });

    // Break caught: the refusal of an event leaving the act's other writes in place (P-1: "the refusal of an event aborts the act's
    // transaction"): a session ended and no record of it.
    it('rolls back the end of the session when its event is refused', async () => {
      const own = await sessionOf(type);
      const context = acting(type, own.principalId, own.id);

      const state = await stateOf(() =>
        withHandle(built.service, context, async (handle, tx) => {
          await store.terminate(handle, { by: 'session', sessionId: own.id }, 'SIGNED_OUT');
          // The event the database refuses: another surface than the principal's own.
          await insertIn(tx, signOutRow(context, type, { surface: SURFACE[other] }));
        }),
      );

      expect(state).toBe('42501');
      expect(await stored(own.id)).toEqual({ terminated: false, reason: null });
      expect(await countOf('auth.session.terminated', own.principalId)).toBe(0);
    });
  },
);

describe('the staff and the authentication arms of the ledger are as they were', () => {
  // Break caught: the new arms disturbing the staff arm, which still writes its own events and no one else's.
  it('lets a staff principal write its own event and refuses it another actor', async () => {
    const principalId = randomUUID();
    const sessionId = randomUUID();

    await withHandle(built.service, acting('STAFF', principalId, sessionId), (handle) =>
      writer.write(handle, SIGN_OUT_EVENT(sessionId)),
    );

    expect(await countOf('auth.session.terminated', principalId)).toBe(1);
    const context = acting('STAFF', principalId, sessionId);
    expect(
      await stateOf(() =>
        insertRaw(context, signOutRow(context, 'STAFF', { actorId: randomUUID() })),
      ),
    ).toBe('42501');
  });

  // Break caught: the authentication capability losing its arm, or another capability gaining one.
  it('lets the authentication capability write an event and refuses every other capability', async () => {
    const sessionId = randomUUID();
    const before = await countOf('auth.session.terminated');

    await withHandle(built.service, system('authentication'), (handle) =>
      writer.write(handle, {
        ...SIGN_OUT_EVENT(sessionId),
        reason: { code: 'EXPIRED', label: 'Expired' },
      }),
    );

    expect(await countOf('auth.session.terminated')).toBe(before + 1);
    expect(
      await stateOf(() =>
        insertRaw(system('rate_limit'), {
          code: 'auth.session.terminated',
          actorType: 'SYSTEM',
          actorId: null,
          surface: 'SYSTEM',
          objectType: 'Session',
          objectId: sessionId,
          reason: 'SIGNED_OUT',
          outcome: 'SUCCEEDED',
          enhanced: false,
        }),
      ),
    ).toBe('42501');
  });
});
