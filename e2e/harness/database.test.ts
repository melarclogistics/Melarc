import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clientSettings, parseCreated, redactUrl, withClient } from './database.ts';

const MIGRATION =
  'postgres://melarc_migration_elevated:m-secret@127.0.0.1:5432/melarc_test_0a1b2c3d';
const RUNTIME = 'postgres://melarc_api_runtime:r-secret@127.0.0.1:5432/melarc_test_0a1b2c3d';

const created = (overrides: Record<string, unknown> = {}) =>
  `${JSON.stringify({ database: 'melarc_test_0a1b2c3d', migrationUrl: MIGRATION, runtimeUrl: RUNTIME, ...overrides })}\n`;

describe('parseCreated', () => {
  it('reads the one line the database command prints', () => {
    expect(parseCreated(created())).toEqual({
      name: 'melarc_test_0a1b2c3d',
      migrationUrl: MIGRATION,
      runtimeUrl: RUNTIME,
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
  ])('refuses a connection string with %s', (_label, url) => {
    const output = created(
      url.startsWith('postgres://melarc_migration') ? { migrationUrl: url } : { runtimeUrl: url },
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
