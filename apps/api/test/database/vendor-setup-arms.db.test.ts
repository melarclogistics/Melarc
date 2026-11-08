import { createHash, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { SOME_SECRET_HASH, insertVendor, vendorRow, type VendorRow } from './support/vendors.js';

/**
 * S0.47b (migration 0035): what `reissueVendorCredentialSetup` may write, against a real PostgreSQL as the API's login. The act runs in the
 * caller's own staff context under `vendor.organization.approve`, as the staff approver's does under its key (migration 0029 states the
 * mechanism): `melarc.vendor_locked_facts` locks an account the caller's scope shows and binds the transaction to it, and the arms of the
 * grant and the message are bound to that account, to the one purpose and kind of the act, and to the caller as issuer. A guard of the
 * grant table holds every writer, the authentication capability included, to the grants a vendor account can use: a setup grant for an
 * approved account with no secret, a browser grant for one that has a secret.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const APPROVE = 'vendor.organization.approve';

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

type Work = (tx: DatabaseTransaction) => Promise<{ rowCount: number | null; rows: unknown[] }>;

const acting = (
  key: string | null = APPROVE,
  hubs: readonly string[] = [HUB_A],
): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  surface: 'OPS_PORTAL',
  correlationId: 'vendor-setup-arms-test',
  hubScopeMode: 'SET',
  authorizedHubIds: hubs,
  ...(key === null ? {} : { authorizationKey: key }),
});

const authentication: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: '61757468-0000-4000-8000-000000000001',
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'vendor-setup-arms-test',
};

/** The work after the account's lock, as the act takes it: the facts first, which bind the transaction. */
const locked =
  (accountId: string, work: Work): Work =>
  async (tx) => {
    await tx.execute(sql`select * from melarc.vendor_locked_facts(${accountId}::uuid)`);
    return work(tx);
  };

async function codeOf(context: SecurityContext, work: Work): Promise<string | undefined> {
  try {
    await built.service.transactionWithContext(context, work);
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code ?? 'other';
  }
}

const hash = (): Buffer => createHash('sha256').update(randomUUID()).digest();

const issue =
  (
    accountId: string,
    issuedBy: string | null,
    overrides: { purpose?: string; principalType?: string } = {},
  ): Work =>
  (tx) =>
    tx.execute(sql`
      insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by)
      values (${randomUUID()}::uuid, ${overrides.principalType ?? 'VENDOR'}, ${accountId}::uuid,
              ${overrides.purpose ?? 'VENDOR_CREDENTIAL_SETUP'}, ${hash()}, clock_timestamp(), clock_timestamp() + interval '30 minutes',
              'PENDING', ${issuedBy}::uuid)`);

async function grantOf(
  account: VendorRow,
  issuedBy: string,
  purpose = 'VENDOR_CREDENTIAL_SETUP',
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by)
     values ($1, 'VENDOR', $2, $3, $4, clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING', $5)`,
    [id, account.accountId, purpose, hash(), issuedBy],
  );
  return id;
}

const queue =
  (accountId: string, grantId: string, overrides: { kind?: string; state?: string } = {}): Work =>
  (tx) =>
    tx.execute(sql`
      insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id, channel,
                                           state, attempt_count, next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext,
                                           payload_nonce, payload_key_version, payload_envelope_version)
      values (${randomUUID()}::uuid, ${overrides.kind ?? 'SETUP_GRANT'}, 'SETUP_GRANT', ${grantId}::uuid, 'VENDOR', ${accountId}::uuid,
              'EMAIL', ${overrides.state ?? 'QUEUED'}, 0, clock_timestamp(), clock_timestamp() + interval '30 minutes', ${randomUUID()},
              ${Buffer.alloc(40, 7)}, ${Buffer.alloc(12, 3)}, 1, 1)`);

const fresh = (overrides: Partial<VendorRow> = {}): Promise<VendorRow> =>
  insertVendor(admin, vendorRow({ hubId: HUB_A, ...overrides }));

