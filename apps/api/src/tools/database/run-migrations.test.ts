import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PostgresUrlError } from '../../platform/database/postgres-url.js';
import {
  MigrationKeyWaitError,
  beginAndTakeKeys,
  describeRun,
  runMigrations,
} from './run-migrations.js';
import { UnsafeTargetError } from './safety.js';

/**
 * Nothing listens on port 1. A run that got as far as connecting would fail with a connection error, so
 * every refusal below is told apart from a connection failure by its own error type.
 */
const MIGRATION = 'postgres://melarc_migration_elevated:SECRET-PW@127.0.0.1:1/melarc_dev';

async function failureOf(url: string): Promise<unknown> {
  return runMigrations({ url }).then(
    () => new Error('expected the run to be refused'),
    (error: unknown) => error,
  );
}

describe('runMigrations: what it refuses before it connects', () => {
  // Break caught (audit F01): a migration URL whose authority names the migration identity while its query
  // string makes the driver connect as another. The identity check approved one user and the driver used
  // another, and migrations create objects owned by whoever runs them.
  it.each([
    ['a user override', `${MIGRATION}?user=postgres`],
    ['a host override', `${MIGRATION}?host=db.example`],
    ['a port override', `${MIGRATION}?port=6543`],
    ['a repeated user', `${MIGRATION}?user=a&user=postgres`],
    ['an encoded option name', `${MIGRATION}?%75ser=postgres`],
    ['a TLS option', `${MIGRATION}?sslmode=require`],
    ['an empty query string', `${MIGRATION}?`],
    ['a fragment', `${MIGRATION}#section`],
  ])('refuses a URL with %s, and does not say what it held', async (_label, url) => {
    const error = await failureOf(url);

    expect(error).toBeInstanceOf(PostgresUrlError);
    expect(String(error)).not.toContain('SECRET-PW');
    expect(String(error)).not.toContain('127.0.0.1');
  });

  // Break caught (audit F01): the reverse of the above. An authority that names the runtime identity with a
  // query string that names the migration identity is refused as well: neither reading is trusted.
  it('refuses the runtime identity that a query string renames to the migration identity', async () => {
    const error = await failureOf(
      'postgres://melarc_api_runtime:SECRET-PW@127.0.0.1:1/melarc_dev?user=melarc_migration_elevated',
    );

    expect(error).toBeInstanceOf(PostgresUrlError);
  });

  // Break caught: the identity check lost in the change. Migrations still run as the migration identity only.
  it.each(['melarc_api_runtime', 'melarc_owner', 'postgres'])(
    'still refuses the user %s',
    async (user) => {
      const error = await failureOf(`postgres://${user}:SECRET-PW@127.0.0.1:1/melarc_dev`);

      expect(error).toBeInstanceOf(UnsafeTargetError);
      expect(String(error)).not.toContain('SECRET-PW');
    },
  );

  it.each(['not a url', 'mysql://melarc_migration_elevated@127.0.0.1/melarc_dev'])(
    'refuses %j as a URL it cannot use',
    async (url) => {
      expect(await failureOf(url)).toBeInstanceOf(PostgresUrlError);
    },
  );

  describe('what the driver is given', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Break caught (audit F01): the client being built from the URL string, which the driver reads again.
    // Whatever the URL holds, the driver is given the settings that were checked and nothing else, and what
    // is escaped in the URL arrives decoded. The client is replaced by one that stops before connecting, so
    // that what it was given can be read without a server.
    it('is the checked settings, decoded, and no connection string', async () => {
      const configs: pg.ClientConfig[] = [];
      class StopsBeforeConnecting {
        constructor(config: pg.ClientConfig) {
          configs.push(config);
        }
        connect(): Promise<never> {
          return Promise.reject(new Error('stopped before connecting'));
        }
      }
      vi.spyOn(pg, 'Client').mockImplementation(
        StopsBeforeConnecting as unknown as typeof pg.Client,
      );

      await expect(
        runMigrations({
          url: 'postgres://melarc_migration_elevated:SECRET%40PW@localhost/melarc%5Fdev',
        }),
      ).rejects.toThrow('stopped before connecting');

      expect(configs).toStrictEqual([
        {
          host: 'localhost',
          port: 5432,
          user: 'melarc_migration_elevated',
          password: 'SECRET@PW',
          database: 'melarc_dev',
          application_name: 'melarc-migrate',
          connectionTimeoutMillis: 5_000,
        },
      ]);
    });
  });

  // Control for the refusals above: an acceptable URL is not refused. The run gets as far as connecting,
  // and what it reports is that nothing is listening, not a refusal.
  it('does not refuse the migration identity with nothing else in the URL', async () => {
    const error = await failureOf(MIGRATION);

    expect(error).not.toBeInstanceOf(PostgresUrlError);
    expect(error).not.toBeInstanceOf(UnsafeTargetError);
    expect((error as { code?: string }).code).toBe('ECONNREFUSED');
  });
});

