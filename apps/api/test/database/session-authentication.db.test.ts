import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UnitOfWork } from '../../src/platform/auth/ports/unit-of-work.port.js';
import {
  SessionAuthenticator,
  type AuthenticationOutcome,
} from '../../src/platform/auth/sessions/session-authenticator.js';
import { contextOfSession } from '../../src/platform/auth/sessions/session-context.js';
import type { PresentedCredential } from '../../src/platform/auth/sessions/session-credentials.js';
import { ACTIVITY_COALESCE_MS } from '../../src/platform/auth/sessions/session-parameters.js';
import { transactionOf } from '../../src/platform/database/transaction-handle.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { openAdmin, type Admin } from './support/admin.js';
import {
  OPS_STAFF_SNAPSHOT,
  insertSessionRow,
  sessionRow,
  type SessionRow,
} from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { sql } from 'drizzle-orm';
import type pg from 'pg';

/**
 * S0.24, authentication against a real PostgreSQL, as the API's login: the session a credential names is found by the hash of its
 * token and judged on one fresh database time, a refused request records nothing, an accepted one records its activity coalesced,
 * and the context built from the session carries the session's id into the transaction a use case opens (obligation OB-54).
 *
 * A session cannot be aged by updating it (its issue time, expiry and activity are guarded), so a session that is old is a row
 * inserted with old times, which is what an old session is.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let adminKit: Admin;
let observer: Observer;
let machinery: Machinery;
let authenticator: SessionAuthenticator;
let runs = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  adminKit = await openAdmin(database);
  observer = await observe(database);
  machinery = assemble(built);
  const counting: UnitOfWork = {
    run: (context, work) => {
      runs += 1;
      return machinery.unitOfWork.run(context, work);
    },
    databaseNow: (handle) => machinery.unitOfWork.databaseNow(handle),
  };
  authenticator = new SessionAuthenticator({
    unitOfWork: counting,
    sessions: machinery.sessions,
    tokens: machinery.tokens,
    settings: machinery.settings,
  });
});

afterAll(async () => {
  await adminKit.close();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

const authenticate = (credential: PresentedCredential): Promise<AuthenticationOutcome> =>
  authenticator.authenticate(credential, 'authentication-test');
const cookie = (token: string): PresentedCredential => ({ kind: 'COOKIE', token });
const bearer = (token: string): PresentedCredential => ({ kind: 'BEARER', token });
const refusal = (outcome: AuthenticationOutcome) =>
  outcome.kind === 'REFUSED' ? { code: outcome.code, cause: outcome.cause } : outcome;

/** A session that exists with the token it names: for a state that cannot be reached by living through it. */
async function arranged(
  overrides: Partial<SessionRow>,
): Promise<{ token: string; row: SessionRow }> {
  const issued = machinery.tokens.issue();
  const row = await insertSessionRow(
    admin,
    sessionRow({ tokenHash: Buffer.from(issued.hash), ...overrides }),
  );
  return { token: issued.token, row };
}
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
const lastActivity = async (id: string) =>
  (
    await observer.one<{ last_activity_at: Date }>(
      `select last_activity_at from session where id = $1`,
      [id],
    )
  )?.last_activity_at;

describe('a credential is judged before the database is asked', () => {
  // Break caught: a request with nothing to authenticate with costing a transaction, or being resolved in favour of one of two
  // credentials that disagree.
  it('refuses no credential, an ambiguous one and a token that cannot be a token, without a statement', async () => {
    const before = runs;

    expect(refusal(await authenticate({ kind: 'NONE' }))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'NO_CREDENTIAL',
    });
    expect(refusal(await authenticate({ kind: 'AMBIGUOUS' }))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'AMBIGUOUS_CREDENTIAL',
    });
    for (const token of ['', 'short', 'x'.repeat(43), `${'A'.repeat(42)}=`, 'a'.repeat(44)]) {
      expect(refusal(await authenticate(cookie(token)))).toEqual({
        code: 'SESSION_INVALID',
        cause: 'MALFORMED_TOKEN',
      });
    }

    expect(runs).toBe(before);
  });

  it('refuses a well-formed token that no session holds', async () => {
    expect(refusal(await authenticate(cookie(machinery.tokens.issue().token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'UNKNOWN_SESSION',
    });
  });
});

