import { describe, expect, it } from 'vitest';

import { deployedEnv, RUNTIME_URL, randomKey, validEnv } from '../../test-support/config-env.js';
import { ENGINEERING_DEFAULTS, EXPECTED } from './config-settings.js';
import { KEY_PURPOSES, keyEnvName } from './key-material.js';
import { loadConfig, type AppConfig, type ConfigProblem } from './load-config.js';

/** Problems reported for a rejected environment; fails the test if it was accepted. */
function problemsFor(env: Record<string, string | undefined>): readonly ConfigProblem[] {
  const result = loadConfig(env);
  if (result.ok) throw new Error('expected the environment to be rejected');
  return result.problems;
}

function configFor(env: Record<string, string | undefined>): AppConfig {
  const result = loadConfig(env);
  if (!result.ok)
    throw new Error(`expected the environment to be accepted: ${JSON.stringify(result.problems)}`);
  return result.config;
}

const keysOf = (problems: readonly ConfigProblem[]): string[] =>
  problems.map((problem) => problem.key).toSorted();

/** Everything a deployment sets to avoid the test adapters. It still has no production key custody to name. */
const REAL_ADAPTERS = {
  DELIVERY_EMAIL_ADAPTER: 'provider',
  DELIVERY_EMAIL_ENDPOINT: 'https://email.provider.example/v1',
  DELIVERY_EMAIL_TIMEOUT_MS: '5000',
  DELIVERY_SMS_ADAPTER: 'provider',
  DELIVERY_SMS_ENDPOINT: 'https://sms.provider.example/v1',
  DELIVERY_SMS_TIMEOUT_MS: '5000',
  ATTESTATION_VERIFIER: 'service',
  ATTESTATION_VERIFIER_URL: 'https://verifier.internal.example',
  ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
  // The service is on another host, so its caller authenticates (SECURITY_DESIGN.md section 15.2.3).
  ATTESTATION_VERIFIER_CALLER_SECRET: randomKey(),
};

