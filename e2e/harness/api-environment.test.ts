import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { describe, expect, it } from 'vitest';

import { apiEnvironment, PROTECTED_KEYS } from './api-environment.ts';

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

  // Break caught: a run that uses a test adapter in a way that proves nothing, such as the in-memory limiter where the
  // authoritative PostgreSQL one is what an integrated run must exercise (SECURITY_DESIGN.md section 14.12).
  it('selects the PostgreSQL limiter, the local key custody, the capture sink and the substitute verifier', () => {
    expect(environment).toMatchObject({
      RATE_LIMITER: 'postgres',
      KEY_CUSTODY: 'local',
      DELIVERY_EMAIL_ADAPTER: 'capture',
      DELIVERY_SMS_ADAPTER: 'capture',
      ATTESTATION_VERIFIER: 'substitute',
    });
  });

  // Break caught: the harness naming a different set of key settings from the one the API reads, so a run fails at start for a
  // setting added to the API and not to the harness.
  it('sets every setting the API example makes required, key material included', () => {
    const example = parseEnv(
      readFileSync(resolve(import.meta.dirname, '../../apps/api/.env.example'), 'utf8'),
    );
    const required = Object.keys(example).filter(
      (name) => name.startsWith('KEY_') || ['OPS_ORIGIN', 'VENDOR_ORIGIN'].includes(name),
    );

    expect(required.length).toBeGreaterThanOrEqual(13);
    for (const name of required) expect(Object.keys(environment), name).toContain(name);
  });

  // Break caught: key material that is not a key (a placeholder, a short string), or the same key for two purposes, which the
  // API refuses at start; or the same keys on every run, which would make them a shared secret.
  it('gives each purpose a fresh key of its own, as the API reads one, on every call', () => {
    const again = apiEnvironment({
      port: 1,
      runtimeUrl: RUNTIME_URL,
      captureFile: '/tmp/capture.jsonl',
    });
    const keys = (values: Record<string, string>): string[] =>
      Object.entries(values)
        .filter(([name]) => /^KEY_.+_MATERIAL$/.test(name))
        .map(([, value]) => value);

    expect(keys(environment)).toHaveLength(5);
    for (const value of keys(environment)) expect(value).toMatch(/^1:[A-Za-z0-9_-]{43}$/);
    expect(new Set([...keys(environment), ...keys(again)]).size).toBe(10);
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
  });

  // Break caught: a key silently leaving the protected list (a rename, a typo, a deletion), after which a
  // test could point the API at another database or turn the sandbox's capture off. The list is compared with
  // a literal, so a change to it is a decision made here, in view, and not a side effect.
  it('protects exactly the settings that make a run local, sandboxed and safe', () => {
    expect([...PROTECTED_KEYS].toSorted()).toEqual([
      'APP_ENV',
      'ATTESTATION_VERIFIER',
      'DATABASE_MIGRATION_URL',
      'DATABASE_URL',
      'DELIVERY_EMAIL_ADAPTER',
      'DELIVERY_SMS_ADAPTER',
      'KEY_CUSTODY',
      'MELARC_E2E_CAPTURE_FILE',
      'NODE_ENV',
      'RATE_LIMITER',
    ]);
  });

  // Break caught: a protected key that can be overridden through `extra`. Every key of the exported list is
  // tried, so a key added to it later is covered without anyone remembering to add a case here.
  it.each(PROTECTED_KEYS)('refuses to let extra settings override %s', (forbidden) => {
    expect(() =>
      apiEnvironment({
        port: 1,
        runtimeUrl: RUNTIME_URL,
        captureFile: '/tmp/capture.jsonl',
        extra: { [forbidden]: 'x' },
      }),
    ).toThrow(`${forbidden} is set by the harness and cannot be overridden.`);
  });

  // Break caught: a refused override that still reaches the environment, or an override that is refused only
  // when it comes alone and slips through beside an allowed one.
  it('refuses a protected key even when it comes beside an allowed one', () => {
    expect(() =>
      apiEnvironment({
        port: 1,
        runtimeUrl: RUNTIME_URL,
        captureFile: '/tmp/capture.jsonl',
        extra: { LOG_LEVEL: 'debug', NODE_ENV: 'production' },
      }),
    ).toThrow('NODE_ENV');
  });
});
