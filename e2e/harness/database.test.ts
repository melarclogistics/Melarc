import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  arrange,
  bootstrapAdministrators,
  clientSettings,
  createDatabase,
  dropDatabase,
  listDatabases,
  observe,
  parseCreated,
  redactUrl,
  resumeAdministrator,
  withClient,
} from './database.ts';
import { repositoryPaths } from './paths.ts';

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
interface ExecOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly windowsHide: boolean;
}

// The database command is never run by these tests: the process API is replaced, so a test that gets past a
// guard it should have stopped at cannot reach a database, a real or a disposable one.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock:
    vi.fn<
      (file: string, args: readonly string[], options: ExecOptions, callback: ExecCallback) => void
    >(),
}));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

const MIGRATION =
  'postgres://melarc_migration_elevated:m-secret@127.0.0.1:5432/melarc_test_0a1b2c3d';
const RUNTIME = 'postgres://melarc_api_runtime:r-secret@127.0.0.1:5432/melarc_test_0a1b2c3d';
const WORKER = 'postgres://melarc_worker_runtime:w-secret@127.0.0.1:5432/melarc_test_0a1b2c3d';

const created = (overrides: Record<string, unknown> = {}) =>
  `${JSON.stringify({ database: 'melarc_test_0a1b2c3d', migrationUrl: MIGRATION, runtimeUrl: RUNTIME, workerUrl: WORKER, ...overrides })}\n`;

describe('parseCreated', () => {
  it('reads the one line the database command prints', () => {
    expect(parseCreated(created())).toEqual({
      name: 'melarc_test_0a1b2c3d',
      migrationUrl: MIGRATION,
      runtimeUrl: RUNTIME,
      workerUrl: WORKER,
    });
  });

  // Break caught: a name other than the one the command makes being accepted, which would let a later drop act
  // on whatever the output said. The harness only ever drops the shape it was given.
  it.each(['melarc_dev', 'postgres', 'melarc_test_xyz', 'melarc_test_0a1b2c3d; drop database x'])(
    'refuses the database name %s',
    (name) => {
      expect(() => parseCreated(created({ database: name }))).toThrow(/database name/);
    },
  );

  // Break caught: output that is not what was expected being read as success: an error page, a warning in
  // front of the line, or two lines.
  it.each([
    ['nothing', ''],
    ['text that is not JSON', 'database created\n'],
    ['a warning before the line', `(node) warning\n${created()}`],
    ['two lines', `${created()}${created()}`],
    ['a missing runtime URL', created({ runtimeUrl: undefined })],
    ['a missing worker URL', created({ workerUrl: undefined })],
    ['a URL that is not a PostgreSQL one', created({ runtimeUrl: 'http://127.0.0.1/x' })],
  ])('refuses %s', (_label, output) => {
    expect(() => parseCreated(output)).toThrow();
  });

  // Break caught (audit F01): a connection string with a query string or fragment being accepted from the
  // database command and later handed to the driver, which acts on a query string (`user`, `host`, `port`,
  // TLS) and so could connect as someone other than the user the URL names. Such a URL is refused, not
  // stripped, and nothing it held is repeated.
  it.each([
    ['a user override', `${MIGRATION}?user=postgres`],
    ['a host override', `${RUNTIME}?host=db.example`],
    ['a TLS option', `${RUNTIME}?sslmode=require`],
    ['an empty query string', `${RUNTIME}?`],
    ['a fragment', `${MIGRATION}#section`],
    ['a worker URL with a user override', `${WORKER}?user=postgres`],
  ])('refuses a connection string with %s', (_label, url) => {
    const output = created(
      url.startsWith('postgres://melarc_migration')
        ? { migrationUrl: url }
        : url.startsWith('postgres://melarc_worker')
          ? { workerUrl: url }
          : { runtimeUrl: url },
    );

    expect(() => parseCreated(output)).toThrow(/query string or fragment/);
    expect(() => parseCreated(output)).not.toThrow(/db\.example|m-secret|r-secret/);
  });
});

