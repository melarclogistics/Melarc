import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALONE_MARK,
  SANCTIONED,
  findSharedStateStatements,
  stringLiterals,
  unexplainedAloneFiles,
} from './test-support/database-isolation.js';

/**
 * The database tests run several files at once (vitest.config.ts, the `database` project) because each file works in a database of its
 * own. A file that changes or watches what the whole server shares would break the files beside it, intermittently: it belongs in
 * `test/database/alone/`, whose files run one at a time once the others are done, each saying why on its first line. This holds the files
 * that run beside each other, and the support they share, to that.
 */
const API = resolve(import.meta.dirname, '..');
const DATABASE_TESTS = join(API, 'test', 'database');

function filesOf(folder: string, relative: string): { path: string; text: string }[] {
  return readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      path: `${relative}/${entry.name}`,
      text: readFileSync(join(folder, entry.name), 'utf8'),
    }));
}

describe('the database tests that run side by side', () => {
  const parallel = filesOf(DATABASE_TESTS, 'test/database');
  const support = filesOf(join(DATABASE_TESTS, 'support'), 'test/database/support');
  const alone = filesOf(join(DATABASE_TESTS, 'alone'), 'test/database/alone');

  it('reads the files it judges: the side-by-side tests, their support, and the folder of the tests that run alone', () => {
    // A check over nothing passes: these counts make an emptied or moved folder fail instead.
    expect(parallel.filter((file) => file.path.endsWith('.db.test.ts')).length).toBeGreaterThan(80);
    for (const sanctioned of SANCTIONED.keys()) {
      expect(
        support.some(
          (file) => `test/database/support/${file.path.split('/').at(-1) ?? ''}` === sanctioned,
        ),
      ).toBe(true);
    }
    expect(alone.filter((file) => file.path.endsWith('.db.test.ts')).length).toBeGreaterThan(20);
  });

  it('change nothing the whole server shares and watch only their own database', () => {
    expect(findSharedStateStatements([...parallel, ...support])).toEqual([]);
  });

  // Break caught: a test moved into the folder for no stated reason, or out of it while it still changes what the server shares.
  it('leave that to the tests that run alone, each of which says why on its first line', () => {
    expect(unexplainedAloneFiles(alone)).toEqual([]);
    // The rules are live on the real files: the tests that run alone for what they change are found by them.
    const found = new Set(findSharedStateStatements(alone).map((finding) => finding.path));
    for (const name of [
      'provisioning',
      'runtime-role',
      'technical-identities',
      'seed-initialization',
      'orphans',
      'e2e-database-tool',
      'e2e-database',
      'reset-tools',
      'rate-limiter',
      'policy-change-races',
    ]) {
      expect(found, name).toContain(`test/database/alone/${name}.db.test.ts`);
    }
  });
});

