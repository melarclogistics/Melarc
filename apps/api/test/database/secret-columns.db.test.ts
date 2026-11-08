import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
} from './support/credentials.js';
import {
  insertSessionRow,
  insertStaff,
  sessionRow,
  staffRow,
  type SessionRow,
  type StaffRow,
} from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * F01 of the audit of 23 October 2026 (migration 0031): the columns of `session` and `mfa_factor` that hold a credential (a session's token
 * hash and synchronizer-token hash, the authority snapshot and the client signal; a factor's sealed seed) are not selectable by the API's
 * login **in any context**, so that a policy that admits rows to an administrator cannot also hand that administrator a credential. The
 * code that legitimately reads them is the authentication capability, through two `SECURITY DEFINER` readers. Everything here runs as the
 * real runtime login (`melarc_api_runtime`) through `DatabaseService`, in the contexts the application opens, and what is asserted is the
 * database's answer: a privilege error is not a row.
 *
 * What this does **not** prove, and the migration says so: the readers decide by two transaction settings that the runtime login can set,
 * so a login that runs arbitrary SQL can assert the authentication capability. The last test shows exactly that, so the documentation of
 * the boundary is something a reader can check.
 */
const HUB_A = HUBS[0]?.id ?? '';
const REVOKE = 'staff.session.revoke';
const READ = 'staff.read';
const RESET = 'staff.mfa.reset';
const APPROVE = 'staff.identity.approve';
const CREATE_KEY = 'staff.identity.create';

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;

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

interface Scope {
  readonly mode: 'SET' | 'ALL';
  readonly hubs?: readonly string[];
}
const ALL: Scope = { mode: 'ALL' };
const OWN_A: Scope = { mode: 'SET', hubs: [HUB_A] };

const acting = (key: string | null, scope: Scope = ALL): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  surface: 'OPS_PORTAL',
  correlationId: 'secret-columns-test',
  hubScopeMode: scope.mode,
  authorizedHubIds: scope.hubs ?? [],
  ...(key === null ? {} : { authorizationKey: key }),
});
const system = (capability: 'authentication' | 'rate_limit'): SecurityContext => ({
  principalType: 'SYSTEM',
  principalId: randomUUID(),
  surface: 'SYSTEM',
  correlationId: 'secret-columns-test',
  taskCapability: capability,
});
const vendor = (): SecurityContext => {
  const principalId = randomUUID();
  return {
    principalType: 'VENDOR',
    principalId,
    surface: 'VENDOR_PWA',
    correlationId: 'secret-columns-test',
    vendorOrganizationId: randomUUID(),
  };
};
const rider = (): SecurityContext => {
  const principalId = randomUUID();
  return {
    principalType: 'RIDER',
    principalId,
    surface: 'RIDER_ANDROID',
    correlationId: 'secret-columns-test',
    riderId: principalId,
  };
};

/** Every context but the authentication capability's: the administrators of the three keys of S0.36 and S0.37, a read, and the rest. */
const NOT_AUTHENTICATION: readonly (readonly [string, () => SecurityContext])[] = [
  ['staff.session.revoke, every hub', () => acting(REVOKE)],
  ['staff.session.revoke, one hub', () => acting(REVOKE, OWN_A)],
  ['staff.read, every hub', () => acting(READ)],
  ['staff.read, one hub', () => acting(READ, OWN_A)],
  ['staff.mfa.reset, every hub', () => acting(RESET)],
  ['staff.identity.approve', () => acting(APPROVE)],
  ['a staff key that reads no session', () => acting(CREATE_KEY)],
  ['staff with no key', () => acting(null)],
  ['a vendor', vendor],
  ['a rider', rider],
  ['the rate-limit capability', () => system('rate_limit')],
];
/** And the authentication capability itself, which reads no secret column either: it asks the readers. */
const EVERY_CONTEXT: readonly (readonly [string, () => SecurityContext])[] = [
  ...NOT_AUTHENTICATION,
  ['the authentication capability', () => system('authentication')],
];

type Tx = Parameters<Parameters<BuiltService['service']['transactionWithContext']>[1]>[0];

async function run<T>(context: SecurityContext, work: (tx: Tx) => Promise<T>): Promise<T> {
  return built.service.transactionWithContext(context, work);
}

async function codeOf(
  context: SecurityContext,
  work: (tx: Tx) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run(context, work);
    return undefined;
  } catch (error) {
    const failure = serverErrorIn(error);
    if (failure?.code === undefined) throw error;
    return failure.code;
  }
}