describe('loadConfig: accepted environments', () => {
  // Break caught: a key mapped to the wrong field, or a number left as a string.
  it('maps a complete environment onto the typed configuration', () => {
    const callerSecret = randomKey();
    const env = deployedEnv('staging', {
      HTTP_HOST: '0.0.0.0',
      HTTP_PORT: '8080',
      LOG_LEVEL: 'debug',
      SHUTDOWN_TIMEOUT_MS: '30000',
      SHUTDOWN_DRAIN_DELAY_MS: '5000',
      DATABASE_URL: 'postgresql://melarc_api_runtime:s3cret@db.internal:6432/melarc',
      DATABASE_POOL_MAX: '25',
      DATABASE_ACQUIRE_TIMEOUT_MS: '4000',
      DATABASE_LOCK_TIMEOUT_MS: '1500',
      DATABASE_STATEMENT_TIMEOUT_MS: '6000',
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '3000',
      DATABASE_TRANSACTION_TIMEOUT_MS: '12000',
      DATABASE_POOL_MAX_WAITERS: '30',
      REQUEST_EXECUTION_BUDGET_MS: '20000',
      HTTP_TRUST_PROXY: '10.0.0.0/8,192.168.1.5',
      HTTP_BODY_LIMIT_BYTES: '65536',
      HTTP_HEADER_TIMEOUT_MS: '8000',
      HTTP_BODY_TIMEOUT_MS: '9000',
      HTTP_ADMISSION_TIMEOUT_MS: '1500',
      HTTP_ADMISSION_CONCURRENCY: '32',
      ...REAL_ADAPTERS,
      ATTESTATION_VERIFIER_CALLER_SECRET: callerSecret,
    });
    const config = configFor(env);

    expect(config).toMatchObject({
      nodeEnv: 'production',
      appEnv: 'staging',
      composition: 'runtime',
      http: {
        host: '0.0.0.0',
        port: 8080,
        trustProxy: ['10.0.0.0/8', '192.168.1.5'],
        bodyLimitBytes: 65536,
        headerTimeoutMs: 8000,
        bodyTimeoutMs: 9000,
        admissionTimeoutMs: 1500,
        admissionConcurrency: 32,
      },
      logLevel: 'debug',
      shutdown: { timeoutMs: 30000, drainDelayMs: 5000 },
      database: {
        url: 'postgresql://melarc_api_runtime:s3cret@db.internal:6432/melarc',
        poolMax: 25,
        deadlines: {
          acquireTimeoutMs: 4000,
          lockTimeoutMs: 1500,
          statementTimeoutMs: 6000,
          idleInTransactionTimeoutMs: 3000,
          transactionTimeoutMs: 12000,
          maxWaiters: 30,
        },
      },
      execution: { requestBudgetMs: 20000 },
      origins: { ops: 'https://ops.melarc.example', vendor: 'https://vendor.melarc.example' },
      adapters: {
        limiter: 'postgres',
        delivery: {
          email: {
            kind: 'provider',
            endpoint: 'https://email.provider.example/v1',
            timeoutMs: 5000,
          },
          sms: { kind: 'provider', endpoint: 'https://sms.provider.example/v1', timeoutMs: 5000 },
        },
        attestationVerifier: {
          kind: 'service',
          url: 'https://verifier.internal.example',
          timeoutMs: 3000,
        },
      },
    });
    expect(config.links.ops.recovery).toBe(
      'https://ops.melarc.example/recovery/complete#token={token}',
    );
    expect(config.links.vendor.setupDevice).toBe(
      'https://vendor.melarc.example/setup/device#token={token}',
    );
    expect(config.adapters.attestationVerifier).toMatchObject({ kind: 'service' });
    const verifier = config.adapters.attestationVerifier;
    expect(verifier.kind === 'service' ? verifier.callerSecret?.reveal() : undefined).toBe(
      callerSecret,
    );
  });

  // Break caught: key material read into the wrong purpose or version, or lost.
  it('keeps every version of every purpose, and the one in use', () => {
    const [first, second, other] = [randomKey(), randomKey(), randomKey()];
    const config = configFor(
      validEnv({
        KEY_TOTP_SEED_MATERIAL: `1:${first},2:${second}`,
        KEY_TOTP_SEED_ACTIVE_VERSION: '2',
        KEY_PASSWORD_PEPPER_MATERIAL: `7:${other}`,
        KEY_PASSWORD_PEPPER_ACTIVE_VERSION: '7',
      }),
    );

    expect(config.keys.custody).toBe('local');
    if (config.keys.custody !== 'local') throw new Error('expected local custody');
    const { totp_seed: totp, password_pepper: pepper } = config.keys.purposes;
    expect(totp.activeVersion).toBe(2);
    expect(totp.versions[1]?.reveal()).toBe(first);
    expect(totp.versions[2]?.reveal()).toBe(second);
    expect(pepper.activeVersion).toBe(7);
    expect(pepper.versions[7]?.reveal()).toBe(other);
    expect(Object.keys(config.keys.purposes)).toEqual([...KEY_PURPOSES]);
  });

  // Break caught: a default changed, or applied where the operator set a value.
  it('applies the documented defaults for optional keys', () => {
    const config = configFor(validEnv());

    expect(config).toMatchObject({
      nodeEnv: 'development',
      appEnv: 'local',
      composition: 'runtime',
      http: {
        host: '127.0.0.1',
        port: 3000,
        trustProxy: [],
        bodyLimitBytes: Number(ENGINEERING_DEFAULTS.HTTP_BODY_LIMIT_BYTES),
        headerTimeoutMs: Number(ENGINEERING_DEFAULTS.HTTP_HEADER_TIMEOUT_MS),
        bodyTimeoutMs: Number(ENGINEERING_DEFAULTS.HTTP_BODY_TIMEOUT_MS),
        admissionTimeoutMs: Number(ENGINEERING_DEFAULTS.HTTP_ADMISSION_TIMEOUT_MS),
        admissionConcurrency: Number(ENGINEERING_DEFAULTS.HTTP_ADMISSION_CONCURRENCY),
      },
      logLevel: 'info',
      shutdown: { timeoutMs: 15000, drainDelayMs: 0 },
      database: {
        url: RUNTIME_URL,
        poolMax: 10,
        deadlines: {
          acquireTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_ACQUIRE_TIMEOUT_MS),
          lockTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_LOCK_TIMEOUT_MS),
          statementTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_STATEMENT_TIMEOUT_MS),
          idleInTransactionTimeoutMs: Number(
            ENGINEERING_DEFAULTS.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS,
          ),
          transactionTimeoutMs: Number(ENGINEERING_DEFAULTS.DATABASE_TRANSACTION_TIMEOUT_MS),
          maxWaiters: Number(ENGINEERING_DEFAULTS.DATABASE_POOL_MAX_WAITERS),
        },
      },
      execution: { requestBudgetMs: Number(ENGINEERING_DEFAULTS.REQUEST_EXECUTION_BUDGET_MS) },
      adapters: {
        limiter: 'postgres',
        delivery: { email: { kind: 'capture' }, sms: { kind: 'capture' } },
        attestationVerifier: { kind: 'substitute' },
      },
    });
  });

  // Break caught: the defaults themselves drifting out of the relations they must satisfy, so a deployment that sets nothing
  // is refused at start.
  it('has development defaults that satisfy their own relations', () => {
    const d = ENGINEERING_DEFAULTS;

    expect(Number(d.DATABASE_LOCK_TIMEOUT_MS)).toBeLessThan(
      Number(d.DATABASE_STATEMENT_TIMEOUT_MS),
    );
    expect(Number(d.DATABASE_STATEMENT_TIMEOUT_MS)).toBeLessThan(
      Number(d.DATABASE_TRANSACTION_TIMEOUT_MS),
    );
    expect(loadConfig(validEnv()).ok).toBe(true);
  });

  // Break caught: a local run in production mode being refused, which would block prod-like local runs.
  it('lets a local environment run with any NODE_ENV', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(loadConfig(validEnv({ NODE_ENV: nodeEnv })).ok).toBe(true);
    }
  });

  // Break caught: unrelated variables (a cloud token, a session secret) failing or leaking into the result.
  it('ignores variables it does not own and does not carry them into the result', () => {
    const result = loadConfig(
      validEnv({
        SESSION_SECRET: 'hunter2',
        AWS_SECRET_ACCESS_KEY: 'AKIAEXAMPLEKEY0000',
        PATH: '/usr/bin',
      }),
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    expect(JSON.stringify(result)).not.toContain('AKIAEXAMPLEKEY0000');
  });

  // Break caught: the shared configuration being mutated at runtime by one module.
  it('returns a configuration that cannot be modified, at every depth', () => {
    const config = configFor(validEnv());
    if (config.keys.custody !== 'local') throw new Error('expected local custody');

    for (const frozen of [
      config,
      config.http,
      config.http.trustProxy,
      config.shutdown,
      config.database,
      config.database?.deadlines,
      config.origins,
      config.links,
      config.links.ops,
      config.links.vendor,
      config.keys,
      config.keys.purposes,
      config.keys.purposes.totp_seed,
      config.keys.purposes.totp_seed.versions,
      config.adapters,
      config.adapters.delivery,
      config.adapters.delivery.email,
      config.adapters.attestationVerifier,
    ]) {
      expect(Object.isFrozen(frozen)).toBe(true);
    }
  });

  // Break caught: key material printed by anything that prints the configuration (a log line, a crash report, a debugger).
  it('prints no key material, however the configuration is rendered', () => {
    const env = validEnv({
      ATTESTATION_VERIFIER: 'service',
      ATTESTATION_VERIFIER_URL: 'http://127.0.0.1:9000',
      ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
    });
    const config = configFor(env);
    const rendered = JSON.stringify(config);

    for (const purpose of KEY_PURPOSES) {
      const key = (env[keyEnvName(purpose, 'MATERIAL')] ?? '').slice(2);
      expect(key).toHaveLength(43);
      expect(rendered).not.toContain(key);
    }
  });
});