/**
 * Taking the policy keys (run 5, Stage 1.3). The run takes every key its files name, exclusively, before its first statement, and keeps them to its commit: every
 * sign-in and every mutation of the application waits that long. The wait for the keys is bounded (a `SET LOCAL lock_timeout` for the wait alone), tried again a few times in a
 * new transaction, and said in words when it gives up; once the keys are held the run goes on under its own bound. A client that records what it is sent stands for the server.
 */
describe('beginAndTakeKeys', () => {
  const KEYS = {
    bundleIds: ['5eed0001-0000-4000-8000-000000000003'],
    fixedTypes: ['RIDER'] as const,
  };
  const SETTINGS = { waitMs: 10_000, attempts: 3, pauseMs: 2_000, runWaitMs: 60_000 };

  /** Records what it is sent; the call of the primitive is answered by the next outcome, the rest by an empty result. */
  class RecordingClient {
    readonly sent: { readonly text: string; readonly values: unknown[] | undefined }[] = [];
    constructor(private readonly outcomes: ('ok' | 'lock timeout' | 'another failure')[]) {}
    query(text: string, values?: unknown[]): Promise<unknown> {
      this.sent.push({ text: text.replaceAll(/\s+/g, ' ').trim(), values });
      if (text.includes('melarc.lock_policy_keys')) {
        const outcome = this.outcomes.shift() ?? 'ok';
        if (outcome === 'lock timeout') {
          return Promise.reject(
            Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
          );
        }
        if (outcome === 'another failure') {
          return Promise.reject(
            Object.assign(new Error('bundle locks are taken in ascending key order'), {
              code: '55000',
            }),
          );
        }
      }
      return Promise.resolve({ rows: [] });
    }
    get texts(): string[] {
      return this.sent.map((statement) => statement.text);
    }
  }

  // Break caught: the keys asked for with no bound of their own (a run that waits for ever behind a transaction that never ends), or a run left under the short bound of the
  // key wait for the whole of its work.
  it('begins, bounds the wait for the keys, takes them, and returns the run to its own bound', async () => {
    const client = new RecordingClient(['ok']);

    const taken = await beginAndTakeKeys(client, KEYS, SETTINGS, () => Promise.resolve());

    expect(client.texts).toEqual([
      'begin',
      "set local lock_timeout = '10000ms'",
      'select melarc.lock_policy_keys($1::uuid[], $2::text[])',
      "set local lock_timeout = '60000ms'",
    ]);
    expect(client.sent[2]?.values).toEqual([KEYS.bundleIds, KEYS.fixedTypes]);
    expect(taken.attempts).toBe(1);
    expect(taken.takenAt).toBeTypeOf('number');
  });

  // Break caught: a run that gives up at the first wait that times out, though the transaction in the way is only a sign-in that will end in a moment.
  it('tries again in a new transaction, after a pause, when the wait timed out', async () => {
    const client = new RecordingClient(['lock timeout', 'lock timeout', 'ok']);
    const pauses: number[] = [];

    const taken = await beginAndTakeKeys(client, KEYS, SETTINGS, (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    });

    expect(taken.attempts).toBe(3);
    expect(pauses).toEqual([2_000, 2_000]);
    expect(client.texts.filter((text) => text === 'begin')).toHaveLength(3);
    expect(client.texts.filter((text) => text === 'rollback')).toHaveLength(2);
    // The transaction that holds the keys is the last one begun, and is still open.
    expect(client.texts.at(-1)).toBe("set local lock_timeout = '60000ms'");
  });

  // Break caught: a run that gives up with the driver's "canceling statement due to lock timeout" and nothing else, so that nobody knows which lock, how long it waited,
  // that nothing was applied, or what to do. The message says all four, and no transaction is left open.
  it('says in words what it waited for, how long, that nothing was applied, and what to do, when every attempt timed out', async () => {
    const client = new RecordingClient(['lock timeout', 'lock timeout', 'lock timeout']);

    const failure = await beginAndTakeKeys(client, KEYS, SETTINGS, () => Promise.resolve()).then(
      () => new Error('expected the wait to give up'),
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MigrationKeyWaitError);
    const message = (failure as Error).message;
    expect(message).toContain('policy keys');
    expect(message).toContain('3 attempts');
    expect(message).toContain('10000 ms');
    expect(message).toContain('Nothing was applied');
    expect(message).toMatch(/try again|run it again/i);
    expect(client.texts.at(-1)).toBe('rollback');
  });

  // Break caught: a failure that is not a wait (the primitive refusing an order of keys, a lost connection) retried as if it were one, or told as a wait.
  it('does not retry a failure that is not a lock timeout, and rolls back', async () => {
    const client = new RecordingClient(['another failure']);

    const failure = await beginAndTakeKeys(client, KEYS, SETTINGS, () => Promise.resolve()).then(
      () => new Error('expected the failure'),
      (error: unknown) => error,
    );

    expect(failure).not.toBeInstanceOf(MigrationKeyWaitError);
    expect((failure as Error).message).toContain('ascending key order');
    expect(client.texts.filter((text) => text.includes('lock_policy_keys'))).toHaveLength(1);
    expect(client.texts.at(-1)).toBe('rollback');
  });

  // Break caught: a run that names no key asking for keys it does not need (and so stalling the application for nothing), or a bound set that nobody asked for.
  it('begins and takes nothing when the run names no key', async () => {
    const client = new RecordingClient([]);

    const taken = await beginAndTakeKeys(client, { bundleIds: [], fixedTypes: [] }, SETTINGS, () =>
      Promise.resolve(),
    );

    expect(client.texts).toEqual(['begin']);
    expect(taken).toEqual({ attempts: 0, takenAt: undefined });
  });

  // Break caught: a bound that is not a whole, positive number of milliseconds reaching the statement as text (the value is put into a `SET LOCAL`, which takes no parameter).
  it.each([
    ['a wait of zero', { ...SETTINGS, waitMs: 0 }],
    ['a wait that is not a number', { ...SETTINGS, waitMs: Number.NaN }],
    ['no attempts', { ...SETTINGS, attempts: 0 }],
    ['a fractional attempt count', { ...SETTINGS, attempts: 1.5 }],
    ['a negative pause', { ...SETTINGS, pauseMs: -1 }],
  ])('refuses %s before it sends anything', async (_label, settings) => {
    const client = new RecordingClient([]);

    await expect(beginAndTakeKeys(client, KEYS, settings, () => Promise.resolve())).rejects.toThrow(
      RangeError,
    );
    expect(client.sent).toEqual([]);
  });
});

