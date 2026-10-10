import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { TestApp } from '../../src/test-support/test-app.js';
import { Admin } from './support/admin.js';
import { startIntegrationKit } from './support/integration.js';
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.10 correction F06: what the integration kit does when it cannot finish starting, and when it cannot finish stopping. The kit
 * opens an application, an administrator's connection and an observer's, in that order. If a step fails, whatever was opened is
 * closed; closing attempts every step whatever the others do, keeps the failures it meets, and does nothing a second time. The
 * database the kit was given is the caller's: the kit never drops it.
 *
 * `startTestApp` is wrapped here (and only in this file) so the application each kit starts can be watched, and its `stop` made to
 * fail after it has really stopped.
 */

const apps = vi.hoisted(() => ({
  started: [] as { readonly app: TestApp; readonly stop: ReturnType<typeof vi.fn> }[],
  failStop: undefined as Error | undefined,
}));

vi.mock('../../src/test-support/test-app.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/test-support/test-app.js')>();
  return {
    ...original,
    startTestApp: async (...args: Parameters<typeof original.startTestApp>) => {
      const app = await original.startTestApp(...args);
      const really = app.stop.bind(app);
      const stop = vi.fn(async () => {
        await really();
        if (apps.failStop !== undefined) throw apps.failStop;
      });
      app.stop = stop;
      apps.started.push({ app, stop });
      return app;
    },
  };
});

/** The sessions connected to the database, other than the one that asks. */
function sessionsOn(database: TestDatabase): Promise<number> {
  return withClient(database.urlFor('postgres'), async (client) =>
    Number(
      await scalar(
        client,
        'select count(*)::int from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [database.name],
      ),
    ),
  );
}

/** The sessions left once the server has noticed that its clients are gone: a backend leaves a moment after its client's socket does. */
async function sessionsLeftOn(database: TestDatabase): Promise<number> {
  const until = Date.now() + 5_000;
  let left = await sessionsOn(database);
  while (left > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    left = await sessionsOn(database);
  }
  return left;
}

const databaseExists = (database: TestDatabase): Promise<boolean> =>
  withClient(
    database.urlFor('postgres'),
    async (client) =>
      Number(
        await scalar(client, 'select count(*)::int from pg_database where datname = $1', [
          database.name,
        ]),
      ) === 1,
  );

/** A database whose second connection as the administrator goes to a database that is not there: the kit's third step fails. */
function observerCannotConnect(database: TestDatabase): TestDatabase {
  let administratorUrls = 0;
  return {
    ...database,
    urlFor: (login) => {
      if (login === 'postgres') {
        administratorUrls += 1;
        if (administratorUrls === 2) {
          return database
            .urlFor('postgres')
            .replace(`/${database.name}`, '/melarc_kit_no_such_database');
        }
      }
      return database.urlFor(login);
    },
  };
}

async function withDatabase(work: (database: TestDatabase) => Promise<void>): Promise<void> {
  const database = await createTestDatabase();
  apps.started.length = 0;
  apps.failStop = undefined;
  try {
    await work(database);
  } finally {
    apps.failStop = undefined;
    await database.drop();
  }
}

describe('a start that fails part-way', () => {
  // Break caught: the application and the administrator's connection, opened before the failing step, left open: a leaked
  // connection for every failed start, and the application's listener with them.
  it('closes the application and the connection it had opened, reports the failure itself, and leaves the database alone', async () => {
    await withDatabase(async (database) => {
      const failure = await startIntegrationKit(observerCannotConnect(database)).catch(
        (error: unknown) => error,
      );

      // The failure is the observer's connection to a database that is not there, not a wrapper around it.
      expect(serverErrorIn(failure)?.code).toBe('3D000');
      expect(failure).not.toBeInstanceOf(AggregateError);
      expect(apps.started).toHaveLength(1);
      expect(apps.started[0]?.stop).toHaveBeenCalledOnce();
      expect(await sessionsLeftOn(database)).toBe(0);
      // The database was the caller's: it is still there.
      expect(await databaseExists(database)).toBe(true);
    });
  });

  // Break caught: a close that fails hiding the failure that caused the cleanup, or ending the cleanup before the rest is closed.
  it('reports both the failure and a failure to close, and still closes the rest', async () => {
    await withDatabase(async (database) => {
      apps.failStop = new Error('the application would not stop');

      const failure = (await startIntegrationKit(observerCannotConnect(database)).catch(
        (error: unknown) => error,
      )) as AggregateError;

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toHaveLength(2);
      expect(serverErrorIn(failure.errors[0])?.code).toBe('3D000');
      expect(failure.errors[1]).toBe(apps.failStop);
      // The administrator's connection is closed although closing the application failed.
      expect(await sessionsLeftOn(database)).toBe(0);
    });
  });
});

