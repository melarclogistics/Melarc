import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from './platform/auth/clock/system.clock.adapter.js';
import type { DeliveryProvider } from './platform/auth/ports/delivery-provider.port.js';
import { CAPTURE_CALL_TIMEOUT_MS } from './platform/delivery/delivery-parameters.js';
import {
  CaptureDirectoryInsideCheckoutError,
  CaptureDirectoryNotPrivateError,
} from './platform/delivery/worker/outside-checkout.js';
import {
  WorkerConfigRefusedError,
  loadWorkerConfig,
  type WorkerConfig,
} from './platform/delivery/worker/worker-config.js';
import { randomKey } from './test-support/config-env.js';
import {
  DeliveryProviderNotBuiltError,
  composeProviders,
  createDeliveryWorkerRuntime,
  leaseFor,
  providerTimeouts,
  shutdownOutcome,
  workerCipher,
} from './delivery-worker-runtime.js';

const clock = new SystemClock();
const WORKER_URL = 'postgres://melarc_worker_runtime:SENTINEL-DB-PASSWORD@127.0.0.1:1/melarc_dev';
const MESSAGE = {
  dedupeId: 'c2d3e4f5-0617-4829-8a3b-4c5d6e7f8091',
  kind: 'SETUP_GRANT',
  channel: 'EMAIL',
  destination: 'staff@example.test',
  link: 'https://ops.example.test/setup/credential#token=SENTINEL-RUNTIME-TOKEN',
} as const;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'melarc-runtime-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function configFor(over: Record<string, string | undefined> = {}): WorkerConfig {
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'development',
    APP_ENV: 'local',
    DATABASE_WORKER_URL: WORKER_URL,
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${randomKey()}`,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: '1',
    DELIVERY_CAPTURE_DIRECTORY: join(directory, 'sink'),
    ...over,
  };
  const loaded = loadWorkerConfig(env);
  if (!loaded.ok) throw new Error(`refused: ${loaded.problems.map((p) => p.key).join(', ')}`);
  return loaded.config;
}

const providerEnv = {
  DELIVERY_EMAIL_ADAPTER: 'provider',
  DELIVERY_EMAIL_ENDPOINT: 'https://email.example.test/v1',
  DELIVERY_EMAIL_TIMEOUT_MS: '7000',
  DELIVERY_SMS_ADAPTER: 'provider',
  DELIVERY_SMS_ENDPOINT: 'https://sms.example.test/v1',
  DELIVERY_SMS_TIMEOUT_MS: '9000',
  DELIVERY_CAPTURE_DIRECTORY: undefined,
};

/**
 * A real provider belongs to staging, inside the controlled window (DEPLOYMENT_AND_ENVIRONMENTS.md section 4.1), and to production; a
 * local run, and CI, uses the capture adapter only (OB-127, closed by the owner's decision of 11 October 2026). The tests of what is
 * composed for a real provider therefore run as staging, with the window.
 */
const stagingEnv = (
  over: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  NODE_ENV: 'production',
  APP_ENV: 'staging',
  DELIVERY_PROVIDER_APPROVAL_REF: 'G3-2026-001',
  DELIVERY_PROVIDER_ALLOWLIST: 'staff@example.test,+233201234567',
  ...over,
});
/** The same configuration with the window taken off it, as a configuration made by hand can be. */
const withoutWindow = (config: WorkerConfig): WorkerConfig => ({
  ...config,
  delivery: { ...config.delivery, providerWindow: undefined },
});

describe('the delivery worker’s composition (S0.18)', () => {
  // Break caught: the capture adapter not writing where the settings say, or writing inside the process's own folders.
  it('composes the capture adapter over the configured directory, for either channel', async () => {
    const providers = composeProviders(configFor(), clock);

    expect(await providers.EMAIL.send(MESSAGE)).toMatchObject({ outcome: 'ACCEPTED' });
    expect(
      await providers.SMS.send({
        ...MESSAGE,
        channel: 'SMS',
        destination: '+233201234567',
        dedupeId: 'd3e4f506-1728-493a-8b4c-5d6e7f8091a2',
      }),
    ).toMatchObject({ outcome: 'ACCEPTED' });
    expect((await readdir(join(directory, 'sink'))).toSorted()).toEqual([
      'c2d3e4f5-0617-4829-8a3b-4c5d6e7f8091.json',
      'd3e4f506-1728-493a-8b4c-5d6e7f8091a2.json',
    ]);
  });

  // Break caught: a real provider selected and silently replaced by the capture adapter (a message that reaches nobody, reported as a
  // delivery), or composed as a stub that accepts everything. No provider adapter is built (release gate G3), so the worker refuses.
  it.each([
    [
      'DELIVERY_EMAIL_ADAPTER',
      {
        ...providerEnv,
        DELIVERY_SMS_ADAPTER: 'capture',
        DELIVERY_SMS_ENDPOINT: undefined,
        DELIVERY_SMS_TIMEOUT_MS: undefined,
        DELIVERY_CAPTURE_DIRECTORY: join(tmpdir(), 'x'),
      },
    ],
    [
      'DELIVERY_SMS_ADAPTER',
      {
        ...providerEnv,
        DELIVERY_EMAIL_ADAPTER: 'capture',
        DELIVERY_EMAIL_ENDPOINT: undefined,
        DELIVERY_EMAIL_TIMEOUT_MS: undefined,
        DELIVERY_CAPTURE_DIRECTORY: join(tmpdir(), 'x'),
      },
    ],
  ])(
    'refuses to compose a real provider for %s, naming the setting and nothing else',
    (key, env) => {
      const attempt = () => composeProviders(configFor(stagingEnv(env)), clock);

      expect(attempt).toThrow(DeliveryProviderNotBuiltError);
      try {
        attempt();
      } catch (error) {
        expect((error as DeliveryProviderNotBuiltError).key).toBe(key);
        expect((error as Error).message).toContain(key);
        expect((error as Error).message).not.toContain('example.test');
      }
    },
  );

  // Break caught: the controlled window's allow-list not standing in front of a real provider, or standing in front of the capture
  // adapter (which reaches nobody and needs none).
  it('puts the allow-list in front of a real provider when the window is configured, and nowhere else', async () => {
    const sent: string[] = [];
    const inner: DeliveryProvider = {
      send: (message) => {
        sent.push(message.destination);
        return Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: 'r' });
      },
      status: () => Promise.resolve(null),
    };
    const windowed = configFor(stagingEnv(providerEnv));
    const guarded = composeProviders(windowed, clock, () => inner);

    expect(await guarded.EMAIL.send({ ...MESSAGE, destination: 'someone@example.test' })).toEqual({
      outcome: 'REJECTED',
      outcomeClass: 'DESTINATION_NOT_ALLOWED',
    });
    expect(await guarded.EMAIL.send(MESSAGE)).toMatchObject({ outcome: 'ACCEPTED' });
    expect(sent).toEqual(['staff@example.test']);

    // No window configured: the provider is reached directly.
    const open = composeProviders(withoutWindow(windowed), clock, () => inner);
    await open.EMAIL.send({ ...MESSAGE, destination: 'anyone@example.test' });
    expect(sent).toEqual(['staff@example.test', 'anyone@example.test']);

    // One channel through a real provider and the other captured, with the window configured: the window is for the real one only.
    const mixed = configFor(
      stagingEnv({
        ...providerEnv,
        DELIVERY_SMS_ADAPTER: 'capture',
        DELIVERY_SMS_ENDPOINT: undefined,
        DELIVERY_SMS_TIMEOUT_MS: undefined,
        DELIVERY_CAPTURE_DIRECTORY: join(directory, 'sink'),
        DELIVERY_PROVIDER_ALLOWLIST: 'staff@example.test',
      }),
    );
    const composed = composeProviders(mixed, clock, () => inner);
    await composed.SMS.send({ ...MESSAGE, channel: 'SMS', destination: '+233209999999' });
    expect(sent.at(-1)).toBe('+233209999999');
    expect(
      await composed.EMAIL.send({ ...MESSAGE, destination: 'someone-else@example.test' }),
    ).toMatchObject({ outcome: 'REJECTED' });
    expect(sent.at(-1)).toBe('+233209999999');
  });

  // Break caught: a provider call given another time than its channel's setting, or the capture adapter given none at all.
  it('gives each channel the time its setting says, and the capture adapter its own bound', () => {
    expect(providerTimeouts(configFor())).toEqual({
      EMAIL: CAPTURE_CALL_TIMEOUT_MS,
      SMS: CAPTURE_CALL_TIMEOUT_MS,
    });
    expect(providerTimeouts(configFor(stagingEnv(providerEnv)))).toEqual({
      EMAIL: 7_000,
      SMS: 9_000,
    });
  });

  // Break caught: a lease shorter than the longest call it must outlast, or a job budget that does not leave the time to record. The
  // figures are written out: thirty seconds and the longest call for the lease, and five seconds less for the work under it.
  it('asks for a lease of the base and the longest call, and a job budget that ends before it', () => {
    expect(leaseFor({ EMAIL: 7_000, SMS: 9_000 })).toEqual({
      leaseMs: 39_000,
      jobBudgetMs: 34_000,
    });
    expect(leaseFor({ EMAIL: 12_000, SMS: 4_000 })).toEqual({
      leaseMs: 42_000,
      jobBudgetMs: 37_000,
    });
    expect(leaseFor({ EMAIL: 5_000, SMS: 5_000 })).toEqual({
      leaseMs: 35_000,
      jobBudgetMs: 30_000,
    });
  });
});

describe('what the worker holds and how it judges its own shutdown (S0.18)', () => {
  const context = new TextEncoder().encode('worker-test-context');

  // Break caught: a cipher built for every purpose (it would refuse to be built on the one key the worker holds), or one that can open
  // the other purposes: the worker seals and opens the delivery payload and nothing else.
  it('builds a cipher from the delivery key alone, which serves the delivery payload and no other purpose', async () => {
    const cipher = workerCipher(configFor());

    const sealed = await cipher.seal('DELIVERY_PAYLOAD', new Uint8Array([1, 2, 3]), context);
    expect([...(await cipher.open('DELIVERY_PAYLOAD', sealed, context))]).toEqual([1, 2, 3]);
    await expect(cipher.seal('TOTP_SEED', new Uint8Array([1]), context)).rejects.toMatchObject({
      condition: 'PURPOSE_KEY_ABSENT',
    });
    await expect(cipher.open('REPLAY_SECRET', sealed, context)).rejects.toMatchObject({
      condition: 'PURPOSE_KEY_ABSENT',
    });
  });

  // Break caught: a shutdown reported clean that left a lease it could not give back, a resource that failed to close, or one that
  // stalled or was not reached: only a shutdown that confirmed everything is clean.
  it.each([
    ['everything confirmed', { unconfirmed: 0 }, {}, 'clean'],
    ['a lease it could not give back', { unconfirmed: 1 }, {}, 'forced'],
    [
      'a resource that failed to close',
      { unconfirmed: 0 },
      { failed: [{ name: 'pool', error: 1 }] },
      'forced',
    ],
    ['a resource that stalled', { unconfirmed: 0 }, { stalled: ['pool'] }, 'forced'],
    ['a resource it did not reach', { unconfirmed: 0 }, { unreached: ['pool'] }, 'forced'],
  ])('judges a shutdown with %s as %s', (_label, report, closed, expected) => {
    expect(
      shutdownOutcome(
        { drained: 0, relinquished: 0, ...report },
        { closed: [], failed: [], stalled: [], unreached: [], ...closed },
      ),
    ).toBe(expected);
  });
});

describe('the delivery worker’s runtime (S0.18)', () => {
  // Break caught: the refusals that hold for the loader's output not holding for a configuration made by hand (a test, a later
  // composition), which would start a production worker on the capture adapter and the local key substitute.
  it('refuses a configuration made by hand that its environment would refuse, naming the settings and no value', () => {
    const handmade: WorkerConfig = { ...configFor(), appEnv: 'production' };

    let refused: unknown;
    try {
      createDeliveryWorkerRuntime(handmade, { destination: { write: () => undefined } });
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(WorkerConfigRefusedError);
    expect((refused as WorkerConfigRefusedError).keys).toEqual([
      'KEY_CUSTODY',
      'DELIVERY_EMAIL_ADAPTER',
      'DELIVERY_SMS_ADAPTER',
    ]);
    expect((refused as Error).message).not.toContain('SENTINEL-DB-PASSWORD');
  });

  // Break caught: a real provider reachable in Staging without the window (approval and allow-list), or the window's settings accepted in
  // production, in a configuration made by hand: the same two rules the environment's loader has.
  it('judges the controlled window on a configuration made by hand as the loader does', () => {
    const real = configFor(stagingEnv(providerEnv));
    const withoutTheWindow: WorkerConfig = withoutWindow(real);
    const withWindow: WorkerConfig = {
      ...real,
      appEnv: 'production',
      delivery: {
        ...real.delivery,
        providerWindow: { approvalRef: 'G3-2026-001', allowList: ['staff@example.test'] },
      },
    };
    const refusedBy = (config: WorkerConfig): string[] => {
      try {
        createDeliveryWorkerRuntime(config, { destination: { write: () => undefined } });
      } catch (error) {
        return error instanceof WorkerConfigRefusedError ? [...error.keys] : ['other'];
      }
      return [];
    };

    expect(refusedBy(withoutTheWindow)).toEqual([
      'DELIVERY_PROVIDER_APPROVAL_REF',
      'DELIVERY_PROVIDER_ALLOWLIST',
    ]);
    // Production also refuses the local key substitute, which is why that is on the list with the two settings of the window.
    expect(refusedBy(withWindow)).toEqual([
      'KEY_CUSTODY',
      'DELIVERY_PROVIDER_APPROVAL_REF',
      'DELIVERY_PROVIDER_ALLOWLIST',
    ]);
  });

  // Break caught (OB-127, closed by the owner's decision of 11 October 2026): the loader's rule that a local run uses the capture
  // adapter only not holding for a configuration made by hand, which is how a test, or a later composition, would reach a real provider
  // from a local run. The composition judges the built configuration, as the API's does.
  it('refuses a configuration made by hand that selects a real provider in a local run', () => {
    const staging = configFor(stagingEnv(providerEnv));
    const local: WorkerConfig = { ...staging, appEnv: 'local' };
    const emailOnly: WorkerConfig = {
      ...local,
      delivery: { ...local.delivery, sms: { kind: 'capture' } },
    };
    const refusedBy = (config: WorkerConfig): string[] => {
      try {
        createDeliveryWorkerRuntime(config, { destination: { write: () => undefined } });
      } catch (error) {
        return error instanceof WorkerConfigRefusedError ? [...error.keys] : ['other'];
      }
      return [];
    };

    expect(refusedBy(local)).toEqual(['DELIVERY_EMAIL_ADAPTER', 'DELIVERY_SMS_ADAPTER']);
    expect(refusedBy(emailOnly)).toEqual(['DELIVERY_EMAIL_ADAPTER']);
  });

  // Break caught: a sink inside the checkout the worker runs from (the source package is built from it).
  it('refuses to start with a capture directory inside the checkout', async () => {
    const repo = join(directory, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    const config = configFor({ DELIVERY_CAPTURE_DIRECTORY: join(repo, 'tmp', 'capture') });

    expect(() => createDeliveryWorkerRuntime(config, { startingPoints: [repo] })).toThrow(
      CaptureDirectoryInsideCheckoutError,
    );
    expect(await readdir(repo)).toEqual(['.git']);
  });

  // Break caught: a capture folder that other users can enter accepted at start: the messages in it hold live links in clear. The probe
  // stands in for the file system, so that this holds on a platform whose files have no permission bits.
  it('refuses to start with a capture folder that other users can enter', () => {
    const open = {
      platform: 'linux',
      userId: 1000,
      stat: () => ({ isDirectory: () => true, mode: 0o040755, uid: 1000 }),
    } as const;
    const private700 = {
      ...open,
      stat: () => ({ isDirectory: () => true, mode: 0o040700, uid: 1000 }),
    };

    expect(() =>
      createDeliveryWorkerRuntime(configFor(), {
        destination: { write: () => undefined },
        privacyProbe: open,
      }),
    ).toThrow(CaptureDirectoryNotPrivateError);
    expect(() =>
      createDeliveryWorkerRuntime(configFor(), {
        destination: { write: () => undefined },
        privacyProbe: private700,
      }),
    ).not.toThrow();
  });

  // Break caught (S0.19): the retention cleanup not running inside the worker, or running on another schedule than the one given,
  // or failing in a way that stops the lanes or names what it was working on. The database is unreachable here, so every run fails;
  // the worker says so by the task's name and the failure's class, and carries on.
  it('runs the retention cleanup on its schedule, and a cleanup that fails does not stop the worker', async () => {
    const lines: string[] = [];
    const runtime = createDeliveryWorkerRuntime(configFor(), {
      destination: { write: (line: string) => void lines.push(line) },
      retentionIntervalMs: 100,
    });

    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const outcome = await runtime.shutdown();

    const failed = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === 'delivery periodic task failed');
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed[0]).toMatchObject({ task: 'retention', level: 'error' });
    expect(Object.keys(failed[0] ?? {})).not.toContain('err');
    expect(lines.join('')).not.toContain('SENTINEL-DB-PASSWORD');
    expect(outcome).toBe('clean');
  });

  // Break caught: a worker that starts without saying that it cannot yet confirm any record (it claims nothing, and an operator who
  // sees messages queue up must be able to find out why), or whose log names a password; or (G2-03) one that claims anyway: every
  // claim it made would be given back, and each would be an attempt counted against a message it could not send.
  it('says at start that no record can be confirmed yet, claims nothing, and logs no credential', async () => {
    const lines: string[] = [];
    const runtime = createDeliveryWorkerRuntime(
      configFor({ DELIVERY_WORKER_POLL_INTERVAL_MS: '100' }),
      {
        destination: { write: (line: string) => void lines.push(line) },
      },
    );

    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const outcome = await runtime.shutdown();

    const text = lines.join('');
    expect(outcome).toBe('clean');
    expect(text).toContain('delivery worker started');
    expect(text).toContain('redemption record readers are not built');
    // the database in this test is not reachable: a worker that claimed would say so, and this one does not ask
    expect(text).not.toContain('delivery claim failed');
    expect(text).toContain('delivery periodic task failed');
    expect(text).toContain('delivery worker stopped');
    expect(text).not.toContain('SENTINEL-DB-PASSWORD');
    expect(text).toContain('melarc-delivery-worker');
  });

  // Break caught (G2-03): the other half of the one above, so that the first cannot pass because nothing ever claims: with a reader
  // that can confirm a record, the same composition does claim.
  it('claims when a reader that can confirm a record is given', async () => {
    const lines: string[] = [];
    const runtime = createDeliveryWorkerRuntime(
      configFor({ DELIVERY_WORKER_POLL_INTERVAL_MS: '100' }),
      {
        destination: { write: (line: string) => void lines.push(line) },
        redemptionReader: { standing: () => Promise.resolve('PENDING') },
      },
    );

    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const outcome = await runtime.shutdown();

    const text = lines.join('');
    expect(outcome).toBe('clean');
    expect(text).not.toContain('redemption record readers are not built');
    expect(text).toContain('delivery claim failed');
  });

  // Break caught: a shutdown that returns before the lanes have stopped, or that waits for the budget when nothing is in flight.
  it('shuts down at once when nothing is in flight, and a second shutdown agrees with the first', async () => {
    const runtime = createDeliveryWorkerRuntime(configFor(), {
      destination: { write: () => undefined },
    });
    runtime.start();
    const started = Date.now();

    const first = await runtime.shutdown();
    const second = await runtime.shutdown();

    expect(first).toBe('clean');
    expect(second).toBe('clean');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
