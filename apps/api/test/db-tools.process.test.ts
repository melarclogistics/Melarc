import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_BOOTSTRAP,
  DB_MIGRATE,
  DB_ORPHANS,
  DB_RESET,
  killAll,
  requireBuild,
  run,
} from './support/api-process.js';

beforeAll(requireBuild);
afterEach(killAll);

const SECRETS = ['ADMIN-SECRET-PW', 'MIGRATION-SECRET-PW', 'RUNTIME-SECRET-PW'];

/**
 * A complete local configuration that points at a port nothing listens on. A tool that gets as far as
 * connecting fails with a connection error; a tool that refuses the target fails before that, and says
 * why. The two are told apart by the message, so a refusal cannot pass for a connection failure.
 */
const LOCAL = {
  MELARC_PG_HOST: '127.0.0.1',
  MELARC_PG_PORT: '1',
  MELARC_PG_ADMIN_PASSWORD: SECRETS[0] ?? '',
  MELARC_PG_MIGRATION_PASSWORD: SECRETS[1] ?? '',
  MELARC_PG_RUNTIME_PASSWORD: SECRETS[2] ?? '',
};

function expectNoSecrets(output: string): void {
  for (const secret of SECRETS) expect(output).not.toContain(secret);
}

/** What a tool says when it reached the point of connecting: the evidence that it did not refuse. */
const CONNECTION_FAILURE = /not reachable/;