const staff = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const liveSession = (overrides: Partial<SessionRow> = {}): Promise<SessionRow> =>
  insertSessionRow(admin, sessionRow({ authorizedHubIds: [HUB_A], ...overrides }));
const hex = (value: Buffer): string => value.toString('hex');

describe('the columns the runtime login may not select', () => {
  // Break caught: a grant widened back to the whole table, or a credential column left on the list.
  it('are exactly the credential columns of a session and of a second factor, and no privilege is held at table level', async () => {
    const refused = async (table: string): Promise<string[]> =>
      (
        await admin.query<{ column: string }>(
          `select a.attname as column
             from pg_attribute a join pg_class c on c.oid = a.attrelid
            where c.relname = $1 and c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
              and not has_column_privilege('melarc_api_runtime', c.oid, a.attnum, 'SELECT')
            order by 1`,
          [table],
        )
      ).rows.map((row) => row.column);

    expect(await refused('session')).toEqual([
      'bundle_snapshot',
      'client_root_signal',
      'csrf_token_hash',
      'token_hash',
    ]);
    expect(await refused('mfa_factor')).toEqual([
      'secret_ciphertext',
      'secret_envelope_version',
      'secret_key_version',
      'secret_nonce',
    ]);
    const table = await admin.query<{ session: boolean; factor: boolean }>(
      `select has_table_privilege('melarc_api_runtime', 'public.session', 'SELECT') as session,
              has_table_privilege('melarc_api_runtime', 'public.mfa_factor', 'SELECT') as factor`,
    );
    expect(table.rows[0]).toEqual({ session: false, factor: false });
  });

  // Break caught: the worker or the provisioning login gaining a way to the tables the correction narrowed for the API, or PUBLIC doing so.
  it('are reachable by no other login: the worker, the provisioning login and PUBLIC hold no privilege on either table', async () => {
    for (const role of ['melarc_worker_runtime', 'melarc_provisioning', 'public']) {
      for (const table of ['public.session', 'public.mfa_factor']) {
        const held = await admin.query<{ any: boolean }>(
          `select has_any_column_privilege($1, $2, 'SELECT,INSERT,UPDATE,REFERENCES') as any`,
          [role, table],
        );
        expect(held.rows[0], `${role} on ${table}`).toEqual({ any: false });
      }
    }
  });

  // Break caught: the generated fact writable, so that the idle tier of a session could be set by whoever may insert or update it.
  it('give the idle tier as a generated column of the snapshot, which nobody writes', async () => {
    const privileged = await liveSession({
      snapshot: {
        format: 1,
        name: 'Platform Admin',
        audience: 'STAFF',
        privileged: true,
        grants: [],
      },
    });
    const ordinary = await liveSession();

    const read = await admin.query<{ id: string; privileged: boolean }>(
      `select id, privileged from session where id = any($1::uuid[])`,
      [[privileged.id, ordinary.id]],
    );
    expect(new Map(read.rows.map((row) => [row.id, row.privileged]))).toEqual(
      new Map([
        [privileged.id, true],
        [ordinary.id, false],
      ]),
    );
    for (const statement of [
      `update session set privileged = true where id = '${ordinary.id}'`,
      `update session set privileged = false where id = '${privileged.id}'`,
    ]) {
      await expect(admin.query(statement)).rejects.toMatchObject({ code: '428C9' });
    }
  });
});