describe('clientSettings', () => {
  // Break caught: the settings differing from the parts of the URL the command printed: a part left
  // encoded, a default port missing, or a connection string left in for the driver to read again.
  it('reads the parts of the URL and hands the driver nothing else', () => {
    expect(clientSettings(MIGRATION)).toStrictEqual({
      host: '127.0.0.1',
      port: 5432,
      user: 'melarc_migration_elevated',
      password: 'm-secret',
      database: 'melarc_test_0a1b2c3d',
    });
  });

  it('decodes percent-encoded parts and takes an IPv6 host without its brackets', () => {
    expect(clientSettings('postgres://we%20ird:p%40ss%3A%2F%3F%23@[::1]:5544/db%5Fname')).toEqual({
      host: '::1',
      port: 5544,
      user: 'we ird',
      password: 'p@ss:/?#',
      database: 'db_name',
    });
  });

  // Break caught: a URL with no port being read as port 0, which the driver treats as unset and replaces
  // with whatever the environment or its own default says.
  it('names 5432 when the URL names no port', () => {
    expect(clientSettings('postgres://u:p@localhost/db').port).toBe(5432);
  });

  // Break caught: a URL with a query string reaching the driver through this reader.
  it.each([`${MIGRATION}?user=postgres`, `${MIGRATION}#x`, `${MIGRATION}?`])(
    'refuses %s',
    (url) => {
      expect(() => clientSettings(url)).toThrow(/query string or fragment/);
    },
  );
});

/**
 * Replaces the driver's client with one that records what it was given and stops before connecting, so what
 * the harness hands the driver can be read without a server, and no test here can reach a real one.
 */
function stubClient(): pg.ClientConfig[] {
  const configs: pg.ClientConfig[] = [];
  class StopsBeforeConnecting {
    constructor(config: pg.ClientConfig) {
      configs.push(config);
    }
    on(): this {
      return this;
    }
    connect(): Promise<never> {
      return Promise.reject(new Error('stopped before connecting'));
    }
  }
  vi.spyOn(pg, 'Client').mockImplementation(StopsBeforeConnecting as unknown as typeof pg.Client);
  return configs;
}

describe('withClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Break caught (audit F01): the harness's own connections being made from the URL string, which the
  // driver reads again, query string included.
  it('gives the driver the settings read from the URL and no connection string', async () => {
    const configs = stubClient();

    await expect(withClient(MIGRATION, () => Promise.resolve())).rejects.toThrow(
      'stopped before connecting',
    );

    expect(configs).toStrictEqual([
      {
        host: '127.0.0.1',
        port: 5432,
        user: 'melarc_migration_elevated',
        password: 'm-secret',
        database: 'melarc_test_0a1b2c3d',
        connectionTimeoutMillis: 5_000,
      },
    ]);
  });

  // Break caught: a URL with connection options being used for a connection. It is refused before any client exists.
  it('refuses a URL with a query string before it makes a client', async () => {
    const configs = stubClient();

    await expect(withClient(`${MIGRATION}?user=postgres`, () => Promise.resolve())).rejects.toThrow(
      /query string or fragment/,
    );

    expect(configs).toEqual([]);
  });
});

describe('redactUrl', () => {
  // Break caught: a password written into a log, an artifact or an error message. A run is read by people
  // and kept by CI; a URL is shown only with the password hidden.
  it('hides the password and nothing else', () => {
    expect(redactUrl(RUNTIME)).toBe(
      'postgres://melarc_api_runtime:***@127.0.0.1:5432/melarc_test_0a1b2c3d',
    );
  });

  it('leaves a URL without a password as it is, and does not echo what it cannot read', () => {
    expect(redactUrl('postgres://127.0.0.1:5432/db')).toBe('postgres://127.0.0.1:5432/db');
    expect(redactUrl('not a url with p@ssw0rd in it')).toBe('(unreadable URL)');
  });
});