describe('stop()', () => {
  // Break caught: a stop that ends at the first failure, which leaves the administrator's and the observer's connections open on
  // a database the file is about to drop.
  it('attempts every close when the first fails, reports that failure, and does nothing a second time', async () => {
    await withDatabase(async (database) => {
      const kit = await startIntegrationKit(database);
      apps.failStop = new Error('the application would not stop');

      await expect(kit.stop()).rejects.toBe(apps.failStop);

      expect(await sessionsLeftOn(database)).toBe(0);
      await expect(kit.admin.query('select 1')).rejects.toThrow();
      await expect(kit.observe.rows('select 1')).rejects.toThrow();
      // A later call (a file's `afterAll` after a test's own stop) neither closes again nor reports the failure again.
      await expect(kit.stop()).resolves.toBeUndefined();
      expect(apps.started[0]?.stop).toHaveBeenCalledOnce();
    });
  });

  // Break caught: several failures reported as the last of them, so a test that leaked two things is told about one.
  it('reports every failure when more than one close fails', async () => {
    await withDatabase(async (database) => {
      const kit = await startIntegrationKit(database);
      await kit.admin.breakWrites('hub');
      // The server ends the administrator's and the observer's sessions: the administrator can no longer mend the table it broke.
      await withClient(database.urlFor('postgres'), (client) =>
        client.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and usename = 'postgres' and pid <> pg_backend_pid()`,
          [database.name],
        ),
      );
      apps.failStop = new Error('the application would not stop');

      const failure = (await kit.stop().catch((error: unknown) => error)) as AggregateError;

      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors).toContain(apps.failStop);
      expect(failure.message).toContain('application');
      expect(await sessionsLeftOn(database)).toBe(0);
    });
  });

  it('stops quietly when nothing fails', async () => {
    await withDatabase(async (database) => {
      const kit = await startIntegrationKit(database);

      await expect(kit.stop()).resolves.toBeUndefined();

      expect(apps.started[0]?.stop).toHaveBeenCalledOnce();
      expect(await sessionsLeftOn(database)).toBe(0);
    });
  });
});

describe('Admin.close()', () => {
  // Break caught: a table that cannot be mended skipping the end of the connection, which leaks it.
  it('ends its connection even when it cannot mend a table it broke, and reports that', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('could not mend'));
    const end = vi.fn(() => Promise.resolve());
    const admin = new Admin({ query, end } as unknown as pg.Client);
    await admin.breakWrites('hub');

    await expect(admin.close()).rejects.toThrow('could not mend');

    expect(end).toHaveBeenCalledOnce();
  });

  // Break caught: one table that cannot be mended leaving the others broken.
  it('mends every table it broke even when one cannot be mended', async () => {
    const mended: string[] = [];
    const query = vi.fn((text: string) => {
      if (text.startsWith('drop trigger')) {
        mended.push(text);
        if (text.includes('"hub"')) return Promise.reject(new Error('could not mend hub'));
      }
      return Promise.resolve({ rows: [] });
    });
    const end = vi.fn(() => Promise.resolve());
    const admin = new Admin({ query, end } as unknown as pg.Client);
    await admin.breakWrites('hub');
    await admin.breakWrites('permission');

    await expect(admin.close()).rejects.toThrow('could not mend hub');

    expect(mended).toHaveLength(2);
    expect(end).toHaveBeenCalledOnce();
  });

  it('reports a failure to end the connection as well as a failure to mend', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('could not mend'));
    const end = vi.fn(() => Promise.reject(new Error('could not end')));
    const admin = new Admin({ query, end } as unknown as pg.Client);
    await admin.breakWrites('hub');

    const failure = (await admin.close().catch((error: unknown) => error)) as AggregateError;

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => (error as Error).message)).toEqual([
      'could not mend',
      'could not end',
    ]);
  });
});
