import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import type {
  IdentityDirectory,
  PrincipalRef,
  PrincipalSummary,
} from '../../src/platform/auth/ports/identity-directory.port.js';
import {
  IdentityDirectoryNotBuiltError,
  PostgresStaffIdentityDirectory,
} from '../../src/staff/postgres.staff-identity-directory.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { openAdmin, type Admin } from './support/admin.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { HUB_A } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { systemContext } from './support/rls-fixture.js';
import type pg from 'pg';

/**
 * S0.24, the staff `IdentityDirectory` (the first adapter a domain provides) against a real PostgreSQL, as the API's login under
 * the `authentication` capability: what it finds by the canonical work email, what it reads without a lock for the discovery of a
 * policy-locked operation, and what it reads **under the identity lock**, which is the read a decision is made on.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let adminKit: Admin;
let unitOfWork: PostgresUnitOfWork;
const directory: IdentityDirectory = new PostgresStaffIdentityDirectory();
let hub: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  adminKit = await openAdmin(database);
  unitOfWork = new PostgresUnitOfWork(built.service);
  const hubs = await admin.query<{ id: string }>('select id from hub order by name limit 1');
  hub = hubs.rows[0]?.id ?? HUB_A;
});

afterAll(async () => {
  await admin.end();
  await adminKit.close();
  await built.close();
  await database.drop();
});

const staff = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const inside = <T>(
  work: (handle: Parameters<IdentityDirectory['readIdentity']>[0]) => Promise<T>,
) => unitOfWork.run(systemContext('authentication'), work);
const ref = (row: StaffRow): PrincipalRef => ({ type: 'STAFF', id: row.id });

describe('findStaffByCanonicalEmail', () => {
  // Break caught: the summary naming something other than the row (the bundle a session snapshots, the hubs it will be limited to).
  it('summarises the identity: its status, its credential, its bundle and its primary hub', async () => {
    const row = await staff({ primaryHubId: hub, roleBundleId: BUNDLE_IDS.seniorOps });

    const found = await inside((handle) =>
      directory.findStaffByCanonicalEmail(handle, row.workEmailCanonical),
    );

    expect(found).toEqual<PrincipalSummary>({
      ref: { type: 'STAFF', id: row.id },
      status: 'ACTIVE',
      credentialGeneration: 1,
      credentialEstablishedAt: row.credentialEstablishedAt,
      bundleId: BUNDLE_IDS.seniorOps,
      authorizedHubIds: [hub],
    });
  });

  it('has no hubs for an identity with no primary hub, and no credential before one is established', async () => {
    const row = await staff({
      status: 'PENDING_APPROVAL',
      approvedBy: null,
      credentialHash: null,
      credentialEstablishedAt: null,
    });

    const found = await inside((handle) =>
      directory.findStaffByCanonicalEmail(handle, row.workEmailCanonical),
    );

    expect(found).toMatchObject({
      status: 'PENDING_APPROVAL',
      credentialGeneration: 0,
      credentialEstablishedAt: null,
      authorizedHubIds: [],
    });
  });

  // Break caught: an address found by the text as typed, so that two spellings of one address are two identities, or a
  // rejected profile found: it released its address.
  it('finds by the canonical form only, and finds nothing for an unknown address or a rejected profile', async () => {
    const row = await staff({
      workEmail: 'Mixed.Case@Example.Test',
      workEmailCanonical: 'mixed.case@example.test',
    });
    const rejected = await staff({ status: 'REJECTED' });

    expect(
      await inside((h) => directory.findStaffByCanonicalEmail(h, 'mixed.case@example.test')),
    ).toMatchObject({
      ref: { id: row.id },
    });
    expect(
      await inside((h) => directory.findStaffByCanonicalEmail(h, 'Mixed.Case@Example.Test')),
    ).toBeNull();
    expect(
      await inside((h) => directory.findStaffByCanonicalEmail(h, 'nobody@example.test')),
    ).toBeNull();
    expect(
      await inside((h) => directory.findStaffByCanonicalEmail(h, rejected.workEmailCanonical)),
    ).toBeNull();
  });

  // Break caught: the lookup matching on the address as entered, lower-cased, instead of on the canonical column. The canonical form
  // is NFKC then lower case (domain-model.md §6.8), so an address typed in fullwidth letters has a canonical form that lower-casing
  // what was entered does not reach.
  it('finds by the canonical column, which is not always the lower case of what was entered', async () => {
    const row = await staff({
      workEmail: 'ＡＤＡ@Example.Test',
      workEmailCanonical: 'ada.fullwidth@example.test',
    });

    expect(
      await inside((h) => directory.findStaffByCanonicalEmail(h, 'ada.fullwidth@example.test')),
    ).toMatchObject({ ref: { id: row.id } });
    expect(
      await inside((h) => directory.findStaffByCanonicalEmail(h, 'ａｄａ@example.test')),
    ).toBeNull();
  });

  // Break caught: the identity found by a wildcard or a pattern: the lookup is by key, and the port offers no scan.
  it('treats the address as a value and never as a pattern', async () => {
    await staff();

    expect(await inside((h) => directory.findStaffByCanonicalEmail(h, '%'))).toBeNull();
    expect(await inside((h) => directory.findStaffByCanonicalEmail(h, "' or true --"))).toBeNull();
  });
});

describe('readIdentity and lockIdentity', () => {
  it('read a staff identity by reference, with no lock and with one', async () => {
    const row = await staff({ primaryHubId: hub });

    const read = await inside((handle) => directory.readIdentity(handle, ref(row)));
    const locked = await inside((handle) => directory.lockIdentity(handle, ref(row)));

    expect(read).toEqual(locked);
    expect(read).toMatchObject({
      ref: { type: 'STAFF', id: row.id },
      status: 'ACTIVE',
      authorizedHubIds: [hub],
    });
  });

  it('answer null for an identity that does not exist', async () => {
    const missing: PrincipalRef = { type: 'STAFF', id: randomUUID() };

    expect(await inside((handle) => directory.readIdentity(handle, missing))).toBeNull();
    expect(await inside((handle) => directory.lockIdentity(handle, missing))).toBeNull();
  });

  // Break caught: the lock read from what the transaction saw before it waited: a decision made on a stale read. The reassignment
  // is committed while the lock is waited for, and what the lock returns is what was committed.
  it('reads under the lock: what another transaction committed while it waited', async () => {
    const row = await staff({ roleBundleId: BUNDLE_IDS.opsStaff });
    await adminKit.query('begin');
    await adminKit.query(`select id from staff_identity where id = $1 for update`, [row.id]);
    const waiting = inside((handle) => directory.lockIdentity(handle, ref(row)));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await adminKit.query(
      `update staff_identity set role_bundle_id = $2, status = 'SUSPENDED' where id = $1`,
      [row.id, BUNDLE_IDS.finance],
    );
    await adminKit.query('commit');

    const locked = await waiting;

    expect(locked).toMatchObject({ bundleId: BUNDLE_IDS.finance, status: 'SUSPENDED' });
  });

  // Break caught: the identity lock not held to the end of the transaction, so that a suspension could slip in between the
  // revalidation of an issue and its insert.
  it('holds the lock until the transaction ends', async () => {
    const row = await staff();
    const events: string[] = [];
    const holder = inside(async (handle) => {
      await directory.lockIdentity(handle, ref(row));
      events.push('held');
      await new Promise((resolve) => setTimeout(resolve, 300));
      events.push('released');
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const waiter = inside(async (handle) => {
      await directory.lockIdentity(handle, ref(row));
      events.push('second');
    });

    await Promise.all([holder, waiter]);

    expect(events).toEqual(['held', 'released', 'second']);
  });
});

describe('what is not built', () => {
  // Break caught: a vendor or a rider found as nobody (a success stub): a lookup the adapter cannot answer fails and says so.
  it('refuses a vendor account, a rider and a reference that is not staff, and says why', async () => {
    await expect(
      inside((h) => directory.findVendorAccountByIdentifier(h, 'ACC-1')),
    ).rejects.toBeInstanceOf(IdentityDirectoryNotBuiltError);
    await expect(
      inside((h) => directory.findRiderByCanonicalPhone(h, '+233201234567')),
    ).rejects.toBeInstanceOf(IdentityDirectoryNotBuiltError);
    for (const type of ['VENDOR', 'RIDER'] as const) {
      await expect(
        inside((h) => directory.readIdentity(h, { type, id: randomUUID() })),
      ).rejects.toBeInstanceOf(IdentityDirectoryNotBuiltError);
      await expect(
        inside((h) => directory.lockIdentity(h, { type, id: randomUUID() })),
      ).rejects.toBeInstanceOf(IdentityDirectoryNotBuiltError);
    }
  });
});
