import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  APPROVED_DEFINER_EXECUTE,
  ROLE_POSTURE_SQL,
  rolePostureParameters,
  unsafeFlags,
} from '../../src/platform/database/role-posture.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { catalogViolations } from '../../src/tools/database/catalog-invariants.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { referenceSeedPlan } from '../../src/tools/seed/reference-seed.js';
import { REASON_FIXTURES, fixturePlan } from '../../src/tools/fixtures/fixtures.js';
import { openAdmin } from './support/admin.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * Initial seeding enforced by the database (correction F02 of Stage 1; migration 0005). The provisioning login holds no privilege on
 * the seven reference tables; `melarc.initialize_reference_data` is the only way in, and it fills the tables once, in one statement,
 * serialized against any other initialization, and refuses unless all seven are empty. These tests call the functions as raw SQL,
 * with no seed helper and no policy lock in front, so that what they show is the database's and not the application's.
 */

const TABLES = [
  'hub',
  'permission',
  'role_bundle',
  'role_bundle_grant',
  'fixed_permission_policy',
  'setting',
  'reason_code',
] as const;

const INITIALIZE = 'select melarc.initialize_reference_data($1::jsonb) as report';
const FIXTURES = 'select melarc.add_reason_fixtures($1::jsonb) as report';

const PLAN = referenceSeedPlan();
const DOCUMENT = JSON.stringify(PLAN.payload);
const PLANNED = Object.fromEntries(
  Object.entries(PLAN.payload).map(([table, rows]) => [table, rows.length]),
);

const SEED_LABEL = { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'seed' } as const;

type Counts = Record<(typeof TABLES)[number], number>;
const EMPTY = Object.fromEntries(TABLES.map((table) => [table, 0])) as Counts;

const countAll = (db: TestDatabase): Promise<Counts> =>
  withClient(db.urlFor('postgres'), async (client) => {
    const counts = {} as Counts;
    for (const table of TABLES) {
      counts[table] = Number(await scalar(client, `select count(*)::int from ${table}`));
    }
    return counts;
  });

/** Every row of the seven tables, as the administrator reads them: what a refused call must leave exactly as it was. */
const snapshot = (db: TestDatabase): Promise<Record<string, unknown[]>> =>
  withClient(db.urlFor('postgres'), async (client) => {
    const result: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      result[table] = (await client.query(`select * from ${table} order by 1, 2`)).rows;
    }
    return result;
  });

/** A connection of `login`, in a transaction, with the settings applied; the transaction is rolled back at the end. */
async function inTransaction<T>(
  db: TestDatabase,
  login: Parameters<TestDatabase['urlFor']>[0],
  settings: Readonly<Record<string, string>>,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(db.urlFor(login), async (client) => {
    await client.query('begin');
    try {
      for (const [name, value] of Object.entries(settings)) {
        await client.query('select set_config($1, $2, true)', [name, value]);
      }
      return await work(client);
    } finally {
      await client.query('rollback');
    }
  });
}

/** What the functions answer: the number of rows each table received. */
interface Report {
  readonly report: Readonly<Record<string, number>>;
}

interface Counters {
  readonly revision: number;
  readonly reduction_floor?: number;
  readonly minimum_revision?: number;
}

const initializeAs = (db: TestDatabase, login: Parameters<TestDatabase['urlFor']>[0]) =>
  withClient(db.urlFor(login), (client) => client.query<Report>(INITIALIZE, [DOCUMENT]));

/** Whether every bundle and every fixed policy is at revision 1 and floor 1. */
async function startsAtOne(db: TestDatabase): Promise<boolean> {
  return withClient(db.urlFor('postgres'), async (client) => {
    const bundles = await client.query<Counters>(
      'select revision, reduction_floor from role_bundle',
    );
    const fixed = await client.query<Counters>(
      'select revision, minimum_revision from fixed_permission_policy',
    );
    return (
      bundles.rows.every((row) => row.revision === 1 && row.reduction_floor === 1) &&
      fixed.rows.every((row) => row.revision === 1 && row.minimum_revision === 1)
    );
  });
}

const failureOf = (promise: Promise<unknown>): Promise<pg.DatabaseError | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) => serverErrorIn(error),
  );

