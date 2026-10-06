import { describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig, type ConfigProblem } from './load-config.js';

const RUNTIME_URL = 'postgres://melarc_api_runtime:CHANGE_ME@127.0.0.1:5432/melarc_dev';

const MINIMAL_ENV = {
  NODE_ENV: 'development',
  APP_ENV: 'local',
  HTTP_PORT: '3000',
  DATABASE_URL: RUNTIME_URL,
};

/** Problems reported for a rejected environment; fails the test if it was accepted. */
function problemsFor(env: Record<string, string | undefined>): readonly ConfigProblem[] {
  const result = loadConfig(env);
  if (result.ok) throw new Error('expected the environment to be rejected');
  return result.problems;
}

describe('loadConfig: accepted environments', () => {
  // Break caught: a key mapped to the wrong field, or a number left as a string.
  it('maps a complete environment onto the typed configuration', () => {
    const result = loadConfig({
      NODE_ENV: 'production',
      APP_ENV: 'staging',
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: '8080',
      LOG_LEVEL: 'debug',
      SHUTDOWN_TIMEOUT_MS: '30000',
      SHUTDOWN_DRAIN_DELAY_MS: '5000',
      DATABASE_URL: 'postgresql://melarc_api_runtime:s3cret@db.internal:6432/melarc',
      DATABASE_POOL_MAX: '25',
    });
    const expected: AppConfig = {
      nodeEnv: 'production',
      appEnv: 'staging',
      http: { host: '0.0.0.0', port: 8080 },
      logLevel: 'debug',
      shutdown: { timeoutMs: 30000, drainDelayMs: 5000 },
      database: {
        url: 'postgresql://melarc_api_runtime:s3cret@db.internal:6432/melarc',
        poolMax: 25,
      },
    };
    expect(result).toEqual({ ok: true, config: expected });
  });

  // Break caught: a default changed, or applied where the operator set a value.
  it('applies the documented defaults for optional keys', () => {
    const result = loadConfig(MINIMAL_ENV);
    const expected: AppConfig = {
      nodeEnv: 'development',
      appEnv: 'local',
      http: { host: '127.0.0.1', port: 3000 },
      logLevel: 'info',
      shutdown: { timeoutMs: 15000, drainDelayMs: 0 },
      database: { url: RUNTIME_URL, poolMax: 10 },
    };
    expect(result).toEqual({ ok: true, config: expected });
  });

  // Break caught: a local run in production mode being refused, which would block prod-like local runs.
  it('lets a local environment run with any NODE_ENV', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(loadConfig({ ...MINIMAL_ENV, NODE_ENV: nodeEnv }).ok).toBe(true);
    }
  });

  // Break caught: unrelated variables (a cloud token, a session secret) failing or leaking into the result.
  it('ignores variables it does not own and does not carry them into the result', () => {
    const result = loadConfig({
      ...MINIMAL_ENV,
      SESSION_SECRET: 'hunter2',
      AWS_SECRET_ACCESS_KEY: 'AKIAEXAMPLEKEY0000',
      PATH: '/usr/bin',
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('AKIAEXAMPLEKEY0000');
  });

  // Break caught: the shared configuration being mutated at runtime by one module.
  it('returns a configuration that cannot be modified', () => {
    const result = loadConfig(MINIMAL_ENV);
    if (!result.ok) throw new Error('expected the environment to be accepted');
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config.http)).toBe(true);
    expect(Object.isFrozen(result.config.shutdown)).toBe(true);
    expect(Object.isFrozen(result.config.database)).toBe(true);
  });
});

