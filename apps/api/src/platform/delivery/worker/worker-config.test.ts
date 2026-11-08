import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { randomKey } from '../../../test-support/config-env.js';
import { KEY_PURPOSES, keyEnvName } from '../../config/key-material.js';
import {
  WORKER_CONFIG_KEYS,
  WORKER_DEFAULTS,
  WORKER_ONLY_KEYS,
  WORKER_SHARED_KEYS,
  WorkerConfigRefusedError,
  assertWorkerConfigAccepted,
  loadWorkerConfig,
  type WorkerConfig,
} from './worker-config.js';

/** An absolute path on whatever platform this runs: the loader judges the text, and nothing is created there. */
const CAPTURE_DIRECTORY = join(tmpdir(), 'melarc-capture');
const WORKER_URL = 'postgres://melarc_worker_runtime:CHANGE_ME@127.0.0.1:5432/melarc_dev';

/** A complete, valid worker environment for a local run, with fresh key material; a key mapped to undefined is removed. */
function workerEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const base: Record<string, string> = {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    DATABASE_WORKER_URL: WORKER_URL,
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${randomKey()}`,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: '1',
    DELIVERY_CAPTURE_DIRECTORY: CAPTURE_DIRECTORY,
  };
  return Object.fromEntries(
    Object.entries({ ...base, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/** What a staging or production deployment sets beyond a local one: production mode. */
const deployed = (
  appEnv: 'staging' | 'production',
  overrides: Readonly<Record<string, string | undefined>> = {},
) => workerEnv({ NODE_ENV: 'production', APP_ENV: appEnv, ...overrides });

function loaded(env: Readonly<Record<string, string | undefined>>): WorkerConfig {
  const result = loadWorkerConfig(env);
  if (!result.ok) throw new Error(`refused: ${result.problems.map((p) => p.key).join(', ')}`);
  return result.config;
}

function problemsOf(env: Readonly<Record<string, string | undefined>>) {
  const result = loadWorkerConfig(env);
  return result.ok ? [] : result.problems;
}

const keysOf = (env: Readonly<Record<string, string | undefined>>): string[] =>
  problemsOf(env).map((problem) => problem.key);

const ALLOW_LIST = 'staff@example.test,+233201234567';

describe('the delivery worker’s configuration (S0.18)', () => {
  describe('a valid local environment', () => {
    // Break caught: a loader that refuses the minimal environment, or fills a default with something other than the documented one.
    it('is accepted, with the documented defaults', () => {
      const config = loaded(workerEnv());

      expect(config).toMatchObject({
        nodeEnv: 'development',
        appEnv: 'local',
        logLevel: 'info',
        shutdown: { timeoutMs: 15_000 },
        delivery: {
          email: { kind: 'capture' },
          sms: { kind: 'capture' },
          concurrency: Number(WORKER_DEFAULTS.DELIVERY_WORKER_CONCURRENCY),
          pollIntervalMs: Number(WORKER_DEFAULTS.DELIVERY_WORKER_POLL_INTERVAL_MS),
          captureDirectory: CAPTURE_DIRECTORY,
        },
        database: {
          deadlines: {
            acquireTimeoutMs: 5_000,
            lockTimeoutMs: 2_000,
            statementTimeoutMs: 5_000,
            idleInTransactionTimeoutMs: 5_000,
            transactionTimeoutMs: 10_000,
            maxWaiters: 50,
          },
        },
      });
      expect(config.delivery.providerWindow).toBeUndefined();
    });

    // Break caught: a pool that is not sized for the lanes (a lane would wait for a connection another holds, or the pool would be
    // far larger than the worker can use): one connection for each lane, one for the poll, one for the cleanup and one for the
    // notification lane (S1.12).
    it('sizes the database pool from the lanes: one connection for each, one to poll, one to clean up and one for the notification lane', () => {
      expect(loaded(workerEnv()).database.poolMax).toBe(4 + 3);
      expect(loaded(workerEnv({ DELIVERY_WORKER_CONCURRENCY: '1' })).database.poolMax).toBe(4);
      expect(loaded(workerEnv({ DELIVERY_WORKER_CONCURRENCY: '32' })).database.poolMax).toBe(35);
    });

    // Break caught: the worker taking the keys of purposes it has no use for, because the file it shares with the API carries them.
    it('holds the credential_delivery key and no other, though the environment carries all five', () => {
      const env = workerEnv();
      for (const purpose of KEY_PURPOSES) {
        if (purpose === 'credential_delivery') continue;
        env[keyEnvName(purpose, 'MATERIAL')] = `1:${randomKey()}`;
        env[keyEnvName(purpose, 'ACTIVE_VERSION')] = '1';
      }

      const config = loaded(env);

      expect(config.keys.custody).toBe('local');
      if (config.keys.custody !== 'local') throw new Error('unreachable');
      expect(Object.keys(config.keys.purposes)).toEqual(['credential_delivery']);
      expect(config.keys.purposes.credential_delivery?.activeVersion).toBe(1);
    });

    // Break caught: key material printed by any ordinary route, which would put it in a log of the worker's start.
    it('prints no key and no connection password', () => {
      const env = workerEnv({
        DATABASE_WORKER_URL: 'postgres://melarc_worker_runtime:Zk3vQ9mT7xLp@127.0.0.1:5432/d',
      });
      const key = env.KEY_CREDENTIAL_DELIVERY_MATERIAL?.slice(2) ?? '';
      const config = loaded(env);

      expect(key).not.toBe('');
      for (const text of [
        JSON.stringify(config.keys),
        inspect(config.keys, { depth: 10, showHidden: true }),
        JSON.stringify(config),
      ]) {
        expect(text).not.toContain(key);
      }
    });

    it('is frozen, down to the lists it holds', () => {
      const config = loaded(deployed('staging', providerChannels(providerWindow())));

      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.delivery)).toBe(true);
      expect(Object.isFrozen(config.database)).toBe(true);
      expect(Object.isFrozen(config.delivery.providerWindow)).toBe(true);
      expect(Object.isFrozen(config.delivery.providerWindow?.allowList)).toBe(true);
    });
  });

  describe('what it needs', () => {
    // Break caught: a start with a setting absent that the worker cannot do without, or the problem naming something else.
    it.each([
      'NODE_ENV',
      'APP_ENV',
      'DATABASE_WORKER_URL',
      'KEY_CUSTODY',
      'KEY_CREDENTIAL_DELIVERY_MATERIAL',
      'KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION',
    ])('refuses an environment without %s, naming it as missing', (key) => {
      const problems = problemsOf(workerEnv({ [key]: undefined }));

      expect(problems.map((problem) => [problem.key, problem.problem])).toContainEqual([
        key,
        'missing',
      ]);
    });

    // Break caught: the worker started with the capture adapter and nowhere to put the messages.
    it('refuses the capture adapter without a directory for its sink', () => {
      expect(problemsOf(workerEnv({ DELIVERY_CAPTURE_DIRECTORY: undefined }))).toEqual([
        expect.objectContaining({ key: 'DELIVERY_CAPTURE_DIRECTORY', problem: 'missing' }),
      ]);
      expect(problemsOf(workerEnv({ DELIVERY_CAPTURE_DIRECTORY: '' }))).toEqual([
        expect.objectContaining({ key: 'DELIVERY_CAPTURE_DIRECTORY', problem: 'missing' }),
      ]);
    });

    it.each([
      ['a relative path', 'melarc-capture'],
      ['a path with a NUL', `${CAPTURE_DIRECTORY}\0x`],
      ['a path that climbs', `${CAPTURE_DIRECTORY}/../elsewhere`],
      ['a path of more than 1024 characters', `${CAPTURE_DIRECTORY}/${'a'.repeat(1030)}`],
    ])('refuses a capture directory that is %s', (_label, directory) => {
      expect(keysOf(workerEnv({ DELIVERY_CAPTURE_DIRECTORY: directory }))).toEqual([
        'DELIVERY_CAPTURE_DIRECTORY',
      ]);
    });

    // Break caught: a directory the worker does not need being demanded (when both channels use a real provider there is no sink).
    it('does not need a capture directory when no channel captures', () => {
      const env = deployed('staging', {
        DELIVERY_CAPTURE_DIRECTORY: undefined,
        ...providerChannels(providerWindow()),
      });

      expect(keysOf(env)).toEqual([]);
    });
  });

  describe('the database login', () => {
    // Break caught: the worker connecting as another identity (the API runtime's login would hand it the API's grants).
    it.each([
      ['the API runtime login', 'postgres://melarc_api_runtime:x@127.0.0.1:5432/melarc_dev'],
      ['the provisioning login', 'postgres://melarc_provisioning:x@127.0.0.1:5432/melarc_dev'],
      ['the owner', 'postgres://melarc_owner:x@127.0.0.1:5432/melarc_dev'],
      ['no user', 'postgres://127.0.0.1:5432/melarc_dev'],
      ['a query string', `${WORKER_URL}?options=-c%20role=melarc_owner`],
      ['a fragment', `${WORKER_URL}#x`],
      ['text that is not a URL', 'not a url'],
    ])('refuses %s', (_label, url) => {
      expect(problemsOf(workerEnv({ DATABASE_WORKER_URL: url }))).toEqual([
        expect.objectContaining({ key: 'DATABASE_WORKER_URL', problem: 'invalid' }),
      ]);
    });

    // Break caught: a connection URL, with its password, repeated in a problem report.
    it('never repeats a value it refuses', () => {
      const secret = 'Zk3vQ9mT7xLp2WnR8sBd4HcY';
      const problems = problemsOf(
        workerEnv({
          DATABASE_WORKER_URL: `postgres://melarc_api_runtime:${secret}@127.0.0.1:5432/melarc_dev`,
          KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${secret}`,
          DELIVERY_WORKER_CONCURRENCY: secret,
        }),
      );

      expect(problems.length).toBeGreaterThanOrEqual(3);
      expect(JSON.stringify(problems)).not.toContain(secret);
    });

    // Break caught: credentials that are not the worker's reaching it (the migration identity exists for the deployment window only;
    // the provisioning login is outside every runtime's configuration).
    it.each(['DATABASE_MIGRATION_URL', 'DATABASE_SEED_URL'])(
      'refuses an environment carrying %s',
      (key) => {
        expect(problemsOf(workerEnv({ [key]: 'postgres://x:y@127.0.0.1/d' }))).toEqual([
          expect.objectContaining({ key, problem: 'invalid' }),
        ]);
        // A copied template leaves it empty, which is absent.
        expect(problemsOf(workerEnv({ [key]: '' }))).toEqual([]);
      },
    );
  });

  describe('bounds and relations', () => {
    // Break caught: a bound moved or dropped. Each is the document's (DEPLOYMENT_AND_ENVIRONMENTS.md), and the first outside it fails.
    it.each([
      ['DELIVERY_WORKER_CONCURRENCY', '0'],
      ['DELIVERY_WORKER_CONCURRENCY', '33'],
      ['DELIVERY_WORKER_CONCURRENCY', '1.5'],
      ['DELIVERY_WORKER_CONCURRENCY', '-1'],
      ['DELIVERY_WORKER_POLL_INTERVAL_MS', '99'],
      ['DELIVERY_WORKER_POLL_INTERVAL_MS', '60001'],
      ['SHUTDOWN_TIMEOUT_MS', '999'],
      ['SHUTDOWN_TIMEOUT_MS', '300001'],
      ['LOG_LEVEL', 'verbose'],
    ])('refuses %s=%s', (key, value) => {
      expect(keysOf(workerEnv({ [key]: value }))).toEqual([key]);
    });

    it.each([
      ['DELIVERY_WORKER_CONCURRENCY', '1'],
      ['DELIVERY_WORKER_CONCURRENCY', '32'],
      ['DELIVERY_WORKER_POLL_INTERVAL_MS', '100'],
      ['DELIVERY_WORKER_POLL_INTERVAL_MS', '60000'],
      ['SHUTDOWN_TIMEOUT_MS', '1000'],
      ['SHUTDOWN_TIMEOUT_MS', '300000'],
    ])('accepts %s=%s, the edge of its bound', (key, value) => {
      expect(keysOf(workerEnv({ [key]: value }))).toEqual([]);
    });

    // Break caught: the nesting of the database deadlines (lock inside statement inside transaction), which the API holds and the
    // worker's own connections need as much.
    it('requires the lock wait to be shorter than the statement time, and that than the transaction time', () => {
      expect(keysOf(workerEnv({ DATABASE_LOCK_TIMEOUT_MS: '5000' }))).toEqual([
        'DATABASE_LOCK_TIMEOUT_MS',
      ]);
      expect(keysOf(workerEnv({ DATABASE_STATEMENT_TIMEOUT_MS: '10000' }))).toEqual([
        'DATABASE_STATEMENT_TIMEOUT_MS',
      ]);
      expect(
        keysOf(
          workerEnv({
            DATABASE_LOCK_TIMEOUT_MS: '100',
            DATABASE_STATEMENT_TIMEOUT_MS: '200',
            DATABASE_TRANSACTION_TIMEOUT_MS: '300',
          }),
        ),
      ).toEqual([]);
    });

    // Break caught: staging or production started in development mode, which the API refuses for the same reason, and a refusal that
    // tells the operator to choose among the three modes when the mode they chose is one of them.
    it('requires production mode when the environment is staging or production, and says so', () => {
      const problem = problemsOf(workerEnv({ APP_ENV: 'staging', NODE_ENV: 'development' })).find(
        (each) => each.key === 'NODE_ENV',
      );
      expect(problem?.expected).toBe('production when APP_ENV is staging or production');
      expect(keysOf(deployed('staging'))).toEqual([]);
    });

    // Break caught: a key set whose active version is not one it holds, which would seal under nothing; and a repeated key.
    it('requires the active key version to be one the material holds', () => {
      expect(keysOf(workerEnv({ KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: '2' }))).toEqual([
        'KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION',
      ]);
      const key = randomKey();
      expect(keysOf(workerEnv({ KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${key},2:${key}` }))).toEqual([
        'KEY_CREDENTIAL_DELIVERY_MATERIAL',
      ]);
    });

    // Break caught: a key that is not 32 random bytes in its one canonical spelling.
    it.each([
      ['too short', '1:abc'],
      ['not base64url', `1:${'+'.repeat(43)}`],
      ['no version', randomKey()],
      ['a zero version', `0:${randomKey()}`],
    ])('refuses key material that is %s', (_label, material) => {
      expect(keysOf(workerEnv({ KEY_CREDENTIAL_DELIVERY_MATERIAL: material }))).toEqual([
        'KEY_CREDENTIAL_DELIVERY_MATERIAL',
      ]);
    });
  });

  describe('the delivery adapters (DEPLOYMENT_AND_ENVIRONMENTS.md sections 4.1 and 12.3)', () => {
    // Break caught: production sending through the capture adapter, which holds every message in clear, or starting on a local key.
    it('refuses, in production, the capture adapter on either channel, and the local key custody', () => {
      const smsCaptured = providerChannels({
        DELIVERY_SMS_ADAPTER: 'capture',
        DELIVERY_SMS_ENDPOINT: undefined,
        DELIVERY_SMS_TIMEOUT_MS: undefined,
        DELIVERY_CAPTURE_DIRECTORY: CAPTURE_DIRECTORY,
      });
      expect(keysOf(deployed('production', smsCaptured))).toEqual(
        expect.arrayContaining(['DELIVERY_SMS_ADAPTER', 'KEY_CUSTODY']),
      );
      expect(keysOf(deployed('production'))).toEqual(
        expect.arrayContaining(['DELIVERY_EMAIL_ADAPTER', 'DELIVERY_SMS_ADAPTER', 'KEY_CUSTODY']),
      );
    });

    // Break caught: the adapter's endpoint and timeout required or refused in the wrong place, as the API's loader does.
    it('requires an endpoint and a timeout with a real provider, and refuses them with capture', () => {
      expect(
        keysOf(
          deployed('staging', { DELIVERY_EMAIL_ADAPTER: 'provider', ...providerWindow() }),
        ).toSorted(),
      ).toEqual(['DELIVERY_EMAIL_ENDPOINT', 'DELIVERY_EMAIL_TIMEOUT_MS']);
      expect(keysOf(workerEnv({ DELIVERY_SMS_ENDPOINT: 'https://sms.example.test/v1' }))).toEqual([
        'DELIVERY_SMS_ENDPOINT',
      ]);
      expect(keysOf(workerEnv({ DELIVERY_SMS_TIMEOUT_MS: '5000' }))).toEqual([
        'DELIVERY_SMS_TIMEOUT_MS',
      ]);
    });

    it('accepts a real provider by https in staging, inside the window, and by no other address', () => {
      const provider = (endpoint: string) =>
        deployed('staging', {
          DELIVERY_CAPTURE_DIRECTORY: undefined,
          ...providerChannels({ ...providerWindow(), DELIVERY_EMAIL_ENDPOINT: endpoint }),
        });

      expect(keysOf(provider('https://email.example.test/v1'))).toEqual([]);
      expect(keysOf(provider('http://127.0.0.1:9000/send'))).toEqual(['DELIVERY_EMAIL_ENDPOINT']);
      expect(keysOf(provider('http://email.example.test/v1'))).toEqual(['DELIVERY_EMAIL_ENDPOINT']);
      expect(keysOf(provider('https://user:pw@email.example.test/v1'))).toEqual([
        'DELIVERY_EMAIL_ENDPOINT',
      ]);
    });

    // Break caught (OB-127, closed by the owner's decision of 11 October 2026): a local run, and CI, which runs as one, accepting a
    // real provider, on a good endpoint, on a loopback stand-in, or with the window's settings. Capture is the only adapter there.
    it.each([
      ['https', 'https://email.example.test/v1'],
      ['a loopback stand-in', 'http://127.0.0.1:9000/send'],
    ])('refuses a real provider in a local run, whatever its endpoint (%s)', (_label, endpoint) => {
      const local = workerEnv({
        DELIVERY_CAPTURE_DIRECTORY: undefined,
        ...providerChannels({ DELIVERY_EMAIL_ENDPOINT: endpoint }),
      });

      expect(keysOf(local).toSorted()).toEqual(['DELIVERY_EMAIL_ADAPTER', 'DELIVERY_SMS_ADAPTER']);
      expect(
        keysOf(
          workerEnv({
            DELIVERY_CAPTURE_DIRECTORY: undefined,
            ...providerChannels({ ...providerWindow(), DELIVERY_EMAIL_ENDPOINT: endpoint }),
          }),
        ).toSorted(),
      ).toEqual(['DELIVERY_EMAIL_ADAPTER', 'DELIVERY_SMS_ADAPTER']);
    });

    // Break caught: the staging worker starting with a real provider and no approval or recipient list: the window is explicit,
    // or the worker refuses to start.
    it('refuses, in staging, a real provider unless the approval reference and the recipient allow-list are configured', () => {
      const without = deployed('staging', providerChannels());

      expect(keysOf(without).toSorted()).toEqual([
        'DELIVERY_PROVIDER_ALLOWLIST',
        'DELIVERY_PROVIDER_APPROVAL_REF',
      ]);
      expect(problemsOf(without).every((problem) => problem.problem === 'missing')).toBe(true);
      expect(
        keysOf(
          deployed('staging', providerChannels({ DELIVERY_PROVIDER_APPROVAL_REF: 'G3-2026-001' })),
        ),
      ).toEqual(['DELIVERY_PROVIDER_ALLOWLIST']);
      expect(
        keysOf(deployed('staging', providerChannels({ DELIVERY_PROVIDER_ALLOWLIST: ALLOW_LIST }))),
      ).toEqual(['DELIVERY_PROVIDER_APPROVAL_REF']);
      expect(keysOf(deployed('staging', providerChannels(providerWindow())))).toEqual([]);
    });

    // Break caught: the window's two settings read as something they are not: they belong to a real provider in Staging, and they
    // are refused in production (the window is a Staging control: an allow-list in production would silently drop real recipients).
    it('refuses the window settings with capture, and in production', () => {
      expect(keysOf(deployed('staging', providerWindow())).toSorted()).toEqual([
        'DELIVERY_PROVIDER_ALLOWLIST',
        'DELIVERY_PROVIDER_APPROVAL_REF',
      ]);
      expect(keysOf(deployed('production', providerChannels(providerWindow())))).toEqual(
        expect.arrayContaining(['DELIVERY_PROVIDER_APPROVAL_REF', 'DELIVERY_PROVIDER_ALLOWLIST']),
      );
    });

    // Break caught: a staging worker with a real provider being unable to use the window, or the window taking effect on the capture
    // adapter.
    it('hands the window to a staging worker that selects a real provider, and to nobody else', () => {
      const staging = loaded(
        deployed('staging', {
          DELIVERY_CAPTURE_DIRECTORY: undefined,
          ...providerChannels(providerWindow()),
        }),
      );

      expect(staging.delivery.providerWindow).toEqual({
        approvalRef: 'G3-2026-001',
        allowList: ['staff@example.test', '+233201234567'],
      });
      expect(loaded(workerEnv()).delivery.providerWindow).toBeUndefined();
    });

    it.each([
      ['an approval reference with a space', { DELIVERY_PROVIDER_APPROVAL_REF: 'G3 2026' }],
      ['a short approval reference', { DELIVERY_PROVIDER_APPROVAL_REF: 'G3' }],
      ['a long approval reference', { DELIVERY_PROVIDER_APPROVAL_REF: 'G'.repeat(65) }],
      ['an allow-list with a name', { DELIVERY_PROVIDER_ALLOWLIST: 'ama' }],
      [
        'an allow-list with a repeat',
        { DELIVERY_PROVIDER_ALLOWLIST: `${ALLOW_LIST},${ALLOW_LIST}` },
      ],
    ])('refuses %s', (_label, change) => {
      const key = Object.keys(change)[0];
      expect(
        keysOf(deployed('staging', providerChannels({ ...providerWindow(), ...change }))),
      ).toEqual([key]);
    });
  });

  describe('a deployed worker holds the worker’s credentials and nobody else’s', () => {
    // Break caught: a deployed worker carrying the API's login or the key material of another purpose, so that the compromise of
    // the worker is the compromise of more than the worker (SECURITY_DESIGN.md section 14.9: each purpose has its own access
    // policy). A local run shares one settings file with the API and is not judged by this.
    it.each([
      'DATABASE_URL',
      keyEnvName('totp_seed', 'MATERIAL'),
      keyEnvName('idempotent_replay', 'MATERIAL'),
      keyEnvName('limiter_digest', 'MATERIAL'),
      keyEnvName('password_pepper', 'MATERIAL'),
      'ATTESTATION_VERIFIER_CALLER_SECRET',
      'METRICS_SECRET',
    ])('refuses, in staging, an environment that carries %s', (key) => {
      const env = deployed('staging', providerChannels(providerWindow()));

      expect(keysOf({ ...env, [key]: 'x' })).toEqual([key]);
      expect(keysOf({ ...env, [key]: '' })).toEqual([]);
      expect(keysOf({ ...workerEnv(), [key]: 'x' })).toEqual([]);
    });
  });

  describe('the list of keys', () => {
    // Break caught: a key the loader reads and the examples never mention (or the reverse), which is how a setting goes undocumented.
    it('is the shared keys and the worker’s own, each once, and the worker’s own are not the API’s', () => {
      expect(new Set(WORKER_CONFIG_KEYS).size).toBe(WORKER_CONFIG_KEYS.length);
      expect([...WORKER_CONFIG_KEYS].toSorted()).toEqual(
        [...WORKER_SHARED_KEYS, ...WORKER_ONLY_KEYS].toSorted(),
      );
      expect(WORKER_ONLY_KEYS).toEqual([
        'DATABASE_WORKER_URL',
        'DELIVERY_WORKER_CONCURRENCY',
        'DELIVERY_WORKER_POLL_INTERVAL_MS',
        'DELIVERY_CAPTURE_DIRECTORY',
        'DELIVERY_PROVIDER_APPROVAL_REF',
        'DELIVERY_PROVIDER_ALLOWLIST',
        'DELIVERY_PROVIDER_MESSAGE_CAP',
        'DELIVERY_PROVIDER_WINDOW_ENDS_AT',
        'NOTIFICATION_SMS_ADAPTER',
        'NOTIFICATION_SMS_ENDPOINT',
        'NOTIFICATION_SMS_TIMEOUT_MS',
        'HUBTEL_SMS_CLIENT_ID',
        'HUBTEL_SMS_CLIENT_SECRET',
        'HUBTEL_SMS_SENDER_ID',
        'DELIVERY_WORKER_METRICS_HOST',
        'DELIVERY_WORKER_METRICS_PORT',
        'DELIVERY_WORKER_METRICS_SECRET',
      ]);
    });
  });
});