describe('a live session', () => {
  // Break caught: a session issued by the protocol not being accepted from the cookie it was issued for.
  it('is accepted from the cookie it was issued for, and records its activity', async () => {
    const persona = await staffPersona(machinery, admin);

    const outcome = await authenticate(cookie(persona.issued.token));

    expect(outcome.kind).toBe('AUTHENTICATED');
    if (outcome.kind !== 'AUTHENTICATED') return;
    expect(outcome.authenticated).toMatchObject({ credential: 'COOKIE' });
    expect(outcome.authenticated.session.id).toBe(persona.issued.session.id);
    expect(outcome.authenticated.session.principalId).toBe(persona.identity.id);
    expect(Math.abs(outcome.authenticated.judgedAt.getTime() - Date.now())).toBeLessThan(5_000);
  });

  // Break caught: a write per request. Within the coalescing window of the issue nothing is written; once the recorded activity is
  // old enough the next accepted request records the database's time.
  it('records activity once the recorded one is old enough, and not before', async () => {
    const recent = await arranged({ lastActivityAt: minutesAgo(0.2), issuedAt: minutesAgo(5) });
    const older = await arranged({ lastActivityAt: minutesAgo(2), issuedAt: minutesAgo(5) });
    const recentBefore = await lastActivity(recent.row.id);

    await authenticate(cookie(recent.token));
    await authenticate(cookie(older.token));

    expect(ACTIVITY_COALESCE_MS).toBe(30_000);
    expect(await lastActivity(recent.row.id)).toEqual(recentBefore);
    const after = await lastActivity(older.row.id);
    expect(Math.abs((after?.getTime() ?? 0) - Date.now())).toBeLessThan(5_000);
  });

  // Break caught (OB-54): a context built from the authenticated session that does not carry its id into the transaction. The
  // setting that row-level security and the audit read is the session's, and the session is readable by its own principal.
  it('gives a context that carries the session’s id into the transaction a use case opens', async () => {
    const persona = await staffPersona(machinery, admin);
    const outcome = await authenticate(cookie(persona.issued.token));
    if (outcome.kind !== 'AUTHENTICATED') throw new Error('the session was not accepted');

    const seen = await machinery.unitOfWork.run(
      contextOfSession(outcome.authenticated.session, { correlationId: 'use-case' }),
      async (handle) => {
        const tx = transactionOf(handle);
        const setting = await tx.execute(
          sql`select current_setting('melarc.session_id', true) as id`,
        );
        const own = await tx.execute(
          sql`select id from session where principal_id = ${persona.identity.id}`,
        );
        return {
          sessionId: (setting.rows[0] as { id: string }).id,
          own: (own.rows as { id: string }[]).map((row) => row.id),
        };
      },
    );

    expect(seen).toEqual({
      sessionId: persona.issued.session.id,
      own: [persona.issued.session.id],
    });
  });
});