describe('loadConfig: refused environments', () => {
  const REQUIRED = [
    'NODE_ENV',
    'APP_ENV',
    'HTTP_PORT',
    'DATABASE_URL',
    'OPS_ORIGIN',
    'VENDOR_ORIGIN',
    'KEY_CUSTODY',
    ...KEY_PURPOSES.flatMap((purpose) => [
      keyEnvName(purpose, 'MATERIAL'),
      keyEnvName(purpose, 'ACTIVE_VERSION'),
    ]),
  ];

  // Break caught: a required key silently defaulted, so the API boots in a mode nobody chose, or with a key nobody supplied.
  it.each(REQUIRED)('refuses a missing %s', (key) => {
    expect(problemsFor(validEnv({ [key]: undefined }))).toEqual([
      expect.objectContaining({ key, problem: 'missing' }),
    ]);
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
    ['SHUTDOWN_TIMEOUT_MS', '999'],
    ['SHUTDOWN_TIMEOUT_MS', '300001'],
    ['SHUTDOWN_TIMEOUT_MS', 'soon'],
    ['SHUTDOWN_DRAIN_DELAY_MS', '1.5'],
    ['SHUTDOWN_DRAIN_DELAY_MS', '60001'],
    ['DATABASE_POOL_MAX', '0'],
    ['DATABASE_POOL_MAX', '101'],
    ['DATABASE_POOL_MAX', '10.5'],
    ['DATABASE_POOL_MAX', 'many'],
    ['DATABASE_POOL_MAX', ''],
    ['DATABASE_ACQUIRE_TIMEOUT_MS', '99'],
    ['DATABASE_ACQUIRE_TIMEOUT_MS', '60001'],
    ['DATABASE_LOCK_TIMEOUT_MS', '99'],
    ['DATABASE_LOCK_TIMEOUT_MS', '60001'],
    ['DATABASE_STATEMENT_TIMEOUT_MS', '99'],
    ['DATABASE_STATEMENT_TIMEOUT_MS', '120001'],
    ['DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', '99'],
    ['DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', '120001'],
    ['DATABASE_TRANSACTION_TIMEOUT_MS', '99'],
    ['DATABASE_TRANSACTION_TIMEOUT_MS', '300001'],
    ['DATABASE_POOL_MAX_WAITERS', '0'],
    ['DATABASE_POOL_MAX_WAITERS', '10001'],
    ['REQUEST_EXECUTION_BUDGET_MS', '999'],
    ['REQUEST_EXECUTION_BUDGET_MS', '300001'],
    ['REQUEST_EXECUTION_BUDGET_MS', '15.5'],
    ['REQUEST_EXECUTION_BUDGET_MS', 'soon'],
    ['REQUEST_EXECUTION_BUDGET_MS', ''],
    ['HTTP_BODY_LIMIT_BYTES', '1023'],
    ['HTTP_BODY_LIMIT_BYTES', '1048577'],
    ['HTTP_HEADER_TIMEOUT_MS', '999'],
    ['HTTP_HEADER_TIMEOUT_MS', '60001'],
    ['HTTP_BODY_TIMEOUT_MS', '999'],
    ['HTTP_BODY_TIMEOUT_MS', '120001'],
    ['HTTP_ADMISSION_TIMEOUT_MS', '99'],
    ['HTTP_ADMISSION_TIMEOUT_MS', '30001'],
    ['HTTP_ADMISSION_CONCURRENCY', '0'],
    ['HTTP_ADMISSION_CONCURRENCY', '10001'],
    ['HTTP_TRUST_PROXY', 'true'],
    ['HTTP_TRUST_PROXY', '1'],
    ['HTTP_TRUST_PROXY', '0.0.0.0/0'],
    ['HTTP_TRUST_PROXY', ''],
    ['OPS_ORIGIN', ''],
    ['OPS_ORIGIN', 'http://127.0.0.1:5173/'],
    ['OPS_ORIGIN', 'ops.melarc.example'],
    ['VENDOR_ORIGIN', 'https://vendor.melarc.example/app'],
    ['RATE_LIMITER', 'redis'],
    ['KEY_CUSTODY', 'kms'],
    ['KEY_CUSTODY', ''],
    ['DELIVERY_EMAIL_ADAPTER', 'smtp'],
    ['DELIVERY_SMS_ADAPTER', 'twilio'],
    ['ATTESTATION_VERIFIER', 'google'],
  ])('refuses %s=%j', (key, value) => {
    expect(problemsFor(validEnv({ [key]: value }))).toEqual([
      expect.objectContaining({ key, problem: 'invalid' }),
    ]);
  });

  // Break caught: a key setting that accepts what is not a key, so a placeholder or a half-pasted value becomes custody.
  it.each(KEY_PURPOSES)('refuses unusable key material and versions for %s', (purpose) => {
    const material = keyEnvName(purpose, 'MATERIAL');
    const version = keyEnvName(purpose, 'ACTIVE_VERSION');

    for (const value of [
      '',
      '1:CHANGE_ME',
      randomKey(),
      `1:${randomKey().slice(1)}`,
      `0:${randomKey()}`,
    ]) {
      expect(problemsFor(validEnv({ [material]: value }))).toEqual([
        expect.objectContaining({ key: material, problem: 'invalid' }),
      ]);
    }
    for (const value of ['', '0', '1000000', 'one', '-1', '1.5']) {
      expect(problemsFor(validEnv({ [version]: value }))).toEqual([
        expect.objectContaining({ key: version, problem: 'invalid' }),
      ]);
    }
  });

  // Break caught: a bound moved by one. The values refused above are one step outside each bound; these are the bounds
  // themselves, which must be accepted.
  it.each([
    ['HTTP_PORT', '1'],
    ['HTTP_PORT', '65535'],
    ['SHUTDOWN_TIMEOUT_MS', '1000'],
    ['SHUTDOWN_TIMEOUT_MS', '300000'],
    ['SHUTDOWN_DRAIN_DELAY_MS', '0'],
    ['DATABASE_POOL_MAX', '1'],
    ['DATABASE_POOL_MAX', '100'],
    ['DATABASE_ACQUIRE_TIMEOUT_MS', '100'],
    ['DATABASE_ACQUIRE_TIMEOUT_MS', '60000'],
    ['DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', '100'],
    ['DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS', '120000'],
    ['DATABASE_POOL_MAX_WAITERS', '1'],
    ['DATABASE_POOL_MAX_WAITERS', '10000'],
    ['REQUEST_EXECUTION_BUDGET_MS', '1000'],
    ['REQUEST_EXECUTION_BUDGET_MS', '300000'],
    ['HTTP_BODY_LIMIT_BYTES', '1024'],
    ['HTTP_BODY_LIMIT_BYTES', '1048576'],
    ['HTTP_HEADER_TIMEOUT_MS', '1000'],
    ['HTTP_HEADER_TIMEOUT_MS', '60000'],
    ['HTTP_BODY_TIMEOUT_MS', '1000'],
    ['HTTP_BODY_TIMEOUT_MS', '120000'],
    ['HTTP_ADMISSION_TIMEOUT_MS', '100'],
    ['HTTP_ADMISSION_TIMEOUT_MS', '30000'],
    ['HTTP_ADMISSION_CONCURRENCY', '1'],
    ['HTTP_ADMISSION_CONCURRENCY', '10000'],
    ['HTTP_TRUST_PROXY', '10.0.0.1'],
    ['KEY_TOTP_SEED_ACTIVE_VERSION', '1'],
  ])('accepts %s=%j', (key, value) => {
    expect(loadConfig(validEnv({ [key]: value })).ok).toBe(true);
  });

  it('accepts the largest drain delay when the timeout is longer', () => {
    expect(
      loadConfig(validEnv({ SHUTDOWN_DRAIN_DELAY_MS: '60000', SHUTDOWN_TIMEOUT_MS: '120000' })).ok,
    ).toBe(true);
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
    expect(problemsFor(validEnv({ DATABASE_URL: url }))).toEqual([
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
    expect(problemsFor(validEnv({ DATABASE_URL: url }))).toEqual([
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
    const env = validEnv({
      DATABASE_MIGRATION_URL: 'postgres://melarc_migration_elevated:x@127.0.0.1/melarc_dev',
    });
    expect(problemsFor(env)).toEqual([
      expect.objectContaining({ key: 'DATABASE_MIGRATION_URL', problem: 'invalid' }),
    ]);
  });

  // Break caught: the provisioning login's credential in the API's environment. The seed runs as that login, which is "outside the
  // API's and every worker's configuration" (SECURITY_DESIGN.md section 14.17): one config change from being the runtime connection.
  it('refuses an environment that carries the seed database URL', () => {
    const env = validEnv({
      DATABASE_SEED_URL: 'postgres://melarc_provisioning:x@127.0.0.1/melarc_dev',
    });
    expect(problemsFor(env)).toEqual([
      expect.objectContaining({ key: 'DATABASE_SEED_URL', problem: 'invalid' }),
    ]);
  });

  it('accepts an empty seed database URL as absent', () => {
    expect(loadConfig(validEnv({ DATABASE_SEED_URL: '' })).ok).toBe(true);
  });

  // Break caught: the migration URL going unreported when another key is wrong too, so the operator fixes the one
  // they were told about, starts the API again and is refused a second time for the credential that was there all along.
  it('reports the migration database URL together with every other invalid key', () => {
    const env = validEnv({
      HTTP_PORT: '0',
      DATABASE_MIGRATION_URL: 'postgres://melarc_migration_elevated:x@127.0.0.1/melarc_dev',
    });
    expect(problemsFor(env).map((problem) => problem.key)).toEqual([
      'HTTP_PORT',
      'DATABASE_MIGRATION_URL',
    ]);
  });

  // Break caught: an empty value, as left by a copied .env template, counted as migration credentials.
  it('accepts an empty migration database URL as absent', () => {
    expect(loadConfig(validEnv({ DATABASE_MIGRATION_URL: '' })).ok).toBe(true);
  });

  // Break caught: staging or production running in a development mode (§12.3: no development bypass).
  it.each([
    ['staging', 'development'],
    ['staging', 'test'],
    ['production', 'development'],
    ['production', 'test'],
  ])('refuses APP_ENV=%s with NODE_ENV=%s', (appEnv, nodeEnv) => {
    expect(
      problemsFor(deployedEnv(appEnv as 'staging' | 'production', { NODE_ENV: nodeEnv })).filter(
        (problem) => problem.key === 'NODE_ENV',
      ),
    ).toEqual([expect.objectContaining({ key: 'NODE_ENV', problem: 'invalid' })]);
  });

  // Break caught: a drain delay that consumes the whole shutdown budget, so every shutdown is forced.
  it('refuses a drain delay that is not shorter than the shutdown timeout', () => {
    const env = validEnv({ SHUTDOWN_TIMEOUT_MS: '5000', SHUTDOWN_DRAIN_DELAY_MS: '5000' });
    expect(problemsFor(env)).toEqual([
      expect.objectContaining({ key: 'SHUTDOWN_DRAIN_DELAY_MS', problem: 'invalid' }),
    ]);
  });

  // Break caught: an implementation that stops at the first problem.
  it('reports every invalid key, not only the first', () => {
    expect(
      keysOf(
        problemsFor(
          validEnv({
            NODE_ENV: 'x',
            APP_ENV: 'y',
            HTTP_PORT: 'z',
            LOG_LEVEL: 'w',
            DATABASE_URL: 'v',
            OPS_ORIGIN: 'u',
          }),
        ),
      ),
    ).toEqual(['APP_ENV', 'DATABASE_URL', 'HTTP_PORT', 'LOG_LEVEL', 'NODE_ENV', 'OPS_ORIGIN']);
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
      KEY_TOTP_SEED_MATERIAL: '1:KEY-MATERIAL-CANARY',
      ATTESTATION_VERIFIER_CALLER_SECRET: 'CALLER-SECRET-CANARY',
      OPS_ORIGIN: 'https://origin-canary.example/path',
    });
    const serialised = JSON.stringify(problems);
    for (const secret of [
      ...secrets,
      'sk_live_should_not_appear',
      'URL-PASSWORD-VALUE',
      'MIGRATION-PASSWORD',
      'prod-db',
      'KEY-MATERIAL-CANARY',
      'CALLER-SECRET-CANARY',
      'origin-canary',
    ]) {
      expect(serialised).not.toContain(secret);
    }
  });

  // Break caught: the refusal of a URL with a query string repeating the query string, or the password
  // next to it. The report names the key and static text only.
  it('never echoes a rejected database URL with connection options', () => {
    const problems = problemsFor(
      validEnv({
        DATABASE_URL:
          'postgres://melarc_api_runtime:URL-PASSWORD-VALUE@host-canary.internal/melarc?user=OPTION-CANARY',
      }),
    );
    const serialised = JSON.stringify(problems);
    for (const secret of ['URL-PASSWORD-VALUE', 'host-canary', 'OPTION-CANARY']) {
      expect(serialised).not.toContain(secret);
    }
  });

  // Break caught: a problem with no hint of what a valid value looks like.
  it('says what is expected for each invalid key', () => {
    const [problem] = problemsFor(validEnv({ HTTP_PORT: 'abc' }));
    expect(problem?.expected).toBe('an integer from 1 to 65535');
    const [database] = problemsFor(validEnv({ DATABASE_URL: 'nope' }));
    expect(database?.expected).toBe(
      'a postgres:// or postgresql:// URL naming a host, one database and the user melarc_api_runtime, with no query string or fragment',
    );
  });

  // Break caught: a setting the loader reads but never describes, so its refusal says nothing about what is valid.
  it('describes every setting it reads', () => {
    const keys = Object.keys(EXPECTED);
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys)
      expect(EXPECTED[key as keyof typeof EXPECTED].length).toBeGreaterThan(8);
  });
});

describe('loadConfig: the database deadlines nest (SECURITY_DESIGN.md §14.6)', () => {
  // Break caught: a lock wait that is not inside the statement time, or a statement that outlives its transaction, so the
  // outer deadline never fires first and a stuck request holds a connection past every budget.
  it.each([
    [
      'a lock wait equal to the statement time',
      { LOCK: '5000', STATEMENT: '5000', TRANSACTION: '10000' },
      'DATABASE_LOCK_TIMEOUT_MS',
    ],
    [
      'a lock wait longer than the statement time',
      { LOCK: '6000', STATEMENT: '5000', TRANSACTION: '10000' },
      'DATABASE_LOCK_TIMEOUT_MS',
    ],
    [
      'a statement time equal to the transaction time',
      { LOCK: '2000', STATEMENT: '10000', TRANSACTION: '10000' },
      'DATABASE_STATEMENT_TIMEOUT_MS',
    ],
    [
      'a statement time longer than the transaction time',
      { LOCK: '2000', STATEMENT: '12000', TRANSACTION: '10000' },
      'DATABASE_STATEMENT_TIMEOUT_MS',
    ],
  ])('refuses %s', (_label, { LOCK, STATEMENT, TRANSACTION }, key) => {
    expect(
      problemsFor(
        validEnv({
          DATABASE_LOCK_TIMEOUT_MS: LOCK,
          DATABASE_STATEMENT_TIMEOUT_MS: STATEMENT,
          DATABASE_TRANSACTION_TIMEOUT_MS: TRANSACTION,
        }),
      ),
    ).toEqual([expect.objectContaining({ key, problem: 'invalid' })]);
  });

  it('accepts each deadline one millisecond inside the next', () => {
    expect(
      loadConfig(
        validEnv({
          DATABASE_LOCK_TIMEOUT_MS: '4999',
          DATABASE_STATEMENT_TIMEOUT_MS: '5000',
          DATABASE_TRANSACTION_TIMEOUT_MS: '5001',
        }),
      ).ok,
    ).toBe(true);
  });

  // Break caught: a relation judged on a value that is itself invalid, so one bad key is reported twice.
  it('judges the relation only when each deadline is valid alone', () => {
    expect(
      problemsFor(
        validEnv({ DATABASE_LOCK_TIMEOUT_MS: 'soon', DATABASE_STATEMENT_TIMEOUT_MS: '100' }),
      ),
    ).toEqual([expect.objectContaining({ key: 'DATABASE_LOCK_TIMEOUT_MS', problem: 'invalid' })]);
  });
});

describe('loadConfig: origins and the other settings that relate keys', () => {
  // Break caught: both surfaces on one origin, which would let one surface's cookie and Origin check stand for the other's
  // (SECURITY_DESIGN.md §14.8: no parent-domain authentication).
  it('refuses one origin for both surfaces', () => {
    expect(
      problemsFor(
        validEnv({ OPS_ORIGIN: 'http://127.0.0.1:5173', VENDOR_ORIGIN: 'http://127.0.0.1:5173' }),
      ),
    ).toEqual([expect.objectContaining({ key: 'VENDOR_ORIGIN', problem: 'invalid' })]);
  });

  // Break caught: a deployed surface served over plain http (DEPLOYMENT_AND_ENVIRONMENTS.md §12.2: HTTPS everywhere).
  it.each(['staging', 'production'] as const)(
    'requires https origins when APP_ENV is %s',
    (appEnv) => {
      expect(
        keysOf(
          problemsFor(
            deployedEnv(appEnv, {
              OPS_ORIGIN: 'http://ops.melarc.example',
              VENDOR_ORIGIN: 'http://vendor.melarc.example',
            }),
          ),
        ).filter((key) => key.endsWith('_ORIGIN')),
      ).toEqual(['OPS_ORIGIN', 'VENDOR_ORIGIN']);
    },
  );

  // Break caught: an active version that names a key nobody supplied, so new records would be sealed under nothing.
  it.each(KEY_PURPOSES)('refuses an active version that %s does not hold', (purpose) => {
    const version = keyEnvName(purpose, 'ACTIVE_VERSION');

    expect(problemsFor(validEnv({ [version]: '2' }))).toEqual([
      expect.objectContaining({ key: version, problem: 'invalid' }),
    ]);
  });

  // Break caught: one key serving two purposes, or two versions, which is the opposite of separation
  // (SECURITY_DESIGN.md §14.9: no purpose's key decrypts or derives another's).
  it('refuses one key used for two purposes', () => {
    const shared = randomKey();
    const problems = problemsFor(
      validEnv({
        KEY_TOTP_SEED_MATERIAL: `1:${shared}`,
        KEY_PASSWORD_PEPPER_MATERIAL: `1:${shared}`,
      }),
    );

    expect(problems).toEqual([
      expect.objectContaining({ key: 'KEY_PASSWORD_PEPPER_MATERIAL', problem: 'invalid' }),
    ]);
    expect(JSON.stringify(problems)).not.toContain(shared);
  });

  it('refuses one key written as two versions of one purpose', () => {
    const shared = randomKey();

    expect(
      problemsFor(
        validEnv({
          KEY_LIMITER_DIGEST_MATERIAL: `1:${shared},2:${shared}`,
          KEY_LIMITER_DIGEST_ACTIVE_VERSION: '2',
        }),
      ),
    ).toEqual([
      expect.objectContaining({ key: 'KEY_LIMITER_DIGEST_MATERIAL', problem: 'invalid' }),
    ]);
  });

  describe('delivery adapters', () => {
    it.each([
      ['email', 'EMAIL'],
      ['sms', 'SMS'],
    ])('requires an endpoint and a timeout for the %s provider', (_label, channel) => {
      expect(
        keysOf(problemsFor(validEnv({ [`DELIVERY_${channel}_ADAPTER`]: 'provider' }))),
      ).toEqual([`DELIVERY_${channel}_ENDPOINT`, `DELIVERY_${channel}_TIMEOUT_MS`]);
    });

    // Break caught: an operator who sets a provider endpoint and leaves the adapter on capture, so messages go nowhere.
    it.each(['EMAIL', 'SMS'])(
      'refuses a %s endpoint or timeout beside the capture adapter',
      (channel) => {
        expect(
          keysOf(
            problemsFor(
              validEnv({
                [`DELIVERY_${channel}_ENDPOINT`]: 'https://provider.example/v1',
                [`DELIVERY_${channel}_TIMEOUT_MS`]: '5000',
              }),
            ),
          ),
        ).toEqual([`DELIVERY_${channel}_ENDPOINT`, `DELIVERY_${channel}_TIMEOUT_MS`]);
      },
    );

    it('reads blank optional settings as absent, as a copied template leaves them', () => {
      expect(
        loadConfig(
          validEnv({
            DELIVERY_EMAIL_ENDPOINT: '',
            DELIVERY_EMAIL_TIMEOUT_MS: '',
            DELIVERY_SMS_ENDPOINT: '',
            ATTESTATION_VERIFIER_URL: '',
            ATTESTATION_VERIFIER_CALLER_SECRET: '',
          }),
        ).ok,
      ).toBe(true);
    });

    // Break caught: a provider reached over plain http outside a local test double.
    it.each([
      ['http to a named host, locally', 'local', 'http://provider.example/v1', false],
      ['http to loopback, locally', 'local', 'http://127.0.0.1:9000/v1', true],
      ['http to loopback, in staging', 'staging', 'http://127.0.0.1:9000/v1', false],
      ['https, in staging', 'staging', 'https://provider.example/v1', true],
      ['user information', 'local', 'https://user:pass@provider.example/v1', false],
      ['a query string', 'local', 'https://provider.example/v1?key=value', false],
      ['a fragment', 'local', 'https://provider.example/v1#x', false],
    ])('judges an endpoint with %s', (_label, appEnv, endpoint, accepted) => {
      const env =
        appEnv === 'local'
          ? validEnv({
              DELIVERY_EMAIL_ADAPTER: 'provider',
              DELIVERY_EMAIL_ENDPOINT: endpoint,
              DELIVERY_EMAIL_TIMEOUT_MS: '5000',
            })
          : deployedEnv('staging', {
              DELIVERY_EMAIL_ADAPTER: 'provider',
              DELIVERY_EMAIL_ENDPOINT: endpoint,
              DELIVERY_EMAIL_TIMEOUT_MS: '5000',
            });

      expect(loadConfig(env).ok).toBe(accepted);
    });
  });

  describe('the attestation verifier', () => {
    it('requires a URL and a timeout for the service', () => {
      expect(keysOf(problemsFor(validEnv({ ATTESTATION_VERIFIER: 'service' })))).toEqual([
        'ATTESTATION_VERIFIER_TIMEOUT_MS',
        'ATTESTATION_VERIFIER_URL',
      ]);
    });

    // Break caught: a service that crosses hosts without authenticating its caller (SECURITY_DESIGN.md §15.2.3).
    it('requires a caller secret when the service is not on a loopback host', () => {
      expect(
        problemsFor(
          validEnv({
            ATTESTATION_VERIFIER: 'service',
            ATTESTATION_VERIFIER_URL: 'https://verifier.internal.example',
            ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
          }),
        ),
      ).toEqual([
        expect.objectContaining({ key: 'ATTESTATION_VERIFIER_CALLER_SECRET', problem: 'missing' }),
      ]);
    });

    it('lets a service on a loopback host go without a caller secret', () => {
      expect(
        loadConfig(
          validEnv({
            ATTESTATION_VERIFIER: 'service',
            ATTESTATION_VERIFIER_URL: 'http://127.0.0.1:9100',
            ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
          }),
        ).ok,
      ).toBe(true);
    });

    it('refuses a service setting beside the substitute', () => {
      expect(
        keysOf(
          problemsFor(
            validEnv({
              ATTESTATION_VERIFIER_URL: 'http://127.0.0.1:9100',
              ATTESTATION_VERIFIER_TIMEOUT_MS: '3000',
              ATTESTATION_VERIFIER_CALLER_SECRET: randomKey(),
            }),
          ),
        ),
      ).toEqual([
        'ATTESTATION_VERIFIER_CALLER_SECRET',
        'ATTESTATION_VERIFIER_TIMEOUT_MS',
        'ATTESTATION_VERIFIER_URL',
      ]);
    });
  });
});

describe('loadConfig: production refuses what is only for tests (DEPLOYMENT_AND_ENVIRONMENTS.md §12.3)', () => {
  // The honest state of S0.2: no production key custody has been built, so a production environment is always refused for it,
  // and for nothing else when every other setting is a real one. Each refusal below is proved against that baseline.
  it('refuses the local key custody in production, and only that, when everything else is real', () => {
    expect(problemsFor(deployedEnv('production', REAL_ADAPTERS))).toEqual([
      expect.objectContaining({ key: 'KEY_CUSTODY', problem: 'invalid' }),
    ]);
  });

  it('accepts the same environment in staging, which does host the substitute walk', () => {
    expect(loadConfig(deployedEnv('staging', REAL_ADAPTERS)).ok).toBe(true);
  });

  // Break caught: the capture sink, which holds a credential message in clear by design, selected in production.
  it.each([
    [
      'DELIVERY_EMAIL_ADAPTER',
      {
        DELIVERY_EMAIL_ADAPTER: 'capture',
        DELIVERY_EMAIL_ENDPOINT: undefined,
        DELIVERY_EMAIL_TIMEOUT_MS: undefined,
      },
    ],
    [
      'DELIVERY_SMS_ADAPTER',
      {
        DELIVERY_SMS_ADAPTER: 'capture',
        DELIVERY_SMS_ENDPOINT: undefined,
        DELIVERY_SMS_TIMEOUT_MS: undefined,
      },
    ],
  ])('refuses the capture adapter on %s in production', (key, change) => {
    expect(keysOf(problemsFor(deployedEnv('production', { ...REAL_ADAPTERS, ...change })))).toEqual(
      [key, 'KEY_CUSTODY'].toSorted(),
    );
  });

  it('allows the capture adapter in staging, for the walk against it', () => {
    expect(
      loadConfig(
        deployedEnv('staging', {
          ...REAL_ADAPTERS,
          DELIVERY_EMAIL_ADAPTER: 'capture',
          DELIVERY_EMAIL_ENDPOINT: undefined,
          DELIVERY_EMAIL_TIMEOUT_MS: undefined,
        }),
      ).ok,
    ).toBe(true);
  });

  // Break caught: the deterministic substitute standing in for attestation in production.
  it('refuses the substitute verifier in production', () => {
    expect(
      keysOf(
        problemsFor(
          deployedEnv('production', {
            ...REAL_ADAPTERS,
            ATTESTATION_VERIFIER: 'substitute',
            ATTESTATION_VERIFIER_URL: undefined,
            ATTESTATION_VERIFIER_TIMEOUT_MS: undefined,
            ATTESTATION_VERIFIER_CALLER_SECRET: undefined,
          }),
        ),
      ),
    ).toEqual(['ATTESTATION_VERIFIER', 'KEY_CUSTODY']);
  });

  // Break caught: the per-process limiter, which resets on restart and multiplies each bucket by the instances
  // (SECURITY_DESIGN.md §14.12), selected anywhere but a local run.
  it.each(['staging', 'production'] as const)(
    'refuses the in-memory limiter when APP_ENV is %s',
    (appEnv) => {
      const problems = problemsFor(
        deployedEnv(appEnv, { ...REAL_ADAPTERS, RATE_LIMITER: 'memory' }),
      );

      expect(problems).toContainEqual(
        expect.objectContaining({ key: 'RATE_LIMITER', problem: 'invalid' }),
      );
    },
  );

  it('lets a local run use the in-memory limiter', () => {
    expect(loadConfig(validEnv({ RATE_LIMITER: 'memory' })).ok).toBe(true);
  });

  // Break caught: a production start with a key absent, which the design refuses rather than boots degraded.
  it.each(KEY_PURPOSES)('refuses a production start with the %s key absent', (purpose) => {
    const material = keyEnvName(purpose, 'MATERIAL');
    const problems = problemsFor(
      deployedEnv('production', { ...REAL_ADAPTERS, [material]: undefined }),
    );

    expect(problems).toContainEqual(expect.objectContaining({ key: material, problem: 'missing' }));
  });
});