describe('the first initialization', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database.drop();
  });

  // Control for everything below: the provisioning login, which holds no table privilege, fills an empty database by the function.
  // Nothing the caller sets is needed: the function sets the seed label itself for its own statements.
  it('fills an empty database from the provisioning login, in one call, and reports each table', async () => {
    const result = await initializeAs(database, PROVISIONING_ROLE);

    expect(result.rows[0]?.report).toEqual(PLANNED);
    expect(await countAll(database)).toEqual(PLANNED);
  });

  // Break caught: a function that takes the revision or the floor from the document, or leaves them to chance. A bundle and a fixed
  // policy start at revision 1 and floor 1, whatever the document says.
  it('starts every bundle and fixed policy at revision 1 and floor 1', async () => {
    expect(await startsAtOne(database)).toBe(true);
  });

  it('ignores a revision or a floor the document names, and a column it does not take', async () => {
    const doctored = await createTestDatabase();
    try {
      const payload = structuredClone(PLAN.payload) as Record<string, Record<string, unknown>[]>;
      for (const row of payload.role_bundle ?? []) {
        row.revision = 7;
        row.reduction_floor = 7;
      }
      for (const row of payload.fixed_permission_policy ?? []) {
        row.revision = 7;
        row.minimum_revision = 7;
      }
      await withClient(doctored.urlFor(PROVISIONING_ROLE), (client) =>
        client.query(INITIALIZE, [JSON.stringify(payload)]),
      );
      expect(await startsAtOne(doctored)).toBe(true);
    } finally {
      await doctored.drop();
    }
  });

  // Break caught: a function that leaves the SYSTEM context and the seed capability set on the caller's transaction after it
  // returns, so that the statements that follow run under a label nobody gave them.
  it('puts back the context the caller had set', async () => {
    const fresh = await createTestDatabase();
    try {
      await withClient(fresh.urlFor(PROVISIONING_ROLE), async (client) => {
        await client.query('begin');
        await client.query("select set_config('melarc.principal_type', 'STAFF', true)");
        await client.query(INITIALIZE, [DOCUMENT]);
        expect(await scalar(client, "select current_setting('melarc.principal_type', true)")).toBe(
          'STAFF',
        );
        expect(
          await scalar(
            client,
            "select coalesce(nullif(current_setting('melarc.task_capability', true), ''), 'unset')",
          ),
        ).toBe('unset');
        await client.query('rollback');
      });
    } finally {
      await fresh.drop();
    }
  });
});

describe('a repeat, and a partly filled database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await initializeAs(database, PROVISIONING_ROLE);
  });
  afterAll(async () => {
    await database.drop();
  });

  // Break caught: a second run that adds to what is there, or "completes" it. It refuses, names the first table with rows and how
  // many it holds, and every row is as it was.
  it('refuses a second initialization with SQLSTATE 55000, naming the table, and changes nothing', async () => {
    const before = await snapshot(database);

    const failure = await failureOf(initializeAs(database, PROVISIONING_ROLE));

    expect(failure?.code).toBe('55000');
    expect(failure?.table).toBe('hub');
    expect(failure?.detail).toBe(`rows=${String(PLANNED.hub)}`);
    expect(failure?.message).toMatch(/already initialized/);
    expect(await snapshot(database)).toEqual(before);
  });

  it('refuses the same call as many times as it is made', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await failureOf(initializeAs(database, PROVISIONING_ROLE)))?.code).toBe('55000');
    }
    expect(await countAll(database)).toEqual(PLANNED);
  });

  // Break caught: a partly filled database "completed" by a call that skips the table it finds filled. One filled table refuses the
  // whole call, after all seven were counted and before any was written: the others stay empty.
  it.each(TABLES)(
    'refuses when only %s has rows, and writes nothing to the others',
    async (table) => {
      const other = await createTestDatabase();
      try {
        // A row of the right shape for each table, written by the administrator (who bypasses row-level security).
        const rows: Record<(typeof TABLES)[number], string> = {
          hub: "insert into hub (id, name) values ('5eed0100-0000-4000-8000-0000000000aa', 'Elsewhere')",
          permission: "insert into permission (key, domain) values ('pickup.invented', 'pickup')",
          role_bundle:
            "insert into role_bundle (id, name, audience, privileged) values ('5eed0001-0000-4000-8000-0000000000aa', 'Invented', 'STAFF', false)",
          role_bundle_grant: `insert into permission (key, domain) values ('pickup.other', 'pickup');
           insert into role_bundle (id, name, audience, privileged) values ('5eed0001-0000-4000-8000-0000000000aa', 'Invented', 'STAFF', false);
           insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
           values ('5eed0001-0000-4000-8000-0000000000aa', 'pickup.other', 'all', 'any', 'A')`,
          fixed_permission_policy:
            "insert into fixed_permission_policy (principal_type) values ('VENDOR')",
          setting: `insert into setting (key, scope, value_type, value, unit, description)
           values ('invented_setting', 'COMPANY', 'string', '"x"', 'text', 'Invented')`,
          reason_code: `insert into reason_code (code, domain, label, attribution)
           values ('INVENTED', 'DELIVERY_FAILURE', 'Invented', 'MELARC')`,
        };
        await withClient(other.urlFor('postgres'), (admin) => admin.query(rows[table]));
        const before = await countAll(other);

        const failure = await failureOf(initializeAs(other, PROVISIONING_ROLE));

        expect(failure?.code).toBe('55000');
        // The first table, in the fixed order, that holds a row: the one that was filled, or the one the extra rows needed first.
        expect(TABLES.indexOf(failure?.table as (typeof TABLES)[number])).toBeLessThanOrEqual(
          TABLES.indexOf(table),
        );
        expect(await countAll(other)).toEqual(before);
      } finally {
        await other.drop();
      }
    },
  );
});