/** Both channels through a real provider (a loopback endpoint, so that a local run may use plain http), with what each needs. */
function providerChannels(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return {
    DELIVERY_CAPTURE_DIRECTORY: undefined,
    DELIVERY_EMAIL_ADAPTER: 'provider',
    DELIVERY_EMAIL_ENDPOINT: 'https://email.example.test/v1',
    DELIVERY_EMAIL_TIMEOUT_MS: '5000',
    DELIVERY_SMS_ADAPTER: 'provider',
    DELIVERY_SMS_ENDPOINT: 'https://sms.example.test/v1',
    DELIVERY_SMS_TIMEOUT_MS: '5000',
    ...overrides,
  };
}

function providerWindow(): Record<string, string> {
  return { DELIVERY_PROVIDER_APPROVAL_REF: 'G3-2026-001', DELIVERY_PROVIDER_ALLOWLIST: ALLOW_LIST };
}

describe('the worker’s private metrics endpoint (S0.68)', () => {
  it('is off unless its own port is set, and then takes one more connection for its read of the queue', () => {
    const off = loaded(workerEnv());
    expect(off.metrics).toBeUndefined();
    const on = loaded(workerEnv({ DELIVERY_WORKER_METRICS_PORT: '9465' }));
    expect(on.metrics).toEqual({ host: '127.0.0.1', port: 9465 });
    expect(on.database.poolMax).toBe(off.database.poolMax + 1);
  });

  // Break caught: the worker reading the API's port setting (the two would claim one port), a secret with no endpoint, or an
  // endpoint off this host that anyone who reaches the address may read.
  it('reads its own keys only, and needs a secret off the loopback address', () => {
    expect(loaded(workerEnv({ METRICS_PORT: '9464' })).metrics).toBeUndefined();
    expect(keysOf(workerEnv({ DELIVERY_WORKER_METRICS_SECRET: randomKey() }))).toEqual([
      'DELIVERY_WORKER_METRICS_SECRET',
    ]);
    expect(
      keysOf(
        workerEnv({
          DELIVERY_WORKER_METRICS_PORT: '9465',
          DELIVERY_WORKER_METRICS_HOST: '0.0.0.0',
        }),
      ),
    ).toEqual(['DELIVERY_WORKER_METRICS_SECRET']);
    const secret = randomKey();
    const metrics = loaded(
      workerEnv({
        DELIVERY_WORKER_METRICS_PORT: '9465',
        DELIVERY_WORKER_METRICS_HOST: '0.0.0.0',
        DELIVERY_WORKER_METRICS_SECRET: secret,
      }),
    ).metrics;
    expect(metrics?.secret?.reveal()).toBe(secret);
    expect(inspect(metrics)).not.toContain(secret);
  });
});

