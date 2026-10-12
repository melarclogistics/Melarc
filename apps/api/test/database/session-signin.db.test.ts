import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AuditEventInput,
  AuditWriter,
} from '../../src/platform/auth/ports/audit-writer.port.js';
import type {
  IdentityDirectory,
  PrincipalSummary,
} from '../../src/platform/auth/ports/identity-directory.port.js';
import type {
  SessionStore,
  StoredSession,
} from '../../src/platform/auth/ports/session-store.port.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import type { SignInStep } from '../../src/platform/auth/sessions/session-issuer.js';
import { transactionOf } from '../../src/platform/database/transaction-handle.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { openAdmin, type Admin } from './support/admin.js';
import { insertStaff, staffRow } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import type pg from 'pg';

/**
 * The sign-in has one transaction owner (the audit of 11 October 2026, F03): the issue protocol ends the earlier session of a
 * Vendor or a Rider, spends the proofs the sign-in rests on and inserts the new session in the **same** transaction, under the
 * identity lock. Against a real PostgreSQL, as the API's login under the `authentication` capability: replacing a session succeeds
 * atomically, a failure anywhere leaves the earlier session as it was and no new session and no new event, concurrent sign-ins of one
 * principal end with exactly one live session, and a proof is spent exactly once and never by a sign-in that failed.
 *
 * Vendor and Rider identities have no table yet, so a fixed directory answers for them; its lock is a transaction-scoped advisory lock
 * keyed on the principal, which stands in for the row lock the real directories will take (the unique index of `session` is the
 * backstop and is not what is being proved).
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let adminKit: Admin;
let observer: Observer;
let machinery: Machinery;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 4 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  adminKit = await openAdmin(database);
  observer = await observe(database);
  machinery = assemble(built, { compiledPolicy: { VENDOR: 1, RIDER: 1 } });
  await admin.query(`
    create table test_proof (id uuid primary key, consumed_at timestamptz);
    grant select, update on test_proof to melarc_api_runtime;
  `);
});

afterAll(async () => {
  await adminKit.close();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

/** A directory for an audience with no identity table: one fixed principal, locked by an advisory lock held to the transaction's end. */
function fixedDirectory(summary: PrincipalSummary): IdentityDirectory {
  const answer = (): Promise<PrincipalSummary> => Promise.resolve(summary);
  return {
    findStaffByCanonicalEmail: () => Promise.resolve(null),
    findVendorAccountByIdentifier: () => Promise.resolve(null),
    findRiderByCanonicalPhone: () => Promise.resolve(null),
    readIdentity: answer,
    lockIdentity: async (handle) => {
      await transactionOf(handle).execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${summary.ref.id}, 0))`,
      );
      return summary;
    },
  };
}

const summaryOf = (type: 'VENDOR' | 'RIDER'): PrincipalSummary => ({
  ref: { type, id: randomUUID() },
  status: 'ACTIVE',
  credentialGeneration: 1,
  credentialEstablishedAt: new Date('2026-10-01T09:00:00.000Z'),
  bundleId: type === 'VENDOR' ? BUNDLE_IDS.vendor : BUNDLE_IDS.rider,
  authorizedHubIds: [],
});

const signIn = (
  summary: PrincipalSummary,
  issuer = machineryFor(summary).issuer,
  extra: { steps?: readonly SignInStep[]; device?: string } = {},
) =>
  issuer.issue({
    principal: summary.ref,
    correlationId: `signin-${randomUUID()}`,
    verifiedCredentialGeneration: 1,
    registeredDeviceId: extra.device ?? randomUUID(),
    ...(extra.steps === undefined ? {} : { steps: extra.steps }),
  });

const machineryFor = (summary: PrincipalSummary): Machinery =>
  assemble(built, { identities: fixedDirectory(summary), compiledPolicy: { VENDOR: 1, RIDER: 1 } });

const sessionsOf = (principalId: string) =>
  observer.rows<{ id: string; terminated_at: Date | null; termination_reason: string | null }>(
    `select id, terminated_at, termination_reason from session where principal_id = $1 order by issued_at, id`,
    [principalId],
  );
const live = async (principalId: string): Promise<number> =>
  (await sessionsOf(principalId)).filter((row) => row.terminated_at === null).length;
const events = (code: string, actorId: string) =>
  observer.rows<{ object_id: string | null; reason_code: string | null }>(
    `select object_id, reason_code from audit_event where event_code = $1 and actor_id = $2 order by recorded_at, id`,
    [code, actorId],
  );

/** A session store that ends and inserts as the real one does, and fails the insert: the earlier session was already ended. */
class FailingInsertStore implements SessionStore {
  constructor(private readonly inner: SessionStore) {}
  create(): Promise<StoredSession> {
    return Promise.reject(new Error('the insert failed'));
  }
  findByTokenHash: SessionStore['findByTokenHash'] = (...args) =>
    this.inner.findByTokenHash(...args);
  recordActivity: SessionStore['recordActivity'] = (...args) => this.inner.recordActivity(...args);
  terminate: SessionStore['terminate'] = (...args) => this.inner.terminate(...args);
}

/** An audit writer that fails on the event of the issue itself, the last write of the transaction before the displacement events. */
class FailingIssueAudit implements AuditWriter {
  constructor(private readonly inner: AuditWriter) {}
  write(handle: TransactionHandle, event: AuditEventInput): Promise<void> {
    if (event.code === 'auth.session.issued') return Promise.reject(new Error('the audit failed'));
    return this.inner.write(handle, event);
  }
}

describe('replacing the earlier session of a Vendor or a Rider (domain-model.md section 6.8)', () => {
  // Break caught: the earlier session left live (the unique index then refuses the new one with a driver error), or ended in a
  // transaction of its own. A vendor's sign-in displaces the colleague's session: the reason is theirs, and so is the event.
  it('ends a vendor’s earlier session in the issuing transaction, as a supersession, and records it', async () => {
    const vendor = summaryOf('VENDOR');
    const first = await signIn(vendor);

    const second = await signIn(vendor);

    expect(second.displacedSessionIds).toEqual([first.session.id]);
    expect(first.displacedSessionIds).toEqual([]);
    expect(await sessionsOf(vendor.ref.id)).toEqual([
      expect.objectContaining({
        id: first.session.id,
        termination_reason: 'SUPERSEDED_BY_NEW_LOGIN',
      }),
      expect.objectContaining({ id: second.session.id, terminated_at: null }),
    ]);
    expect(await live(vendor.ref.id)).toBe(1);
    expect(await events('auth.session.issued', vendor.ref.id)).toHaveLength(2);
    expect(await events('auth.session.superseded', vendor.ref.id)).toEqual([
      expect.objectContaining({ object_id: first.session.id }),
    ]);
    expect(await events('auth.session.terminated', vendor.ref.id)).toEqual([]);
  });

  // Break caught: a rider’s replacement told as a displacement. The rider's old token is an ordinary invalid session, and the
  // catalogue records it as a termination with its reason, never as `auth.session.superseded` (audit.md section 5.4).
  it('ends a rider’s earlier session as a replacement, and records an ordinary termination', async () => {
    const rider = summaryOf('RIDER');
    const first = await signIn(rider);

    const second = await signIn(rider);

    expect(second.displacedSessionIds).toEqual([first.session.id]);
    expect(await sessionsOf(rider.ref.id)).toEqual([
      expect.objectContaining({
        id: first.session.id,
        termination_reason: 'REPLACED_BY_NEW_SESSION',
      }),
      expect.objectContaining({ id: second.session.id, terminated_at: null }),
    ]);
    expect(await events('auth.session.terminated', rider.ref.id)).toEqual([
      expect.objectContaining({
        object_id: first.session.id,
        reason_code: 'REPLACED_BY_NEW_SESSION',
      }),
    ]);
    expect(await events('auth.session.superseded', rider.ref.id)).toEqual([]);
  });

  // Break caught: the displacement applied to staff, who hold as many browser sessions as they have browsers.
  it('ends nothing for a staff member, who may hold several sessions', async () => {
    const row = await insertStaff(admin, staffRow());
    const issue = () =>
      machinery.issuer.issue({
        principal: { type: 'STAFF', id: row.id },
        correlationId: 'staff-twice',
        verifiedCredentialGeneration: 1,
      });

    const first = await issue();
    const second = await issue();

    expect(second.displacedSessionIds).toEqual([]);
    expect(await live(row.id)).toBe(2);
    expect(first.session.id).not.toBe(second.session.id);
  });

  // Break caught: the earlier session ended first and the failure of the insert leaving the person with no session at all, the
  // event of a displacement that never happened, or a half-written audit.
  it('leaves the earlier session live, and writes no replacement and no event, when the insert fails', async () => {
    const vendor = summaryOf('VENDOR');
    const first = await signIn(vendor);
    const failing = assemble(built, {
      identities: fixedDirectory(vendor),
      sessions: new FailingInsertStore(machinery.sessions),
      compiledPolicy: { VENDOR: 1, RIDER: 1 },
    });

    await expect(signIn(vendor, failing.issuer)).rejects.toThrow('the insert failed');

    expect(await sessionsOf(vendor.ref.id)).toEqual([
      expect.objectContaining({ id: first.session.id, terminated_at: null }),
    ]);
    expect(await events('auth.session.issued', vendor.ref.id)).toHaveLength(1);
    expect(await events('auth.session.superseded', vendor.ref.id)).toEqual([]);
  });

  // Break caught: the audit written in a transaction of its own, or after the commit, so that a failure of the event would leave the
  // new session issued and the earlier one ended without the record that explains it.
  it('leaves the earlier session live and nothing new when the audit of the issue fails after the insert', async () => {
    const rider = summaryOf('RIDER');
    const first = await signIn(rider);
    const failing = assemble(built, {
      identities: fixedDirectory(rider),
      audit: new FailingIssueAudit(machinery.audit),
      compiledPolicy: { VENDOR: 1, RIDER: 1 },
    });

    await expect(signIn(rider, failing.issuer)).rejects.toThrow('the audit failed');

    expect(await sessionsOf(rider.ref.id)).toEqual([
      expect.objectContaining({ id: first.session.id, terminated_at: null }),
    ]);
    expect(await events('auth.session.terminated', rider.ref.id)).toEqual([]);
  });

  // Break caught: two sign-ins of one principal interleaving, each ending "the earlier session" it saw, so that both create one and
  // the unique index turns the second into a driver error (or, without it, two live sessions). The identity lock serializes them.
  it('ends with exactly one live session when two sign-ins of one principal run at once', async () => {
    const vendor = summaryOf('VENDOR');
    const issuer = machineryFor(vendor).issuer;

    const results = await Promise.allSettled([
      signIn(vendor, issuer),
      signIn(vendor, issuer),
      signIn(vendor, issuer),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(await live(vendor.ref.id)).toBe(1);
    expect(await sessionsOf(vendor.ref.id)).toHaveLength(3);
    expect(await events('auth.session.superseded', vendor.ref.id)).toHaveLength(2);
  });
});

describe('the proofs a sign-in spends commit with it (typed steps)', () => {
  const proof = async (): Promise<string> => {
    const id = randomUUID();
    await admin.query(`insert into test_proof (id) values ($1)`, [id]);
    return id;
  };
  const consumed = async (id: string): Promise<boolean> =>
    (
      await observer.one<{ consumed: boolean }>(
        `select consumed_at is not null as consumed from test_proof where id = $1`,
        [id],
      )
    )?.consumed === true;
  /** A proof is single use by what the step writes: a conditional update that finds it already spent refuses. */
  const spend = (id: string): SignInStep => ({
    name: 'spend the proof',
    run: async (handle) => {
      const result = await transactionOf(handle).execute(
        sql`update test_proof set consumed_at = now() where id = ${id} and consumed_at is null`,
      );
      if (result.rowCount !== 1) throw new Error('the proof is already spent');
    },
  });

  it('spends the proof with the session that rests on it', async () => {
    const vendor = summaryOf('VENDOR');
    const id = await proof();

    const issued = await signIn(vendor, undefined, { steps: [spend(id)] });

    expect(await consumed(id)).toBe(true);
    expect(await live(vendor.ref.id)).toBe(1);
    expect(issued.session.principalId).toBe(vendor.ref.id);
  });

  // Break caught: the proof spent in a transaction of its own before the issue, so that a sign-in that then fails has used it up and
  // the person must start again, or after, so that a replay could use it twice.
  it('leaves the proof unspent, and the earlier session live, when the issue fails after the step', async () => {
    const vendor = summaryOf('VENDOR');
    const first = await signIn(vendor);
    const id = await proof();
    const failing = assemble(built, {
      identities: fixedDirectory(vendor),
      sessions: new FailingInsertStore(machinery.sessions),
      compiledPolicy: { VENDOR: 1, RIDER: 1 },
    });

    await expect(signIn(vendor, failing.issuer, { steps: [spend(id)] })).rejects.toThrow(
      'the insert failed',
    );

    expect(await consumed(id)).toBe(false);
    expect(await sessionsOf(vendor.ref.id)).toEqual([
      expect.objectContaining({ id: first.session.id, terminated_at: null }),
    ]);
  });

  // Break caught: a step that fails and leaves a session behind, or leaves another step's work standing.
  it('writes no session, no event and nothing of an earlier step when a step refuses', async () => {
    const rider = summaryOf('RIDER');
    const first = await signIn(rider);
    const earlier = await proof();
    const spent = await proof();
    await admin.query(`update test_proof set consumed_at = now() where id = $1`, [spent]);

    await expect(
      signIn(rider, undefined, { steps: [spend(earlier), spend(spent)] }),
    ).rejects.toThrow('the proof is already spent');

    expect(await consumed(earlier)).toBe(false);
    expect(await sessionsOf(rider.ref.id)).toEqual([
      expect.objectContaining({ id: first.session.id, terminated_at: null }),
    ]);
    expect(await events('auth.session.issued', rider.ref.id)).toHaveLength(1);
  });

  // Break caught: a proof that can be spent by two sign-ins at once, so that one proof opens two sessions.
  it('lets one proof open one session when two sign-ins race to spend it', async () => {
    const vendor = summaryOf('VENDOR');
    const issuer = machineryFor(vendor).issuer;
    const id = await proof();

    const results = await Promise.allSettled([
      signIn(vendor, issuer, { steps: [spend(id)] }),
      signIn(vendor, issuer, { steps: [spend(id)] }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await consumed(id)).toBe(true);
    expect(await sessionsOf(vendor.ref.id)).toHaveLength(1);
  });

  // Break caught: a step run before the refusals are decided, so that an inactive or changed principal's proof is spent on a sign-in
  // that was never going to happen. The rollback would hide a write; what it cannot hide is that the step ran at all.
  it('runs no step for a principal that is refused', async () => {
    const row = await insertStaff(admin, staffRow({ status: 'SUSPENDED' }));
    let ran = 0;
    const counting: SignInStep = {
      name: 'count',
      run: () => {
        ran += 1;
        return Promise.resolve();
      },
    };

    await expect(
      machinery.issuer.issue({
        principal: { type: 'STAFF', id: row.id },
        correlationId: 'suspended',
        verifiedCredentialGeneration: 1,
        steps: [counting],
      }),
    ).rejects.toMatchObject({ reason: 'PRINCIPAL_NOT_ACTIVE' });

    expect(ran).toBe(0);
  });

  it('runs the steps in order, with the locked principal and the issuing transaction', async () => {
    const vendor = summaryOf('VENDOR');
    const ran: string[] = [];
    const named = (name: string): SignInStep => ({
      name,
      run: (handle, locked) => {
        ran.push(
          `${name}:${locked.ref.id === vendor.ref.id ? 'locked' : 'other'}:${typeof transactionOf(handle)}`,
        );
        return Promise.resolve();
      },
    });

    await signIn(vendor, undefined, { steps: [named('first'), named('second')] });

    expect(ran).toEqual(['first:locked:object', 'second:locked:object']);
  });

  it.each([
    [
      'more than four',
      Array.from({ length: 5 }, () => ({ name: 'x', run: () => Promise.resolve() })),
    ],
    ['one without a name', [{ name: '', run: () => Promise.resolve() }]],
    ['one without a function', [{ name: 'x' }]],
    ['something that is not a list', 'spend'],
  ])('refuses %s as a malformed request, before it opens a transaction', async (_label, steps) => {
    const vendor = summaryOf('VENDOR');

    await expect(
      machineryFor(vendor).issuer.issue({
        principal: vendor.ref,
        correlationId: 'malformed',
        verifiedCredentialGeneration: 1,
        registeredDeviceId: randomUUID(),
        steps,
      } as never),
    ).rejects.toThrow(TypeError);
    expect(await sessionsOf(vendor.ref.id)).toEqual([]);
  });
});