describe('a failure part-way leaves nothing and can be run again', () => {
  // Break caught: a function that commits what it wrote before a later table fails, or one that leaves a lock behind. A write to
  // the last table is refused by a trigger the test kit puts there; every table before it is rolled back with it, and once the
  // table is mended the same call fills the database.
  it('rolls back every table when the last one fails, and fills the database on the next run', async () => {
    const database = await createTestDatabase();
    const admin = await openAdmin(database);
    try {
      const broken = await admin.breakWrites('reason_code');

      const failure = await failureOf(initializeAs(database, PROVISIONING_ROLE));

      expect(failure?.code).toBe('P0001');
      expect(failure?.message).toMatch(/write refused by the test kit/);
      expect(await countAll(database)).toEqual(EMPTY);

      await broken.mend();
      const result = await initializeAs(database, PROVISIONING_ROLE);
      expect(result.rows[0]?.report).toEqual(PLANNED);
      expect(await countAll(database)).toEqual(PLANNED);
    } finally {
      await admin.close();
      await database.drop();
    }
  });

  // Break caught: a short insert that the function lets through. A document whose row is dropped would otherwise leave a catalogue
  // with a hole in it. (A row the table refuses is an error, not a short insert, so the count check is the second line.)
  it('refuses a document whose row a constraint refuses, with nothing written', async () => {
    const database = await createTestDatabase();
    try {
      const payload = structuredClone(PLAN.payload) as Record<string, Record<string, unknown>[]>;
      const last = payload.reason_code?.at(-1);
      if (last === undefined) throw new Error('the reference plan has no reason');
      last.domain = 'NOT_A_DOMAIN';
      const failure = await failureOf(
        withClient(database.urlFor(PROVISIONING_ROLE), (client) =>
          client.query(INITIALIZE, [JSON.stringify(payload)]),
        ),
      );
      expect(failure?.code).toBe('23514');
      expect(await countAll(database)).toEqual(EMPTY);
    } finally {
      await database.drop();
    }
  });
});

/** Waits until a session of the provisioning login is waiting on a lock inside the initialization. */
async function untilBlocked(admin: pg.Client): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const blocked = await admin.query(
      `select 1 from pg_stat_activity
        where usename = $1 and wait_event_type = 'Lock' and query like '%initialize_reference_data%'`,
      [PROVISIONING_ROLE],
    );
    if (blocked.rowCount !== 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no initialization was waiting on a lock');
}