describe('a statement that reads a secret column of a session', () => {
  let target: SessionRow;
  beforeAll(async () => {
    target = await liveSession();
  });

  const STATEMENTS: readonly (readonly [string, () => string])[] = [
    ['the token hash', () => 'select token_hash from session'],
    ['every column', () => 'select * from session'],
    ['the synchronizer-token hash', () => 'select csrf_token_hash from session'],
    ['the authority snapshot', () => 'select bundle_snapshot from session'],
    ['the client signal', () => 'select client_root_signal from session'],
    ['a value computed from the token hash', () => 'select length(token_hash) from session'],
    [
      'a row found by its token hash',
      () => `select id from session where token_hash = decode('${hex(target.tokenHash)}', 'hex')`,
    ],
    [
      'a join on the token hash',
      () => 'select a.id from session a join session b on a.token_hash = b.token_hash',
    ],
  ];

  // Break caught: the grant by column left whole in one context, or a policy that is read around: the refusal is the database's, in every one.
  it.each(EVERY_CONTEXT)('is refused with a privilege error as %s', async (_label, context) => {
    for (const [what, statement] of STATEMENTS) {
      expect(await codeOf(context(), (tx) => tx.execute(sql.raw(statement()))), what).toBe('42501');
    }
  });

  // Break caught: a write that finds its row by a credential, or returns one, passing because it "only" updates.
  it('is refused when an update finds its row by the token hash, or an insert or an update returns it', async () => {
    for (const context of [acting(REVOKE), system('authentication')]) {
      expect(
        await codeOf(context, (tx) =>
          tx.execute(
            sql.raw(
              `update session set last_activity_at = clock_timestamp() where token_hash = decode('${hex(target.tokenHash)}', 'hex')`,
            ),
          ),
        ),
      ).toBe('42501');
      expect(
        await codeOf(context, (tx) =>
          tx.execute(
            sql.raw(
              `update session set last_activity_at = clock_timestamp() where id = '${target.id}' returning token_hash`,
            ),
          ),
        ),
      ).toBe('42501');
    }
  });

  // Break caught: the columns an administration list needs removed with the secret ones, which would end the revoke screen.
  it('leaves the columns an administration list needs readable: the hubs, the times and the privilege of the bundle', async () => {
    const privileged = await liveSession({
      snapshot: {
        format: 1,
        name: 'Platform Admin',
        audience: 'STAFF',
        privileged: true,
        grants: [],
      },
    });

    for (const key of [REVOKE, READ]) {
      const result = await run(acting(key), (tx) =>
        tx.execute(
          sql`select id, principal_type, principal_id, bundle_id, authorized_hub_ids, privileged, issued_at, expires_at,
                     last_activity_at, terminated_at, termination_reason
                from session where id = any(${`{${target.id},${privileged.id}}`}::uuid[])`,
        ),
      );
      const rows = result.rows as {
        id: string;
        privileged: boolean;
        authorized_hub_ids: string[];
      }[];
      expect(new Map(rows.map((row) => [row.id, row.privileged]))).toEqual(
        new Map([
          [target.id, false],
          [privileged.id, true],
        ]),
      );
      expect(rows[0]?.authorized_hub_ids).toEqual([HUB_A]);
    }
  });
});

describe('a statement that reads a secret column of a second factor', () => {
  let owner: StaffRow;
  let pending: Awaited<ReturnType<typeof insertFactor>>;

  beforeAll(async () => {
    owner = await staff();
    pending = await insertFactor(admin, factorRow(owner.id));
  });

  const STATEMENTS = [
    ['the sealed seed', 'select secret_ciphertext from mfa_factor'],
    ['every column', 'select * from mfa_factor'],
    ['the nonce', 'select secret_nonce from mfa_factor'],
    ['the key version', 'select secret_key_version from mfa_factor'],
    ['the envelope version', 'select secret_envelope_version from mfa_factor'],
    ['a value computed from the seed', 'select length(secret_ciphertext) from mfa_factor'],
    ['a row found by its seed', 'select id from mfa_factor where secret_nonce is not null'],
  ] as const;

  // Break caught: as for the session; here the secret is the second factor's seed itself.
  it.each(EVERY_CONTEXT)('is refused with a privilege error as %s', async (_label, context) => {
    for (const [what, statement] of STATEMENTS) {
      expect(await codeOf(context(), (tx) => tx.execute(sql.raw(statement))), what).toBe('42501');
    }
  });

  // Break caught: the columns the reset and the sign-in read removed with the secret ones.
  it('leaves the status, the episode and the counter readable to the contexts that need them', async () => {
    await activateFactor(admin, pending.id);

    const result = await run(system('authentication'), (tx) =>
      tx.execute(
        sql`select id, staff_identity_id, ordinal, factor_type, status, enrolled_at, revoked_at, last_verified_counter,
                   created_by_purpose, revoked_by, revocation_reason_code, created_episode_id, revocation_episode_id
              from mfa_factor where staff_identity_id = ${owner.id}`,
      ),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: pending.id, status: 'ACTIVE' });
  });
});

