import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { randomKey } from '../src/test-support/config-env.js';
import {
  DEADLINES,
  killAll,
  requireBuild,
  start,
  WORKER_FIXTURE,
  WORKER_MAIN,
  type Finished,
} from './support/api-process.js';

beforeAll(requireBuild);
afterEach(killAll);

/** A valid worker login that nothing listens on: the worker's pool connects lazily, so a start is accepted and every claim fails. */
const UNREACHABLE = 'postgres://melarc_worker_runtime:ENV-SECRET-WORKER@127.0.0.1:1/melarc';
const API_ROOT = resolve(import.meta.dirname, '..');

/** The worker's environment for a local run with nothing behind it, with the key material fresh and the sink given. */
function env(over: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'production',
    APP_ENV: 'local',
    DATABASE_WORKER_URL: UNREACHABLE,
    KEY_CUSTODY: 'local',
    KEY_CREDENTIAL_DELIVERY_MATERIAL: `1:${randomKey()}`,
    KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION: '1',
    DELIVERY_CAPTURE_DIRECTORY: join(tmpdir(), 'melarc-worker-process-test-sink'),
    DELIVERY_WORKER_POLL_INTERVAL_MS: '100',
    SHUTDOWN_TIMEOUT_MS: '4000',
    ...over,
  };
}

const lines = (finished: { readonly stdout: string }): Record<string, unknown>[] =>
  finished.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const messages = (finished: Finished): unknown[] => lines(finished).map((line) => line.msg);