describe('two initializations at once cannot both populate', () => {
  async function twoSessions(database: TestDatabase) {
    const first = clientFor(database.urlFor(PROVISIONING_ROLE));
    const second = clientFor(database.urlFor(PROVISIONING_ROLE));
    for (const client of [first, second]) client.on('error', () => undefined);
    await first.connect();
    await second.connect();
    const admin = clientFor(database.urlFor('postgres'));
    admin.on('error', () => undefined);
    await admin.connect();
    return {
      first,
      second,
      admin,
      end: async () => {
        await Promise.all(
          [first.end(), second.end(), admin.end()].map((end) => end.catch(() => undefined)),
        );
      },
    };
  }

  // Break caught: no lock between the check and the inserts, so that two transactions both see empty tables and both fill them.
  // The second waits for the first, then finds the tables filled, and refuses.
  it('makes the second wait for the first, and refuse once the first has committed', async () => {
    const database = await createTestDatabase();
    const sessions = await twoSessions(database);
    try {
      await sessions.first.query('begin');
      await sessions.first.query(INITIALIZE, [DOCUMENT]);
      await sessions.second.query('begin');
      const second = sessions.second.query(INITIALIZE, [DOCUMENT]).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await untilBlocked(sessions.admin);
      // Nothing of the first is visible to anyone yet, and the second has not written anything.
      expect(await countAll(database)).toEqual(EMPTY);
      await sessions.first.query('commit');

      const outcome = await second;
      expect(outcome.ok).toBe(false);
      expect(serverErrorIn((outcome as { error: unknown }).error)?.code).toBe('55000');
      await sessions.second.query('rollback');
      expect(await countAll(database)).toEqual(PLANNED);
    } finally {
      await sessions.end();
      await database.drop();
    }
  });

  // Break caught: a lock that is not held to the end of the transaction, or one that a lock timeout cannot reach. A second call
  // that will not wait is ended by lock_timeout and writes nothing.
  it('ends a second call that will not wait with the lock timeout, and writes nothing', async () => {
    const database = await createTestDatabase();
    const sessions = await twoSessions(database);
    try {
      await sessions.first.query('begin');
      await sessions.first.query(INITIALIZE, [DOCUMENT]);
      await sessions.second.query('begin');
      await sessions.second.query("set local lock_timeout = '300ms'");

      const failure = await failureOf(sessions.second.query(INITIALIZE, [DOCUMENT]));

      expect(failure?.code).toBe('55P03');
      await sessions.second.query('rollback');
      await sessions.first.query('commit');
      expect(await countAll(database)).toEqual(PLANNED);
    } finally {
      await sessions.end();
      await database.drop();
    }
  });

  // The other side: the first one fails or is rolled back, and the second, which waited for it, fills the database, once.
  it('lets the second one run when the first is rolled back, and the database is filled once', async () => {
    const database = await createTestDatabase();
    const sessions = await twoSessions(database);
    try {
      await sessions.first.query('begin');
      await sessions.first.query(INITIALIZE, [DOCUMENT]);
      await sessions.second.query('begin');
      const second = sessions.second.query<Report>(INITIALIZE, [DOCUMENT]);

      await untilBlocked(sessions.admin);
      await sessions.first.query('rollback');

      expect((await second).rows[0]?.report).toEqual(PLANNED);
      await sessions.second.query('commit');
      expect(await countAll(database)).toEqual(PLANNED);
    } finally {
      await sessions.end();
      await database.drop();
    }
  });
});