describe('the reader of a session by the hash of its token', () => {
  // Break caught: the reader returning nothing to the authentication capability, or the token hash itself back to the caller.
  it('answers the authentication capability with the session and its synchronizer-token hash, and never the token hash', async () => {
    const stored = await liveSession({ authorizedHubIds: [HUB_A] });

    const result = await run(system('authentication'), (tx) =>
      tx.execute(
        sql.raw(
          `select * from melarc.session_by_token_hash(decode('${hex(stored.tokenHash)}', 'hex'))`,
        ),
      ),
    );

    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    if (row === undefined) throw new Error('the reader answered no row');
    expect(row).toMatchObject({
      id: stored.id,
      principal_type: 'STAFF',
      principal_id: stored.principalId,
      authorized_hub_ids: [HUB_A],
      bundle_revision: 1,
    });
    expect(Buffer.from(row.csrf_token_hash as Buffer)).toEqual(stored.csrfTokenHash);
    expect(Object.keys(row)).not.toContain('token_hash');
    expect(row.bundle_snapshot).toMatchObject({ audience: 'STAFF' });
  });

  // Break caught: a lookup that guesses, or a session ended read as absent (the authenticator judges an ended session; it needs the row).
  it('answers no row for a hash that names nothing, a hash of another length and a null, and the row of an ended session', async () => {
    const ended = await liveSession({
      terminatedAt: new Date(Date.now() - 30_000),
      terminationReason: 'SIGNED_OUT',
    });
    const lookup = (value: string) =>
      run(
        system('authentication'),
        async (tx) =>
          (
            await tx.execute(
              sql.raw(`select id, terminated_at from melarc.session_by_token_hash(${value})`),
            )
          ).rows,
      );

    expect(await lookup(`decode('${'ab'.repeat(32)}', 'hex')`)).toEqual([]);
    expect(await lookup(`decode('${'ab'.repeat(31)}', 'hex')`)).toEqual([]);
    expect(await lookup(`decode('${'ab'.repeat(33)}', 'hex')`)).toEqual([]);
    expect(await lookup(`null::bytea`)).toEqual([]);
    const found = await lookup(`decode('${hex(ended.tokenHash)}', 'hex')`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: ended.id });
    expect((found[0] as { terminated_at: unknown }).terminated_at).not.toBeNull();
  });

  // Break caught: the capability test dropped or widened, so that an administrator's context reads any session's credentials by name.
  it.each(NOT_AUTHENTICATION)('refuses %s', async (_label, context) => {
    const stored = await liveSession();

    expect(
      await codeOf(context(), (tx) =>
        tx.execute(
          sql.raw(
            `select * from melarc.session_by_token_hash(decode('${hex(stored.tokenHash)}', 'hex'))`,
          ),
        ),
      ),
    ).toBe('42501');
  });
});

