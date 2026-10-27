import { describe, expect, it } from 'vitest';

import { runKeys } from './api-environment.ts';
import { workerEnvironment } from './worker-environment.ts';

const WORKER_URL =
  'postgres://melarc_worker_runtime:worker-secret@127.0.0.1:5432/melarc_test_0a1b2c3d';

const given = (keys = runKeys()) => ({
  databaseWorkerUrl: WORKER_URL,
  captureDirectory: '/tmp/melarc-capture',
  captureFile: '/tmp/capture.jsonl',
  keys,
});

describe('workerEnvironment', () => {
  // Break caught: the worker holding a key it has no use for, which the worker's own configuration refuses in a deployed environment
  // and which would make the compromise of the worker the compromise of more (SECURITY_DESIGN.md §14.9).
  it('holds the credential-delivery key and no other', () => {
    const keys = runKeys();
    const environment = workerEnvironment(given(keys));

    expect(environment.KEY_CREDENTIAL_DELIVERY_MATERIAL).toBe(
      keys.KEY_CREDENTIAL_DELIVERY_MATERIAL,
    );
    expect(environment.KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION).toBe(
      keys.KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION,
    );
    expect(
      Object.keys(environment)
        .filter((name) => name.startsWith('KEY_'))
        .toSorted(),
    ).toEqual([
      'KEY_CREDENTIAL_DELIVERY_ACTIVE_VERSION',
      'KEY_CREDENTIAL_DELIVERY_MATERIAL',
      'KEY_CUSTODY',
    ]);
  });

  // Break caught: the worker given the API's connection or a migration login, which it must not hold.
  it('connects as the worker login only, and carries no other database credential', () => {
    const environment = workerEnvironment(given());

    expect(environment.DATABASE_WORKER_URL).toBe(WORKER_URL);
    for (const name of ['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_SEED_URL']) {
      expect(Object.keys(environment), name).not.toContain(name);
    }
    expect(JSON.stringify(environment)).not.toMatch(/melarc_migration|melarc_api_runtime/);
  });

  // Break caught: a worker that could select a real provider in a journey run.
  it('sends through the capture adapter only, into the folder it is given, and is a local test run', () => {
    expect(workerEnvironment(given())).toMatchObject({
      NODE_ENV: 'test',
      APP_ENV: 'local',
      KEY_CUSTODY: 'local',
      DELIVERY_EMAIL_ADAPTER: 'capture',
      DELIVERY_SMS_ADAPTER: 'capture',
      DELIVERY_CAPTURE_DIRECTORY: '/tmp/melarc-capture',
      MELARC_E2E_CAPTURE_FILE: '/tmp/capture.jsonl',
    });
  });

  // Break caught: a worker that waits for the production default between looks at the queue, so that a link takes seconds to arrive
  // and every journey waits on it.
  it('looks at the queue often, and stops within a short budget', () => {
    const environment = workerEnvironment(given());
    expect(Number(environment.DELIVERY_WORKER_POLL_INTERVAL_MS)).toBeLessThanOrEqual(500);
    expect(Number(environment.SHUTDOWN_TIMEOUT_MS)).toBeLessThanOrEqual(10_000);
  });
});