describe('after the initialization, the initialization authority cannot append policy content (F02)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    await initializeAs(database, PROVISIONING_ROLE);
  });
  afterAll(async () => {
    await database.drop();
  });

  // The headline of F02. Reproduced on the migrations up to 0004, where this statement succeeded. The provisioning login asserts
  // the seed label by hand and adds a permission to an existing bundle: refused by the privilege, because it holds none.
  it('refuses a grant added to an existing bundle by the provisioning login with the seed label asserted', async () => {
    await inTransaction(database, PROVISIONING_ROLE, SEED_LABEL, async (client) => {
      const failure = await client
        .query(
          `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
           values ($1, 'pickup.request.create', 'all', 'any', 'A')`,
          [BUNDLE_IDS.opsStaff],
        )
        .catch((error: unknown) => error as pg.DatabaseError);
      expect((failure as pg.DatabaseError).code).toBe('42501');
      expect((failure as pg.DatabaseError).message).toMatch(
        /permission denied for table role_bundle_grant/,
      );
    });
  });

  // Break caught: a privilege on any of the seven left with the provisioning login: to insert, to read, to change or to remove.
  it.each(TABLES)('gives the provisioning login no privilege at all on %s', async (table) => {
    await withClient(database.urlFor('postgres'), async (admin) => {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        expect(
          await scalar<boolean>(
            admin,
            `select has_table_privilege('${PROVISIONING_ROLE}', 'public.${table}', '${privilege}')`,
          ),
          `${privilege} ${table}`,
        ).toBe(false);
        if (['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)) {
          expect(
            await scalar<boolean>(
              admin,
              `select has_any_column_privilege('${PROVISIONING_ROLE}', 'public.${table}', '${privilege}')`,
            ),
            `column ${privilege} ${table}`,
          ).toBe(false);
        }
      }
    });
  });

  it('refuses every statement on every table, under the seed label or not, by the privilege', async () => {
    for (const table of TABLES) {
      for (const settings of [SEED_LABEL, {}]) {
        await inTransaction(database, PROVISIONING_ROLE, settings, async (client) => {
          for (const statement of [
            `select count(*) from ${table}`,
            `delete from ${table}`,
            `truncate ${table}`,
          ]) {
            await client.query('savepoint attempt');
            expect(await sqlState(client, statement), `${table}: ${statement}`).toBe('42501');
            await client.query('rollback to savepoint attempt');
          }
        });
      }
    }
  });

  // GBT-E6 carried to the function. Break caught: EXECUTE left with PUBLIC, or given to the runtime or the base worker.
  it.each([API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE] as const)(
    'refuses %s the initialization and the fixtures, by the privilege on the function',
    async (login) => {
      for (const statement of [
        "select melarc.initialize_reference_data('{}'::jsonb)",
        "select melarc.add_reason_fixtures('{}'::jsonb)",
      ]) {
        await inTransaction(database, login, SEED_LABEL, async (client) => {
          const failure = await client
            .query(statement)
            .catch((error: unknown) => error as pg.DatabaseError);
          expect((failure as pg.DatabaseError).code, statement).toBe('42501');
          expect((failure as pg.DatabaseError).message, statement).toMatch(
            /permission denied for function/,
          );
        });
      }
    },
  );

  it.each([API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE] as const)(
    'refuses %s a grant added to an existing bundle, with the seed label asserted',
    async (login) => {
      await inTransaction(database, login, SEED_LABEL, async (client) => {
        expect(
          await sqlState(
            client,
            `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
             values ('${BUNDLE_IDS.opsStaff}', 'pickup.request.create', 'all', 'any', 'A')`,
          ),
        ).toBe('42501');
      });
    },
  );
});