describe('the reader of the sealed seed of a second factor', () => {
  // Break caught: the reader returning a different column set, or none: the verification opens the seed from exactly these five.
  it('answers the authentication capability with the five columns that seal the seed of a pending and of an active factor', async () => {
    const owner = await staff();
    const row = factorRow(owner.id);
    const pending = await insertFactor(admin, row);
    const read = (id: string) =>
      run(
        system('authentication'),
        async (tx) =>
          (await tx.execute(sql`select * from melarc.mfa_factor_sealed_seed(${id}::uuid)`)).rows,
      );

    const whilePending = await read(pending.id);
    expect(whilePending).toHaveLength(1);
    expect(Object.keys(whilePending[0] as object).toSorted()).toEqual([
      'secret_ciphertext',
      'secret_envelope_version',
      'secret_key_version',
      'secret_nonce',
      'staff_identity_id',
    ]);
    expect(whilePending[0]).toMatchObject({
      staff_identity_id: owner.id,
      secret_key_version: row.secretKeyVersion,
      secret_envelope_version: row.secretEnvelopeVersion,
    });
    expect(
      Buffer.from((whilePending[0] as { secret_ciphertext: Buffer }).secret_ciphertext),
    ).toEqual(row.secretCiphertext);
    await activateFactor(admin, pending.id);
    expect(await read(pending.id)).toHaveLength(1);
  });

  // Break caught: a revoked factor's seed still readable, or a guess at an id answered.
  it('answers no row for a revoked factor or an id that names nothing', async () => {
    const owner = await staff();
    const revoker = await staff();
    const factor = await insertFactor(admin, factorRow(owner.id));
    const episode = randomUUID();
    await insertGrant(
      admin,
      grantRow({
        principalId: owner.id,
        purpose: 'MFA_REENROLMENT',
        episodeId: episode,
        issuedBy: revoker.id,
      }),
    );
    await admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = now(), revoked_by = $2, revocation_reason_code = 'MFA_AUTHENTICATOR_UNAVAILABLE', revocation_episode_id = $3 where id = $1`,
      [factor.id, revoker.id, episode],
    );
    const read = (id: string) =>
      run(
        system('authentication'),
        async (tx) =>
          (await tx.execute(sql`select * from melarc.mfa_factor_sealed_seed(${id}::uuid)`)).rows,
      );

    expect(await read(factor.id)).toEqual([]);
    expect(await read(randomUUID())).toEqual([]);
  });

  // Break caught: the capability test dropped or widened.
  it.each(NOT_AUTHENTICATION)('refuses %s', async (_label, context) => {
    const owner = await staff();
    const factor = await insertFactor(admin, factorRow(owner.id));

    expect(
      await codeOf(context(), (tx) =>
        tx.execute(sql`select * from melarc.mfa_factor_sealed_seed(${factor.id}::uuid)`),
      ),
    ).toBe('42501');
  });
});

describe('the two readers as the catalogue holds them', () => {
  // Break caught: a reader open to a login that should not run it (EXECUTE left to PUBLIC), owned by a role with more reach, or without a fixed
  // search path (a definer function whose lookups an attacker's schema can shadow).
  it('are definer functions of the owner role with a fixed search path, executable by the API runtime alone', async () => {
    const result = await admin.query<{
      name: string;
      owner: string;
      definer: boolean;
      volatility: string;
      search_path: string | null;
      public_execute: boolean;
      runtime_execute: boolean;
      worker_execute: boolean;
      provisioning_execute: boolean;
    }>(
      `select p.oid::regprocedure::text as name, pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer, p.provolatile as volatility,
              (select option_value from pg_options_to_table(p.proconfig) where option_name = 'search_path') as search_path,
              has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
              has_function_privilege('melarc_api_runtime', p.oid, 'EXECUTE') as runtime_execute,
              has_function_privilege('melarc_worker_runtime', p.oid, 'EXECUTE') as worker_execute,
              has_function_privilege('melarc_provisioning', p.oid, 'EXECUTE') as provisioning_execute
         from pg_proc p
        where p.oid in ('melarc.session_by_token_hash(bytea)'::regprocedure, 'melarc.mfa_factor_sealed_seed(uuid)'::regprocedure)
        order by 1`,
    );

    expect(result.rows).toEqual([
      {
        name: 'melarc.mfa_factor_sealed_seed(uuid)',
        owner: 'melarc_owner',
        definer: true,
        volatility: 's',
        search_path: 'pg_catalog, pg_temp',
        public_execute: false,
        runtime_execute: true,
        worker_execute: false,
        provisioning_execute: false,
      },
      {
        name: 'melarc.session_by_token_hash(bytea)',
        owner: 'melarc_owner',
        definer: true,
        volatility: 's',
        search_path: 'pg_catalog, pg_temp',
        public_execute: false,
        runtime_execute: true,
        worker_execute: false,
        provisioning_execute: false,
      },
    ]);
  });
});

describe('the boundary these tests do not claim to close', () => {
  // THE DOCUMENTED RESIDUAL RISK (migration 0031, SECURITY_DESIGN.md section 14, plan 7.36). The readers decide by two transaction settings,
  // and the runtime login sets them itself to open every transaction; a login that runs arbitrary SQL can therefore assert the
  // authentication capability and call a reader. The correction narrows what a statement can read under the context the runtime holds
  // (an administration query, or a policy that is wider than intended, run in another context); it does not stop arbitrary SQL: an
  // injection that can run statements of its own can assert the context as this test does, and so can a compromised runtime.
  // If this test starts to fail, the boundary has improved: update the migration's header, SECURITY_DESIGN.md and the plan, then delete it.
  it('lets a runtime login that asserts the authentication context itself call a reader: a context setting is not a proof of who is asking', async () => {
    const stored = await liveSession();
    const runtime = clientFor(database.urlFor('melarc_api_runtime'));
    await runtime.connect();
    try {
      await runtime.query('begin');
      await runtime.query(`select set_config('melarc.principal_type', 'SYSTEM', true)`);
      await runtime.query(`select set_config('melarc.task_capability', 'authentication', true)`);
      const result = await runtime.query(
        `select id from melarc.session_by_token_hash(decode($1, 'hex'))`,
        [hex(stored.tokenHash)],
      );
      await runtime.query('rollback');

      expect(result.rows).toEqual([{ id: stored.id }]);
    } finally {
      await runtime.end();
    }
  });
});
