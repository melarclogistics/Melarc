import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { OWNER_ROLE } from '../../src/tools/database/provisioning.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE, UnsafeTargetError } from '../../src/tools/database/safety.js';
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

const COMMITTED = readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith('.sql')).length;
const ACCESSORS = [
  'principal_type',
  'hub_scope_mode',
  'authorized_hub_ids',
  'current_vendor_organization_id',
  'current_rider_id',
];

/** What the migrations declare, as one comparable value: if a repeat changed anything, this changes. */
const FINGERPRINT = `
  select md5(coalesce(string_agg(pg_get_functiondef(p.oid) || coalesce(p.proacl::text, '') || p.proowner::text,
                                 ';' order by p.proname), ''))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'melarc'`;

const journalRows = (database: TestDatabase) =>
  withClient(database.urlFor('postgres'), async (client) =>
    Number(await scalar<string>(client, 'select count(*) from drizzle.__drizzle_migrations')),
  );

describe('migrating an empty database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await database.drop();
  });

  // Break caught: a migration history that does not apply to a database that has nothing in it, which is
  // how every new environment and every test database starts.
  it('applies every committed migration and creates what they declare', async () => {
    await withClient(database.urlFor('postgres'), async (client) => {
      expect(await scalar(client, "select to_regnamespace('melarc') is null")).toBe(true);
      expect(
        await scalar(client, "select to_regclass('drizzle.__drizzle_migrations') is null"),
      ).toBe(true);
    });

    const result = await database.migrate();

    expect(COMMITTED).toBeGreaterThan(0);
    expect(result.applied).toBe(COMMITTED);
    expect(await journalRows(database)).toBe(COMMITTED);
    await withClient(database.urlFor('postgres'), async (client) => {
      const functions = await client.query<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'melarc' order by p.proname`,
      );
      expect(functions.rows.map((row) => row.proname)).toEqual([...ACCESSORS].sort());
    });
  });

  // Break caught: an object left owned by whoever ran the migration, or by a role that can log in. Owner,
  // not creator, decides who can switch off row-level security on a table (GBT-J3, K2 and K3).
  it('leaves everything it created in the melarc schema owned by the NOLOGIN owner role', async () => {
    await withClient(database.urlFor('postgres'), async (client) => {
      const { rows } = await client.query<{ kind: string; name: string; owner: string }>(
        `select 'schema' as kind, n.nspname as name, pg_get_userbyid(n.nspowner) as owner
           from pg_namespace n where n.nspname = 'melarc'
         union all
         select 'function', p.proname, pg_get_userbyid(p.proowner)
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'melarc'
         union all
         select 'relation', c.relname, pg_get_userbyid(c.relowner)
           from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'melarc'`,
      );
      expect(rows.length).toBe(1 + ACCESSORS.length);
      expect(new Set(rows.map((row) => row.owner))).toEqual(new Set([OWNER_ROLE]));
      expect(
        await scalar(client, 'select rolcanlogin from pg_roles where rolname = $1', [OWNER_ROLE]),
      ).toBe(false);
    });
  });

  // Break caught: the accessors executable by everyone, or by nobody. Row-level-security policies call
  // them as whoever is querying, so the runtime role needs them; no other role is named.
  it('lets the runtime role use the accessors and nothing else in the schema, and PUBLIC nothing', async () => {
    await withClient(database.urlFor('postgres'), async (client) => {
      expect(
        await scalar(client, `select has_schema_privilege($1, 'melarc', 'USAGE')`, [
          API_RUNTIME_ROLE,
        ]),
      ).toBe(true);
      expect(
        await scalar(client, `select has_schema_privilege($1, 'melarc', 'CREATE')`, [
          API_RUNTIME_ROLE,
        ]),
      ).toBe(false);
      for (const accessor of ACCESSORS) {
        expect(
          await scalar(
            client,
            `select has_function_privilege($1, 'melarc.${accessor}()', 'EXECUTE')`,
            [API_RUNTIME_ROLE],
          ),
        ).toBe(true);
      }
      const publicGrants = await scalar<string>(
        client,
        `select count(*) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(p.proacl) a
          where n.nspname = 'melarc' and a.grantee = 0`,
      );
      expect(Number(publicGrants)).toBe(0);
      expect(
        await scalar(
          client,
          `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname = 'melarc' and p.proacl is null`,
        ),
      ).toBe('0');
    });
  });

  // Break caught: a repeat that fails, re-applies something, or quietly changes what was declared.
  it('is safe to repeat: nothing is applied, nothing is journaled, nothing changes', async () => {
    const before = await withClient(database.urlFor('postgres'), (client) =>
      scalar(client, FINGERPRINT),
    );

    for (const run of [1, 2, 3]) {
      const result = await database.migrate();
      expect(result.applied, `repeat ${String(run)}`).toBe(0);
    }

    expect(await journalRows(database)).toBe(COMMITTED);
    const after = await withClient(database.urlFor('postgres'), (client) =>
      scalar(client, FINGERPRINT),
    );
    expect(after).toBe(before);
  });
});

describe('migrating at the same time', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await database.drop();
  });

  // Break caught: two deployments or two test workers migrating one database together, each seeing an empty
  // journal and each applying everything: a duplicate-object failure at best, a half-applied history at worst.
  it('serialises the runs: one applies everything, the others find nothing to do', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => database.migrate()));

    const applied = results.map((result) => result.applied);
    expect(applied.reduce((sum, count) => sum + count, 0)).toBe(COMMITTED);
    expect(applied.filter((count) => count === 0)).toHaveLength(3);
    expect(await journalRows(database)).toBe(COMMITTED);
  });
});

describe('who may migrate', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await database.drop();
  });

  // Break caught: a migration run as the runtime role, the owner or the administrator. It is refused
  // before connecting, and nothing is created.
  it.each([API_RUNTIME_ROLE, 'postgres'] as const)(
    'refuses %s and creates nothing',
    async (login) => {
      await expect(runMigrations({ url: database.urlFor(login) })).rejects.toThrow(
        UnsafeTargetError,
      );

      await withClient(database.urlFor('postgres'), async (client) => {
        expect(await scalar(client, "select to_regnamespace('melarc') is null")).toBe(true);
        expect(await scalar(client, "select to_regnamespace('drizzle') is null")).toBe(true);
      });
    },
  );

  // Break caught: a wrong migration password not being refused by the server, which would mean the
  // identity is not authenticated at all.
  it('refuses a wrong migration password with the server error for it', async () => {
    const wrong = database
      .urlFor(MIGRATION_ROLE)
      .replace(database.settings.migrationPassword, 'not-it');
    await expect(runMigrations({ url: wrong })).rejects.toMatchObject({ code: '28P01' });
  });
});

describe('a migration that fails', () => {
  let database: TestDatabase;
  let folder: string;

  beforeAll(async () => {
    database = await createTestDatabase({ migrate: false });
    folder = mkdtempSync(join(tmpdir(), 'melarc-broken-migrations-'));
    mkdirSync(join(folder, 'meta'));
    const entries = ['0000_good', '0001_bad'].map((tag, idx) => ({
      idx,
      version: '7',
      when: 1_700_000_000_000 + idx,
      tag,
      breakpoints: true,
    }));
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries }),
    );
    writeFileSync(join(folder, '0000_good.sql'), 'CREATE TABLE public.migrated_ok (id integer);');
    writeFileSync(
      join(folder, '0001_bad.sql'),
      'CREATE TABLE public.migrated_too (id integer);\n--> statement-breakpoint\nSELECT 1 / 0;',
    );
  });
  afterAll(async () => {
    rmSync(folder, { recursive: true, force: true });
    await database.drop();
  });

  // Break caught: a failure that leaves part of the history applied, so the next run starts from a state
  // that is neither the old one nor the new one; or one that leaves the lock held.
  it('rolls everything back, journals nothing, and leaves the database migratable', async () => {
    const failure = await runMigrations({ url: database.urlFor(MIGRATION_ROLE), folder }).catch(
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);

    await withClient(database.urlFor('postgres'), async (client) => {
      expect(await scalar(client, "select to_regclass('public.migrated_ok') is null")).toBe(true);
      expect(await scalar(client, "select to_regclass('public.migrated_too') is null")).toBe(true);
      expect(await scalar(client, 'select count(*) from drizzle.__drizzle_migrations')).toBe('0');
      const locks = await scalar<string>(
        client,
        `select count(*) from pg_locks where locktype = 'advisory' and granted
                and database = (select oid from pg_database where datname = current_database())`,
      );
      expect(Number(locks)).toBe(0);
    });

    const recovered = await runMigrations({ url: database.urlFor(MIGRATION_ROLE) });
    expect(recovered.applied).toBe(COMMITTED);
  });
});