describe('the functions, as the catalogue and the posture check see them', () => {
  let database: TestDatabase;
  const NAMES = ['initialize_reference_data', 'add_reason_fixtures'] as const;

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database.drop();
  });

  // Break caught: a definer function that runs with the caller's search_path, is owned by someone else, or is executable by anyone
  // but the one login that is meant to run it.
  it('are SECURITY DEFINER, owned by the owner role, with a fixed search_path, executable by the provisioning login alone', async () => {
    await withClient(database.urlFor('postgres'), async (admin) => {
      const { rows } = await admin.query<{
        proname: string;
        prosecdef: boolean;
        owner: string;
        proconfig: string[] | null;
        public_can: boolean;
        provisioning_can: boolean;
        api_can: boolean;
        worker_can: boolean;
        migration_can: boolean;
      }>(
        `select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as owner, p.proconfig,
                has_function_privilege('public', p.oid, 'EXECUTE') as public_can,
                has_function_privilege($1, p.oid, 'EXECUTE') as provisioning_can,
                has_function_privilege($2, p.oid, 'EXECUTE') as api_can,
                has_function_privilege($3, p.oid, 'EXECUTE') as worker_can,
                has_function_privilege('melarc_migration_elevated', p.oid, 'EXECUTE') as migration_can
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'melarc' and p.proname = any($4) order by p.proname`,
        [PROVISIONING_ROLE, API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE, [...NAMES]],
      );
      expect(rows.map((row) => row.proname)).toEqual([...NAMES].toSorted());
      for (const row of rows) {
        expect(row.prosecdef, row.proname).toBe(true);
        expect(row.owner, row.proname).toBe('melarc_owner');
        expect(row.proconfig, row.proname).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(row.public_can, row.proname).toBe(false);
        expect(row.provisioning_can, row.proname).toBe(true);
        expect(row.api_can, row.proname).toBe(false);
        expect(row.worker_can, row.proname).toBe(false);
      }
    });
  });

  it('are the whole of the allow-list, and the catalogue holds', async () => {
    // The two seed functions, and the one function of migration 0017 that the seed takes its exclusive policy locks with (S0.27).
    expect(APPROVED_DEFINER_EXECUTE[PROVISIONING_ROLE]?.toSorted()).toEqual(
      [...NAMES.map((name) => `melarc.${name}`), 'melarc.lock_policy_keys'].toSorted(),
    );
    // And the runtime's one: the read of a credential hash for the authentication capability (migration 0016). A definer function
    // added to either list is a reviewed line here, and no other login is on the list.
    expect(APPROVED_DEFINER_EXECUTE[API_RUNTIME_ROLE]).toEqual(['melarc.staff_credential_hash']);
    expect(Object.keys(APPROVED_DEFINER_EXECUTE).toSorted()).toEqual(
      [API_RUNTIME_ROLE, PROVISIONING_ROLE].toSorted(),
    );
    const violations = await withClient(database.urlFor('postgres'), (client) =>
      catalogViolations(client),
    );
    expect(violations).toEqual([]);
  });

  // Break caught: an allow-list that is decoration. Without it the provisioning login is reported as able to run a definer
  // function; with it the same login is clean. And the runtime, given EXECUTE, is reported at once.
  it('make the posture check report the login that may execute them unless the allow-list names them', async () => {
    await withClient(database.urlFor('postgres'), async (admin) => {
      const posture = async (role: string, allowed: unknown) =>
        (
          await admin.query<Record<string, unknown>>(ROLE_POSTURE_SQL, [
            role,
            JSON.stringify(allowed),
          ])
        ).rows[0];
      expect(unsafeFlags((await posture(PROVISIONING_ROLE, {})) ?? {})).toEqual([
        'can_execute_definer',
      ]);
      expect(
        unsafeFlags((await posture(PROVISIONING_ROLE, APPROVED_DEFINER_EXECUTE)) ?? {}),
      ).toEqual([]);
      const [role, allowed] = rolePostureParameters(PROVISIONING_ROLE);
      expect(unsafeFlags((await posture(String(role), JSON.parse(allowed))) ?? {})).toEqual([]);

      await admin.query('begin');
      try {
        await admin.query(
          `grant execute on function melarc.initialize_reference_data(jsonb) to ${API_RUNTIME_ROLE}`,
        );
        expect(
          unsafeFlags((await posture(API_RUNTIME_ROLE, APPROVED_DEFINER_EXECUTE)) ?? {}),
        ).toEqual(['can_execute_definer']);
        const violations = await catalogViolations(admin);
        expect(violations).toContainEqual(
          expect.stringMatching(
            /role melarc_api_runtime is not a safe runtime identity: can_execute_definer/,
          ),
        );
      } finally {
        await admin.query('rollback');
      }
    });
  });
});

