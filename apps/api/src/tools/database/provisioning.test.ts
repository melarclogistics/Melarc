import { describe, expect, it, vi } from 'vitest';

import { postgresConnectionSettings } from '../../platform/database/postgres-url.js';
import {
  buildDatabaseUrl,
  connectLocalAdmin,
  createDisposableDatabase,
  DISPOSABLE_MARKER,
  dropDisposableDatabase,
  listTestDatabases,
  type LocalAdmin,
  type SqlClient,
} from './provisioning.js';
import { UnsafeTargetError } from './safety.js';

const SETTINGS = {
  host: '127.0.0.1',
  port: 5432,
  adminPassword: 'admin-secret',
  migrationPassword: 'migration-secret',
  runtimePassword: 'runtime-secret',
};

/** An administrator whose every query fails the test: a refusal must happen before any statement is sent. */
function untouchableAdmin(host = '127.0.0.1'): {
  admin: LocalAdmin;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(() => Promise.reject(new Error('a refused target must not be queried')));
  return { admin: { client: { query }, host, close: () => Promise.resolve() }, query };
}

describe('buildDatabaseUrl', () => {
  // Break caught: a credential with URL-significant characters corrupting the URL, so the connection goes
  // to the wrong host or as the wrong user.
  it('encodes the user and password and round-trips through the URL parser', () => {
    const url = buildDatabaseUrl({
      host: '127.0.0.1',
      port: 5544,
      user: 'melarc_api_runtime',
      password: 'p@ss:/?#word',
      database: 'melarc_test_ab12cd34',
    });
    const parsed = new URL(url);
    expect(parsed.protocol).toBe('postgres:');
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(parsed.port).toBe('5544');
    expect(decodeURIComponent(parsed.username)).toBe('melarc_api_runtime');
    expect(decodeURIComponent(parsed.password)).toBe('p@ss:/?#word');
    expect(parsed.pathname).toBe('/melarc_test_ab12cd34');
  });

  const GOOD = {
    host: '127.0.0.1',
    port: 5432,
    user: 'melarc_api_runtime',
    password: 'p@ss:/?#word',
    database: 'melarc_test_ab12cd34',
  };

  // Break caught (audit F01): a URL that reads back as something other than the parts it was built from.
  // Every part has to come back exactly, whatever characters the user, password and database held.
  it.each([
    ['the parts of a local database', GOOD],
    ['an IPv6 host', { ...GOOD, host: '::1' }],
    [
      'a user and database that need escaping',
      { ...GOOD, user: 'we ird@user', database: 'a b?c#d' },
    ],
    ['an empty password', { ...GOOD, password: '' }],
  ])('builds a URL that reads back as %s', (_label, parts) => {
    const settings = postgresConnectionSettings(buildDatabaseUrl(parts));

    expect({ ...settings, password: settings.password ?? '' }).toEqual(parts);
  });

  // Break caught (audit F01): a part with URL syntax in it changing what the URL means. A host such as
  // "127.0.0.1?user=postgres" would add a query string, "a@b" would move the user, and neither is what was asked for.
  it.each([
    ['a query string in the host', { host: '127.0.0.1?user=postgres' }],
    ['a path in the host', { host: '127.0.0.1/other' }],
    ['a fragment in the host', { host: '127.0.0.1#x' }],
    ['an @ in the host', { host: 'user@127.0.0.1' }],
    ['a port in the host', { host: '127.0.0.1:6543' }],
    ['an IPv6 host the URL would rewrite', { host: '0:0:0:0:0:0:0:1' }],
    ['a port of zero', { port: 0 }],
    ['a fractional port', { port: 5432.5 }],
    ['an empty user', { user: '' }],
    ['an empty database', { database: '' }],
  ])('refuses %s instead of building a URL that means something else', (_label, part) => {
    const error = (() => {
      try {
        return buildDatabaseUrl({ ...GOOD, ...part });
      } catch (caught) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(UnsafeTargetError);
    expect(String(error)).not.toContain('p@ss');
  });
});

describe('connectLocalAdmin', () => {
  // Break caught: an administrator connection reaching a server that is not on this machine, which is how
  // a reset or a role rewrite lands on a shared or production cluster. The refusal must come before any
  // connection or name lookup.
  it.each(['db.internal', '10.0.0.5', 'localhost.evil.example', ''])(
    'refuses the non-local host %j without connecting',
    async (host) => {
      await expect(connectLocalAdmin({ ...SETTINGS, host })).rejects.toThrow(UnsafeTargetError);
    },
  );

  // Break caught: a destructive local command running with a deployed environment in scope.
  it.each(['staging', 'production'])('refuses APP_ENV=%s', async (appEnv) => {
    await expect(connectLocalAdmin(SETTINGS, { APP_ENV: appEnv })).rejects.toThrow(
      UnsafeTargetError,
    );
  });

  // Break caught: the refusal leaking the administrator password into the message.
  it('does not put a password in a refusal', async () => {
    const error = await connectLocalAdmin({ ...SETTINGS, host: 'db.internal' }).catch(
      (e: unknown) => e,
    );
    expect(String(error)).not.toContain('admin-secret');
  });
});

describe('dropDisposableDatabase', () => {
  // Break caught: a database that is not plainly a development or test one being dropped. Nothing may be
  // sent to the server for these, not even a lookup.
  it.each([
    'postgres',
    'template1',
    'melarc',
    'melarc_prod',
    'melarc_dev"; DROP DATABASE postgres; --',
  ])('refuses %j before sending a statement', async (name) => {
    const { admin, query } = untouchableAdmin();
    await expect(dropDisposableDatabase(admin, name)).rejects.toThrow(UnsafeTargetError);
    expect(query).not.toHaveBeenCalled();
  });

  // Break caught: the guard trusting the administrator's own host label and not refusing a remote one.
  it('refuses an administrator that is not on this machine', async () => {
    const { admin, query } = untouchableAdmin('db.internal');
    await expect(dropDisposableDatabase(admin, 'melarc_test_ab12cd34')).rejects.toThrow(
      UnsafeTargetError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  // Break caught: a database that merely has a disposable-looking name being dropped. Only one this tool
  // created, which carries the marker, may be.
  it('refuses a database that exists without the disposable marker', async () => {
    const query = vi.fn((text: string) =>
      Promise.resolve({
        rows: text.includes('shobj_description') ? [{ comment: 'someone elses data' }] : [],
      }),
    );
    const admin: LocalAdmin = {
      client: { query },
      host: '127.0.0.1',
      close: () => Promise.resolve(),
    };
    await expect(dropDisposableDatabase(admin, 'melarc_dev')).rejects.toThrow(UnsafeTargetError);
    const sent = query.mock.calls.map(([text]) => text).join('\n');
    expect(sent).not.toMatch(/drop\s+database/i);
    expect(sent).not.toMatch(/pg_terminate_backend/i);
  });

  // Break caught: a missing database turning a reset into an error.
  it('does nothing when the database does not exist', async () => {
    const query = vi.fn<SqlClient['query']>(() => Promise.resolve({ rows: [] }));
    const admin: LocalAdmin = {
      client: { query },
      host: '127.0.0.1',
      close: () => Promise.resolve(),
    };
    await expect(dropDisposableDatabase(admin, 'melarc_dev')).resolves.toBeUndefined();
    expect(query.mock.calls.map(([text]) => text).join('\n')).not.toMatch(/drop\s+database/i);
  });
});

describe('createDisposableDatabase', () => {
  // Break caught: a database with a production-looking name being created by a tool that can later drop it.
  it('refuses a name that is not disposable before sending a statement', async () => {
    const { admin, query } = untouchableAdmin();
    await expect(createDisposableDatabase(admin, 'melarc_prod')).rejects.toThrow(UnsafeTargetError);
    expect(query).not.toHaveBeenCalled();
  });

  // Break caught: adopting a database someone else made, which a later reset would then drop.
  it('refuses to adopt an existing database that has no marker', async () => {
    const query = vi.fn((text: string) =>
      Promise.resolve({
        rows: text.includes('shobj_description') ? [{ comment: null }] : [],
      }),
    );
    const admin: LocalAdmin = {
      client: { query },
      host: '127.0.0.1',
      close: () => Promise.resolve(),
    };
    await expect(createDisposableDatabase(admin, 'melarc_dev')).rejects.toThrow(UnsafeTargetError);
    expect(query.mock.calls.map(([text]) => text).join('\n')).not.toMatch(/create\s+database/i);
  });

  it('uses a marker that cannot be mistaken for an ordinary comment', () => {
    expect(DISPOSABLE_MARKER).toBe('melarc:disposable');
  });
});

describe('listTestDatabases (audit F07)', () => {
  // Break caught: the listing that people read before they delete anything also changing something. It sends
  // one read, and no statement that drops, terminates or alters.
  it('only reads, and reports how many sessions are connected to each database', async () => {
    const query = vi.fn<SqlClient['query']>(() =>
      Promise.resolve({
        rows: [
          { name: 'melarc_test_0a1b2c3d', sessions: 0 },
          { name: 'melarc_test_9f8e7d6c', sessions: 3 },
        ],
      }),
    );
    const admin: LocalAdmin = {
      client: { query },
      host: '127.0.0.1',
      close: () => Promise.resolve(),
    };

    const listed = await listTestDatabases(admin);

    expect(listed).toEqual([
      { name: 'melarc_test_0a1b2c3d', sessions: 0 },
      { name: 'melarc_test_9f8e7d6c', sessions: 3 },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.map(([text]) => text).join('\n')).not.toMatch(
      /drop\s+database|pg_terminate_backend|alter\s|create\s/i,
    );
  });

  // Break caught: the listing running against a server that is not on this machine.
  it('refuses an administrator that is not on this machine, without sending a statement', async () => {
    const { admin, query } = untouchableAdmin('db.internal');
    await expect(listTestDatabases(admin)).rejects.toThrow(UnsafeTargetError);
    expect(query).not.toHaveBeenCalled();
  });

  // Break caught: a database that merely looks like a test database being offered for deletion: the listing
  // asks the server for marked databases only, whatever the pattern.
  it('asks only for databases that carry the disposable marker', async () => {
    const query = vi.fn<SqlClient['query']>(() => Promise.resolve({ rows: [] }));
    const admin: LocalAdmin = {
      client: { query },
      host: '127.0.0.1',
      close: () => Promise.resolve(),
    };

    await listTestDatabases(admin);

    expect(query.mock.calls[0]?.[1]).toEqual([DISPOSABLE_MARKER]);
    expect(query.mock.calls[0]?.[0]).toContain('shobj_description');
  });
});

/** An administrator whose server answers the marker lookup and records everything else it is sent. */
function recordingAdmin(options: { marker?: string | null; refuseDropWith?: string } = {}) {
  const sent: string[] = [];
  const query = vi.fn<SqlClient['query']>((text, values) => {
    sent.push(text);
    if (text.includes('shobj_description')) {
      const marker = options.marker === undefined ? DISPOSABLE_MARKER : options.marker;
      return Promise.resolve({ rows: [{ comment: marker }] });
    }
    if (text.startsWith('select format(')) {
      const [template, args] = values as [string, string[]];
      return Promise.resolve({
        rows: [{ statement: template.replace('%I', `"${String(args[0])}"`) }],
      });
    }
    if (text.startsWith('DROP DATABASE') && options.refuseDropWith !== undefined) {
      return Promise.reject(Object.assign(new Error('in use'), { code: options.refuseDropWith }));
    }
    return Promise.resolve({ rows: [] });
  });
  const admin: LocalAdmin = {
    client: { query },
    host: '127.0.0.1',
    close: () => Promise.resolve(),
  };
  return { admin, sent };
}

describe('dropDisposableDatabase without disconnecting anyone (audit F07)', () => {
  // Break caught: a deliberate drop of a database that another run is using ending that run's sessions. The
  // server itself refuses to drop a database with sessions, so the refusal cannot race a new connection.
  it('asks the server for a plain drop, and ends no session', async () => {
    const { admin, sent } = recordingAdmin();

    await dropDisposableDatabase(admin, 'melarc_test_ab12cd34', { disconnect: false });

    expect(sent.join('\n')).not.toMatch(/pg_terminate_backend/i);
    expect(sent).toContain('DROP DATABASE "melarc_test_ab12cd34"');
    expect(sent.join('\n')).not.toMatch(/with\s*\(\s*force/i);
  });

  it('refuses, saying sessions are connected, when the server says the database is in use', async () => {
    const { admin, sent } = recordingAdmin({ refuseDropWith: '55006' });

    const error = await dropDisposableDatabase(admin, 'melarc_test_ab12cd34', {
      disconnect: false,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsafeTargetError);
    expect(String(error)).toMatch(/sessions are connected/);
    expect(sent.join('\n')).not.toMatch(/pg_terminate_backend/i);
  });

  it('lets any other failure through as it is', async () => {
    const { admin } = recordingAdmin({ refuseDropWith: '42501' });

    const error = await dropDisposableDatabase(admin, 'melarc_test_ab12cd34', {
      disconnect: false,
    }).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(UnsafeTargetError);
    expect((error as { code?: string }).code).toBe('42501');
  });

  // Break caught: the explicit option changing what a run does to its own database, which must still be dropped
  // while the API or a test holds a connection.
  it('still ends the sessions and forces the drop by default, as a run does for its own database', async () => {
    const { admin, sent } = recordingAdmin();

    await dropDisposableDatabase(admin, 'melarc_test_ab12cd34');

    expect(sent.join('\n')).toMatch(/pg_terminate_backend/i);
    expect(sent.join('\n')).toMatch(
      /DROP DATABASE IF EXISTS "melarc_test_ab12cd34" WITH \(FORCE\)/,
    );
  });
});