describe('findSharedStateStatements', () => {
  const judge = (text: string, path = 'test/database/x.db.test.ts'): string[] =>
    findSharedStateStatements([{ path, text }]).map((finding) => finding.rule);

  // Break caught: each rule, planted in a statement the way a test writes one, including the forms an earlier reading let through.
  it.each([
    ["await admin.query('alter role melarc_api_runtime nologin');", 'changes a role'],
    ['await admin.query(`CREATE ROLE intruder LOGIN`);', 'changes a role'],
    ["await admin.query('alter group melarc_owner add user intruder');", 'changes a role'],
    ["await admin.query(format('GRANT %I TO %I', a, b));", 'grants a role to a role'],
    [
      "await admin.query('grant melarc_owner, melarc_migration_elevated to intruder');",
      'grants a role to a role',
    ],
    [
      'await admin.query(sql`grant ${sql.raw(role)} to ${sql.raw(member)}`);',
      'grants a role to a role',
    ],
    [
      "await admin.query('revoke melarc_owner from melarc_migration_elevated');",
      'revokes a role from a role',
    ],
    ['await admin.query(`drop database ${name}`);', 'creates, changes or drops a database'],
    [
      "await admin.query('alter system set log_statement = ''all''');",
      "changes the server's settings",
    ],
    ["await admin.query('select pg_reload_conf()');", "changes the server's settings"],
    [
      "await admin.query(`select count(*) from pg_stat_activity where usename = 'melarc_api_runtime'`);",
      'watches every session of the server',
    ],
    [
      "await admin.query('select count(*) from pg_stat_activity where pid <> pg_backend_pid()');",
      'watches every session of the server',
    ],
    [
      "await admin.query('select datname, count(*) from pg_stat_activity group by datname');",
      'watches every session of the server',
    ],
    [
      "await admin.query('select * from pg_stat_get_activity(null)');",
      'watches every session of the server',
    ],
    [
      "await admin.query('select pid from pg_locks where locktype = $1 and objid = $2', [kind, key]);",
      'watches every session of the server',
    ],
    [
      "await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where usename = $1', [role]);",
      'ends or cancels a session of the server',
    ],
    [
      "await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname <> current_database()');",
      'ends or cancels a session of the server',
    ],
    ["await admin.query('select datname from pg_database');", 'lists the databases of the server'],
    [
      'await provisionRoles(admin, settings);',
      'names a provisioning function or a tool that acts on the whole server',
    ],
    [
      'await dropDisposableDatabase(admin, other);',
      'names a provisioning function or a tool that acts on the whole server',
    ],
    [
      'const admin = await connectLocalAdmin(settings);',
      'names a provisioning function or a tool that acts on the whole server',
    ],
    [
      "await run(DB_BOOTSTRAP, ['--yes']);",
      'names a provisioning function or a tool that acts on the whole server',
    ],
    [
      'const tool = E2E_DATABASE;',
      'names a provisioning function or a tool that acts on the whole server',
    ],
  ])('finds %s', (text, rule) => {
    expect(judge(text)).toContain(rule);
  });

  it.each([
    // A grant of a privilege on an object of its own database, and looks at its own sessions, locks and database.
    "await admin.query('grant select on staff_identity to melarc_api_runtime');",
    "await admin.query('revoke insert on audit_event from melarc_api_runtime');",
    "await admin.query('select count(*) from pg_stat_activity where datname = current_database()');",
    "await admin.query('select count(*) from pg_stat_activity where datname = $1 and usename = $2', [name, role]);",
    "await admin.query('select count(*)::int from pg_stat_activity where pid = $1', [pid]);",
    'await admin.query(`select l.pid from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.datname = current_database()`);',
    "await admin.query('select pid from pg_locks where database = (select oid from pg_database where datname = current_database())');",
    "await client.query(`select mode from pg_locks where locktype = 'advisory' and pid = coalesce($1::int, pg_backend_pid())`, [pid]);",
    "await admin.query('select pg_terminate_backend($1)', [pid]);",
    "await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1', [name]);",
    "await admin.query('select oid from pg_database where datname = current_database()');",
    // Words in comments, names and the titles of tests are not statements.
    '// this test never alters a role, and drops no database\nconst value = 1;',
    "it('refuses a grant issued to a rider who has since left, and revokes nothing from anyone', () => {});",
    "const note = 'role'; // provisionRoles( is called by the support file",
  ])('leaves alone %s', (text) => {
    expect(judge(text)).toEqual([]);
  });

  it('allows the sanctioned support files what they need, and nothing more', () => {
    const maker =
      'await provisionRoles(admin, settings); await createDisposableDatabase(admin, name); await connectLocalAdmin(s);';
    expect(judge(maker, 'test/database/support/test-database.ts')).toEqual([]);
    expect(
      judge('await connectLocalAdmin(settings);', 'test/database/support/server-hold.ts'),
    ).toEqual([]);
    expect(
      judge('await provisionRoles(admin, settings);', 'test/database/support/server-hold.ts'),
    ).toEqual(['names a provisioning function or a tool that acts on the whole server']);
  });

  it('reads a statement split over lines and one with an interpolated part', () => {
    expect(
      judge('await admin.query(`\n  alter\n  role ${role}\n  with password ${secret}`);'),
    ).toEqual(['changes a role']);
    expect(
      findSharedStateStatements([
        { path: 'test/database/x.db.test.ts', text: 'const a = 1;\n\nq(`drop database x`);' },
      ])[0]?.line,
    ).toBe(3);
  });
});

describe('unexplainedAloneFiles', () => {
  // Break caught: a file in the folder that does not say why, or says nothing.
  it('asks every file of the folder for a reason on its first line', () => {
    const explained = {
      path: 'a.db.test.ts',
      text: `${ALONE_MARK}it changes the roles every database shares.\nimport x;`,
    };
    expect(unexplainedAloneFiles([explained])).toEqual([]);
    expect(unexplainedAloneFiles([{ path: 'b.db.test.ts', text: "import x from 'y';" }])).toEqual([
      'b.db.test.ts',
    ]);
    expect(
      unexplainedAloneFiles([{ path: 'c.db.test.ts', text: `${ALONE_MARK}because.\n` }]),
    ).toEqual(['c.db.test.ts']);
  });
});

describe('stringLiterals', () => {
  it('reads quoted strings and template literals, and skips comments', () => {
    const text =
      "// 'not this'\nconst a = 'one'; /* `nor this` */ const b = \"two\"; const c = `three ${a} four`;";
    expect(stringLiterals(text).map((literal) => literal.text)).toEqual([
      'one',
      'two',
      'three ${a} four',
    ]);
  });

  it('keeps an escaped quote inside its string', () => {
    expect(stringLiterals("const a = 'it\\'s';").map((literal) => literal.text)).toEqual([
      "it\\'s",
    ]);
  });
});