describe('the reason fixtures function', () => {
  let database: TestDatabase;
  const FIXTURE_DOCUMENT = JSON.stringify(fixturePlan().payload);

  beforeAll(async () => {
    database = await createTestDatabase();
    await initializeAs(database, PROVISIONING_ROLE);
  });
  afterAll(async () => {
    await database.drop();
  });

  const reason = (code: string) => ({ ...(fixturePlan().payload.reason_code?.[0] ?? {}), code });

  // Break caught: a second way to write the reason table that takes any code. The function writes FIXTURE_ codes and nothing else,
  // and a code that merely looks like the prefix (the underscore is not a wildcard) is refused.
  it.each([
    ['a real reason code', 'SESSION_SECURITY_CONCERN_TWO'],
    ['a code without the prefix', 'ANOTHER_REASON'],
    ['a code that only resembles the prefix', 'FIXTUREX_ODD'],
    ['a code in lower case', 'fixture_lower'],
  ])('refuses %s, and writes nothing', async (_label, code) => {
    const before = await countAll(database);
    const failure = await failureOf(
      withClient(database.urlFor(PROVISIONING_ROLE), (client) =>
        client.query(FIXTURES, [JSON.stringify({ reason_code: [reason(code)] })]),
      ),
    );
    expect(failure?.code).toBe('22023');
    expect(await countAll(database)).toEqual(before);
  });

  it.each([
    ['a document with another table in it', { reason_code: [reason('FIXTURE_X')], hub: [] }],
    ['a document with no rows', { reason_code: [] }],
    ['a document without the reason table', {}],
    ['a list', [reason('FIXTURE_X')]],
  ])('refuses %s', async (_label, document) => {
    const failure = await failureOf(
      withClient(database.urlFor(PROVISIONING_ROLE), (client) =>
        client.query(FIXTURES, [JSON.stringify(document)]),
      ),
    );
    expect(failure?.code).toBe('22023');
  });

  // Break caught: the fixtures function run at a snapshot taken before it waited for the table lock, which would count the fixtures
  // already there as they were before another call committed. It has the initialization's guard: read committed only.
  it.each(['repeatable read', 'serializable'])(
    'refuses to run at %s isolation, and writes nothing',
    async (level) => {
      const before = await countAll(database);
      const failure = await failureOf(
        withClient(database.urlFor(PROVISIONING_ROLE), async (client) => {
          await client.query(`begin isolation level ${level}`);
          try {
            await client.query(FIXTURES, [FIXTURE_DOCUMENT]);
          } finally {
            await client.query('rollback');
          }
        }),
      );
      expect(failure?.code).toBe('25000');
      expect(failure?.message).toMatch(/read committed/);
      expect(await countAll(database)).toEqual(before);
    },
  );

  it('adds the fixtures once, beside the seeded reasons, and refuses a second time', async () => {
    const before = await countAll(database);

    const result = await withClient(database.urlFor(PROVISIONING_ROLE), (client) =>
      client.query<Report>(FIXTURES, [FIXTURE_DOCUMENT]),
    );

    expect(result.rows[0]?.report).toEqual({ reason_code: REASON_FIXTURES.length });
    expect(await countAll(database)).toEqual({
      ...before,
      reason_code: before.reason_code + REASON_FIXTURES.length,
    });
    const failure = await failureOf(
      withClient(database.urlFor(PROVISIONING_ROLE), (client) =>
        client.query(FIXTURES, [FIXTURE_DOCUMENT]),
      ),
    );
    expect(failure?.code).toBe('55000');
    expect(failure?.table).toBe('reason_code');
    expect(failure?.detail).toBe(`rows=${String(REASON_FIXTURES.length)}`);
  });
});

describe('what the functions refuse in the call itself', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database.drop();
  });

  const call = (document: string, before?: string) =>
    withClient(database.urlFor(PROVISIONING_ROLE), async (client) => {
      if (before !== undefined) {
        await client.query('begin');
        await client.query(before);
      }
      return client.query(INITIALIZE, [document]);
    });

  // Break caught: a document the function reads loosely: a table it does not know, a table left out, an empty table, or no object.
  it.each([
    ['a document that is not an object', '[]'],
    [
      'a document with a table that is not part of it',
      JSON.stringify({ ...PLAN.payload, audit_event: [{}] }),
    ],
    [
      'a document without one of the seven tables',
      JSON.stringify({ ...PLAN.payload, hub: undefined }),
    ],
    ['a document with an empty table', JSON.stringify({ ...PLAN.payload, hub: [] })],
    [
      'a document whose table is not an array',
      JSON.stringify({ ...PLAN.payload, hub: { id: 'x' } }),
    ],
    ['no document at all', 'null'],
  ])('refuses %s, with SQLSTATE 22023 and nothing written', async (_label, document) => {
    const failure = await failureOf(call(document));
    expect(failure?.code).toBe('22023');
    expect(await countAll(database)).toEqual(EMPTY);
  });

  // Break caught: the function run at a snapshot taken before it waited for another initialization's locks, which would count the
  // tables as they were before that one committed.
  it.each(['repeatable read', 'serializable'])('refuses to run at %s isolation', async (level) => {
    const failure = await failureOf(
      withClient(database.urlFor(PROVISIONING_ROLE), async (client) => {
        await client.query(`begin isolation level ${level}`);
        try {
          await client.query(INITIALIZE, [DOCUMENT]);
        } finally {
          await client.query('rollback');
        }
      }),
    );
    expect(failure?.code).toBe('25000');
    expect(await countAll(database)).toEqual(EMPTY);
  });
});
