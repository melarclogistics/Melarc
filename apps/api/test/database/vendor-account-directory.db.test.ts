import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { vendorOrganizationFromDirectory } from '../../src/platform/auth/directory/vendor-organization-resolver.js';
import { RoutedIdentityDirectory } from '../../src/platform/auth/directory/routed.identity-directory.adapter.js';
import type { PrincipalRef } from '../../src/platform/auth/ports/identity-directory.port.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { VendorOrganizationUnavailableError } from '../../src/platform/authorization/operation-contexts.js';
import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import { PostgresRiderIdentityDirectory } from '../../src/staff/postgres.rider-identity-directory.adapter.js';
import { PostgresStaffIdentityDirectory } from '../../src/staff/postgres.staff-identity-directory.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  NotAVendorQuestionError,
  PostgresVendorAccountDirectory,
} from '../../src/vendor/postgres.vendor-account-directory.adapter.js';
import { waitUntilBlocked } from './support/policy-fixtures.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { SOME_SECRET_HASH, insertVendor, vendorRow, type VendorRow } from './support/vendors.js';

/**
 * S0.47, the vendor `IdentityDirectory` against a real PostgreSQL, as the API's login under the `authentication` capability: what it finds
 * by the account identifier, the lock it takes (the credential row's), the first secret it writes, the shared lockout it keeps, and what a
 * vendor session is shown as and acts for. It is reached through the platform's router, as the composition binds it.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let unitOfWork: PostgresUnitOfWork;
const vendors = new PostgresVendorAccountDirectory();
const directory = new RoutedIdentityDirectory({
  STAFF: new PostgresStaffIdentityDirectory(),
  VENDOR: vendors,
  RIDER: new PostgresRiderIdentityDirectory(),
});
const POLICY = { maxAttempts: 3, lockoutMinutes: 15 };

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 3 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  unitOfWork = new PostgresUnitOfWork(built.service);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const vendor = (overrides: Partial<VendorRow> = {}): Promise<VendorRow> =>
  insertVendor(admin, vendorRow(overrides));
const inside = <T>(work: (handle: TransactionHandle) => Promise<T>) =>
  unitOfWork.run(systemContext('authentication'), work);
const ref = (row: VendorRow): PrincipalRef => ({ type: 'VENDOR', id: row.accountId });
const credential = async (row: VendorRow) =>
  (
    await admin.query<{
      failed_attempt_count: number;
      locked: boolean;
      credential_generation: string;
      secret_hash: string | null;
    }>(
      `select failed_attempt_count, (locked_until is not null and locked_until > clock_timestamp()) as locked,
              credential_generation, secret_hash
         from vendor_credential where vendor_account_id = $1`,
      [row.accountId],
    )
  ).rows[0];

describe('findVendorAccountByIdentifier', () => {
  // Break caught: a summary naming the wrong bundle (a session snapshots the fixed Vendor bundle), a hub, or another account.
  it('summarises the account: its status, its credential, the fixed Vendor bundle and no hub', async () => {
    const row = await vendor({ secretHash: SOME_SECRET_HASH });
    expect(
      await inside((handle) =>
        directory.findVendorAccountByIdentifier(handle, row.accountIdentifier),
      ),
    ).toEqual({
      ref: { type: 'VENDOR', id: row.accountId },
      status: 'ACTIVE',
      credentialGeneration: 1,
      credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
      bundleId: BUNDLE_IDS.vendor,
      authorizedHubIds: [],
    });
  });

  // The finder takes the canonical identifier; the caller makes it (`canonicalAccountIdentifier`).
  it('finds nothing for an identifier that is not one, or not in its canonical form', async () => {
    const row = await vendor();
    expect(
      await inside((handle) => directory.findVendorAccountByIdentifier(handle, 'ZZZZZZZZ')),
    ).toBeNull();
    expect(
      await inside((handle) =>
        directory.findVendorAccountByIdentifier(handle, row.accountIdentifier.toLowerCase()),
      ),
    ).toBeNull();
  });

  it('says a suspended account is suspended', async () => {
    const row = await vendor({ accountStatus: 'SUSPENDED' });
    expect((await inside((handle) => directory.readIdentity(handle, ref(row))))?.status).toBe(
      'SUSPENDED',
    );
  });
});

describe('lockIdentity', () => {
  // Break caught: a lock on a row a change of the account's standing does not take (a suspension updates the account), so a sign-in, a
  // setup or a recovery could interleave with it.
  it('locks the account row until the transaction ends', async () => {
    const row = await vendor();
    await inside(async (handle) => {
      expect((await directory.lockIdentity(handle, ref(row)))?.ref.id).toBe(row.accountId);
      const other = clientFor(database.urlFor('postgres'));
      await other.connect();
      try {
        await expect(
          other.query(`select 1 from vendor_account where id = $1 for update nowait`, [
            row.accountId,
          ]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await other.end();
      }
    });
  });

  // Break caught: the state read in the statement that waited for the lock, whose snapshot is older than the wait: an account suspended,
  // or a secret replaced, by the transaction that held the lock would be judged as it was before.
  it('reads the account and its credential as they stand once the lock is held, after any wait', async () => {
    const row = await vendor({ secretHash: SOME_SECRET_HASH });
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from vendor_account where id = $1 for update`, [row.accountId]);
      const read = inside((handle) => directory.lockIdentity(handle, ref(row)));
      await waitUntilBlocked(admin, database.name, /vendor_account/);
      await holder.query(`update vendor_account set status = 'SUSPENDED' where id = $1`, [
        row.accountId,
      ]);
      await holder.query(
        `update vendor_credential set secret_hash = $2, credential_established_at = clock_timestamp(), credential_generation = 2
          where vendor_account_id = $1`,
        [row.accountId, `${SOME_SECRET_HASH}v2`],
      );
      await holder.query('commit');
      expect(await read).toMatchObject({ status: 'SUSPENDED', credentialGeneration: 2 });
    } finally {
      await holder.end();
    }
  });
});

describe('establishCredential', () => {
  it('writes the first secret once, from generation 0 to 1, and clears the lockout', async () => {
    const row = await vendor();
    await admin.query(
      `update vendor_credential set failed_attempt_count = 2 where vendor_account_id = $1`,
      [row.accountId],
    );
    expect(
      await inside((handle) => directory.establishCredential(handle, ref(row), SOME_SECRET_HASH)),
    ).toEqual({
      generation: 1,
    });
    expect(await credential(row)).toEqual({
      failed_attempt_count: 0,
      locked: false,
      credential_generation: '1',
      secret_hash: SOME_SECRET_HASH,
    });
    // A replacement is a recovery's act, never a setup's.
    expect(
      await inside((handle) =>
        directory.establishCredential(handle, ref(row), `${SOME_SECRET_HASH}x`),
      ),
    ).toBeNull();
    expect((await credential(row))?.secret_hash).toBe(SOME_SECRET_HASH);
  });
});

describe('the shared lockout', () => {
  it('counts each failure, sets the lock at the policy’s count once, and then counts nothing', async () => {
    const row = await vendor({ secretHash: SOME_SECRET_HASH });
    const fail = () =>
      inside((handle) => directory.recordFailedAttempt(handle, ref(row), 1, POLICY));
    expect(await fail()).toMatchObject({ counted: true, failedAttemptCount: 1, tipped: false });
    expect(await fail()).toMatchObject({ counted: true, failedAttemptCount: 2, tipped: false });
    expect(await fail()).toMatchObject({ counted: true, failedAttemptCount: 3, tipped: true });
    expect(await fail()).toEqual({ counted: false, reason: 'LOCKED' });
    expect(await inside((handle) => directory.isCredentialLocked(handle, ref(row)))).toBe(true);
    await inside((handle) => directory.clearFailedAttempts(handle, ref(row)));
    expect(await credential(row)).toMatchObject({ failed_attempt_count: 0, locked: false });
  });

  // Break caught (A03 of 21 October 2026, for the vendor): an old verification counting against a new secret or a suspended account.
  it('counts nothing against another generation or a suspended account', async () => {
    const row = await vendor({ secretHash: SOME_SECRET_HASH });
    expect(
      await inside((handle) => directory.recordFailedAttempt(handle, ref(row), 2, POLICY)),
    ).toEqual({
      counted: false,
      reason: 'STALE',
    });
    const suspended = await vendor({ secretHash: SOME_SECRET_HASH, accountStatus: 'SUSPENDED' });
    expect(
      await inside((handle) => directory.recordFailedAttempt(handle, ref(suspended), 1, POLICY)),
    ).toEqual({
      counted: false,
      reason: 'STALE',
    });
    expect((await credential(suspended))?.failed_attempt_count).toBe(0);
  });
});

describe('readCredentialHash and rehashCredential', () => {
  it('gives the hash through the authentication-only reader, and rehashes only the hash that was verified', async () => {
    const row = await vendor({ secretHash: SOME_SECRET_HASH });
    expect(await inside((handle) => directory.readCredentialHash(handle, ref(row)))).toBe(
      SOME_SECRET_HASH,
    );
    expect(
      await inside((handle) =>
        directory.rehashCredential(
          handle,
          ref(row),
          1,
          'not-the-stored-hash',
          `${SOME_SECRET_HASH}v2`,
        ),
      ),
    ).toBe(false);
    expect(
      await inside((handle) =>
        directory.rehashCredential(handle, ref(row), 1, SOME_SECRET_HASH, `${SOME_SECRET_HASH}v2`),
      ),
    ).toBe(true);
    expect(await credential(row)).toMatchObject({
      secret_hash: `${SOME_SECRET_HASH}v2`,
      credential_generation: '1',
    });
  });
});

describe('what a vendor session is shown as and acts for', () => {
  // Break caught (vendor-authentication.md section 5.2): a session naming a person, or not naming the organisation.
  it('names the organisation, by its trading name where it has one', async () => {
    const legal = await vendor({ legalName: 'Asante Foods Limited' });
    const trading = await vendor({
      legalName: 'Kofi Ventures Limited',
      tradingName: 'Kofi Ventures',
    });
    expect(await inside((handle) => directory.displayName(handle, ref(legal)))).toBe(
      'Asante Foods Limited',
    );
    expect(await inside((handle) => directory.displayName(handle, ref(trading)))).toBe(
      'Kofi Ventures',
    );
    expect(
      await inside((handle) => directory.displayName(handle, { type: 'VENDOR', id: randomUUID() })),
    ).toBeNull();
  });

  it('resolves a vendor session’s organisation from its account, and refuses one whose account is not there', async () => {
    const row = await vendor();
    const resolve = vendorOrganizationFromDirectory(unitOfWork, directory);
    expect(await resolve({ principalId: row.accountId })).toBe(row.organizationId);
    await expect(resolve({ principalId: randomUUID() })).rejects.toBeInstanceOf(
      VendorOrganizationUnavailableError,
    );
  });
});

describe('the questions that are not the vendor directory’s', () => {
  it('refuses a staff or rider principal and the staff finders, which the router never sends it', async () => {
    await expect(
      inside((handle) => vendors.readIdentity(handle, { type: 'STAFF', id: randomUUID() })),
    ).rejects.toBeInstanceOf(NotAVendorQuestionError);
    await expect(inside(() => vendors.findStaffByCanonicalEmail())).rejects.toBeInstanceOf(
      NotAVendorQuestionError,
    );
    await expect(inside(() => vendors.accountLabel())).rejects.toBeInstanceOf(
      NotAVendorQuestionError,
    );
  });

  // Break caught: a staff context reaching a credential through the directory (row-level security gives it none).
  it('finds nothing under a staff context, which row-level security keeps from the credential', async () => {
    const row = await vendor();
    const found = await unitOfWork.run(
      {
        principalType: 'STAFF',
        principalId: randomUUID(),
        surface: 'OPS_PORTAL',
        correlationId: 'vendor-directory-test',
        hubScopeMode: 'ALL',
        authorizedHubIds: [],
        authorizationKey: 'vendor.read',
      },
      (handle) => directory.findVendorAccountByIdentifier(handle, row.accountIdentifier),
    );
    expect(found).toBeNull();
  });
});
