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
    // far larger than the worker can use): one connection for each lane, one for the poll and one for the cleanup.
    it('sizes the database pool from the lanes: one connection for each, one to poll and one to clean up', () => {
      expect(loaded(workerEnv()).database.poolMax).toBe(4 + 2);
      expect(loaded(workerEnv({ DELIVERY_WORKER_CONCURRENCY: '1' })).database.poolMax).toBe(3);
      expect(loaded(workerEnv({ DELIVERY_WORKER_CONCURRENCY: '32' })).database.poolMax).toBe(34);
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