/** Makes the stand-in for the database command answer, as the real one does, with what it was told to print. */
function commandPrints(stdout: string): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(null, stdout, '');
  });
}

/** The one call the stand-in saw: what would have been run, and with which environment and limits. */
function theCall() {
  expect(execFileMock).toHaveBeenCalledTimes(1);
  const [file, args, options] = execFileMock.mock.calls[0] ?? [];
  return { file, args, options };
}

describe('dropDatabase', () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  // Break caught: the database command being asked to drop a database of the right shape and nothing else
  // changing in how it is run: the name travels as one argument, after the verb, to the built tool.
  it('drops a database of the shape the harness makes, naming it as one argument', async () => {
    commandPrints('');

    await dropDatabase('melarc_test_0a1b2c3d');

    expect(theCall().file).toBe(process.execPath);
    expect(theCall().args).toEqual([
      repositoryPaths().databaseTool,
      'drop',
      'melarc_test_0a1b2c3d',
    ]);
  });

  // Break caught (the drop-name guard removed): the harness dropping a database it did not make. A name that
  // is a real application database (`melarc_dev` is the local one), a system database, a near miss of the
  // shape, or text with SQL in it must be refused before any command is run, whatever the command itself
  // would then do with it.
  it.each([
    ['the local application database', 'melarc_dev'],
    ['a name that starts like a harness database but is shorter', 'melarc_test'],
    ['a system database', 'postgres'],
    ['a template database', 'template1'],
    ['an empty name', ''],
    ['seven hex digits', 'melarc_test_0a1b2c3'],
    ['nine hex digits', 'melarc_test_0a1b2c3d4'],
    ['upper-case hex digits', 'melarc_test_0A1B2C3D'],
    ['a digit that is not hex', 'melarc_test_0a1b2c3g'],
    ['a prefix before the shape', 'xmelarc_test_0a1b2c3d'],
    ['a suffix after the shape', 'melarc_test_0a1b2c3d_copy'],
    ['a trailing newline', 'melarc_test_0a1b2c3d\n'],
    ['a leading space', ' melarc_test_0a1b2c3d'],
    ['a path', '../melarc_test_0a1b2c3d'],
    ['a second statement', 'melarc_test_0a1b2c3d; drop database melarc_dev'],
    ['a quote and a comment', 'melarc_test_0a1b2c3d" ; drop database melarc_dev; --'],
    ['an always-true condition', "melarc_test_0a1b2c3d' or '1'='1"],
    ['a null character', 'melarc_test_0a1b2c3d\u0000'],
  ])('refuses to drop %s, and runs no command', async (_label, name) => {
    commandPrints('');

    await expect(dropDatabase(name)).rejects.toThrow('Refusing to drop');

    expect(execFileMock).not.toHaveBeenCalled();
  });

  // Break caught: a failure of the command being reported without what it said, or without which command it
  // was, which leaves a failed run with nothing to read.
  it('reports a failed command with its arguments and what it wrote to stderr', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('exit 1'), '', 'database is being accessed by other users\n');
    });

    await expect(dropDatabase('melarc_test_0a1b2c3d')).rejects.toThrow(
      'The database command (drop melarc_test_0a1b2c3d) failed: database is being accessed by other users',
    );
  });

  it('falls back to the process error when the command wrote nothing to stderr', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('spawn failed'), '', '');
    });

    await expect(dropDatabase('melarc_test_0a1b2c3d')).rejects.toThrow(/failed: spawn failed$/);
  });
});