// S1.12d. The notification lane sends text messages through Hubtel. A real provider belongs to Staging and production, and to a local
// run only inside a controlled window (the Product Owner's decision of 29 October 2026, which amends the decision of 11 October 2026
// that a local run uses the capture adapter only): an approval reference, an allow-list of numbers the owner controls, the most messages
// the window may send and the moment it ends. The credential channels keep the rule of 11 October: capture only in a local run.
describe('the notification SMS channel and its controlled window (S1.12d)', () => {
  const NOW = new Date('2026-10-29T12:00:00.000Z');
  const CLIENT_ID = 'SENTINEL_CLIENT_ID_91c4';
  const CLIENT_SECRET = 'SENTINEL_CLIENT_SECRET_77ab';
  const GUARDS = [
    'DELIVERY_PROVIDER_APPROVAL_REF',
    'DELIVERY_PROVIDER_ALLOWLIST',
    'DELIVERY_PROVIDER_MESSAGE_CAP',
    'DELIVERY_PROVIDER_WINDOW_ENDS_AT',
  ] as const;
  const HUBTEL = [
    'NOTIFICATION_SMS_ENDPOINT',
    'NOTIFICATION_SMS_TIMEOUT_MS',
    'HUBTEL_SMS_CLIENT_ID',
    'HUBTEL_SMS_CLIENT_SECRET',
    'HUBTEL_SMS_SENDER_ID',
  ] as const;

  /** A local environment whose notification SMS goes through Hubtel, inside a complete window, unless a test says otherwise. */
  const inWindow = (
    overrides: Readonly<Record<string, string | undefined>> = {},
  ): Record<string, string> =>
    workerEnv({
      NOTIFICATION_SMS_ADAPTER: 'provider',
      NOTIFICATION_SMS_ENDPOINT: 'https://smsc.hubtel.com/v1/messages',
      NOTIFICATION_SMS_TIMEOUT_MS: '8000',
      HUBTEL_SMS_CLIENT_ID: CLIENT_ID,
      HUBTEL_SMS_CLIENT_SECRET: CLIENT_SECRET,
      HUBTEL_SMS_SENDER_ID: 'Melarc',
      DELIVERY_PROVIDER_APPROVAL_REF: 'OWNER-2026-10-29-SMS',
      DELIVERY_PROVIDER_ALLOWLIST: '+233201234567',
      DELIVERY_PROVIDER_MESSAGE_CAP: '20',
      DELIVERY_PROVIDER_WINDOW_ENDS_AT: '2026-11-05T23:59:59Z',
      ...overrides,
    });
  const load = (env: Readonly<Record<string, string | undefined>>) =>
    loadWorkerConfig(env, { now: NOW });
  const acceptedAt = (env: Readonly<Record<string, string | undefined>>): WorkerConfig => {
    const result = load(env);
    if (!result.ok) throw new Error(`refused: ${result.problems.map((p) => p.key).join(', ')}`);
    return result.config;
  };
  const refusedKeys = (env: Readonly<Record<string, string | undefined>>): string[] => {
    const result = load(env);
    return result.ok ? [] : result.problems.map((problem) => problem.key).toSorted();
  };
  const problemKinds = (env: Readonly<Record<string, string | undefined>>): string[] => {
    const result = load(env);
    return result.ok ? [] : result.problems.map((problem) => problem.problem);
  };

  // Break caught: the lane selecting a provider by default, or holding provider detail when nothing was selected.
  it('selects capture when nothing is set, and holds no provider detail and no window', () => {
    const config = acceptedAt(workerEnv());
    expect(config.delivery.notificationSms).toEqual({ kind: 'capture' });
    expect(config.delivery.providerWindow).toBeUndefined();
  });

  // Break caught: the local window refused although it is complete, or accepted with the detail left out of what the lane is built from.
  it('accepts a real provider in a local run inside a complete window, and holds what the lane is built from', () => {
    const config = acceptedAt(inWindow());
    const { notificationSms } = config.delivery;
    expect(notificationSms.kind).toBe('provider');
    if (notificationSms.kind !== 'provider') throw new Error('unreachable');
    expect(notificationSms).toMatchObject({
      endpoint: 'https://smsc.hubtel.com/v1/messages',
      timeoutMs: 8000,
      hubtel: { senderId: 'Melarc' },
    });
    expect(notificationSms.hubtel.clientId.reveal()).toBe(CLIENT_ID);
    expect(notificationSms.hubtel.clientSecret.reveal()).toBe(CLIENT_SECRET);
    expect(config.delivery.providerWindow).toEqual({
      approvalRef: 'OWNER-2026-10-29-SMS',
      allowList: ['+233201234567'],
      messageCap: 20,
      endsAt: new Date('2026-11-05T23:59:59Z'),
    });
    expect(Object.isFrozen(config.delivery.providerWindow)).toBe(true);
    expect(Object.isFrozen(notificationSms)).toBe(true);
  });

  // Break caught: a local run that sends for real with a guard missing, which is the whole of what the window is for.
  it.each(GUARDS)('refuses a real provider in a local run without %s', (key) => {
    expect(refusedKeys(inWindow({ [key]: undefined }))).toEqual([key]);
    expect(problemKinds(inWindow({ [key]: undefined }))).toEqual(['missing']);
  });

  // Break caught: a provider selected without the detail it is built from, which would fail at the first send and not at the start.
  it.each(HUBTEL)('refuses a real provider without %s', (key) => {
    expect(refusedKeys(inWindow({ [key]: undefined }))).toEqual([key]);
    expect(problemKinds(inWindow({ [key]: undefined }))).toEqual(['missing']);
  });

  // Break caught: a window with no end, one that has ended, one that is open for longer than the controlled fortnight, or one whose end
  // is a local time (an instant that moves with the machine's zone).
  it.each([
    ['in the past', '2026-10-29T11:59:59Z'],
    ['now', '2026-10-29T12:00:00Z'],
    ['more than fourteen days away', '2026-11-12T12:00:01Z'],
    ['without the Z of UTC', '2026-11-05T23:59:59'],
    ['with an offset', '2026-11-05T23:59:59+01:00'],
    ['a date only', '2026-11-05'],
    ['not an instant', 'soon'],
  ])('refuses a window end that is %s', (_label, endsAt) => {
    expect(refusedKeys(inWindow({ DELIVERY_PROVIDER_WINDOW_ENDS_AT: endsAt }))).toEqual([
      'DELIVERY_PROVIDER_WINDOW_ENDS_AT',
    ]);
  });

  it('accepts a window that ends within fourteen days, to the second', () => {
    expect(
      acceptedAt(inWindow({ DELIVERY_PROVIDER_WINDOW_ENDS_AT: '2026-11-12T12:00:00Z' })).delivery
        .providerWindow?.endsAt,
    ).toEqual(new Date('2026-11-12T12:00:00Z'));
    expect(
      acceptedAt(inWindow({ DELIVERY_PROVIDER_WINDOW_ENDS_AT: '2026-10-29T12:00:01Z' })).delivery
        .providerWindow?.endsAt,
    ).toEqual(new Date('2026-10-29T12:00:01Z'));
  });

  // Break caught: a cap that is not a whole number of messages from one to a thousand, or that reads text as a number.
  it.each([['0'], ['1001'], ['-1'], ['2.5'], ['many'], ['1e2'], [' 20']])(
    'refuses a message cap of %s',
    (cap) => {
      expect(refusedKeys(inWindow({ DELIVERY_PROVIDER_MESSAGE_CAP: cap }))).toEqual([
        'DELIVERY_PROVIDER_MESSAGE_CAP',
      ]);
    },
  );

  it.each([['1'], ['20'], ['1000']])('accepts a message cap of %s', (cap) => {
    expect(
      acceptedAt(inWindow({ DELIVERY_PROVIDER_MESSAGE_CAP: cap })).delivery.providerWindow
        ?.messageCap,
    ).toBe(Number(cap));
  });

  // Break caught: a sender ID Hubtel cannot show (3 to 11 letters or digits), found at the first send and not at the start.
  it.each([['Me'], ['Melarc Logistics'], ['Mel arc'], ['Melarc!'], ['Mélarc']])(
    'refuses the sender ID %j',
    (senderId) => {
      expect(refusedKeys(inWindow({ HUBTEL_SMS_SENDER_ID: senderId }))).toEqual([
        'HUBTEL_SMS_SENDER_ID',
      ]);
    },
  );

  it.each([['Melarc'], ['MELARC01'], ['A1B2C3'], ['Mel']])(
    'accepts the sender ID %j',
    (senderId) => {
      expect(acceptedAt(inWindow({ HUBTEL_SMS_SENDER_ID: senderId }))).toBeDefined();
    },
  );

  // Break caught: the provider's settings read with capture, where there is no provider to take them; and the window's guards read
  // where there is no real provider to guard.
  it.each([...HUBTEL, ...GUARDS])('refuses %s with capture', (key) => {
    // Only the key under test stays: every other setting of the provider and the window is taken away.
    const others: readonly string[] = [...HUBTEL, ...GUARDS].filter((other) => other !== key);
    const env = Object.fromEntries(
      Object.entries(inWindow({ NOTIFICATION_SMS_ADAPTER: 'capture' })).filter(
        ([name]) => !others.includes(name),
      ),
    );
    expect(refusedKeys(env)).toEqual([key]);
  });

  // Break caught: plain http reaching a host that is not this machine, which would put the credentials on a network.
  it('takes plain http to a loopback host in a local run only, and https anywhere', () => {
    expect(
      acceptedAt(inWindow({ NOTIFICATION_SMS_ENDPOINT: 'http://127.0.0.1:4010/v1/messages' })),
    ).toBeDefined();
    expect(
      refusedKeys(inWindow({ NOTIFICATION_SMS_ENDPOINT: 'http://smsc.hubtel.com/v1/messages' })),
    ).toEqual(['NOTIFICATION_SMS_ENDPOINT']);
    expect(refusedKeys(inWindow({ NOTIFICATION_SMS_ENDPOINT: 'not a url' }))).toEqual([
      'NOTIFICATION_SMS_ENDPOINT',
    ]);
  });

  // Break caught: Staging not held to the same window as a local run, or production asked for a window it must not have.
  it('holds Staging to the same window, and production to a real provider without one', () => {
    const staging = (over: Record<string, string | undefined> = {}) =>
      inWindow({ NODE_ENV: 'production', APP_ENV: 'staging', ...over });
    expect(acceptedAt(staging())).toBeDefined();
    for (const key of GUARDS) {
      expect(refusedKeys(staging({ [key]: undefined }))).toEqual([key]);
    }

    const production = (over: Record<string, string | undefined> = {}) =>
      workerEnv({
        NODE_ENV: 'production',
        APP_ENV: 'production',
        DELIVERY_CAPTURE_DIRECTORY: undefined,
        DELIVERY_EMAIL_ADAPTER: 'provider',
        DELIVERY_EMAIL_ENDPOINT: 'https://email.example.test/v1',
        DELIVERY_EMAIL_TIMEOUT_MS: '5000',
        DELIVERY_SMS_ADAPTER: 'provider',
        DELIVERY_SMS_ENDPOINT: 'https://sms.example.test/v1',
        DELIVERY_SMS_TIMEOUT_MS: '5000',
        NOTIFICATION_SMS_ADAPTER: 'provider',
        NOTIFICATION_SMS_ENDPOINT: 'https://smsc.hubtel.com/v1/messages',
        NOTIFICATION_SMS_TIMEOUT_MS: '8000',
        HUBTEL_SMS_CLIENT_ID: CLIENT_ID,
        HUBTEL_SMS_CLIENT_SECRET: CLIENT_SECRET,
        HUBTEL_SMS_SENDER_ID: 'Melarc',
        ...over,
      });
    // The environment may still name what production refuses elsewhere (the local key custody): only the notification keys are asked about.
    const notificationKeys = (env: Record<string, string>): string[] =>
      refusedKeys(env).filter(
        (key) =>
          key.startsWith('NOTIFICATION_') ||
          key.startsWith('HUBTEL_') ||
          (GUARDS as readonly string[]).includes(key),
      );
    expect(notificationKeys(production())).toEqual([]);
    for (const key of GUARDS) {
      expect(notificationKeys(production({ [key]: inWindow()[key] }))).toContain(key);
    }
  });

  // Break caught: production selecting capture for its text messages, which would drop them quietly.
  it('refuses capture for the notification SMS in production', () => {
    const production = workerEnv({
      NODE_ENV: 'production',
      APP_ENV: 'production',
      DELIVERY_CAPTURE_DIRECTORY: undefined,
      DELIVERY_EMAIL_ADAPTER: 'provider',
      DELIVERY_EMAIL_ENDPOINT: 'https://email.example.test/v1',
      DELIVERY_EMAIL_TIMEOUT_MS: '5000',
      DELIVERY_SMS_ADAPTER: 'provider',
      DELIVERY_SMS_ENDPOINT: 'https://sms.example.test/v1',
      DELIVERY_SMS_TIMEOUT_MS: '5000',
    });
    expect(refusedKeys(production)).toContain('NOTIFICATION_SMS_ADAPTER');
  });

  // Break caught: the owner's rule of 11 October for the credential channels dropped with the amendment: they stay capture-only locally.
  it('leaves the credential channels as they were: a real provider for them is still refused in a local run', () => {
    expect(
      refusedKeys(
        workerEnv({
          DELIVERY_SMS_ADAPTER: 'provider',
          DELIVERY_SMS_ENDPOINT: 'https://sms.example.test/v1',
          DELIVERY_SMS_TIMEOUT_MS: '5000',
          ...Object.fromEntries(GUARDS.map((key) => [key, inWindow()[key]])),
        }),
      ),
    ).toContain('DELIVERY_SMS_ADAPTER');
  });

  // Break caught: a credential, or the sender's secret, printed by a problem, by the config's JSON or by its inspected form.
  it('prints no credential: not in a problem, not in the configuration', () => {
    const config = acceptedAt(inWindow());
    for (const text of [
      JSON.stringify(config),
      inspect(config, { depth: 10, showHidden: true }),
      JSON.stringify(config.delivery.notificationSms),
    ]) {
      expect(text).not.toContain(CLIENT_ID);
      expect(text).not.toContain(CLIENT_SECRET);
    }
    const refused = load(
      inWindow({ DELIVERY_PROVIDER_MESSAGE_CAP: 'many', HUBTEL_SMS_SENDER_ID: 'x' }),
    );
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain(CLIENT_ID);
    expect(JSON.stringify(refused)).not.toContain(CLIENT_SECRET);
  });

  // Break caught: a keys list that does not name the new settings, so that the example and the deployment document are not held to them.
  it('names its settings among the keys only the worker reads', () => {
    for (const key of [...HUBTEL, ...GUARDS, 'NOTIFICATION_SMS_ADAPTER']) {
      expect(WORKER_ONLY_KEYS as readonly string[], key).toContain(key);
      expect(WORKER_CONFIG_KEYS, key).toContain(key);
    }
  });

  // Break caught: the composition trusting the loader alone: a configuration made by hand is judged by the same rule.
  it('judges a configuration made by hand as it judges the environment', () => {
    const config = acceptedAt(inWindow());
    expect(() => {
      assertWorkerConfigAccepted(config);
    }).not.toThrow();
    const { providerWindow: _window, ...delivery } = config.delivery;
    expect(_window).toBeDefined();
    expect(() => {
      assertWorkerConfigAccepted({ ...config, delivery });
    }).toThrow(WorkerConfigRefusedError);
    expect(() => {
      assertWorkerConfigAccepted({ ...config, appEnv: 'production' });
    }).toThrow(WorkerConfigRefusedError);
  });
});
