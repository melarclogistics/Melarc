import { describe, expect, it, vi } from 'vitest';

import { CliUsageError } from '../database/cli.js';
import { UnsafeTargetError } from '../database/safety.js';
import { FixturesRefusedError } from '../fixtures/fixtures.js';
import {
  localProvisioningUrl,
  runSeedCommand,
  type SeedCommandDependencies,
} from './seed-command.js';

/**
 * The `db:seed` command (S0.9): which database it acts on, which environment it believes it is in, and what it refuses before it
 * connects. The seed itself is `seed-helper.test.ts`'s and `seed.db.test.ts`'s; here the helper and the connection are doubles.
 */

const URL = 'postgres://melarc_provisioning:CANARY-PASSWORD@db.example:5432/melarc';
const LOCAL = 'postgres://melarc_provisioning:LOCAL-CANARY@127.0.0.1:5432/melarc_dev';

function build() {
  const closed = vi.fn(() => Promise.resolve());
  const database = { transactionWithContext: vi.fn() };
  const opened: string[] = [];
  const plans: string[][] = [];
  const dependencies: SeedCommandDependencies = {
    localUrl: () => LOCAL,
    open: (url) => {
      opened.push(url);
      return { database, close: closed };
    },
    runSeed: (_database, plan) => {
      const named = Object.entries(plan.payload).map(
        ([table, rows]) => [plan.labels?.[table] ?? table, rows.length] as const,
      );
      plans.push(named.map(([table]) => table));
      return Promise.resolve(Object.fromEntries(named));
    },
  };
  const lines: string[] = [];
  const run = (argv: string[], env: Record<string, string | undefined>) =>
    runSeedCommand(argv, env, (line) => lines.push(line), dependencies);
  return { run, lines, opened, plans, closed };
}