describe('the database command', () => {
  afterEach(() => {
    execFileMock.mockReset();
    vi.unstubAllEnvs();
  });

  // Break caught: the wrong verb, so that `create` or `list` runs something else, or the output of the command
  // being read from the wrong place; or a database made without the reference data, which the API the run
  // starts is not ready over (`reference_data_missing`, the owner's decision of 25 October 2026).
  it('creates a database with `create --seed` and reads the one line it prints', async () => {
    commandPrints(created());

    await expect(createDatabase()).resolves.toMatchObject({ name: 'melarc_test_0a1b2c3d' });

    expect(theCall().args).toEqual([repositoryPaths().databaseTool, 'create', '--seed']);
  });

  it('lists the disposable databases with `list`', async () => {
    commandPrints(JSON.stringify({ databases: ['melarc_test_0a1b2c3d', 'melarc_test_1f2e3d4c'] }));

    await expect(listDatabases()).resolves.toEqual([
      'melarc_test_0a1b2c3d',
      'melarc_test_1f2e3d4c',
    ]);

    expect(theCall().args).toEqual([repositoryPaths().databaseTool, 'list']);
  });

  // Break caught: a command that can hang a run for ever, or one that opens a console window.
  it('bounds the command in time and keeps its window hidden', async () => {
    commandPrints(JSON.stringify({ databases: [] }));

    await listDatabases();

    expect(theCall().options).toMatchObject({ timeout: 60_000, windowsHide: true });
  });

  // Break caught (commandEnvironment): the command being given more than it needs, so that a developer's own
  // settings (their database URLs, credentials of other tools, NODE_OPTIONS, the sandbox's capture file) steer
  // what it does, or less than it needs, so that it cannot reach the local server. It gets the MELARC_PG_
  // settings, which say where the local server is, and nothing else.
  it('gives the command the MELARC_PG_ settings and nothing else of this machine', async () => {
    vi.stubEnv('MELARC_PG_HOST', 'db.local.example');
    vi.stubEnv('MELARC_PG_PORT', '5544');
    vi.stubEnv('MELARC_PG_ADMIN_PASSWORD', 'admin-secret-value');
    for (const name of [
      'DATABASE_URL',
      'DATABASE_MIGRATION_URL',
      'PGPASSWORD',
      'AWS_SECRET_ACCESS_KEY',
      'NODE_OPTIONS',
      'MELARC_E2E_CAPTURE_FILE',
      'MELARC_PGX_NOT_A_SETTING',
      'XMELARC_PG_PREFIXED',
      'APP_ENV',
    ]) {
      vi.stubEnv(name, 'must-not-reach-the-command');
    }
    commandPrints(JSON.stringify({ databases: [] }));

    await listDatabases();

    const passed = theCall().options?.env ?? {};
    expect(passed).toMatchObject({
      MELARC_PG_HOST: 'db.local.example',
      MELARC_PG_PORT: '5544',
      MELARC_PG_ADMIN_PASSWORD: 'admin-secret-value',
    });
    const others = Object.keys(passed).filter(
      (name) => !name.startsWith('MELARC_PG_') && name.toUpperCase() !== 'SYSTEMROOT',
    );
    expect(others).toEqual([]);
  });

  // Break caught: Windows' own SystemRoot not reaching the command. Without it Node on Windows cannot start
  // its network code, and the command fails before it says anything. Windows spells the name as its parent
  // process did (`SystemRoot` or `SYSTEMROOT`), so what must hold is that the value arrives, whatever the
  // case of the name in this process.
  it('gives the command SystemRoot when this process has it', async () => {
    vi.stubEnv('SystemRoot', 'C:\\StubbedWindows');
    commandPrints(JSON.stringify({ databases: [] }));

    await listDatabases();

    const passed = theCall().options?.env ?? {};
    const systemRoot = Object.entries(passed).find(([name]) => name.toUpperCase() === 'SYSTEMROOT');
    expect(systemRoot?.[1]).toBe('C:\\StubbedWindows');
  });
});