describe('a session that is not live', () => {
  // Break caught: an ended session served, or its reason lost to a displaced vendor.
  it('refuses an ended session, and tells a displaced vendor so and nobody else', async () => {
    const persona = await staffPersona(machinery, admin);
    await machinery.unitOfWork.run(
      {
        principalType: 'SYSTEM',
        principalId: randomUUID(),
        surface: 'SYSTEM',
        taskCapability: 'authentication',
        correlationId: 'end',
      },
      (handle) =>
        machinery.sessions.terminate(
          handle,
          { by: 'session', sessionId: persona.issued.session.id },
          'SIGNED_OUT',
        ),
    );
    const device = randomUUID();
    const displaced = await arranged({
      principalType: 'VENDOR',
      registeredDeviceId: device,
      policyRevision: 1,
      bundleId: BUNDLE_IDS.vendor,
      terminatedAt: new Date(),
      terminationReason: 'SUPERSEDED_BY_NEW_LOGIN',
    });
    const staffSuperseded = await arranged({
      terminatedAt: new Date(),
      terminationReason: 'SUPERSEDED_BY_NEW_LOGIN',
    });

    expect(refusal(await authenticate(cookie(persona.issued.token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'SESSION_TERMINATED',
    });
    expect(refusal(await authenticate(cookie(displaced.token)))).toEqual({
      code: 'SESSION_SUPERSEDED',
      cause: 'SESSION_TERMINATED',
    });
    expect(refusal(await authenticate(cookie(staffSuperseded.token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'SESSION_TERMINATED',
    });
  });

  // Break caught (errors-and-enums.md §4: "SESSION_SUPERSEDED for a displaced vendor session only"): every ended vendor session told it
  // was displaced, so that a vendor who signed out or was revoked is sent to explain a colleague's sign-in that never happened.
  it.each([
    'SIGNED_OUT',
    'ADMIN_REVOKED',
    'EXPIRED',
    'CREDENTIAL_CHANGED',
    'DEVICE_REVOKED',
  ] as const)(
    'does not tell a vendor session ended by %s that it was displaced',
    async (reason) => {
      const ended = await arranged({
        principalType: 'VENDOR',
        registeredDeviceId: randomUUID(),
        policyRevision: 1,
        bundleId: BUNDLE_IDS.vendor,
        terminatedAt: new Date(),
        terminationReason: reason,
      });

      expect(refusal(await authenticate(cookie(ended.token)))).toEqual({
        code: 'SESSION_INVALID',
        cause: 'SESSION_TERMINATED',
      });
    },
  );

  // Break caught (§13.3a): expiry left to a job, or judged on the application's clock.
  it('refuses a session past its absolute end, on the database’s time', async () => {
    const expired = await arranged({
      issuedAt: minutesAgo(800),
      lastActivityAt: minutesAgo(1),
      expiresAt: minutesAgo(5),
    });
    const before = await lastActivity(expired.row.id);

    expect(refusal(await authenticate(cookie(expired.token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'SESSION_EXPIRED_ABSOLUTE',
    });
    expect(await lastActivity(expired.row.id)).toEqual(before);
  });

  // Break caught: the idle limit of the wrong tier (the standard 30 minutes for a privileged session, the reverse), or none; and a
  // refused request recording activity, which would revive the session it refuses.
  it.each([
    ['standard', OPS_STAFF_SNAPSHOT, 29, 31],
    ['privileged', { ...OPS_STAFF_SNAPSHOT, name: 'Senior Ops', privileged: true }, 14, 16],
  ] as const)(
    'holds a %s browser session to the idle limit of its tier',
    async (_tier, snapshot, within, beyond) => {
      const live = await arranged({
        snapshot,
        issuedAt: minutesAgo(100),
        lastActivityAt: minutesAgo(within),
      });
      const idle = await arranged({
        snapshot,
        issuedAt: minutesAgo(100),
        lastActivityAt: minutesAgo(beyond),
      });
      const idleBefore = await lastActivity(idle.row.id);

      expect((await authenticate(cookie(live.token))).kind).toBe('AUTHENTICATED');
      expect(refusal(await authenticate(cookie(idle.token)))).toEqual({
        code: 'SESSION_INVALID',
        cause: 'SESSION_EXPIRED_IDLE',
      });
      expect(await lastActivity(idle.row.id)).toEqual(idleBefore);
    },
  );

  it('holds a vendor session to the standard idle limit', async () => {
    const vendor = await arranged({
      principalType: 'VENDOR',
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: BUNDLE_IDS.vendor,
      snapshot: { ...OPS_STAFF_SNAPSHOT, name: 'Vendor', audience: 'VENDOR' },
      issuedAt: minutesAgo(100),
      lastActivityAt: minutesAgo(31),
    });

    expect(refusal(await authenticate(cookie(vendor.token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'SESSION_EXPIRED_IDLE',
    });
  });
});

describe('the three authentication models never mix', () => {
  const rider = (overrides: Partial<SessionRow> = {}) =>
    arranged({
      principalType: 'RIDER',
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: BUNDLE_IDS.rider,
      snapshot: { ...OPS_STAFF_SNAPSHOT, name: 'Rider', audience: 'RIDER' },
      ...overrides,
    });

  // Break caught: a staff token accepted as a bearer credential, or a rider's in a cookie.
  it('accepts a rider session as a bearer credential only, and a browser session as a cookie only', async () => {
    const asRider = await rider();
    const persona = await staffPersona(machinery, admin);

    expect((await authenticate(bearer(asRider.token))).kind).toBe('AUTHENTICATED');
    expect(refusal(await authenticate(cookie(asRider.token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'WRONG_CREDENTIAL_FOR_SESSION',
    });
    expect(refusal(await authenticate(bearer(persona.issued.token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'WRONG_CREDENTIAL_FOR_SESSION',
    });
    expect((await authenticate(cookie(persona.issued.token))).kind).toBe('AUTHENTICATED');
  });

  // Break caught (domain-model.md §6.8: "rider sessions are never terminated by idleness"): an idle rider ended.
  it('never ends a rider session for idleness, but does at its absolute end', async () => {
    const idleRider = await rider({
      issuedAt: minutesAgo(1_000),
      lastActivityAt: minutesAgo(900),
      expiresAt: minutesAgo(-400),
    });
    const pastEnd = await rider({
      issuedAt: minutesAgo(1_500),
      lastActivityAt: minutesAgo(2),
      expiresAt: minutesAgo(10),
    });

    expect((await authenticate(bearer(idleRider.token))).kind).toBe('AUTHENTICATED');
    expect(refusal(await authenticate(bearer(pastEnd.token)))).toEqual({
      code: 'SESSION_INVALID',
      cause: 'SESSION_EXPIRED_ABSOLUTE',
    });
  });
});