async function until(condition: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

describe('the delivery worker refuses to start on settings it cannot accept (S0.18)', () => {
  // Break caught: a worker that starts on a bad configuration, or a refusal that names a value (a password in the URL, a key).
  it('exits 1 with one line that names the keys and no value', async () => {
    const running = start(
      WORKER_MAIN,
      env({
        DATABASE_WORKER_URL: 'postgres://melarc_api_runtime:ENV-SECRET-WRONG@127.0.0.1:1/melarc',
        KEY_CREDENTIAL_DELIVERY_MATERIAL: '1:SENTINEL-NOT-A-KEY',
      }),
    );

    const finished = await running.waitForExit(DEADLINES.finish, 'did not refuse by itself');

    expect(finished).toMatchObject({ code: 1, signal: null, stdout: '' });
    const record = JSON.parse(finished.stderr) as {
      service: string;
      msg: string;
      problems: { key: string }[];
    };
    expect(finished.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(record).toMatchObject({
      service: 'melarc-delivery-worker',
      msg: 'Invalid configuration: the delivery worker will not start',
    });
    expect(record.problems.map((problem) => problem.key).toSorted()).toEqual([
      'DATABASE_WORKER_URL',
      'KEY_CREDENTIAL_DELIVERY_MATERIAL',
    ]);
    expect(finished.stderr).not.toContain('ENV-SECRET-WRONG');
    expect(finished.stderr).not.toContain('SENTINEL-NOT-A-KEY');
  });

  // Break caught: a deployed worker that carries the API's connection, which turns the worker's compromise into the API's.
  it('refuses a Staging environment that carries the API’s database URL', async () => {
    const running = start(
      WORKER_MAIN,
      env({
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        DATABASE_URL: 'postgres://melarc_api_runtime:ENV-SECRET-API@127.0.0.1:1/melarc',
      }),
    );

    const finished = await running.waitForExit(DEADLINES.finish, 'did not refuse by itself');

    expect(finished.code).toBe(1);
    expect((JSON.parse(finished.stderr) as { problems: { key: string }[] }).problems).toEqual([
      expect.objectContaining({ key: 'DATABASE_URL', problem: 'invalid' }),
    ]);
    expect(finished.stderr).not.toContain('ENV-SECRET-API');
  });

  // Break caught (OB-127, closed by the owner's decision of 11 October 2026): a local run, and CI, which runs as one, starting with a
  // real provider selected, whatever its endpoint. Capture is the only adapter there; the loader refuses before anything is composed.
  it('refuses a real provider in a local run, naming the setting only', async () => {
    const running = start(
      WORKER_MAIN,
      env({
        DELIVERY_EMAIL_ADAPTER: 'provider',
        DELIVERY_EMAIL_ENDPOINT: 'https://email.example.test/v1',
        DELIVERY_EMAIL_TIMEOUT_MS: '5000',
      }),
    );

    const finished = await running.waitForExit(DEADLINES.finish, 'did not refuse by itself');

    expect(finished).toMatchObject({ code: 1, signal: null, stdout: '' });
    const record = JSON.parse(finished.stderr) as { msg: string; problems: { key: string }[] };
    expect(record.msg).toBe('Invalid configuration: the delivery worker will not start');
    expect(record.problems.map((problem) => problem.key)).toEqual(['DELIVERY_EMAIL_ADAPTER']);
    expect(finished.stderr).not.toContain('email.example.test');
  });

  // Break caught: a real provider selected and silently replaced by something that accepts (a stub), or the endpoint repeated. The one
  // place a real provider can be selected is staging, inside the controlled window; none is built (release gate G3), so it refuses.
  it('refuses to start with a real provider selected in staging, because none is built, naming the setting only', async () => {
    const running = start(
      WORKER_MAIN,
      env({
        NODE_ENV: 'production',
        APP_ENV: 'staging',
        DELIVERY_EMAIL_ADAPTER: 'provider',
        DELIVERY_EMAIL_ENDPOINT: 'https://email.example.test/v1',
        DELIVERY_EMAIL_TIMEOUT_MS: '5000',
        DELIVERY_PROVIDER_APPROVAL_REF: 'G3-2026-001',
        DELIVERY_PROVIDER_ALLOWLIST: 'staff@example.test',
      }),
    );

    const finished = await running.waitForExit(DEADLINES.finish, 'did not refuse by itself');

    expect(finished.code).toBe(1);
    const record = JSON.parse(finished.stderr) as { msg: string; err: { message: string } };
    expect(record.msg).toBe('startup failed');
    expect(record.err.message).toContain('DELIVERY_EMAIL_ADAPTER');
    expect(finished.stderr).not.toContain('email.example.test');
  });

  // Break caught: the capture sink inside the checkout the worker runs from: the source package is built from it.
  it('refuses a capture sink inside the checkout, and creates nothing there', async () => {
    const inside = resolve(API_ROOT, 'melarc-sink-inside-the-checkout');
    const running = start(WORKER_MAIN, env({ DELIVERY_CAPTURE_DIRECTORY: inside }));

    const finished = await running.waitForExit(DEADLINES.finish, 'did not refuse by itself');

    expect(finished.code).toBe(1);
    expect((JSON.parse(finished.stderr) as { err: { type: string } }).err.type).toBe(
      'CaptureDirectoryInsideCheckoutError',
    );
    expect(existsSync(inside)).toBe(false);
  });
});

describe('a real worker process and its stop signal (S0.18; OB-24)', () => {
  // Break caught: a stop that does not stop the lanes, or leaves the process alive, or reports a clean end it did not make. The
  // fixture signals itself, so this runs on Windows as well: process.emit reaches the same handlers.
  it('stops by itself on a stop signal, with exit code 0, and says what it did', async () => {
    const running = start(WORKER_FIXTURE, env(), ['plain', '--signal-itself']);

    const finished = await running.waitForExit(DEADLINES.finish, 'did not end by itself');

    expect(finished).toMatchObject({ code: 0, signal: null, stderr: '' });
    const said = messages(finished);
    expect(said).toEqual(
      expect.arrayContaining([
        'delivery worker started',
        'redemption record readers are not built yet: the worker claims no message, and every queued message waits unspent until they are',
        'signal received',
        'delivery worker stopping',
        'delivery worker stopped',
        'shutdown complete',
      ]),
    );
    expect(said.indexOf('signal received')).toBeLessThan(said.indexOf('delivery worker stopped'));
    expect(said).not.toContain('exiting now');
    expect(finished.stdout).not.toContain('ENV-SECRET-WORKER');
    expect(lines(finished).find((line) => line.msg === 'delivery worker started')).toMatchObject({
      service: 'melarc-delivery-worker',
    });
  });

  // Break caught: the same, through a real signal from the operating system. Windows cannot deliver a graceful SIGTERM to a child
  // process (it ends the child outright), so this runs on Linux and macOS (and CI) and is reported as skipped, not passed, on Windows.
  // THIS IS THE WORKER'S REAL-SIGTERM EVIDENCE (plan OB-24): Gate 2 stays pending until it has run on Linux, WSL2 or CI.
  it.skipIf(process.platform === 'win32')(
    'stops by itself after a real SIGTERM, with exit code 0',
    async () => {
      const running = start(WORKER_MAIN, env());
      await until(() => running.stdout.includes('delivery worker started'), 'the worker to start');

      running.signal('SIGTERM');
      const finished = await running.waitForExit(
        DEADLINES.stop,
        'did not exit by itself after SIGTERM',
      );

      expect(finished).toMatchObject({ code: 0, signal: null, stderr: '' });
      expect(messages(finished)).toEqual(
        expect.arrayContaining(['signal received', 'delivery worker stopped', 'shutdown complete']),
      );
    },
  );
});