describe('the setup grant a re-issue writes (vendor.organization.approve)', () => {
  // Break caught: no arm for the re-issue, so that reissueVendorCredentialSetup could not issue the grant AC-SLICE-000-101 says it does.
  it('issues a VENDOR_CREDENTIAL_SETUP grant in its own name to an account of its scope that it locked', async () => {
    const approver = acting();
    const account = await fresh();
    const result = await built.service.transactionWithContext(
      approver,
      locked(account.accountId, issue(account.accountId, approver.principalId)),
    );
    expect(result.rowCount).toBe(1);
  });

  // Break caught: an arm that binds nothing: a grant for an account the transaction never locked, another than the one it locked, or one
  // outside its hubs (which the facts function does not lock).
  it('refuses a grant for an account the act did not lock, another than the one it locked, or one outside its hubs', async () => {
    const approver = acting();
    const account = await fresh();
    const other = await fresh();
    const outside = await fresh({ hubId: HUB_B });
    expect(await codeOf(approver, issue(account.accountId, approver.principalId))).toBe('42501');
    expect(
      await codeOf(
        approver,
        locked(other.accountId, issue(account.accountId, approver.principalId)),
      ),
    ).toBe('42501');
    expect(
      await codeOf(
        approver,
        locked(outside.accountId, issue(outside.accountId, approver.principalId)),
      ),
    ).toBe('42501');
  });

  it.each([
    ['in another issuer’s name', (account: VendorRow) => issue(account.accountId, randomUUID())],
    ['in nobody’s name', (account: VendorRow) => issue(account.accountId, null)],
    [
      'of another purpose',
      (account: VendorRow, actor: string) =>
        issue(account.accountId, actor, { purpose: 'VENDOR_DEVICE_ENROLMENT' }),
    ],
  ] as const)('refuses a grant %s', async (_name, make) => {
    const approver = acting();
    const account = await fresh();
    expect(
      await codeOf(approver, locked(account.accountId, make(account, approver.principalId))),
    ).toBeDefined();
  });

  it.each(['vendor.read', 'vendor.credential.recover', 'staff.identity.approve', null])(
    'is refused under the key %s',
    async (key) => {
      const context = acting(key);
      const account = await fresh();
      expect(
        await codeOf(
          context,
          locked(account.accountId, issue(account.accountId, context.principalId)),
        ),
      ).toBeDefined();
    },
  );

  // Break caught: the re-issue reading or ending grants it did not issue to the locked account, or consuming one.
  it('reads and ends the pending setup grants of the account it locked, by superseding or expiring them only', async () => {
    const approver = acting();
    const account = await fresh();
    const other = await fresh();
    const mine = await grantOf(account, randomUUID());
    const theirs = await grantOf(other, randomUUID());
    const read: Work = (tx) =>
      tx.execute(sql`select id from setup_grant where id in (${mine}::uuid, ${theirs}::uuid)`);
    expect(
      (await built.service.transactionWithContext(approver, locked(account.accountId, read))).rows,
    ).toEqual([{ id: mine }]);
    expect((await built.service.transactionWithContext(approver, read)).rows).toEqual([]);

    const end =
      (id: string, state: string): Work =>
      (tx) =>
        tx.execute(
          sql`update setup_grant set state = ${state} where id = ${id}::uuid returning id`,
        );
    expect(await codeOf(approver, locked(account.accountId, end(mine, 'CONSUMED')))).toBe('42501');
    expect(
      (
        await built.service.transactionWithContext(
          approver,
          locked(account.accountId, end(theirs, 'SUPERSEDED')),
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await built.service.transactionWithContext(
          approver,
          locked(account.accountId, end(mine, 'SUPERSEDED')),
        )
      ).rows,
    ).toEqual([{ id: mine }]);
  });
});

describe('the grants a vendor account can use, for every writer', () => {
  // Break caught (vendor-authentication.md section 4.2; the re-issue's guard "the secret IS NULL"): a setup grant for an account that has
  // already set its secret, which would let the grant replace the secret without a recovery.
  it('refuses a setup grant for an account that holds a secret, whoever writes it', async () => {
    const account = await fresh({ secretHash: SOME_SECRET_HASH });
    expect(await codeOf(authentication, issue(account.accountId, null))).toBe('23514');
    const approver = acting();
    expect(
      await codeOf(
        approver,
        locked(account.accountId, issue(account.accountId, approver.principalId)),
      ),
    ).toBe('23514');
  });

  // Break caught: a grant that a suspended account, or an organisation not approved or ended, could take (the setup refuses it anyway, and
  // a grant nobody can use is a message to nobody).
  it.each([
    ['a suspended account', { accountStatus: 'SUSPENDED' }],
    ['an organisation that is suspended', { organizationStatus: 'SUSPENDED' }],
    ['an organisation that was rejected', { organizationStatus: 'REJECTED' }],
    ['an organisation that is terminated', { organizationStatus: 'TERMINATED' }],
    [
      'an organisation still under review',
      { organizationStatus: 'PENDING_SENIOR_OPS_REVIEW', deliveryChannel: null },
    ],
  ] as const)('refuses a setup grant for %s', async (_name, overrides) => {
    const account = await fresh(overrides);
    expect(await codeOf(authentication, issue(account.accountId, null))).toBe('23514');
  });

  it('refuses a browser grant for an account with no secret yet, and admits one for an active account that has one', async () => {
    const none = await fresh();
    expect(
      await codeOf(
        authentication,
        issue(none.accountId, null, { purpose: 'VENDOR_DEVICE_ENROLMENT' }),
      ),
    ).toBe('23514');
    const established = await fresh({ secretHash: SOME_SECRET_HASH });
    expect(
      await codeOf(
        authentication,
        issue(established.accountId, null, { purpose: 'VENDOR_DEVICE_ENROLMENT' }),
      ),
    ).toBeUndefined();
  });

  it('refuses a vendor grant for an account that does not exist', async () => {
    expect(await codeOf(authentication, issue(randomUUID(), null))).toBe('23514');
  });
});

describe('the message a re-issue queues', () => {
  // Break caught: no arm for the re-issue's message, so the grant could not travel in the act's own transaction.
  it('queues a SETUP_GRANT message for a pending grant it issued to the account it locked', async () => {
    const approver = acting();
    const account = await fresh();
    const grant = await grantOf(account, approver.principalId);
    const result = await built.service.transactionWithContext(
      approver,
      locked(account.accountId, queue(account.accountId, grant)),
    );
    expect(result.rowCount).toBe(1);
  });

  it('refuses a message for an account it did not lock, a grant it did not issue, another kind or a job already begun', async () => {
    const approver = acting();
    const account = await fresh();
    const grant = await grantOf(account, approver.principalId);
    // One pending setup grant per account: the grant of another issuer is another account's.
    const elsewhere = await fresh();
    const foreign = await grantOf(elsewhere, randomUUID());
    expect(await codeOf(approver, queue(account.accountId, grant))).toBe('42501');
    expect(
      await codeOf(approver, locked(elsewhere.accountId, queue(elsewhere.accountId, foreign))),
    ).toBe('42501');
    expect(
      await codeOf(
        approver,
        locked(account.accountId, queue(account.accountId, grant, { kind: 'DEVICE_GRANT' })),
      ),
    ).toBeDefined();
    expect(
      await codeOf(
        approver,
        locked(account.accountId, queue(account.accountId, grant, { state: 'LEASED' })),
      ),
    ).toBeDefined();
  });

  // Break caught: the re-issue unable to cancel the message of the grant it supersedes, or able to cancel another account's.
  it('reads and cancels the live setup messages of the account it locked, and no other', async () => {
    const approver = acting();
    const account = await fresh();
    const other = await fresh();
    const grant = await grantOf(account, approver.principalId);
    const theirs = await grantOf(other, approver.principalId);
    await built.service.transactionWithContext(
      approver,
      locked(account.accountId, queue(account.accountId, grant)),
    );
    await built.service.transactionWithContext(
      approver,
      locked(other.accountId, queue(other.accountId, theirs)),
    );
    const cancel: Work = (tx) =>
      tx.execute(sql`update credential_delivery_job
                        set state = 'CANCELLED', outcome_class = 'CANCELLED', payload_ciphertext = null, payload_nonce = null,
                            payload_key_version = null, payload_envelope_version = null, payload_erased_at = clock_timestamp()
                      where redemption_record_id in (${grant}::uuid, ${theirs}::uuid) returning redemption_record_id`);
    expect(
      (await built.service.transactionWithContext(approver, locked(account.accountId, cancel)))
        .rows,
    ).toEqual([{ redemption_record_id: grant }]);
  });
});