describe('loadConfig: refused environments', () => {
  // Break caught: a required key silently defaulted, so the API boots in a mode nobody chose.
  it.each(['NODE_ENV', 'APP_ENV', 'HTTP_PORT', 'DATABASE_URL'])('refuses a missing %s', (key) => {
    const env = Object.fromEntries(Object.entries(MINIMAL_ENV).filter(([name]) => name !== key));
    expect(problemsFor(env)).toEqual([expect.objectContaining({ key, problem: 'missing' })]);
  });

  // Break caught: lenient parsing (Number('abc'), parseInt('80abc')) turning garbage into a working value.
  it.each([
    ['HTTP_PORT', '0'],
    ['HTTP_PORT', '65536'],
    ['HTTP_PORT', 'abc'],
    ['HTTP_PORT', '80abc'],
    ['HTTP_PORT', '80.5'],
    ['HTTP_PORT', '-1'],
    ['HTTP_PORT', ' 80'],
    ['HTTP_PORT', ''],
    ['NODE_ENV', 'staging'],
    ['APP_ENV', 'prod'],
    ['LOG_LEVEL', 'verbose'],
    ['HTTP_HOST', ''],
    ['HTTP_HOST', 'host name'],
    ['SHUTDOWN_TIMEOUT_MS', '15'],
    ['SHUTDOWN_TIMEOUT_MS', '300001'],
    ['SHUTDOWN_TIMEOUT_MS', 'soon'],
    ['SHUTDOWN_DRAIN_DELAY_MS', '1.5'],
    ['SHUTDOWN_DRAIN_DELAY_MS', '60001'],
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_POOL_MAX', '101'],
    ['DATABASE_POOL_MAX', '10.5'],
    ['DATABASE_POOL_MAX', 'many'],
    ['DATABASE_POOL_MAX', ''],
  ])('refuses %s=%j', (key, value) => {
    expect(problemsFor({ ...MINIMAL_ENV, [key]: value })).toEqual([
      expect.objectContaining({ key, problem: 'invalid' }),
    ]);
  });

  // Break caught: an unusable or unsafe database address being accepted. The API connects with its own
  // runtime identity only (SECURITY_DESIGN.md section 14.17): never the migration identity, the owner or
  // the cluster superuser, whatever the URL otherwise looks like.
  it.each([
    ['a URL with another scheme', 'mysql://melarc_api_runtime@127.0.0.1/melarc'],
    ['no URL at all', 'not a url'],
    ['no host', 'postgres://melarc_api_runtime@/melarc'],
    ['no database', 'postgres://melarc_api_runtime@127.0.0.1:5432'],
    ['an empty database name', 'postgres://melarc_api_runtime@127.0.0.1:5432/'],
    ['no user', 'postgres://127.0.0.1:5432/melarc'],
    ['the migration identity', 'postgres://melarc_migration_elevated:x@127.0.0.1/melarc'],
    ['the owner', 'postgres://melarc_owner:x@127.0.0.1/melarc'],
    ['the cluster superuser', 'postgres://postgres:x@127.0.0.1/melarc'],
    ['another runtime identity', 'postgres://melarc_worker_runtime:x@127.0.0.1/melarc'],
  ])('refuses DATABASE_URL with %s', (_label, url) => {
    expect(problemsFor({ ...MINIMAL_ENV, DATABASE_URL: url })).toEqual([
      expect.objectContaining({ key: 'DATABASE_URL', problem: 'invalid' }),
    ]);
  });

  // Break caught (audit F01): a URL whose authority names the runtime identity but whose query string makes
  // the driver connect as another. The configuration check approved one identity and the driver used
  // another. Connection options are refused outright, whatever they hold, and none is silently dropped.
  it.each([
    ['a user override', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?user=postgres'],
    ['a host override', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?host=db.example'],
    ['a port override', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?port=6543'],
    ['a repeated user', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?user=a&user=postgres'],
    ['an encoded option name', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?%75ser=postgres'],
    ['a TLS option', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?sslmode=require'],
    ['a role option', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?options=-c%20role%3Dx'],
    ['an empty query string', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc?'],
    ['a fragment', 'postgres://melarc_api_runtime:x@127.0.0.1/melarc#x'],
    ['a port of zero', 'postgres://melarc_api_runtime:x@127.0.0.1:0/melarc'],
    ['an escaped host', 'postgres://melarc_api_runtime:x@%2Fvar%2Frun%2Fpostgresql/melarc'],
  ])('refuses DATABASE_URL with %s', (_label, url) => {
    expect(problemsFor({ ...MINIMAL_ENV, DATABASE_URL: url })).toEqual([
      {
        key: 'DATABASE_URL',
        problem: 'invalid',
        expected: expect.stringContaining('no query string') as string,
      },
    ]);
  });

  // Break caught: migration credentials present in the API's environment at all. Even unused they would
  // sit one config change away from being the runtime connection, and the migration identity must exist
  // only for the deployment window (MIGRATION_AND_SEEDING.md section 5.1).
  it('refuses an environment that carries the migration database URL', () => {
    const env = {
      ...MINIMAL_ENV,
      DATABASE_MIGRATION_URL: 'postgres://melarc_migration_elevated:x@127.0.0.1/melarc_dev',
    };
    expect(problemsFor(env)).toEqual([
      expect.objectContaining({ key: 'DATABASE_MIGRATION_URL', problem: 'invalid' }),
    ]);
  });

  // Break caught: an empty value, as left by a copied .env template, counted as migration credentials.
  it('accepts an empty migration database URL as absent', () => {
    expect(loadConfig({ ...MINIMAL_ENV, DATABASE_MIGRATION_URL: '' }).ok).toBe(true);
  });

  // Break caught: staging or production running in a development mode (§12.3: no development bypass).
  it.each([
    ['staging', 'development'],
    ['staging', 'test'],
    ['production', 'development'],
    ['production', 'test'],
  ])('refuses APP_ENV=%s with NODE_ENV=%s', (appEnv, nodeEnv) => {
    expect(problemsFor({ ...MINIMAL_ENV, APP_ENV: appEnv, NODE_ENV: nodeEnv })).toEqual([
      expect.objectContaining({ key: 'NODE_ENV', problem: 'invalid' }),
    ]);
  });

  // Break caught: a drain delay that consumes the whole shutdown budget, so every shutdown is forced.
  it('refuses a drain delay that is not shorter than the shutdown timeout', () => {
    const env = { ...MINIMAL_ENV, SHUTDOWN_TIMEOUT_MS: '5000', SHUTDOWN_DRAIN_DELAY_MS: '5000' };
    expect(problemsFor(env)).toEqual([
      expect.objectContaining({ key: 'SHUTDOWN_DRAIN_DELAY_MS', problem: 'invalid' }),
    ]);
  });

  // Break caught: an implementation that stops at the first problem.
  it('reports every invalid key, not only the first', () => {
    const keys = problemsFor({
      NODE_ENV: 'x',
      APP_ENV: 'y',
      HTTP_PORT: 'z',
      LOG_LEVEL: 'w',
      DATABASE_URL: 'v',
    })
      .map((problem) => problem.key)
      .toSorted();
    expect(keys).toEqual(['APP_ENV', 'DATABASE_URL', 'HTTP_PORT', 'LOG_LEVEL', 'NODE_ENV']);
  });

  // Break caught: error output echoing what was supplied, which leaks a secret pasted into the wrong
  // variable, or the password inside a rejected database URL.
  it('never echoes a rejected value', () => {
    const secrets = ['hunter2-secret', 's3cr3t-token-value', 'AKIAEXAMPLEKEY0000'];
    const problems = problemsFor({
      NODE_ENV: secrets[0],
      APP_ENV: secrets[1],
      HTTP_PORT: secrets[2],
      LOG_LEVEL: 'sk_live_should_not_appear',
      DATABASE_URL: 'postgres://postgres:URL-PASSWORD-VALUE@prod-db.internal/melarc',
      DATABASE_MIGRATION_URL:
        'postgres://melarc_migration_elevated:MIGRATION-PASSWORD@prod-db/melarc',
    });
    const serialised = JSON.stringify(problems);
    for (const secret of [
      ...secrets,
      'sk_live_should_not_appear',
      'URL-PASSWORD-VALUE',
      'MIGRATION-PASSWORD',
      'prod-db',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  // Break caught: the refusal of a URL with a query string repeating the query string, or the password
  // next to it. The report names the key and static text only.
  it('never echoes a rejected database URL with connection options', () => {
    const problems = problemsFor({
      ...MINIMAL_ENV,
      DATABASE_URL:
        'postgres://melarc_api_runtime:URL-PASSWORD-VALUE@host-canary.internal/melarc?user=OPTION-CANARY',
    });
    const serialised = JSON.stringify(problems);
    for (const secret of ['URL-PASSWORD-VALUE', 'host-canary', 'OPTION-CANARY']) {
      expect(serialised).not.toContain(secret);
    }
  });

  // Break caught: a problem with no hint of what a valid value looks like.
  it('says what is expected for each invalid key', () => {
    const [problem] = problemsFor({ ...MINIMAL_ENV, HTTP_PORT: 'abc' });
    expect(problem?.expected).toBe('an integer from 1 to 65535');
    const [database] = problemsFor({ ...MINIMAL_ENV, DATABASE_URL: 'nope' });
    expect(database?.expected).toBe(
      'a postgres:// or postgresql:// URL naming a host, one database and the user melarc_api_runtime, with no query string or fragment',
    );
  });
});
