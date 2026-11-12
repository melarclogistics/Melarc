// Runs alone: the bootstrap functions it drives act as the provisioning login under deadlines of real time (BOOTSTRAP_DEADLINES), which files beside it would delay.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../../src/platform/auth/clock/system.clock.adapter.js';
import { Sha256TokenService } from '../../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import { PROVISIONING_ROLE } from '../../../src/platform/database/technical-roles.js';
import { FakeAccess, FakeDisk } from '../../../src/test-support/custody-fakes.js';
import {
  runBootstrapResume,
  runBootstrapSeed,
  targetOf,
  type BootstrapDependencies,
} from '../../../src/tools/bootstrap/bootstrap-command.js';
import { PostgresBootstrapDatabase } from '../../../src/tools/bootstrap/bootstrap-database.js';
import {
  BootstrapRefusedError,
  type RefusalReason,
} from '../../../src/tools/bootstrap/bootstrap-vocabulary.js';
import { BUNDLE_MAGIC } from '../../../src/tools/bootstrap/custody-bundle.js';
import {
  assertCustodyDirectory,
  NodeCustodyDisk,
  privateAccessFor,
  randomBundleName,
} from '../../../src/tools/bootstrap/custody-node.js';
import { CustodyStore } from '../../../src/tools/bootstrap/custody-store.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import {
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
  setGrantState,
  activateFactor,
} from '../support/credentials.js';
import { Admin, openAdmin } from '../support/admin.js';
import { seedReferenceData } from '../support/seeded.js';
import { buildService, type BuiltService } from '../support/service.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  type TestDatabase,
} from '../support/test-database.js';

/**
 * S0.30, the two commands over a real database and a real folder (MIGRATION_AND_SEEDING.md §3.2 and §3.3a): the seed and the resume
 * run as the provisioning login, the bundles are written by the real custody adapters in a disposable folder of the temporary
 * directory (outside the checkout, as the command demands), and the access of each bundle is read back by the real inspection of
 * this platform (the access list on Windows, the mode on POSIX). **Every value is a throwaway sentinel and no real custody file or
 * credential is made**; nothing here connects to `melarc_dev`.
 */

const tokens = new Sha256TokenService();
const clock = new SystemClock();

const FIRST = 'Kofi Boateng <kofi.boateng@melarc.example>';
const SECOND = 'Efua Addo <efua.addo@melarc.example>';

let database: TestDatabase;
let admin: Admin;
let adminClient: pg.Client;
let provisioning: BuiltService;
let folder: string;
let directory: string;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = await openAdmin(database);
  adminClient = clientFor(database.urlFor('postgres'));
  await adminClient.connect();
  provisioning = buildService(database, { login: PROVISIONING_ROLE });
  folder = await mkdtemp(join(tmpdir(), 'melarc-bootstrap-test-'));
});

afterAll(async () => {
  await provisioning.close();
  await adminClient.end();
  await admin.close();
  await rm(folder, { recursive: true, force: true });
  await database.drop();
});

let run = 0;
beforeEach(async () => {
  await adminClient.query(
    'truncate trusted_browser, mfa_challenge, mfa_factor, setup_grant, session, staff_identity',
  );
  run += 1;
  directory = join(folder, `run-${String(run)}`);
});

const ENV = (): Record<string, string> => ({ BOOTSTRAP_CUSTODY_DIRECTORY: directory });

function dependencies(overrides: Partial<BootstrapDependencies> = {}): BootstrapDependencies {
  return {
    localUrl: () => database.urlFor(PROVISIONING_ROLE),
    open: () => ({
      database: new PostgresBootstrapDatabase(provisioning.service),
      // The pool belongs to the test; the command's close of it is the test's to ignore.
      close: () => Promise.resolve(),
    }),
    store: new CustodyStore(new NodeCustodyDisk(), privateAccessFor(), randomBundleName),
    tokens,
    clock,
    custodyDirectory: (value) => assertCustodyDirectory(value, [process.cwd()]),
    correlationId: () => `bootstrap-it-${randomUUID()}`,
    ...overrides,
  };
}

