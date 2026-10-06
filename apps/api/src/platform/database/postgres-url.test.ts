import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parsePostgresUrl,
  postgresConnectionSettings,
  PostgresUrlError,
  postgresUrlProblem,
} from './postgres-url.js';

/** The identity a client given `config` would connect as. Building a client opens no connection. */
function connectsAs(config: pg.ClientConfig) {
  const client = new pg.Client(config);
  return { user: client.user, host: client.host, port: client.port, database: client.database };
}

/** The driver's own reading of a URL string, which is what handing it the URL would have used. */
function driverReads(url: string) {
  // eslint-disable-next-line no-restricted-syntax -- this is the one place that asks the driver what it would have made of the string
  return connectsAs({ connectionString: url });
}

const BASE = 'postgres://melarc_api_runtime:FAKE-PW@127.0.0.1/melarc_test_demo';
const AUTHORITY = {
  user: 'melarc_api_runtime',
  host: '127.0.0.1',
  port: 5432,
  database: 'melarc_test_demo',
};

// The driver falls back to these variables for anything it is not given. A developer machine may set them.
const AMBIENT = ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD'];
beforeEach(() => {
  for (const key of AMBIENT) vi.stubEnv(key, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parsePostgresUrl', () => {
  // Break caught: the wrong field read from the URL, which every safety decision downstream relies on.
  it('reads the host, port, database and user', () => {
    expect(parsePostgresUrl('postgres://melarc_api_runtime:pw@db.internal:6432/melarc')).toEqual({
      host: 'db.internal',
      port: 6432,
      database: 'melarc',
      user: 'melarc_api_runtime',
    });
  });

  // Break caught: a missing port treated as no port, or as 0, so a default local database is not recognised.
  it('uses 5432 when the URL names no port, and accepts the postgresql scheme', () => {
    expect(parsePostgresUrl('postgresql://u@localhost/melarc_dev')).toEqual({
      host: 'localhost',
      port: 5432,
      database: 'melarc_dev',
      user: 'u',
    });
  });

  // Break caught: an IPv6 loopback kept with its brackets, so "is this loopback?" never matches it.
  it('returns an IPv6 host without its brackets', () => {
    expect(parsePostgresUrl('postgres://u@[::1]:5432/melarc')?.host).toBe('::1');
  });

  // Break caught: percent-encoded parts left encoded, so a role or database with an escaped character
  // is compared by its encoded spelling.
  it('decodes percent-encoded user and database names', () => {
    const target = parsePostgresUrl('postgres://melarc%5Fapi%5Fruntime@h/melarc%5Fdev');
    expect(target).toMatchObject({ user: 'melarc_api_runtime', database: 'melarc_dev' });
  });

  // Break caught: the parser ever handing back the password, which a caller could then log.
  it('never returns the password', () => {
    const target = parsePostgresUrl('postgres://u:PASSWORD-VALUE@h/melarc');
    expect(JSON.stringify(target)).not.toContain('PASSWORD-VALUE');
  });

  // Break caught: a URL that is not a usable PostgreSQL target being accepted, or the parser throwing on it.
  it.each([
    ['another scheme', 'mysql://u@h/melarc'],
    ['not a URL', 'definitely not a url'],
    ['an empty string', ''],
    ['no host', 'postgres://u@/melarc'],
    ['no database', 'postgres://u@h:5432'],
    ['an empty database', 'postgres://u@h:5432/'],
    ['a database with a path', 'postgres://u@h/a/b'],
    ['no user', 'postgres://h:5432/melarc'],
    ['a port out of range', 'postgres://u@h:70000/melarc'],
    ['broken percent-encoding', 'postgres://u@h/%E0%A4%A'],
  ])('returns undefined for %s', (_label, url) => {
    expect(parsePostgresUrl(url)).toBeUndefined();
  });
});

/**
 * Audit F01. These are URLs on which the driver, handed the string, connects as someone else than the
 * URL's authority says: the guard approved one identity and the driver used another.
 */
const IDENTITY_OVERRIDES: readonly (readonly [string, string])[] = [
  ['a user', `${BASE}?user=postgres`],
  ['a host', `${BASE}?host=db.example`],
  ['a port', `${BASE}?port=6543`],
  ['a repeated user, of which the last one wins', `${BASE}?user=a&user=postgres`],
  ['a percent-encoded option name', `${BASE}?%75ser=postgres`],
  ['a user after other options', `${BASE}?application_name=x&user=postgres`],
];

/** Connection options that change nothing about identity but are not supported either. */
const OTHER_OPTIONS: readonly (readonly [string, string])[] = [
  ['a TLS mode', `${BASE}?sslmode=require`],
  ['a TLS mode that turns verification off', `${BASE}?sslmode=no-verify`],
  ['a role set through options', `${BASE}?options=-c%20role%3Dpostgres`],
  ['a password', `${BASE}?password=other`],
  ['an application name', `${BASE}?application_name=x`],
  ['an empty query string', `${BASE}?`],
];

/** A host the driver reads differently than the URL's text: it decodes percent-escapes and treats / as a socket. */
const HOST_DISAGREEMENTS: readonly (readonly [string, string])[] = [
  [
    'a socket path',
    'postgres://melarc_api_runtime:FAKE-PW@%2Fvar%2Frun%2Fpostgresql/melarc_test_demo',
  ],
  ['an escaped digit', 'postgres://melarc_api_runtime:FAKE-PW@127.0.0.%32/melarc_test_demo'],
];

describe('control characters in a connection URL', () => {
  // Break caught: a percent-escaped NUL or newline in the user, the password or the database name. The URL parser
  // decodes it, and the driver writes the decoded text into its startup message, which PostgreSQL reads as
  // NUL-terminated strings: the text after the NUL is read as the next parameter.
  it.each([
    ['a NUL in the user', 'postgres://app%00x:pw@127.0.0.1/db'],
    ['a NUL in the password', 'postgres://app:p%00w@127.0.0.1/db'],
    ['a NUL in the database', 'postgres://app:pw@127.0.0.1/d%00b'],
    ['a newline in the user', 'postgres://app%0Ax:pw@127.0.0.1/db'],
    ['a carriage return in the password', 'postgres://app:p%0Dw@127.0.0.1/db'],
    ['a unit separator in the database', 'postgres://app:pw@127.0.0.1/d%1Fb'],
    ['a delete character in the user', 'postgres://app%7Fx:pw@127.0.0.1/db'],
  ])('refuses %s, in fixed text', (_label, url) => {
    expect(parsePostgresUrl(url)).toBeUndefined();
    expect(postgresUrlProblem(url)).toBe('must not contain control characters');
    expect(() => postgresConnectionSettings(url)).toThrow(PostgresUrlError);
  });

  it('still accepts a password with every printable character that needs escaping', () => {
    const url = 'postgres://app:p%40ss%3Aw%2Frd%20%25@127.0.0.1/db';
    expect(postgresConnectionSettings(url).password).toBe('p@ss:w/rd %');
  });
});

describe('the one reading of a connection URL (audit F01)', () => {
  // Break caught: the guard and the driver reading different things. If this table stops holding, the
  // driver changed what it does with a query string and the reasons for refusing one should be reviewed.
  it.each([...IDENTITY_OVERRIDES, ...HOST_DISAGREEMENTS])(
    'the driver would have connected elsewhere than the authority names, given %s',
    (_label, url) => {
      expect(driverReads(url)).not.toEqual(AUTHORITY);
    },
  );

  // Break caught: a URL that carries a user, host or port override being read as its authority. The guard
  // then approves one identity while the driver connects as another.
  it.each(IDENTITY_OVERRIDES)('refuses %s in the query string', (_label, url) => {
    expect(parsePostgresUrl(url)).toBeUndefined();
    expect(postgresUrlProblem(url)).toMatch(/query string/);
    expect(() => postgresConnectionSettings(url)).toThrow(PostgresUrlError);
  });

  // Break caught: an option the driver would honour (TLS, role, password, application name) slipping in
  // because only identity options were looked for. Unsupported input is refused, never stripped.
  it.each(OTHER_OPTIONS)('refuses %s instead of passing it on or dropping it', (_label, url) => {
    expect(parsePostgresUrl(url)).toBeUndefined();
    expect(postgresUrlProblem(url)).toMatch(/query string/);
    expect(() => postgresConnectionSettings(url)).toThrow(PostgresUrlError);
  });

  // Break caught: a fragment being tolerated and dropped, so that what was supplied is not what is used.
  it.each([
    ['a fragment', `${BASE}#section`],
    ['an empty fragment', `${BASE}#`],
    ['a query string and a fragment', `${BASE}?a=b#c`],
  ])('refuses %s', (_label, url) => {
    expect(parsePostgresUrl(url)).toBeUndefined();
    expect(postgresUrlProblem(url)).toMatch(/query string|fragment/);
    expect(() => postgresConnectionSettings(url)).toThrow(PostgresUrlError);
  });

  // Break caught: a host the driver would decode into something else (a Unix socket directory, another
  // address) being accepted because its text looks like a host name.
  it.each(HOST_DISAGREEMENTS)('refuses a host with %s', (_label, url) => {
    expect(parsePostgresUrl(url)).toBeUndefined();
    expect(postgresUrlProblem(url)).toMatch(/host/);
  });

  // Break caught: a port of zero. The driver treats it as no port at all and uses 5432, or whatever PGPORT
  // names, so the port that was checked is not the port that connects.
  it.each(['0', '00', '000'])('refuses the port %s', (port) => {
    const url = `postgres://u:p@127.0.0.1:${port}/db`;
    expect(parsePostgresUrl(url)).toBeUndefined();
    expect(postgresUrlProblem(url)).toMatch(/port/);
  });

  it('refuses a host with a non-ASCII or otherwise unexpected character', () => {
    expect(parsePostgresUrl('postgres://u:p@hôst/db')).toBeUndefined();
    expect(postgresUrlProblem('postgres://u:p@hôst/db')).toMatch(/host/);
  });

  // The ordinary shapes a deployment uses. The settings are exactly the facts in the URL.
  const ACCEPTED: readonly (readonly [string, string, pg.ClientConfig])[] = [
    [
      'a plain URL',
      'postgres://melarc_api_runtime:pw@127.0.0.1:5432/melarc_dev',
      {
        host: '127.0.0.1',
        port: 5432,
        user: 'melarc_api_runtime',
        password: 'pw',
        database: 'melarc_dev',
      },
    ],
    [
      'the postgresql scheme and a host name',
      'postgresql://u:p@db.internal:6432/melarc',
      { host: 'db.internal', port: 6432, user: 'u', password: 'p', database: 'melarc' },
    ],
    [
      'no port',
      'postgres://u:p@localhost/melarc_dev',
      { host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'melarc_dev' },
    ],
    [
      'an IPv6 host',
      'postgres://u:p@[::1]:5433/melarc',
      { host: '::1', port: 5433, user: 'u', password: 'p', database: 'melarc' },
    ],
    [
      'an underscore in the host name',
      'postgres://u:p@db_1.internal/melarc',
      { host: 'db_1.internal', port: 5432, user: 'u', password: 'p', database: 'melarc' },
    ],
    [
      'percent-encoded parts',
      'postgres://melarc%5Fapi%5Fruntime:p%40ss%3Aw%2Frd%3F%23@h/melarc%5Fdev',
      {
        host: 'h',
        port: 5432,
        user: 'melarc_api_runtime',
        password: 'p@ss:w/rd?#',
        database: 'melarc_dev',
      },
    ],
    ['no password', 'postgres://u@h/db', { host: 'h', port: 5432, user: 'u', database: 'db' }],
  ];

  // Break caught: the settings differing from what the URL says: a part left encoded, a default missing,
  // a password added where there was none.
  it.each(ACCEPTED)('reads %s into exactly the settings it names', (_label, url, expected) => {
    expect(postgresConnectionSettings(url)).toStrictEqual(expected);
    expect(postgresUrlProblem(url)).toBeUndefined();
  });

  // Break caught: the settings the driver is given not being what the guard checked. What a client built
  // from them connects as must be the target `parsePostgresUrl` reports, field for field.
  it.each(ACCEPTED)('connects as the checked target for %s', (_label, url) => {
    const target = parsePostgresUrl(url);
    expect(target).toBeDefined();
    expect(connectsAs(postgresConnectionSettings(url))).toEqual({
      user: target?.user,
      host: target?.host,
      port: target?.port,
      database: target?.database,
    });
  });

  // Break caught: the new reading changing what an ordinary URL means. For URLs with nothing in them the
  // driver would reinterpret, the driver's own reading and ours name the same identity.
  it.each(ACCEPTED.filter(([label]) => label !== 'no password'))(
    'agrees with the driver on %s',
    (_label, url) => {
      expect(connectsAs(postgresConnectionSettings(url))).toEqual(driverReads(url));
    },
  );

  // Break caught: ambient PG* variables deciding what an omitted part means. A URL with no port names 5432;
  // a variable in the environment must not turn that into another port.
  it('is not changed by the driver ambient PG* variables', () => {
    vi.stubEnv('PGHOST', 'elsewhere.example');
    vi.stubEnv('PGPORT', '9999');
    vi.stubEnv('PGUSER', 'postgres');
    vi.stubEnv('PGDATABASE', 'other');
    expect(connectsAs(postgresConnectionSettings('postgres://u:p@localhost/melarc_dev'))).toEqual({
      user: 'u',
      host: 'localhost',
      port: 5432,
      database: 'melarc_dev',
    });
  });

  // Break caught: a connection string reaching the driver, which would read the query string again.
  it('hands the driver no connection string', () => {
    expect(postgresConnectionSettings(BASE)).not.toHaveProperty('connectionString');
  });

  // Break caught: a refusal that repeats the URL, with the password, or the supplied host, user or
  // database, in its message or anywhere on the error.
  it('names the problem in fixed text and never repeats the URL', () => {
    const url =
      'postgres://user-canary:PASSWORD-CANARY@host-canary.internal:6432/database-canary?user=option-canary';
    let error: unknown;
    try {
      postgresConnectionSettings(url);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PostgresUrlError);
    const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`;
    expect(text).toMatch(/query string/);
    for (const canary of [
      'PASSWORD-CANARY',
      'user-canary',
      'host-canary',
      'database-canary',
      'option-canary',
      '6432',
    ]) {
      expect(text).not.toContain(canary);
    }
  });

  // Break caught: a text that is not a usable URL being described with the text itself, which leaks
  // whatever was pasted into the wrong variable.
  it.each(['MIGRATION-SECRET-PW', 'mysql://u:SECRET@h/db', 'postgres://u:SECRET@/db'])(
    'describes %j without repeating it',
    (url) => {
      const problem = postgresUrlProblem(url);
      expect(problem).toBeDefined();
      expect(problem).not.toContain('SECRET');
      expect(problem).not.toContain(url);
    },
  );

  it('describes an empty value as unreadable', () => {
    expect(postgresUrlProblem('')).toMatch(/not a readable URL/);
  });
});
