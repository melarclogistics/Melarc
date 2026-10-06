import { describe, expect, it } from 'vitest';

import { apiEnvironment } from './api-environment.ts';

const RUNTIME_URL =
  'postgres://melarc_api_runtime:runtime-secret@127.0.0.1:5432/melarc_test_0a1b2c3d';

describe('apiEnvironment', () => {
  const environment = apiEnvironment({
    port: 4321,
    runtimeUrl: RUNTIME_URL,
    captureFile: '/tmp/capture.jsonl',
  });

  // Break caught: a missing required key, which the API reports and refuses to start for, so a run would fail
  // before its first test with a configuration error.
  it('sets every key the API requires, and says it is a local test run', () => {
    expect(environment).toMatchObject({
      NODE_ENV: 'test',
      APP_ENV: 'local',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: '4321',
      DATABASE_URL: RUNTIME_URL,
    });
  });

  // Break caught: the migration credentials reaching the API. It refuses to start with the variable present,
  // and it must never be able to act as the identity that owns the schema.
  it('carries no migration credential, and only the runtime identity', () => {
    expect(Object.keys(environment)).not.toContain('DATABASE_MIGRATION_URL');
    expect(environment.DATABASE_URL).toContain('melarc_api_runtime:');
    expect(JSON.stringify(environment)).not.toMatch(/melarc_migration/);
  });

  // Break caught: the sandbox not being told where to write, which would turn it from a capture into a plain
  // refusal that no test can look at.
  it('tells the sandbox where to record what it refuses', () => {
    expect(environment.MELARC_E2E_CAPTURE_FILE).toBe('/tmp/capture.jsonl');
  });

  // Break caught: a harness whose shutdown is not bounded. A run must not wait for the production default.
  it('keeps a short, finite shutdown budget', () => {
    expect(Number(environment.SHUTDOWN_TIMEOUT_MS)).toBeGreaterThanOrEqual(1_000);
    expect(Number(environment.SHUTDOWN_TIMEOUT_MS)).toBeLessThanOrEqual(10_000);
    expect(Number(environment.SHUTDOWN_DRAIN_DELAY_MS)).toBeLessThan(
      Number(environment.SHUTDOWN_TIMEOUT_MS),
    );
  });

  // Break caught: a connection pool large enough to exhaust the local server across runs.
  it('keeps the connection pool small', () => {
    expect(Number(environment.DATABASE_POOL_MAX)).toBeLessThanOrEqual(5);
  });

  // Break caught: a test that needs one more setting and cannot give it without rebuilding the harness. Extra
  // values are added, and may replace a default, but never the ones that make the run safe.
  it('accepts extra settings, and refuses to let them undo the safety ones', () => {
    const extra = apiEnvironment({
      port: 1,
      runtimeUrl: RUNTIME_URL,
      captureFile: '/tmp/capture.jsonl',
      extra: { LOG_LEVEL: 'debug' },
    });

    expect(extra.LOG_LEVEL).toBe('debug');
    for (const forbidden of ['APP_ENV', 'DATABASE_MIGRATION_URL', 'MELARC_E2E_CAPTURE_FILE']) {
      expect(() =>
        apiEnvironment({
          port: 1,
          runtimeUrl: RUNTIME_URL,
          captureFile: '/tmp/capture.jsonl',
          extra: { [forbidden]: 'x' },
        }),
      ).toThrow(forbidden);
    }
  });
});