/** Runs the command with its output kept, as a terminal would keep it. */
async function seed(overrides: Partial<BootstrapDependencies> = {}, argv?: string[]) {
  const output: string[] = [];
  await runBootstrapSeed(
    argv ?? ['--custodian', FIRST, '--custodian', SECOND],
    ENV(),
    (line) => output.push(line),
    dependencies(overrides),
  );
  return output;
}

const bundlesOnDisk = (): { name: string; text: string }[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.bundle'))
    .map((name) => ({ name, text: readFileSync(join(directory, name), 'utf8') }));

const secretOf = (text: string): string => text.split('\nsecret:\n')[1]?.split('\n')[0] ?? '';
const hashOfSecret = (secret: string): string =>
  createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex');
const refusalReason = async (run: Promise<unknown>): Promise<RefusalReason | undefined> => {
  try {
    await run;
  } catch (error) {
    if (error instanceof BootstrapRefusedError) return error.reason;
    throw error;
  }
  return undefined;
};

describe('the bootstrap seed, end to end (S0.30)', () => {
  it('makes the pair, and one private bundle for each custodian whose secret is the one the database holds the hash of', async () => {
    const output = await seed();

    const identities = (
      await adminClient.query<{
        id: string;
        full_name: string;
        work_email: string;
        origin: string;
        status: string;
        role_bundle_id: string;
      }>(
        'select id, full_name, work_email, origin, status, role_bundle_id from staff_identity order by work_email',
      )
    ).rows;
    expect(
      identities.map((row) => [row.work_email, row.origin, row.status, row.role_bundle_id]),
    ).toEqual([
      ['efua.addo@melarc.example', 'BOOTSTRAP', 'ACTIVE', BUNDLE_IDS.platformAdmin],
      ['kofi.boateng@melarc.example', 'BOOTSTRAP', 'ACTIVE', BUNDLE_IDS.platformAdmin],
    ]);

    const bundles = bundlesOnDisk();
    expect(bundles).toHaveLength(2);
    for (const identity of identities) {
      const bundle = bundles.find((candidate) =>
        candidate.text.includes(`<${identity.work_email}>`),
      );
      expect(bundle, identity.work_email).toBeDefined();
      expect(bundle?.text.startsWith(BUNDLE_MAGIC)).toBe(true);
      const stored = await scalar<string>(
        adminClient,
        "select encode(token_hash, 'hex') from setup_grant where principal_id = $1 and purpose = 'BOOTSTRAP_SETUP' and state = 'PENDING'",
        [identity.id],
      );
      expect(hashOfSecret(secretOf(bundle?.text ?? '')), identity.work_email).toBe(stored);
      // Each bundle names its own custodian and not the other.
      const other = identities.find((candidate) => candidate.id !== identity.id);
      expect(bundle?.text).not.toContain(other?.work_email ?? 'x');
      expect(bundle?.text).not.toContain(other?.full_name ?? 'x');
    }
    expect(output.some((line) => line.includes('staff_identity: 2 rows'))).toBe(true);
  });

  // Break caught: a bundle that the file system made readable by more than its operator, which is the secret of an administrator of
  // the whole platform. The real inspection of this platform reads it back: the mode on POSIX, the access list on Windows.
  it('leaves each bundle private to the user who ran the command, as the platform inspects it', async () => {
    await seed();
    const access = privateAccessFor();
    for (const { name } of bundlesOnDisk()) {
      expect(await access.inspect(join(directory, name)), name).toBe('PRIVATE');
    }
    expect(bundlesOnDisk()).toHaveLength(2);
  });

  // Break caught: the secret reaching anything but the one file made for it.
  it('puts no secret, address or path in the output, the database, the audit ledger or anything but the bundle', async () => {
    const output = await seed();
    const secrets = bundlesOnDisk().map((bundle) => secretOf(bundle.text));
    expect(secrets).toHaveLength(2);
    const everywhere = JSON.stringify([
      output,
      (await adminClient.query('select * from setup_grant')).rows,
      (
        await adminClient.query('select * from audit_event where event_code in ($1, $2, $3)', [
          'staff.identity.created',
          'staff.identity.approved',
          'auth.setup_grant.issued',
        ])
      ).rows,
      (
        await adminClient.query(
          'select id, full_name, status, origin, created_by, approved_by from staff_identity',
        )
      ).rows,
    ]);
    for (const secret of secrets) expect(everywhere).not.toContain(secret);
    expect(output.join('\n')).not.toMatch(/melarc\.example|Kofi|Efua|Boateng|Addo/);
    expect(output.join('\n')).not.toContain(directory);
  });

  it('refuses to run again: the table is not empty, and the bundles of the pair are as they were', async () => {
    await seed();
    const before = bundlesOnDisk();
    const reason = await refusalReason(seed());
    expect(reason).toBe('STAFF_TABLE_NOT_EMPTY');
    expect(bundlesOnDisk()).toEqual(before);
    expect(Number(await scalar(adminClient, 'select count(*)::int from staff_identity'))).toBe(2);
  });

  it('refuses a table that holds one ordinary identity, and writes no bundle', async () => {
    await adminClient.query(
      `insert into staff_identity (id, work_email, work_email_canonical, full_name, status, role_bundle_id, created_by, approved_by, origin)
       values ($1, 'x@melarc.example', 'x@melarc.example', 'X', 'ACTIVE', $2, $3, $4, 'MAKER_CHECKER')`,
      [randomUUID(), BUNDLE_IDS.opsStaff, randomUUID(), randomUUID()],
    );
    expect(await refusalReason(seed())).toBe('STAFF_TABLE_NOT_EMPTY');
    // The folder is prepared before the table is asked, and nothing is written in it.
    expect(readdirSync(directory)).toEqual([]);
  });

  // Break caught: the pair written one identity at a time, or a refusal of the input that leaves a half pair. Each of these creates
  // no identity and leaves the table empty (AC-SLICE-000-118, "in a separate environment").
  it.each([
    ['one email', ['--custodian', FIRST]],
    [
      'three emails',
      [
        '--custodian',
        FIRST,
        '--custodian',
        SECOND,
        '--custodian',
        'Yaw Owusu <yaw@melarc.example>',
      ],
    ],
    ['the same email twice', ['--custodian', FIRST, '--custodian', FIRST]],
    [
      'one email in two spellings',
      ['--custodian', FIRST, '--custodian', 'Other <KOFI.BOATENG@Melarc.Example>'],
    ],
  ])('creates no identity for %s, and leaves the table empty and no file', async (_name, argv) => {
    await expect(seed({}, argv)).rejects.toBeInstanceOf(Error);
    expect(Number(await scalar(adminClient, 'select count(*)::int from staff_identity'))).toBe(0);
    expect(Number(await scalar(adminClient, 'select count(*)::int from setup_grant'))).toBe(0);
    expect(() => readdirSync(directory)).toThrow();
  });

  // Break caught: an interrupted run that leaves a pair with no bundle, a bundle with no pair, or half of either. A write that
  // fails in the middle of the database's work leaves nothing, and the function runs before any file is made.
  it('leaves nothing when the database fails in the middle of making the pair', async () => {
    const broken = await admin.breakWrites('audit_event');
    try {
      await expect(seed()).rejects.toThrow(/SQLSTATE P0001/);
    } finally {
      await broken.mend();
    }
    expect(Number(await scalar(adminClient, 'select count(*)::int from staff_identity'))).toBe(0);
    expect(Number(await scalar(adminClient, 'select count(*)::int from setup_grant'))).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
    // And the next run is not refused for what the failed one did.
    await seed();
    expect(Number(await scalar(adminClient, 'select count(*)::int from staff_identity'))).toBe(2);
  });

  // Break caught: the pair committed although a bundle could not be written: two administrators nobody can reach.
  it('leaves no pair and no bundle when the second bundle cannot be written', async () => {
    const disk = new FakeDisk();
    disk.failWriteNumber = 2;
    const store = new CustodyStore(disk, new FakeAccess(disk), randomBundleName);
    // The failure is the one rule that was broken, and the first bundle was written and then removed: a seed that failed before it wrote
    // any bundle (a bad fake, a missing reference row, a lock) leaves the same table and the same empty disk, and is not this case.
    await expect(seed({ store })).rejects.toMatchObject({ problem: 'WRITE_FAILED' });
    expect(Number(await scalar(adminClient, 'select count(*)::int from staff_identity'))).toBe(0);
    expect(Number(await scalar(adminClient, 'select count(*)::int from setup_grant'))).toBe(0);
    expect(disk.everWritten.filter((text) => text.startsWith(BUNDLE_MAGIC))).toHaveLength(1);
    expect(disk.files.size).toBe(0);
  });

  // Break caught: the orphan of a crashed run surviving into the next, or being taken for the bundle of a pair that did commit.
  it('sweeps the bundle of a run that crashed between its file and its commit, and leaves other files and the new bundles', async () => {
    const store = new CustodyStore(new NodeCustodyDisk(), privateAccessFor(), randomBundleName);
    await store.prepare(directory);
    // The crash: a bundle written (as the command writes one), and no pair, because the process was gone before the commit.
    const orphan = await store.write(directory, {
      target: targetOf(database.urlFor(PROVISIONING_ROLE)),
      purpose: 'BOOTSTRAP_SETUP',
      custodian: { fullName: 'Orphan', workEmail: 'orphan@melarc.example' },
      secret: 'sentinel-orphan-secret-0000000000000000000000',
      issuedAt: new Date(),
      expiresAt: null,
    });
    await writeFile(join(directory, 'notes.txt'), 'not a bundle');
    expect(Number(await scalar(adminClient, 'select count(*)::int from staff_identity'))).toBe(0);

    const output = await seed();

    const names = readdirSync(directory);
    expect(names).not.toContain(orphan.name);
    expect(names).toContain('notes.txt');
    expect(names.filter((name) => name.endsWith('.bundle'))).toHaveLength(2);
    expect(output.some((line) => line.includes('removed 1 bundle of an earlier run'))).toBe(true);
    // The orphan's secret redeems nothing: no grant holds its hash.
    expect(
      Number(
        await scalar(
          adminClient,
          "select count(*)::int from setup_grant where token_hash = decode($1, 'hex')",
          [hashOfSecret('sentinel-orphan-secret-0000000000000000000000')],
        ),
      ),
    ).toBe(0);
  });

  // Break caught: a sweep that takes every bundle in the folder for an orphan, so that the seed of one environment deletes the bundles of
  // another's pair that did commit: the only copies of secrets still to be handed over.
  it('leaves the bundle of another database in the same folder, and says it did', async () => {
    const store = new CustodyStore(new NodeCustodyDisk(), privateAccessFor(), randomBundleName);
    await store.prepare(directory);
    const foreign = await store.write(directory, {
      target: targetOf('postgres://provisioning@db.staging.example:5432/melarc'),
      purpose: 'BOOTSTRAP_SETUP',
      custodian: { fullName: 'Staging Custodian', workEmail: 'staging@melarc.example' },
      secret: 'sentinel-staging-secret-00000000000000000000000',
      issuedAt: new Date(),
      expiresAt: null,
    });

    const output = await seed();

    const names = readdirSync(directory);
    expect(names).toContain(foreign.name);
    expect(names.filter((name) => name.endsWith('.bundle'))).toHaveLength(3);
    expect(output.some((line) => line.includes('removed'))).toBe(false);
    expect(output.some((line) => line.includes('left 1 other bundle'))).toBe(true);
    expect(output.join('\n')).not.toContain('staging');
  });

  it('refuses a deployment whose reference data is not seeded, naming the cause, and writes no bundle', async () => {
    const bare = await createTestDatabase();
    const built = buildService(bare, { login: PROVISIONING_ROLE });
    try {
      const reason = await refusalReason(
        seed({
          open: () => ({
            database: new PostgresBootstrapDatabase(built.service),
            close: () => Promise.resolve(),
          }),
        }),
      );
      expect(reason).toBe('REFERENCE_DATA_MISSING');
      expect(() => readdirSync(directory)).not.toThrow();
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      await built.close();
      await bare.drop();
    }
  });

  // Break caught: a custody folder in the repository, which the source package is built from.
  it('refuses a custody folder inside the checkout before it touches the database', async () => {
    await expect(
      runBootstrapSeed(
        ['--custodian', FIRST, '--custodian', SECOND],
        { BOOTSTRAP_CUSTODY_DIRECTORY: join(process.cwd(), 'custody-inside-checkout') },
        () => undefined,
        dependencies(),
      ),
    ).rejects.toMatchObject({ problem: 'DIRECTORY_INSIDE_CHECKOUT' });
    expect(Number(await scalar(adminClient, 'select count(*)::int from staff_identity'))).toBe(0);
  });

  it('reaches the database as the provisioning login under the bootstrap capability, and as nothing else', async () => {
    await seed();
    const audit = (
      await adminClient.query<{
        actor_type: string;
        actor_id: string | null;
        surface_context: string;
      }>(
        "select distinct actor_type, actor_id, surface_context from audit_event where event_code = 'staff.identity.created'",
      )
    ).rows;
    expect(audit).toEqual([{ actor_type: 'SYSTEM', actor_id: null, surface_context: 'SYSTEM' }]);
  });
});

/** Each administrator's walk of §3.3 as the administrator, as far as the test needs it. */
async function seededPair() {
  await seed();
  const rows = (
    await adminClient.query<{ id: string; work_email_canonical: string }>(
      'select id, work_email_canonical from staff_identity order by work_email_canonical',
    )
  ).rows;
  const [efua, kofi] = rows;
  if (efua === undefined || kofi === undefined) throw new Error('two administrators');
  return { efua, kofi };
}

async function strand(identityId: string): Promise<{ factorId: string }> {
  const grantId = await scalar<string>(
    adminClient,
    "select id from setup_grant where principal_id = $1 and purpose = 'BOOTSTRAP_SETUP'",
    [identityId],
  );
  await setGrantState(adminClient, grantId, 'CONSUMED');
  await adminClient.query(
    `update staff_identity set credential_hash = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA', credential_established_at = clock_timestamp(), credential_generation = 1 where id = $1`,
    [identityId],
  );
  const factor = await insertFactor(
    adminClient,
    factorRow(identityId, { createdByPurpose: 'BOOTSTRAP_SETUP' }),
  );
  const issuedAt = new Date(Date.now() - 45 * 60_000);
  await insertGrant(
    adminClient,
    grantRow({
      principalId: identityId,
      purpose: 'MFA_ENROLMENT',
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 30 * 60_000),
    }),
  );
  return { factorId: factor.id };
}