describe.each([
  ['db-reset', DB_RESET],
  ['db-bootstrap', DB_BOOTSTRAP],
])('%s refuses an unsafe target', (_name, script) => {
  // Break caught: a reset or a role rewrite sent to a server that is not on this machine, which is how a
  // shared or production cluster is lost. The refusal comes before any connection or name lookup.
  it.each(['db.internal', '10.0.0.5', 'localhost.evil.example'])(
    'refuses the host %s without connecting',
    async (host) => {
      const result = await run(script, { ...LOCAL, MELARC_PG_HOST: host });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not on this machine');
      expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
      expectNoSecrets(`${result.stdout}${result.stderr}`);
    },
  );

  // Break caught: a destructive local command running with a deployed environment in scope.
  it.each(['staging', 'production'])('refuses APP_ENV=%s', async (appEnv) => {
    const result = await run(script, { ...LOCAL, APP_ENV: appEnv });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`APP_ENV=${appEnv}`);
    expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  // Break caught: any database but a development or test one being named as the target, the cluster's own
  // and a production-looking name included.
  it.each(['postgres', 'template1', 'melarc', 'melarc_prod'])(
    'refuses the database %s',
    async (database) => {
      const result = await run(script, LOCAL, [database]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('only melarc_dev and melarc_test databases are disposable');
      expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
      expectNoSecrets(`${result.stdout}${result.stderr}`);
    },
  );

  // Control for the refusals above: a safe target is not refused. The tool gets as far as connecting, and
  // the failure it reports is the unreachable server, with no password in it.
  it('does not refuse a local server and a development database', async () => {
    const result = await run(script, LOCAL, ['melarc_dev']);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(CONNECTION_FAILURE);
    expect(result.stderr).not.toContain('refusing');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });
});

describe('db-orphans (audit F07)', () => {
  // Break caught: the listing or a removal reaching a server that is not on this machine, which is how a shared
  // cluster loses databases. The refusal comes before any connection or name lookup.
  it.each(['db.internal', '10.0.0.5', 'localhost.evil.example'])(
    'refuses the host %s without connecting',
    async (host) => {
      const result = await run(DB_ORPHANS, { ...LOCAL, MELARC_PG_HOST: host });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not on this machine');
      expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
      expectNoSecrets(`${result.stdout}${result.stderr}`);
    },
  );

  it.each(['staging', 'production'])('refuses APP_ENV=%s', async (appEnv) => {
    const result = await run(DB_ORPHANS, { ...LOCAL, APP_ENV: appEnv });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`APP_ENV=${appEnv}`);
    expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
  });

  // Break caught: a name that is not a test database reaching the server. The development database and the
  // cluster's own are not abandoned test databases, and the refusal is made before anything connects.
  it.each(['melarc_dev', 'postgres', 'template1', 'melarc_test', 'melarc_test_AB12CD34'])(
    'refuses to drop %s before connecting',
    async (database) => {
      const result = await run(DB_ORPHANS, LOCAL, ['--drop', database]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('only databases named melarc_test_');
      expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
      expectNoSecrets(`${result.stdout}${result.stderr}`);
    },
  );

  // Break caught: a deletion that nobody asked for by name. None of these selects a database, and none connects.
  it.each([
    ['--all'],
    ['--drop'],
    ['melarc_test_aaaa1111'],
    ['--disconnect'],
    ['--drop', '--force'],
  ])('says how to use it for %j, and connects to nothing', async (...args) => {
    const result = await run(DB_ORPHANS, LOCAL, args);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('usage');
    expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
  });

  // Control for the refusals above: asking for the listing is not refused. It gets as far as connecting, and
  // the failure it reports is the unreachable server, with no password in it.
  it('does not refuse a listing on a local server', async () => {
    const result = await run(DB_ORPHANS, LOCAL);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(CONNECTION_FAILURE);
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });
});

describe('db-migrate', () => {
  const MIGRATOR =
    'postgres://melarc_migration_elevated:MIGRATION-SECRET-PW@127.0.0.1:1/melarc_dev';

  // Break caught: migrations run as the runtime role, a superuser or the owner, which leaves objects owned
  // by the wrong role. The password in the URL must not be echoed.
  it.each([
    ['the runtime role', 'postgres://melarc_api_runtime:RUNTIME-SECRET-PW@127.0.0.1:1/melarc_dev'],
    ['the owner role', 'postgres://melarc_owner:RUNTIME-SECRET-PW@127.0.0.1:1/melarc_dev'],
    ['a superuser', 'postgres://postgres:ADMIN-SECRET-PW@127.0.0.1:1/melarc_dev'],
  ])('refuses a URL for %s without connecting', async (_role, url) => {
    const result = await run(DB_MIGRATE, { DATABASE_MIGRATION_URL: url });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('migrations run only as melarc_migration_elevated');
    expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  // Break caught (audit F01): a migration URL whose authority names the migration identity while its query
  // string makes the driver connect as another user or to another host. The identity check approved one
  // connection and the tool made a different one. Connection options are refused before anything connects,
  // and what was in them is not repeated.
  it.each([
    ['a user override', `${MIGRATOR}?user=postgres`],
    ['a host override', `${MIGRATOR}?host=db.example`],
    ['a repeated user', `${MIGRATOR}?user=a&user=postgres`],
    ['an encoded option name', `${MIGRATOR}?%75ser=postgres`],
    ['a TLS option', `${MIGRATOR}?sslmode=require`],
    ['a fragment', `${MIGRATOR}#section`],
  ])('refuses a URL with %s without connecting', async (_label, url) => {
    const result = await run(DB_MIGRATE, { DATABASE_MIGRATION_URL: url });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_MIGRATION_URL');
    expect(result.stderr).toMatch(/query string|fragment/);
    expect(result.stderr).not.toMatch(CONNECTION_FAILURE);
    expect(`${result.stdout}${result.stderr}`).not.toContain('db.example');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  // Break caught: a value that is not a database URL being echoed back, which leaks whatever was pasted.
  it('refuses a value that is not a PostgreSQL URL, and does not echo it', async () => {
    const result = await run(DB_MIGRATE, { DATABASE_MIGRATION_URL: 'MIGRATION-SECRET-PW' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_MIGRATION_URL');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  // Control: the migration identity is accepted, so the tool reaches the connection.
  it('does not refuse the migration identity', async () => {
    const result = await run(DB_MIGRATE, { DATABASE_MIGRATION_URL: MIGRATOR });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(CONNECTION_FAILURE);
    expect(result.stderr).not.toContain('refusing');
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });

  // Control: with no URL given it builds the local one, as the migration identity, from the local settings.
  it('falls back to the local development database when no URL is given', async () => {
    const result = await run(DB_MIGRATE, LOCAL);

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(CONNECTION_FAILURE);
    expectNoSecrets(`${result.stdout}${result.stderr}`);
  });
});
