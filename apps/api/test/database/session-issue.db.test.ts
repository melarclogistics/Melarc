import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  IdentityDirectory,
  PrincipalRef,
  PrincipalSummary,
} from '../../src/platform/auth/ports/identity-directory.port.js';
import type {
  NewSession,
  SessionStore,
  StoredSession,
} from '../../src/platform/auth/ports/session-store.port.js';
import { SessionIssueRefusedError } from '../../src/platform/auth/sessions/session-errors.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { PolicyCoordinationError } from '../../src/platform/database/policy-lock/coordinate.js';
import {
  AUTH_POLICY_BUNDLE,
  AUTH_POLICY_FIXED,
  bundleLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { PostgresStaffIdentityDirectory } from '../../src/staff/postgres.staff-identity-directory.adapter.js';
import { openAdmin, type Admin } from './support/admin.js';
import { hashOf, insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import type pg from 'pg';

/**
 * S0.24, the session-issue protocol of SECURITY_DESIGN.md §13.10a against a real PostgreSQL, as the API's login under the
 * `authentication` capability: a session records the **locked** bundle's content and revision, the policy locks are held while it
 * is written, an identity reassigned between discovery and lock revalidates and restarts within a bound with nothing written
 * before the revalidation passed (obligation 11, `OB-11`), a refused principal gets nothing, and the session, its token and its
 * audit event commit together or not at all.
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
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  adminKit = await openAdmin(database);
  observer = await observe(database);
  machinery = assemble(built, { compiledPolicy: { VENDOR: 1, RIDER: 1 } });
});

afterAll(async () => {
  await adminKit.close();
  await admin.end();
  await observer.close();
  await built.close();
  await database.drop();
});

const staff = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
/** Issues a session to the staff member as a sign-in that verified the credential `row` was arranged with (or another, if told). */
const issue = (
  row: StaffRow,
  issuer = machinery.issuer,
  verifiedCredentialGeneration: number = Math.max(1, row.credentialGeneration),
) =>
  issuer.issue({
    principal: { type: 'STAFF', id: row.id },
    correlationId: `issue-${row.id}`,
    verifiedCredentialGeneration,
  });
/** What a writer of credentials does to replace one that was established at the very instant of the new one: no moment given. */
const replaceCredentialAtSameInstant = (id: string) =>
  admin.query(
    `update staff_identity
        set credential_hash = 'replaced', credential_generation = credential_generation + 1
      where id = $1`,
    [id],
  );
/** What a writer of credentials does to replace one: the hash, the moment and the generation, together. */
const replaceCredential = (id: string, establishedAt: string) =>
  admin.query(
    `update staff_identity
        set credential_hash = 'replaced', credential_established_at = $2::timestamptz,
            credential_generation = credential_generation + 1
      where id = $1`,
    [id, establishedAt],
  );
const sessionRows = (principalId: string) =>
  observer.rows<{ id: string; bundle_id: string; token_hash: Buffer }>(
    `select id, bundle_id, token_hash from session where principal_id = $1`,
    [principalId],
  );
const issuedEvents = (principalId: string) =>
  observer.count('audit_event', { event_code: 'auth.session.issued', actor_id: principalId });

describe('what a session records', () => {
  // Break caught (the evidence of S0.24): a session carrying a bundle it was not issued from, or a revision or content that is not
  // what the lock protected, so that authorization would read authority the person was never given.
  it('records the locked bundle’s content and revision, the hubs, the lifetime of the tier and the hash of the token', async () => {
    const hub = (await observer.one<{ id: string }>(`select id from hub order by name limit 1`))
      ?.id;
    const row = await staff({ roleBundleId: BUNDLE_IDS.seniorOps, primaryHubId: hub ?? null });
    const bundle = await observer.one<{ revision: number; name: string }>(
      `select revision, name from role_bundle where id = $1`,
      [BUNDLE_IDS.seniorOps],
    );
    const grants = await observer.rows<{
      permission_key: string;
      hub_scope: string;
      ownership_scope: string;
      tier: string | null;
    }>(
      `select permission_key, hub_scope, ownership_scope, tier from role_bundle_grant where bundle_id = $1 order by permission_key collate "C"`,
      [BUNDLE_IDS.seniorOps],
    );

    const issued = await issue(row);

    const stored = await observer.one<{
      principal_type: string;
      bundle_id: string;
      bundle_revision: number;
      policy_revision: number | null;
      bundle_snapshot: unknown;
      authorized_hub_ids: string[];
      token_hash: Buffer;
      csrf_token_hash: Buffer | null;
      issued_at: Date;
      expires_at: Date;
      last_activity_at: Date;
      terminated_at: Date | null;
      row: string;
    }>(`select s.*, s::text as row from session s where id = $1`, [issued.session.id]);
    expect(stored).toMatchObject({
      principal_type: 'STAFF',
      bundle_id: BUNDLE_IDS.seniorOps,
      bundle_revision: bundle?.revision,
      policy_revision: null,
      authorized_hub_ids: hub === undefined ? [] : [hub],
      terminated_at: null,
    });
    expect(stored?.bundle_snapshot).toEqual({
      format: 1,
      name: 'Senior Ops',
      audience: 'STAFF',
      privileged: true,
      grants: grants.map((grant) => ({
        permission: grant.permission_key,
        hubScope: grant.hub_scope,
        ownershipScope: grant.ownership_scope,
        tier: grant.tier,
      })),
    });
    expect(grants.length).toBeGreaterThan(10);
    // The session begins at the fresh database time of the decision and ends one lifetime of its tier later: 480 minutes, privileged.
    expect(stored?.last_activity_at.getTime()).toBe(stored?.issued_at.getTime());
    expect(Math.abs((stored?.issued_at.getTime() ?? 0) - Date.now())).toBeLessThan(10_000);
    expect((stored?.expires_at.getTime() ?? 0) - (stored?.issued_at.getTime() ?? 0)).toBe(
      480 * 60_000,
    );
    // Only the hash of each token is stored, and neither token is anywhere in the row.
    expect(stored?.token_hash.equals(hashOf(issued.token)) ?? false).toBe(false);
    expect(stored?.token_hash.equals(machinery.tokens.hash(issued.token) as Buffer)).toBe(true);
    expect(
      stored?.csrf_token_hash?.equals(machinery.tokens.hash(issued.csrfToken ?? '') as Buffer),
    ).toBe(true);
    expect(stored?.row).not.toContain(issued.token);
    expect(stored?.row).not.toContain(issued.csrfToken ?? 'absent');
    expect(issued.token).not.toBe(issued.csrfToken);
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // Break caught: every staff session given the privileged lifetime, or none: the tier is the bundle's own flag.
  it('gives a standard bundle the standard lifetime', async () => {
    const row = await staff({ roleBundleId: BUNDLE_IDS.opsStaff });

    const issued = await issue(row);

    expect(issued.session.expiresAt.getTime() - issued.session.issuedAt.getTime()).toBe(
      720 * 60_000,
    );
    expect(issued.session.authority.snapshot.privileged).toBe(false);
  });

  // Break caught (audit.md §5.4): an issued session with no event, or an event that names the token, or the wrong actor.
  it('writes auth.session.issued in the same transaction, naming the principal and never the token', async () => {
    const row = await staff();

    const issued = await issue(row);

    const events = await observer.rows<{
      event_code: string;
      actor_type: string;
      actor_id: string;
      object_type: string;
      object_id: string;
      outcome: string;
      enhanced: boolean;
      surface_context: string;
      correlation_id: string;
      actor_bundle: string | null;
      row: string;
    }>(`select e.*, e::text as row from audit_event e where object_id = $1`, [issued.session.id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_code: 'auth.session.issued',
      actor_type: 'STAFF',
      actor_id: row.id,
      object_type: 'Session',
      outcome: 'SUCCEEDED',
      enhanced: false,
      surface_context: 'SYSTEM',
      correlation_id: `issue-${row.id}`,
      actor_bundle: 'Ops Staff',
    });
    expect(events[0]?.row).not.toContain(issued.token);
    expect(events[0]?.row).not.toContain(issued.csrfToken ?? 'absent');
  });

  // Break caught: a session left behind when its audit event could not be written, which would be an unrecorded sign-in.
  it('leaves no session when the audit event cannot be written', async () => {
    const row = await staff();
    const broken = await adminKit.breakWrites('audit_event');

    try {
      await expect(issue(row)).rejects.toThrow();
    } finally {
      await broken.mend();
    }

    expect(await sessionRows(row.id)).toEqual([]);
  });
});

describe('who may be given a session', () => {
  // Break caught: a pending, rejected, suspended or offboarded profile, or one that has not established a credential, given a
  // session: "an ACTIVE identity that has not completed setup grants zero authenticated access", and the rest grant none.
  it.each([
    ['pending approval', { status: 'PENDING_APPROVAL', approvedBy: null }, 'PRINCIPAL_NOT_ACTIVE'],
    ['rejected', { status: 'REJECTED' }, 'PRINCIPAL_NOT_ACTIVE'],
    ['suspended', { status: 'SUSPENDED' }, 'PRINCIPAL_NOT_ACTIVE'],
    ['offboarded', { status: 'OFFBOARDED' }, 'PRINCIPAL_NOT_ACTIVE'],
    [
      'without an established credential',
      { credentialHash: null, credentialEstablishedAt: null },
      'CREDENTIAL_NOT_ESTABLISHED',
    ],
  ] as const)(
    'refuses an identity that is %s, and writes nothing',
    async (_label, overrides, reason) => {
      const row = await staff(overrides);

      await expect(issue(row)).rejects.toMatchObject({ name: 'SessionIssueRefusedError', reason });

      expect(await sessionRows(row.id)).toEqual([]);
      expect(await issuedEvents(row.id)).toBe(0);
    },
  );

  it('refuses a principal that does not exist, before it takes any lock', async () => {
    await expect(
      machinery.issuer.issue({
        principal: { type: 'STAFF', id: randomUUID() },
        correlationId: 'unknown',
        verifiedCredentialGeneration: 1,
      }),
    ).rejects.toBeInstanceOf(SessionIssueRefusedError);
  });

  // Break caught: a request for the wrong kind of session reaching the table's constraints, or its own checks, as a driver error.
  it.each([
    [
      'a staff session with a registered device',
      { principal: { type: 'STAFF', id: randomUUID() }, registeredDeviceId: randomUUID() },
    ],
    ['a vendor session without one', { principal: { type: 'VENDOR', id: randomUUID() } }],
    [
      'a staff session with a root signal',
      { principal: { type: 'STAFF', id: randomUUID() }, clientRootSignal: 'DETECTED' },
    ],
    [
      'a vendor session with a root signal',
      {
        principal: { type: 'VENDOR', id: randomUUID() },
        registeredDeviceId: randomUUID(),
        clientRootSignal: 'DETECTED',
      },
    ],
    ['a principal that is not an id', { principal: { type: 'STAFF', id: 'ama' } }],
    ['a principal of a type there is not', { principal: { type: 'ADMIN', id: randomUUID() } }],
  ] as const)(
    'refuses %s as a malformed request, before it opens a transaction',
    async (_label, request) => {
      await expect(
        machinery.issuer.issue({ correlationId: 'malformed', ...request } as never),
      ).rejects.toThrow(TypeError);
    },
  );
});

/** The advisory locks the database holds on behalf of other connections' transactions, as `pg_locks` shows them. */
async function advisoryLocks(): Promise<
  { mode: string; granted: boolean; classid: number; objid: number }[]
> {
  return observer.rows(
    `select mode, granted, classid::bigint::float8 as classid, objid::bigint::float8 as objid
       from pg_locks
      where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`,
  );
}

class RecordingStore implements SessionStore {
  creates: NewSession[] = [];
  locksAtCreate: Awaited<ReturnType<typeof advisoryLocks>> = [];
  constructor(private readonly inner: SessionStore) {}
  async create(handle: TransactionHandle, session: NewSession): Promise<StoredSession> {
    this.creates.push(session);
    this.locksAtCreate = await advisoryLocks();
    return this.inner.create(handle, session);
  }
  findByTokenHash: SessionStore['findByTokenHash'] = (...args) =>
    this.inner.findByTokenHash(...args);
  recordActivity: SessionStore['recordActivity'] = (...args) => this.inner.recordActivity(...args);
  terminate: SessionStore['terminate'] = (...args) => this.inner.terminate(...args);
}

describe('the policy locks', () => {
  // Break caught (§13.10a): the bundle read and the session written without the shared lock on the bundle's key, so that a reduction
  // could commit between them and leave a session carrying the old content. The lock is held while the session is written.
  it('holds the shared lock on the bundle’s key while it writes the session, and no fixed-policy lock for staff', async () => {
    const store = new RecordingStore(machinery.sessions);
    const recorded = assemble(built, { sessions: store });
    const row = await staff({ roleBundleId: BUNDLE_IDS.finance });

    await issue(row, recorded.issuer);

    const key = bundleLockKey(BUNDLE_IDS.finance) >>> 0;
    const bundleLocks = store.locksAtCreate.filter((lock) => lock.classid === AUTH_POLICY_BUNDLE);
    expect(bundleLocks).toEqual([
      expect.objectContaining({ mode: 'ShareLock', granted: true, objid: key }),
    ]);
    expect(store.locksAtCreate.filter((lock) => lock.classid === AUTH_POLICY_FIXED)).toEqual([]);
    // And it is released with the transaction: nothing is held afterwards.
    expect((await advisoryLocks()).filter((lock) => lock.classid === AUTH_POLICY_BUNDLE)).toEqual(
      [],
    );
  });
});

/** A directory that, at its first discovery, has the principal reassigned to another bundle after the read that returned the old one. */
class ReassigningDirectory implements IdentityDirectory {
  discoveries = 0;
  locks = 0;
  constructor(
    private readonly inner: IdentityDirectory,
    private readonly reassign: (discovery: number) => Promise<void>,
    private readonly reassignOn: (discovery: number) => boolean,
  ) {}
  findStaffByCanonicalEmail: IdentityDirectory['findStaffByCanonicalEmail'] = (...args) =>
    this.inner.findStaffByCanonicalEmail(...args);
  findVendorAccountByIdentifier: IdentityDirectory['findVendorAccountByIdentifier'] = (...args) =>
    this.inner.findVendorAccountByIdentifier(...args);
  findRiderByCanonicalPhone: IdentityDirectory['findRiderByCanonicalPhone'] = (...args) =>
    this.inner.findRiderByCanonicalPhone(...args);
  async readIdentity(
    handle: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    this.discoveries += 1;
    const read = await this.inner.readIdentity(handle, ref);
    if (this.reassignOn(this.discoveries)) await this.reassign(this.discoveries);
    return read;
  }
  lockIdentity(handle: TransactionHandle, ref: PrincipalRef): Promise<PrincipalSummary | null> {
    this.locks += 1;
    return this.inner.lockIdentity(handle, ref);
  }
}

/** A directory that runs something once the identity lock is held, to show what the lock keeps out. */
class AfterLockDirectory implements IdentityDirectory {
  constructor(
    private readonly inner: IdentityDirectory,
    private readonly afterLock: () => Promise<void>,
  ) {}
  findStaffByCanonicalEmail: IdentityDirectory['findStaffByCanonicalEmail'] = (...args) =>
    this.inner.findStaffByCanonicalEmail(...args);
  findVendorAccountByIdentifier: IdentityDirectory['findVendorAccountByIdentifier'] = (...args) =>
    this.inner.findVendorAccountByIdentifier(...args);
  findRiderByCanonicalPhone: IdentityDirectory['findRiderByCanonicalPhone'] = (...args) =>
    this.inner.findRiderByCanonicalPhone(...args);
  readIdentity: IdentityDirectory['readIdentity'] = (...args) => this.inner.readIdentity(...args);
  async lockIdentity(
    handle: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    const locked = await this.inner.lockIdentity(handle, ref);
    await this.afterLock();
    return locked;
  }
}

describe('an identity reassigned between discovery and lock (§13.10a obligation 11, OB-11)', () => {
  // Break caught: the plan built on the discovery trusted without a second read under the locks, so that a session is issued for the
  // bundle the identity had, with the lock of a bundle it no longer has.
  it('revalidates under the locks, restarts once, and issues from the bundle it now has, writing nothing before the revalidation passed', async () => {
    const row = await staff({ roleBundleId: BUNDLE_IDS.opsStaff });
    const store = new RecordingStore(machinery.sessions);
    const directory = new ReassigningDirectory(
      new PostgresStaffIdentityDirectory(),
      () =>
        admin
          .query(`update staff_identity set role_bundle_id = $2 where id = $1`, [
            row.id,
            BUNDLE_IDS.finance,
          ])
          .then(() => undefined),
      (discovery) => discovery === 1,
    );
    const reassigned = assemble(built, { sessions: store, identities: directory });

    const issued = await issue(row, reassigned.issuer);

    expect(directory.discoveries).toBe(2);
    expect(directory.locks).toBe(2);
    expect(store.creates).toHaveLength(1);
    expect(issued.session.authority.bundleId).toBe(BUNDLE_IDS.finance);
    expect(issued.session.authority.snapshot.name).toBe('Finance/Reconciliation');
    // The lock held when the session was written is the lock of the bundle it was issued from, and of no other.
    const held = store.locksAtCreate.filter((lock) => lock.classid === AUTH_POLICY_BUNDLE);
    expect(held.map((lock) => lock.objid)).toEqual([bundleLockKey(BUNDLE_IDS.finance) >>> 0]);
    // One session and one event, from the attempt that passed.
    expect(await sessionRows(row.id)).toHaveLength(1);
    expect(await issuedEvents(row.id)).toBe(1);
  });

  // Break caught: a restart that never gives up, or gives up having written part of the act.
  it('gives up after the bounded number of attempts with the generic failure, and nothing was written', async () => {
    const row = await staff({ roleBundleId: BUNDLE_IDS.opsStaff });
    const store = new RecordingStore(machinery.sessions);
    const flip = (): Promise<void> =>
      admin
        .query(
          `update staff_identity set role_bundle_id = case when role_bundle_id = $2 then $3::uuid else $2::uuid end where id = $1`,
          [row.id, BUNDLE_IDS.opsStaff, BUNDLE_IDS.finance],
        )
        .then(() => undefined);
    const directory = new ReassigningDirectory(
      new PostgresStaffIdentityDirectory(),
      flip,
      () => true,
    );
    const reassigned = assemble(built, { sessions: store, identities: directory });

    await expect(issue(row, reassigned.issuer)).rejects.toBeInstanceOf(PolicyCoordinationError);

    expect(directory.discoveries).toBe(3);
    expect(store.creates).toEqual([]);
    expect(await sessionRows(row.id)).toEqual([]);
    expect(await issuedEvents(row.id)).toBe(0);
  });
});

describe('every fact the plan rests on is compared under the locks', () => {
  // Break caught: a restart decided on the bundle alone, so that an identity suspended between the discovery and the lock was given
  // a session on the strength of the status it had when it was discovered.
  it('restarts when the status changed, and then refuses a principal that is no longer active', async () => {
    const row = await staff();
    const store = new RecordingStore(machinery.sessions);
    const directory = new ReassigningDirectory(
      new PostgresStaffIdentityDirectory(),
      () =>
        admin
          .query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [row.id])
          .then(() => undefined),
      (discovery) => discovery === 1,
    );
    const reassigned = assemble(built, { sessions: store, identities: directory });

    await expect(issue(row, reassigned.issuer)).rejects.toMatchObject({
      name: 'SessionIssueRefusedError',
      reason: 'PRINCIPAL_NOT_ACTIVE',
    });

    expect(directory.discoveries).toBe(2);
    expect(store.creates).toEqual([]);
    expect(await issuedEvents(row.id)).toBe(0);
  });

  // Break caught: the hubs of the session taken from the discovery, so that a hub reassigned in between is not the hub the session
  // is limited to.
  it('restarts when the primary hub changed, and records the hubs it has now', async () => {
    const hub = (await observer.one<{ id: string }>(`select id from hub order by name limit 1`))
      ?.id;
    if (hub === undefined) throw new Error('the seed holds no hub');
    const row = await staff({ primaryHubId: null });
    const directory = new ReassigningDirectory(
      new PostgresStaffIdentityDirectory(),
      () =>
        admin
          .query(`update staff_identity set primary_hub_id = $2 where id = $1`, [row.id, hub])
          .then(() => undefined),
      (discovery) => discovery === 1,
    );
    const reassigned = assemble(built, { identities: directory });

    const issued = await issue(row, reassigned.issuer);

    expect(directory.discoveries).toBe(2);
    expect(issued.session.authority.authorizedHubIds).toEqual([hub]);
  });

  // Break caught (found by the review of this batch): a session issued on a credential that was replaced after the caller verified it.
  // The replacement ended every session of the principal, so a session issued afterwards on the strength of the old credential
  // would outlive it. The caller states the credential it verified, and the protocol compares it under the identity lock.
  it('refuses a session on a credential other than the one the caller verified, writing nothing', async () => {
    const row = await staff();
    await replaceCredential(row.id, '2026-10-05T09:00:00.000Z');

    await expect(issue(row, machinery.issuer, 1)).rejects.toMatchObject({
      name: 'SessionIssueRefusedError',
      reason: 'CREDENTIAL_CHANGED',
    });

    expect(await sessionRows(row.id)).toEqual([]);
    expect(await issuedEvents(row.id)).toBe(0);
  });

  // Break caught (the audit of 11 October 2026): the credential told apart by the moment it was established. A JavaScript date keeps
  // milliseconds and the database microseconds, so two credentials established within one millisecond carry the same date.
  it('tells a credential replaced within the same millisecond from the one that was verified', async () => {
    const row = await staff({ credentialEstablishedAt: new Date('2026-10-01T09:00:00.123Z') });
    await replaceCredential(row.id, '2026-10-01 09:00:00.123900+00');
    const stored = await observer.one<{ same_millisecond: boolean }>(
      `select date_trunc('milliseconds', credential_established_at) = '2026-10-01 09:00:00.123+00'::timestamptz as same_millisecond
         from staff_identity where id = $1`,
      [row.id],
    );
    expect(stored?.same_millisecond).toBe(true);

    await expect(issue(row, machinery.issuer, 1)).rejects.toMatchObject({
      name: 'SessionIssueRefusedError',
      reason: 'CREDENTIAL_CHANGED',
    });

    expect(await sessionRows(row.id)).toEqual([]);
  });

  // Break caught (the review of the corrections): the credential told apart by the moment after all, so that a replacement at exactly
  // the instant of the one it replaced is refused by the database or taken for the same credential. The generation alone decides.
  it('tells a credential replaced at the very same instant from the one that was verified, and issues on the new generation', async () => {
    const row = await staff({ credentialEstablishedAt: new Date('2026-10-01T09:00:00.123Z') });
    await replaceCredentialAtSameInstant(row.id);
    const stored = await observer.one<{ same: boolean; generation: string }>(
      `select credential_established_at = '2026-10-01 09:00:00.123+00'::timestamptz as same, credential_generation::text as generation
         from staff_identity where id = $1`,
      [row.id],
    );
    expect(stored).toEqual({ same: true, generation: '2' });

    await expect(issue(row, machinery.issuer, 1)).rejects.toMatchObject({
      name: 'SessionIssueRefusedError',
      reason: 'CREDENTIAL_CHANGED',
    });
    expect(await sessionRows(row.id)).toEqual([]);

    const issued = await issue(row, machinery.issuer, 2);
    expect(issued.session.principalId).toBe(row.id);
    expect(await sessionRows(row.id)).toHaveLength(1);
  });

  // Break caught: a clock that stepped back, so that the replacement carries an earlier moment than the credential it replaced.
  it('tells a credential replaced at an earlier moment from the one that was verified', async () => {
    const row = await staff({ credentialEstablishedAt: new Date('2026-10-01T09:00:00Z') });
    await replaceCredential(row.id, '2026-09-30T09:00:00Z');

    await expect(issue(row, machinery.issuer, 1)).rejects.toMatchObject({
      name: 'SessionIssueRefusedError',
      reason: 'CREDENTIAL_CHANGED',
    });

    expect(await sessionRows(row.id)).toEqual([]);
  });

  // Break caught: a rehash taken for a replacement, so that a sign-in that verified a credential is refused because the hash of the
  // same credential was rewritten at a new cost between the verification and the issue.
  it('issues on a credential that was only rehashed since it was verified', async () => {
    const row = await staff();
    await admin.query(`update staff_identity set credential_hash = 'rehashed' where id = $1`, [
      row.id,
    ]);

    const issued = await issue(row, machinery.issuer, 1);

    expect(issued.session.principalId).toBe(row.id);
  });

  // Break caught: the replacement seen only at the lock and not compared with what the plan was built on: a restart, and then the
  // refusal the stale verification deserves.
  it('restarts when the credential is replaced between the discovery and the lock, and then refuses the stale verification', async () => {
    const row = await staff();
    const directory = new ReassigningDirectory(
      new PostgresStaffIdentityDirectory(),
      () => replaceCredential(row.id, '2026-10-05T09:00:00.000Z').then(() => undefined),
      (discovery) => discovery === 1,
    );
    const reassigned = assemble(built, { identities: directory });

    await expect(issue(row, reassigned.issuer, 1)).rejects.toMatchObject({
      name: 'SessionIssueRefusedError',
      reason: 'CREDENTIAL_CHANGED',
    });

    expect(directory.discoveries).toBe(2);
    expect(await sessionRows(row.id)).toEqual([]);
  });

  // Break caught: an identity lock that does not hold a replacement of the credential off until the issuing transaction ends, so that
  // the replacement (which ends the sessions it finds) could commit between the issuing transaction's check and its insert, and
  // leave a session on the credential it replaced. Here the replacement is begun while the issuing transaction holds the lock.
  it('holds a replacement of the credential off until the issuing transaction has committed', async () => {
    const row = await staff();
    let replacement: Promise<unknown> = Promise.resolve();
    let settledWhileLocked = true;
    const directory = new AfterLockDirectory(new PostgresStaffIdentityDirectory(), async () => {
      let settled = false;
      replacement = replaceCredential(row.id, '2026-10-05T09:00:00.000Z').then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      settledWhileLocked = settled;
    });
    const locked = assemble(built, { identities: directory });

    const issued = await issue(row, locked.issuer, 1);
    await replacement;

    expect(settledWhileLocked).toBe(false);
    expect(issued.session.principalId).toBe(row.id);
    const after = await observer.one<{ credential_generation: string }>(
      `select credential_generation::text as credential_generation from staff_identity where id = $1`,
      [row.id],
    );
    expect(after?.credential_generation).toBe('2');
    // The session was committed before the replacement, so the replacement's writer finds it and ends it (S0.31 and the recovery).
    expect(await sessionRows(row.id)).toHaveLength(1);
  });

  // Break caught: a request that states no credential, or one that is not a whole number of one or more, treated as one that verified
  // nothing in particular.
  it('refuses a request that does not say which credential it verified', async () => {
    const row = await staff();

    for (const verifiedCredentialGeneration of [undefined, null, '1', 0, -1, 1.5, Number.NaN]) {
      await expect(
        machinery.issuer.issue({
          principal: { type: 'STAFF', id: row.id },
          correlationId: 'unsaid',
          verifiedCredentialGeneration,
        } as never),
      ).rejects.toMatchObject({
        name: 'TypeError',
        message: expect.stringContaining('a credential the caller verified') as unknown,
      });
    }
    expect(await sessionRows(row.id)).toEqual([]);
  });
});

/** A directory for an audience that has no identity table yet: it answers for one fixed principal, which a test describes. */
function fixedDirectory(summary: PrincipalSummary): IdentityDirectory {
  const answer = (): Promise<PrincipalSummary> => Promise.resolve(summary);
  return {
    findStaffByCanonicalEmail: () => Promise.resolve(null),
    findVendorAccountByIdentifier: () => Promise.resolve(null),
    findRiderByCanonicalPhone: () => Promise.resolve(null),
    readIdentity: answer,
    lockIdentity: answer,
  };
}

describe('a vendor and a rider rest on the fixed policy too', () => {
  const vendorId = randomUUID();
  const riderId = randomUUID();
  const device = randomUUID();
  /** The moment the credential of each was established, which each sign-in states it verified. */
  const VERIFIED = new Date('2026-10-01T09:00:00.000Z');
  const vendor: PrincipalSummary = {
    ref: { type: 'VENDOR', id: vendorId },
    status: 'ACTIVE',
    credentialGeneration: 1,
    credentialEstablishedAt: VERIFIED,
    bundleId: BUNDLE_IDS.vendor,
    authorizedHubIds: [],
  };
  const rider: PrincipalSummary = {
    ref: { type: 'RIDER', id: riderId },
    status: 'ACTIVE',
    credentialGeneration: 1,
    credentialEstablishedAt: VERIFIED,
    bundleId: BUNDLE_IDS.rider,
    authorizedHubIds: [],
  };

  // Break caught: the fixed-policy lock missing from the plan of a vendor or rider, or the revision recorded being the stored one
  // and not the build's, or a rider given a synchronizer token or a vendor none.
  it('locks the fixed policy of the audience, records the build’s revision and gives each its credentials and lifetime', async () => {
    const store = new RecordingStore(machinery.sessions);
    const asVendor = assemble(built, {
      sessions: store,
      identities: fixedDirectory(vendor),
      compiledPolicy: { VENDOR: 1, RIDER: 1 },
    });
    const asRider = assemble(built, {
      sessions: store,
      identities: fixedDirectory(rider),
      compiledPolicy: { VENDOR: 1, RIDER: 1 },
    });

    const vendorSession = await asVendor.issuer.issue({
      principal: vendor.ref,
      correlationId: 'vendor',
      verifiedCredentialGeneration: 1,
      registeredDeviceId: device,
    });
    const vendorLocks = store.locksAtCreate;
    const riderSession = await asRider.issuer.issue({
      principal: rider.ref,
      correlationId: 'rider',
      verifiedCredentialGeneration: 1,
      registeredDeviceId: device,
      clientRootSignal: 'NOT_DETECTED',
    });
    const riderLocks = store.locksAtCreate;

    expect(vendorSession.session).toMatchObject({
      principalType: 'VENDOR',
      registeredDeviceId: device,
    });
    expect(vendorSession.session.authority).toMatchObject({
      bundleId: BUNDLE_IDS.vendor,
      policyRevision: 1,
    });
    expect(
      vendorSession.session.expiresAt.getTime() - vendorSession.session.issuedAt.getTime(),
    ).toBe(720 * 60_000);
    expect(vendorSession.csrfToken).not.toBeNull();
    expect(vendorLocks.filter((lock) => lock.classid === AUTH_POLICY_FIXED)).toEqual([
      expect.objectContaining({ mode: 'ShareLock', granted: true, objid: 1 }),
    ]);

    expect(riderSession.session).toMatchObject({
      principalType: 'RIDER',
      clientRootSignal: 'NOT_DETECTED',
    });
    expect(riderSession.session.authority.policyRevision).toBe(1);
    expect(riderSession.session.expiresAt.getTime() - riderSession.session.issuedAt.getTime()).toBe(
      1_440 * 60_000,
    );
    expect(riderSession.csrfToken).toBeNull();
    expect(riderSession.session.csrfTokenHash).toBeNull();
    expect(riderLocks.filter((lock) => lock.classid === AUTH_POLICY_FIXED)).toEqual([
      expect.objectContaining({ mode: 'ShareLock', granted: true, objid: 2 }),
    ]);
  });

  it('refuses a bundle that is not of the audience, writing nothing', async () => {
    const wrong = assemble(built, {
      identities: fixedDirectory({ ...vendor, bundleId: BUNDLE_IDS.opsStaff }),
      compiledPolicy: { VENDOR: 1 },
    });

    await expect(
      wrong.issuer.issue({
        principal: vendor.ref,
        correlationId: 'wrong',
        verifiedCredentialGeneration: 1,
        registeredDeviceId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      name: 'SessionIssueRefusedError',
      reason: 'BUNDLE_AUDIENCE_MISMATCH',
    });
  });

  // The floor only rises, so this test goes last: the rest of the file runs against a fixed policy it has not raised.
  // Break caught (§13.10): an instance below the floor issuing, or one that knows no revision, or one that treats a missing
  // policy as permission. Each refuses with the operational failure and writes nothing.
  it('refuses issuance, writing nothing, below the floor, with no compiled revision, and without a seeded policy', async () => {
    // A vendor of its own: an account has at most one live session, and the other test left one for the first.
    const another: PrincipalSummary = { ...vendor, ref: { type: 'VENDOR', id: randomUUID() } };
    await admin.query(
      `update fixed_permission_policy set revision = 2, minimum_revision = 2 where principal_type = 'VENDOR'`,
    );
    const below = assemble(built, {
      identities: fixedDirectory(another),
      compiledPolicy: { VENDOR: 1 },
    });
    const unknown = assemble(built, { identities: fixedDirectory(another), compiledPolicy: {} });
    const request = {
      principal: another.ref,
      correlationId: 'fixed',
      verifiedCredentialGeneration: 1,
      registeredDeviceId: randomUUID(),
    };

    await expect(below.issuer.issue(request)).rejects.toMatchObject({
      name: 'FixedPolicyUnavailableError',
      reason: 'BELOW_FLOOR',
    });
    await expect(unknown.issuer.issue(request)).rejects.toMatchObject({
      name: 'FixedPolicyUnavailableError',
      reason: 'NOT_COMPILED',
    });
    expect(await observer.count('session', { principal_id: another.ref.id })).toBe(0);
    const current = assemble(built, {
      identities: fixedDirectory(another),
      compiledPolicy: { VENDOR: 2 },
    });
    const allowed = await current.issuer.issue(request);
    expect(allowed.session.authority.policyRevision).toBe(2);
    expect(await observer.count('session', { principal_id: another.ref.id })).toBe(1);

    // An addition raises the revision and leaves the floor: a build that is behind the revision and at or above the floor still
    // issues, and records its own revision, not the stored one.
    await admin.query(
      `update fixed_permission_policy set revision = 3 where principal_type = 'VENDOR'`,
    );
    const yetAnother: PrincipalSummary = { ...vendor, ref: { type: 'VENDOR', id: randomUUID() } };
    const behind = assemble(built, {
      identities: fixedDirectory(yetAnother),
      compiledPolicy: { VENDOR: 2 },
    });
    const issuedBehind = await behind.issuer.issue({
      principal: yetAnother.ref,
      correlationId: 'behind',
      verifiedCredentialGeneration: 1,
      registeredDeviceId: randomUUID(),
    });
    expect(issuedBehind.session.authority.policyRevision).toBe(2);
  });
});