describe('which database it acts on', () => {
  // Break caught: a deployed seed run against the local development database, or the other way round.
  it('uses DATABASE_SEED_URL when it is set, and the local provisioning login when it is not', async () => {
    const given = build();
    await given.run([], { DATABASE_SEED_URL: URL, APP_ENV: 'staging' });
    expect(given.opened).toEqual([URL]);

    const local = build();
    await local.run([], {});
    expect(local.opened).toEqual([LOCAL]);
  });

  // Break caught: a deployed database seeded without saying which environment it is (the fixtures guard would then have nothing
  // to judge). A URL that was given needs APP_ENV, one of the three.
  it.each([undefined, '', 'prod', 'Production', 'qa'])(
    'refuses a given URL when APP_ENV is %j, before it connects',
    async (appEnv) => {
      const { run, opened } = build();
      await expect(run([], { DATABASE_SEED_URL: URL, APP_ENV: appEnv })).rejects.toThrow(/APP_ENV/);
      expect(opened).toEqual([]);
    },
  );

  // Break caught: the local default (a database on this machine) reached with APP_ENV naming a deployed environment: the
  // default would then be taken for that environment's database.
  it('refuses the local default when APP_ENV says staging or production', async () => {
    for (const appEnv of ['staging', 'production']) {
      const { run, opened } = build();
      await expect(run([], { APP_ENV: appEnv })).rejects.toThrow(CliUsageError);
      expect(opened).toEqual([]);
    }
  });

  it('accepts the local default with APP_ENV absent, empty or local', async () => {
    for (const env of [{}, { APP_ENV: '' }, { APP_ENV: 'local' }]) {
      const { run, opened } = build();
      await run([], env);
      expect(opened).toEqual([LOCAL]);
    }
  });

  // Break caught: a malformed URL echoed back (a password in the message). The message names the setting and what is wrong.
  it('refuses a URL that is not accepted, naming the setting and never the value', async () => {
    const { run, opened } = build();
    const failure = await run([], {
      DATABASE_SEED_URL:
        'postgres://melarc_provisioning:CANARY-PASSWORD@db.example/melarc?user=postgres',
      APP_ENV: 'staging',
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CliUsageError);
    expect((failure as Error).message).toMatch(/^DATABASE_SEED_URL /);
    expect((failure as Error).message).not.toContain('CANARY-PASSWORD');
    expect(opened).toEqual([]);
  });

  // Break caught: a URL for another login. The seed's grants belong to the provisioning identity; any other user would either fail
  // late or, worse, succeed as something with more rights. The command says so before it connects.
  it.each(['melarc_api_runtime', 'melarc_migration_elevated', 'postgres', 'melarc_worker_runtime'])(
    'refuses a URL whose user is %s: the seed runs as the provisioning login',
    async (user) => {
      const { run, opened } = build();
      await expect(
        run([], {
          DATABASE_SEED_URL: `postgres://${user}:x@db.example/melarc`,
          APP_ENV: 'staging',
        }),
      ).rejects.toThrow(/provisioning login/);
      expect(opened).toEqual([]);
    },
  );
});

describe('the local default', () => {
  const PASSWORDS = {
    MELARC_PG_ADMIN_PASSWORD: 'a-local-administrator-password',
    MELARC_PG_MIGRATION_PASSWORD: 'a-local-migration-password',
    MELARC_PG_RUNTIME_PASSWORD: 'a-local-runtime-password',
  };
  const NO_FILE = 'a-settings-file-that-does-not-exist.env';

  // Break caught: the default taken for a database on this machine when MELARC_PG_HOST names another, so that a run with APP_ENV unset
  // is allowed its fixtures against a server it never checked. The local default acts on this machine or not at all.
  it('refuses a server that is not on this machine', () => {
    expect(() =>
      localProvisioningUrl({
        env: { ...PASSWORDS, MELARC_PG_HOST: 'db.example' },
        envFile: NO_FILE,
      }),
    ).toThrow(UnsafeTargetError);
  });

  it('is the provisioning login on the development database of this machine, and says no password', () => {
    const url = localProvisioningUrl({
      env: { ...PASSWORDS, MELARC_PG_HOST: '127.0.0.1', MELARC_PG_PORT: '5433' },
      envFile: NO_FILE,
    });
    expect(url).toMatch(/^postgres:\/\/melarc_provisioning:[^@]+@127\.0\.0\.1:5433\/melarc_dev$/);
    expect(url).not.toContain(PASSWORDS.MELARC_PG_ADMIN_PASSWORD);
  });
});

describe('what it runs', () => {
  it('runs the reference seed by default and reports each table', async () => {
    const { run, plans, lines, closed } = build();
    await run([], { DATABASE_SEED_URL: URL, APP_ENV: 'production' });
    expect(plans).toEqual([
      [
        'hub',
        'permission',
        'role_bundle',
        'role_bundle_grant',
        'fixed_permission_policy',
        'setting',
        'reason_code',
      ],
    ]);
    expect(lines.some((line) => /^seeded hub: 1 row$/.test(line))).toBe(true);
    expect(lines.some((line) => /^seeded permission: \d+ rows$/.test(line))).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });

  // Break caught: the fixtures reachable in production by any route, flag included. The command refuses before it opens a
  // connection, and the runner refuses again.
  it('refuses --fixtures in production before it connects', async () => {
    const { run, opened, plans } = build();
    await expect(
      run(['--fixtures'], { DATABASE_SEED_URL: URL, APP_ENV: 'production' }),
    ).rejects.toBeInstanceOf(FixturesRefusedError);
    expect(opened).toEqual([]);
    expect(plans).toEqual([]);
  });

  it.each(['local', 'staging'])('runs only the fixtures with --fixtures in %s', async (appEnv) => {
    const { run, plans } = build();
    await run(['--fixtures'], { DATABASE_SEED_URL: URL, APP_ENV: appEnv });
    expect(plans).toEqual([['reason_code (fixtures)']]);
  });

  it('refuses an argument it does not know, before it connects', async () => {
    for (const argv of [
      ['--fixture'],
      ['fixtures'],
      ['--fixtures', '--reference'],
      ['melarc_dev'],
    ]) {
      const { run, opened } = build();
      await expect(
        run(argv, { DATABASE_SEED_URL: URL, APP_ENV: 'staging' }),
      ).rejects.toBeInstanceOf(CliUsageError);
      expect(opened).toEqual([]);
    }
  });

  // Break caught: a connection left open after a refusal, which keeps the process alive and the database busy.
  it('closes the connection when the seed refuses', async () => {
    const closed = vi.fn(() => Promise.resolve());
    const lines: string[] = [];
    await expect(
      runSeedCommand(
        [],
        { DATABASE_SEED_URL: URL, APP_ENV: 'staging' },
        (line) => lines.push(line),
        {
          localUrl: () => LOCAL,
          open: () => ({ database: { transactionWithContext: vi.fn() }, close: closed }),
          runSeed: () =>
            Promise.reject(new Error('The seed refuses to run: table hub is not empty')),
        },
      ),
    ).rejects.toThrow(/not empty/);
    expect(closed).toHaveBeenCalledOnce();
    expect(lines).toEqual([]);
  });

  // Break caught: a failure to close the connection hiding the reason the seed refused, so the person reads "connection terminated"
  // and not "table hub is not empty".
  it('reports why the seed refused even when closing the connection fails too', async () => {
    await expect(
      runSeedCommand([], { DATABASE_SEED_URL: URL, APP_ENV: 'staging' }, () => undefined, {
        localUrl: () => LOCAL,
        open: () => ({
          database: { transactionWithContext: vi.fn() },
          close: () => Promise.reject(new Error('the pool would not close')),
        }),
        runSeed: () => Promise.reject(new Error('The seed refuses to run: table hub is not empty')),
      }),
    ).rejects.toThrow(/not empty/);
  });

  // Break caught: the URL, with its password, written to the output.
  it('never writes the URL or its password', async () => {
    const { run, lines } = build();
    await run([], { DATABASE_SEED_URL: URL, APP_ENV: 'staging' });
    expect(lines.join('\n')).not.toMatch(/CANARY-PASSWORD|postgres:\/\//);
  });
});