describe('what a journey asks of the database command (S0.45)', () => {
  const NAME = 'melarc_test_0a1b2c3d';

  afterEach(() => {
    execFileMock.mockReset();
  });

  // Break caught: the bootstrap run against a database other than the run's own, or the custodians passed as one argument, which the
  // command would read as one custodian.
  it('bootstraps the run database with the folder and each custodian as an argument of its own', async () => {
    commandPrints(`${JSON.stringify({ bootstrapped: NAME })}
`);

    await bootstrapAdministrators(NAME, '/tmp/custody', [
      'Ada Admin <ada@x.example>',
      'Bola <b@x.example>',
    ]);

    expect(theCall().args).toEqual([
      repositoryPaths().databaseTool,
      'bootstrap',
      NAME,
      '/tmp/custody',
      'Ada Admin <ada@x.example>',
      'Bola <b@x.example>',
    ]);
  });

  // Break caught: a bootstrap that takes seconds on Windows (a bundle costs runs of whoami and icacls) being cut off by the limit of
  // an ordinary command, and a run failing for want of time rather than for a reason.
  it('allows the bootstrap and the resume the time a custody bundle costs', async () => {
    commandPrints(`${JSON.stringify({ bootstrapped: NAME })}
`);
    await bootstrapAdministrators(NAME, '/tmp/custody', ['a <a@x.example>', 'b <b@x.example>']);
    expect(theCall().options?.timeout).toBeGreaterThan(60_000);

    execFileMock.mockReset();
    commandPrints(`${JSON.stringify({ resumed: NAME })}
`);
    await resumeAdministrator(NAME, '/tmp/custody', 'ada@x.example');
    expect(theCall().options?.timeout).toBeGreaterThan(60_000);
  });

  // Break caught: the command acting on a database of another shape, the development database among them.
  it.each([
    [
      'bootstrap',
      () => bootstrapAdministrators('melarc_dev', '/tmp/c', ['a <a@x.example>', 'b <b@x.example>']),
    ],
    ['resume', () => resumeAdministrator('melarc_dev', '/tmp/c', 'a@x.example')],
    ['arrange', () => arrange('melarc_dev', 'lapse-lock', 'a@x.example')],
    ['observe', () => observe('melarc_dev', 'lock', 'a@x.example')],
  ])(
    'refuses to %s a database that is not a harness database, and runs no command',
    async (verb, call) => {
      commandPrints('{}');

      await expect(call()).rejects.toThrow(`Refusing to ${verb}`);

      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  // Break caught: output that is not the command's answer being taken for it.
  it('refuses an answer that does not say what was done', async () => {
    commandPrints(`${JSON.stringify({ bootstrapped: 'melarc_test_ffffffff' })}
`);
    await expect(
      bootstrapAdministrators(NAME, '/tmp/custody', ['a <a@x.example>', 'b <b@x.example>']),
    ).rejects.toThrow(/did not say it bootstrapped/);

    commandPrints(`${JSON.stringify({ arranged: 'something-else', rows: 1 })}
`);
    await expect(arrange(NAME, 'lapse-lock', 'a@x.example')).rejects.toThrow(/did not say/);

    commandPrints(`${JSON.stringify({ observed: 'lock', rows: 'many' })}
`);
    await expect(observe(NAME, 'lock', 'a@x.example')).rejects.toThrow(/did not answer/);
  });

  it('passes an arrangement and an observation by name with their arguments, and returns the rows', async () => {
    commandPrints(`${JSON.stringify({ arranged: 'expire-setup-grant', rows: 2 })}
`);
    await expect(
      arrange(NAME, 'expire-setup-grant', 'a@x.example', 'STAFF_CREDENTIAL_SETUP'),
    ).resolves.toBe(2);
    expect(theCall().args).toEqual([
      repositoryPaths().databaseTool,
      'arrange',
      NAME,
      'expire-setup-grant',
      'a@x.example',
      'STAFF_CREDENTIAL_SETUP',
    ]);

    execFileMock.mockReset();
    commandPrints(`${JSON.stringify({ observed: 'factors', rows: [{ status: 'ACTIVE' }] })}
`);
    await expect(observe(NAME, 'factors', 'a@x.example')).resolves.toEqual([{ status: 'ACTIVE' }]);
    expect(theCall().args).toEqual([
      repositoryPaths().databaseTool,
      'observe',
      NAME,
      'factors',
      'a@x.example',
    ]);
  });
});
