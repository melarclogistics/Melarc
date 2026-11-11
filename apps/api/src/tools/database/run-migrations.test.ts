import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENGINEERING_DEFAULTS } from '../../platform/config/config-settings.js';
import { PostgresUrlError } from '../../platform/database/postgres-url.js';
import {
  DEFAULT_KEY_WAIT,
  KEY_WAIT_PATIENCE_MS,
  MigrationKeyWaitError,
  applicationLockTimeoutOf,
  beginAndTakeKeys,
  describeLockTimeoutUsed,
  describeRun,
  keyWaitFor,
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
  // Every attempt waits for less than the application's own lock timeout (here its default, 2 s): see `keyWaitFor`.
  const SETTINGS = {
    applicationLockTimeoutMs: 2_000,
    waitMs: 1_500,
    attempts: 3,
    pauseMs: 500,
    runWaitMs: 60_000,
  };

  /** Records what it is sent; the call of the primitive is answered by the next outcome, the rest by an empty result. */
  class RecordingClient {
    readonly sent: { readonly text: string; readonly values: unknown[] | undefined }[] = [];
    constructor(
      private readonly outcomes: (
        'ok' | 'lock timeout' | 'statement timeout' | 'another failure'
      )[],
    ) {}
    query(text: string, values?: unknown[]): Promise<unknown> {
      this.sent.push({ text: text.replaceAll(/\s+/g, ' ').trim(), values });
      if (text.includes('melarc.lock_policy_keys')) {
        const outcome = this.outcomes.shift() ?? 'ok';
        if (outcome === 'lock timeout') {
          return Promise.reject(
            Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
          );
        }
        if (outcome === 'statement timeout') {
          return Promise.reject(
            Object.assign(new Error('canceling statement due to statement timeout'), {
              code: '57014',
            }),
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
  // key wait for the whole of its work. Run 7, Stage 3.1: the bound of the whole call is a `statement_timeout` (the primitive takes the keys one at a time, and a `lock_timeout`
  // applies to each lock it waits for, holding the keys it already took), and it is given back once the call has returned.
  it('begins, bounds the wait for the keys as a whole, takes them, and returns the run to its own bound', async () => {
    const client = new RecordingClient(['ok']);

    const taken = await beginAndTakeKeys(client, KEYS, SETTINGS, () => Promise.resolve());

    expect(client.texts).toEqual([
      'begin',
      "set local lock_timeout = '1500ms'",
      "set local statement_timeout = '1500ms'",
      'select melarc.lock_policy_keys($1::uuid[], $2::text[])',
      'set local statement_timeout = default',
      "set local lock_timeout = '60000ms'",
    ]);
    expect(client.sent[3]?.values).toEqual([KEYS.bundleIds, KEYS.fixedTypes]);
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
    expect(pauses).toEqual([500, 500]);
    expect(client.texts.filter((text) => text === 'begin')).toHaveLength(3);
    expect(client.texts.filter((text) => text === 'rollback')).toHaveLength(2);
    // The transaction that holds the keys is the last one begun, and is still open.
    expect(client.texts.at(-1)).toBe("set local lock_timeout = '60000ms'");
  });

  // Break caught (run 7, Stage 3.1): a cancelled statement (57014, what the `statement_timeout` of the whole call raises) told as a failure that is not a wait, so that the first
  // attempt that outlasts the bound ends the run with the driver's words instead of being tried again after a pause.
  it('tries again, after a pause, when the whole call was cancelled by its statement timeout', async () => {
    const client = new RecordingClient(['statement timeout', 'lock timeout', 'ok']);
    const pauses: number[] = [];

    const taken = await beginAndTakeKeys(client, KEYS, SETTINGS, (ms) => {
      pauses.push(ms);
      return Promise.resolve();
    });

    expect(taken.attempts).toBe(3);
    expect(pauses).toEqual([500, 500]);
    expect(client.texts.filter((text) => text === 'rollback')).toHaveLength(2);
  });

  it('says in words that it waited, and not in the words of the driver, when every attempt was cancelled by its statement timeout', async () => {
    const client = new RecordingClient([
      'statement timeout',
      'statement timeout',
      'statement timeout',
    ]);

    const failure = await beginAndTakeKeys(client, KEYS, SETTINGS, () => Promise.resolve()).then(
      () => new Error('expected the wait to give up'),
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MigrationKeyWaitError);
    expect((failure as Error).message).toContain('3 attempts of 1500 ms');
    expect((failure as Error).message).toContain('Nothing was applied');
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
    expect(message).toContain('1500 ms');
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
    expect(taken).toEqual({ attempts: 0, takenAt: undefined, waitedMs: 0 });
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

  // Break caught (run 6, Stage 1.1): an attempt that waits as long as the application's own lock timeout, or longer. The run is a waiting exclusive request, so a sign-in or a
  // mutation that asks for the same key behind it queues behind it; if the attempt outlasts that request's lock timeout the request fails (a retryable 503) before the attempt
  // ends and lets it through. Every attempt waits for less, and a settings object that says otherwise is refused before anything is sent.
  it.each([
    ["a wait equal to the application's lock timeout", { ...SETTINGS, waitMs: 2_000 }],
    ['a wait of ten seconds, the figure of run 5', { ...SETTINGS, waitMs: 10_000 }],
    [
      "a wait that is not shorter than a smaller lock timeout of the application's",
      { ...SETTINGS, applicationLockTimeoutMs: 1_000, waitMs: 1_000 },
    ],
  ])('refuses %s, naming both figures, before it sends anything', async (_label, settings) => {
    const client = new RecordingClient([]);

    const failure = await beginAndTakeKeys(client, KEYS, settings, () => Promise.resolve()).then(
      () => new Error('expected the settings to be refused'),
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RangeError);
    expect((failure as Error).message).toContain(`${String(settings.waitMs)} ms`);
    expect((failure as Error).message).toContain(`${String(settings.applicationLockTimeoutMs)} ms`);
    expect(client.sent).toEqual([]);
  });

  it.each([
    ['not a whole number', 1_999.5],
    ['below the 100 ms the application allows', 99],
    ['above the 60000 ms the application allows', 60_001],
    ['not a number', Number.NaN],
  ])('refuses an application lock timeout that is %s', async (_label, applicationLockTimeoutMs) => {
    const client = new RecordingClient([]);

    await expect(
      beginAndTakeKeys(client, KEYS, { ...SETTINGS, applicationLockTimeoutMs, waitMs: 50 }, () =>
        Promise.resolve(),
      ),
    ).rejects.toThrow(RangeError);
    expect(client.sent).toEqual([]);
  });

  /** A client whose every call of the primitive costs what the server would have waited, on a clock the test holds. */
  class TimedClient extends RecordingClient {
    time = 1_000;
    override query(text: string, values?: unknown[]): Promise<unknown> {
      if (text.includes('melarc.lock_policy_keys')) this.time += SETTINGS.waitMs;
      return super.query(text, values);
    }
  }

  // Break caught (run 6, Stage 1.1): a run that reports how long it held the keys and nothing of how long it waited for them, so that the stall a release caused is
  // under-reported by every attempt that timed out and every pause between them.
  it('counts what it waited in all, the attempts that timed out and the pauses between them included', async () => {
    const client = new TimedClient(['lock timeout', 'lock timeout', 'ok']);

    const taken = await beginAndTakeKeys(
      client,
      KEYS,
      SETTINGS,
      (milliseconds) => {
        client.time += milliseconds;
        return Promise.resolve();
      },
      () => client.time,
    );

    // Three waits of 1500 ms and two pauses of 500 ms.
    expect(taken.waitedMs).toBe(5_500);
    expect(taken.takenAt).toBe(6_500);
    expect(taken.attempts).toBe(3);
  });

  // Break caught (run 6, Stage 1.1): a message that says how many attempts it made and not how long the release waited in all.
  it('says in its failure how long it waited in all', async () => {
    const client = new TimedClient(['lock timeout', 'lock timeout', 'lock timeout']);

    const failure = await beginAndTakeKeys(
      client,
      KEYS,
      SETTINGS,
      (milliseconds) => {
        client.time += milliseconds;
        return Promise.resolve();
      },
      () => client.time,
    ).then(
      () => new Error('expected the wait to give up'),
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MigrationKeyWaitError);
    expect((failure as MigrationKeyWaitError).waitedMs).toBe(5_500);
    expect((failure as MigrationKeyWaitError).message).toContain('after waiting 5.5 s in all');
    expect((failure as MigrationKeyWaitError).message).toContain('500 ms apart');
  });
});

/**
 * How long the run waits for its keys follows from how long the application waits for the same keys (run 6, Stage 1.1). The application takes its shared policy key under its
 * own `lock_timeout` (`DATABASE_LOCK_TIMEOUT_MS`, 2 s unless it is set), and a lock timeout there is a retryable 503, not a retry. A shared request queues behind a waiting
 * exclusive one, so the run's wait is a stall for the application too: it is kept shorter than the application's own, tried again after a pause, and said in the report.
 */
describe('keyWaitFor', () => {
  // Break caught: the defaults of run 5 (three attempts of ten seconds), which failed every request that queued behind the run for longer than 2 s.
  it("is attempts of 1.5 s, 0.5 s apart, fifteen of them, for the application's own default of 2 s", () => {
    expect(Number(ENGINEERING_DEFAULTS.DATABASE_LOCK_TIMEOUT_MS)).toBe(2_000);
    expect(keyWaitFor(2_000)).toEqual({
      applicationLockTimeoutMs: 2_000,
      waitMs: 1_500,
      pauseMs: 500,
      attempts: 15,
    });
    expect(DEFAULT_KEY_WAIT).toEqual(
      keyWaitFor(Number(ENGINEERING_DEFAULTS.DATABASE_LOCK_TIMEOUT_MS)),
    );
  });

  // Break caught: an attempt that is not shorter than the application's lock timeout for some setting of it, or a run that gives up much sooner or much later than thirty seconds.
  it.each([100, 101, 250, 999, 1_000, 2_000, 4_000, 5_000, 20_000, 60_000])(
    'waits less than %i ms an attempt, and about thirty seconds in all',
    (applicationLockTimeoutMs) => {
      const wait = keyWaitFor(applicationLockTimeoutMs);
      const cycle = wait.waitMs + wait.pauseMs;

      expect(wait.waitMs).toBeGreaterThanOrEqual(1);
      expect(wait.waitMs).toBeLessThan(applicationLockTimeoutMs);
      expect(wait.pauseMs).toBeGreaterThanOrEqual(1);
      expect(wait.attempts).toBeGreaterThanOrEqual(1);
      expect(wait.attempts * cycle).toBeGreaterThanOrEqual(KEY_WAIT_PATIENCE_MS);
      expect(wait.attempts * cycle).toBeLessThan(KEY_WAIT_PATIENCE_MS + cycle);
    },
  );

  it.each([99, 60_001, 1_999.5, Number.NaN])(
    'refuses a lock timeout of %s that the application would refuse',
    (applicationLockTimeoutMs) => {
      expect(() => keyWaitFor(applicationLockTimeoutMs)).toThrow(RangeError);
    },
  );
});

describe('applicationLockTimeoutOf', () => {
  it("is the application's own default when the environment of the run does not set it", () => {
    expect(applicationLockTimeoutOf({})).toBe(2_000);
    expect(applicationLockTimeoutOf({ DATABASE_LOCK_TIMEOUT_MS: '' })).toBe(2_000);
  });

  it("reads the application's setting from the environment of the run", () => {
    expect(applicationLockTimeoutOf({ DATABASE_LOCK_TIMEOUT_MS: '1500' })).toBe(1_500);
    expect(applicationLockTimeoutOf({ DATABASE_LOCK_TIMEOUT_MS: '60000' })).toBe(60_000);
  });

  // Break caught (run 7, Stage 3.2): a release step that lacks the setting falling back to 2000 ms, so that an API set lower than that finds every attempt of the run outlasting
  // what queues behind it. In a release (the migration URL is given) the setting is required, and the refusal names it and the reason.
  it.each([
    ['not set', {}],
    ['empty', { DATABASE_LOCK_TIMEOUT_MS: '' }],
  ])(
    'refuses, in a release, an environment where it is %s, and names the setting',
    (_label, environment) => {
      let failure: unknown;
      try {
        applicationLockTimeoutOf(environment, { release: true });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(RangeError);
      expect((failure as Error).message).toContain('DATABASE_LOCK_TIMEOUT_MS');
      expect((failure as Error).message).toContain('DATABASE_MIGRATION_URL');
    },
  );

  it('reads the setting in a release as it does elsewhere, and applies the same rules to it', () => {
    expect(applicationLockTimeoutOf({ DATABASE_LOCK_TIMEOUT_MS: '1500' }, { release: true })).toBe(
      1_500,
    );
    expect(() =>
      applicationLockTimeoutOf({ DATABASE_LOCK_TIMEOUT_MS: '99' }, { release: true }),
    ).toThrow(RangeError);
  });

  // Break caught: a run that starts without saying which lock timeout it keeps its waits shorter than, so that nobody reading the log of a release can see that the setting reached it.
  it('says which value it uses, and where it came from', () => {
    expect(describeLockTimeoutUsed(1_500, true)).toBe(
      "db:migrate: each wait for the policy keys is kept shorter than the application's lock timeout of 1500 ms (DATABASE_LOCK_TIMEOUT_MS)",
    );
    expect(describeLockTimeoutUsed(2_000, false)).toBe(
      "db:migrate: each wait for the policy keys is kept shorter than the application's lock timeout of 2000 ms (the application's default, because DATABASE_LOCK_TIMEOUT_MS is not set; a release must set it)",
    );
  });

  // Break caught: a value the application would refuse used for the run, so that the attempts are kept shorter than a figure nobody runs with.
  it.each(['soon', '99', '60001', ' 1500', '1e3', '2000ms', '-1', '1500.5', '0x10'])(
    'refuses %j, naming the setting and not what it held',
    (value) => {
      let failure: unknown;
      try {
        applicationLockTimeoutOf({ DATABASE_LOCK_TIMEOUT_MS: value });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(RangeError);
      expect((failure as Error).message).toContain('DATABASE_LOCK_TIMEOUT_MS');
      expect((failure as Error).message).not.toContain(value);
    },
  );
});

describe('describeRun', () => {
  const RUN = { keyAttempts: 1, applicationLockTimeoutMs: 2_000 };

  // Break caught: a tool that does not say how long the run took, how long it waited for its keys or how long it held them, so that nobody planning a release knows what the stall
  // costs; or one that says every sign-in and mutation waited as long as the run, when each fails once the application's lock timeout has passed.
  it('says what was applied, how long the run took, how long it waited for the keys and how long it held them, and what the application saw', () => {
    const line = describeRun({
      ...RUN,
      applied: 3,
      durationMs: 4_260,
      keyWaitMs: 140,
      keysHeldMs: 3_940,
    });

    expect(line).toBe(
      "applied 3 migrations in 4.3 s; waited 0.1 s for the policy keys and held them for 3.9 s; a sign-in or mutation held up by the run fails with a retryable 503 after the application's lock timeout of 2.0 s",
    );
  });

  // Break caught: a run that waited for its keys more than once reported as if it had not, hiding that a transaction of the application was in its way.
  it('says at which attempt the keys were taken when it was not the first, and how long the waiting was', () => {
    const line = describeRun({
      ...RUN,
      applied: 1,
      durationMs: 12_000,
      keyWaitMs: 5_400,
      keysHeldMs: 800,
      keyAttempts: 2,
    });

    expect(line).toContain('waited 5.4 s for the policy keys (taken at attempt 2)');
    expect(line).toContain('held them for 0.8 s');
  });

  // Break caught: a stall claimed for a run that took no key.
  it('says that no key was taken when none was, and that nothing was applied when the database is current', () => {
    expect(
      describeRun({
        ...RUN,
        applied: 1,
        durationMs: 250,
        keyWaitMs: 0,
        keysHeldMs: 0,
        keyAttempts: 0,
      }),
    ).toBe('applied 1 migration in 0.3 s; no policy key was taken');
    expect(
      describeRun({
        ...RUN,
        applied: 0,
        durationMs: 40,
        keyWaitMs: 0,
        keysHeldMs: 0,
        keyAttempts: 0,
      }),
    ).toBe('database is up to date, nothing applied');
  });
});