describe('describeRun', () => {
  // Break caught: a tool that does not say how long the run took or how long the application waited for it, so that nobody planning a release knows what the stall costs.
  it('says what was applied, how long the run took, and how long every sign-in and mutation waited for the keys', () => {
    const line = describeRun({ applied: 3, durationMs: 4_260, keysHeldMs: 3_940, keyAttempts: 1 });

    expect(line).toBe(
      'applied 3 migrations in 4.3 s; the policy keys were held for 3.9 s, and every sign-in and mutation of the application waited that long',
    );
  });

  // Break caught: a run that waited for its keys more than once reported as if it had not, hiding that a transaction of the application was in its way.
  it('says at which attempt the keys were taken when it was not the first', () => {
    expect(
      describeRun({ applied: 1, durationMs: 12_000, keysHeldMs: 800, keyAttempts: 2 }),
    ).toContain('taken at attempt 2');
  });

  // Break caught: a stall claimed for a run that took no key.
  it('says that no key was taken when none was, and that nothing was applied when the database is current', () => {
    expect(describeRun({ applied: 1, durationMs: 250, keysHeldMs: 0, keyAttempts: 0 })).toBe(
      'applied 1 migration in 0.3 s; no policy key was taken',
    );
    expect(describeRun({ applied: 0, durationMs: 40, keysHeldMs: 0, keyAttempts: 0 })).toBe(
      'database is up to date, nothing applied',
    );
  });
});