async function resume(email: string, overrides: Partial<BootstrapDependencies> = {}) {
  const output: string[] = [];
  await runBootstrapResume(
    ['--custodian', email],
    ENV(),
    (line) => output.push(line),
    dependencies(overrides),
  );
  return output;
}

describe('the resume command, end to end (S0.30)', () => {
  it('gives a stranded administrator a fresh MFA_REENROLMENT in a bundle, and changes only what the section allows', async () => {
    const { kofi, efua } = await seededPair();
    const { factorId } = await strand(kofi.id);
    const before = bundlesOnDisk().map((bundle) => bundle.name);

    const output = await resume('KOFI.BOATENG@melarc.example');

    const fresh = bundlesOnDisk().filter((bundle) => !before.includes(bundle.name));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.text).toContain('purpose: MFA_REENROLMENT');
    expect(fresh[0]?.text).toContain('<kofi.boateng@melarc.example>');
    const stored = await scalar<string>(
      adminClient,
      "select encode(token_hash, 'hex') from setup_grant where principal_id = $1 and purpose = 'MFA_REENROLMENT' and state = 'PENDING'",
      [kofi.id],
    );
    expect(hashOfSecret(secretOf(fresh[0]?.text ?? ''))).toBe(stored);
    expect(
      await scalar(adminClient, 'select status from mfa_factor where id = $1', [factorId]),
    ).toBe('REVOKED');
    // The other administrator is untouched, no session is granted, no factor is active, the password is as it was.
    expect(
      await scalar(
        adminClient,
        "select state from setup_grant where principal_id = $1 and purpose = 'BOOTSTRAP_SETUP'",
        [efua.id],
      ),
    ).toBe('PENDING');
    expect(Number(await scalar(adminClient, 'select count(*)::int from session'))).toBe(0);
    expect(
      Number(
        await scalar(adminClient, "select count(*)::int from mfa_factor where status = 'ACTIVE'"),
      ),
    ).toBe(0);
    expect(output.join('\n')).toMatch(/path REENROLMENT/);
    expect(output.join('\n')).not.toContain(secretOf(fresh[0]?.text ?? ''));
    expect(await privateAccessFor().inspect(join(directory, fresh[0]?.name ?? ''))).toBe('PRIVATE');
  });

  // Break caught: the command left working once it is no longer needed (AC-SLICE-000-93, AC-SLICE-000-120): a recovery mechanism
  // that outlives its emergency is an attack surface.
  it('refuses the identity the moment it holds an ACTIVE factor, and writes no bundle', async () => {
    const { kofi } = await seededPair();
    const { factorId } = await strand(kofi.id);
    await activateFactor(adminClient, factorId);
    const before = bundlesOnDisk().map((bundle) => bundle.name);
    expect(await refusalReason(resume('kofi.boateng@melarc.example'))).toBe('ACTIVE_FACTOR');
    expect(bundlesOnDisk().map((bundle) => bundle.name)).toEqual(before);
  });

  it('refuses, by its own rule, the second run while the first grant is still live', async () => {
    const { kofi } = await seededPair();
    await strand(kofi.id);
    await resume('kofi.boateng@melarc.example');
    expect(await refusalReason(resume('kofi.boateng@melarc.example'))).toBe('LIVE_GRANT');
  });

  it('supersedes a lost bundle: the new secret redeems, the old one no longer can', async () => {
    const { kofi } = await seededPair();
    const before = bundlesOnDisk();
    const oldHash = await scalar<string>(
      adminClient,
      "select encode(token_hash, 'hex') from setup_grant where principal_id = $1",
      [kofi.id],
    );

    await resume('kofi.boateng@melarc.example');

    const grants = (
      await adminClient.query<{ state: string; hash: string }>(
        "select state, encode(token_hash, 'hex') as hash from setup_grant where principal_id = $1 order by issued_at",
        [kofi.id],
      )
    ).rows;
    expect(grants.map((grant) => grant.state)).toEqual(['SUPERSEDED', 'PENDING']);
    expect(grants[0]?.hash).toBe(oldHash);
    const fresh = bundlesOnDisk().filter(
      (bundle) => !before.some((old) => old.name === bundle.name),
    );
    expect(hashOfSecret(secretOf(fresh[0]?.text ?? ''))).toBe(grants[1]?.hash);
    // The old bundle's secret hashes to a superseded grant: it redeems nothing.
    const oldBundle = before.find((bundle) =>
      bundle.text.includes('<kofi.boateng@melarc.example>'),
    );
    expect(hashOfSecret(secretOf(oldBundle?.text ?? ''))).toBe(oldHash);
  });

  it.each([
    ['an identity that is not a bootstrap identity', 'NOT_BOOTSTRAP_IDENTITY'],
    ['an address no identity has', 'NO_SUCH_IDENTITY'],
  ] as const)('refuses %s', async (what, reason) => {
    await seededPair();
    const ordinary = randomUUID();
    await adminClient.query(
      `insert into staff_identity (id, work_email, work_email_canonical, full_name, status, role_bundle_id, created_by, approved_by, origin)
       values ($1, 'ordinary@melarc.example', 'ordinary@melarc.example', 'Ordinary', 'ACTIVE', $2, $3, $4, 'MAKER_CHECKER')`,
      [ordinary, BUNDLE_IDS.opsStaff, randomUUID(), randomUUID()],
    );
    const email =
      reason === 'NOT_BOOTSTRAP_IDENTITY' ? 'ordinary@melarc.example' : 'nobody@melarc.example';
    expect(await refusalReason(resume(email)), what).toBe(reason);
  });

  // Break caught: a bundle for a change that was rolled back, or a change whose bundle could not be written.
  it('rolls the change back when the bundle cannot be written, leaving the identity as it was', async () => {
    const { kofi } = await seededPair();
    const { factorId } = await strand(kofi.id);
    const disk = new FakeDisk();
    disk.failWrite = true;
    await expect(
      resume('kofi.boateng@melarc.example', {
        store: new CustodyStore(disk, new FakeAccess(disk), randomBundleName),
      }),
    ).rejects.toMatchObject({ problem: 'WRITE_FAILED' });
    expect(
      await scalar(adminClient, 'select status from mfa_factor where id = $1', [factorId]),
    ).toBe('PENDING');
    expect(
      Number(
        await scalar(
          adminClient,
          "select count(*)::int from setup_grant where purpose = 'MFA_REENROLMENT'",
        ),
      ),
    ).toBe(0);
  });
});
