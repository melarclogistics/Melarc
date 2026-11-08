import net from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module.js';
import { createApp } from '../create-app.js';
import { DESCRIBE_PORT_BINDINGS } from '../platform/auth/describe/describe-ports.adapter.js';
import { PORTS } from '../platform/auth/ports/index.js';
import { adapterRefusals } from '../platform/config/adapter-refusals.js';
import { CONFIG_KEYS } from '../platform/config/load-config.js';
import { randomKey } from '../test-support/config-env.js';
import { DESCRIBE_CONFIG } from './describe-config.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('the describe composition, as contract:check and openapi:generate build it (S0.2)', () => {
  // The exit condition of S0.2: `contract:check`, `openapi:generate` and the default test application resolve every S0.1 port.
  // The two tools build the application with exactly this call, so this is their composition, initialised and not listening.
  it('resolves every port to its inert adapter without listening or connecting', async () => {
    const listen = vi.spyOn(net.Server.prototype, 'listen');
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const app = await createApp({
      config: DESCRIBE_CONFIG,
      rootModule: (options) => AppModule.register(options),
    });
    try {
      await app.init();

      for (const entry of PORTS) {
        const key = entry.name.charAt(0).toLowerCase() + entry.name.slice(1);
        const binding = DESCRIBE_PORT_BINDINGS[key as keyof typeof DESCRIBE_PORT_BINDINGS];
        const adapter = app.get<object>(entry.token, { strict: false });

        expect(binding !== undefined && 'useClass' in binding, entry.name).toBe(true);
        expect(adapter.constructor.name, entry.name).toBe(`Describe${entry.name}`);
      }
      expect(listen).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }, 30_000);

  // Break caught: a describe configuration that reads the environment, so the tools that run in CI depend on, and could
  // print, whatever the machine holds (the plan: never resolve a secret during describe).
  it('reads nothing from the environment, whatever it holds', async () => {
    const before = JSON.stringify(DESCRIBE_CONFIG);
    const key = randomKey();
    // Every setting the API reads holds a canary, so a configuration that took any one of them from the environment differs.
    for (const name of CONFIG_KEYS) vi.stubEnv(name, `environment-canary-${name}`);
    vi.stubEnv('KEY_TOTP_SEED_MATERIAL', `1:${key}`);
    vi.stubEnv('KEY_CUSTODY', 'local');
    vi.stubEnv('APP_ENV', 'production');
    vi.stubEnv('OPS_ORIGIN', 'https://environment-canary.example');
    vi.stubEnv('DATABASE_URL', 'postgres://melarc_api_runtime:ENV-CANARY@127.0.0.1:1/melarc');
    vi.resetModules();

    const { DESCRIBE_CONFIG: reloaded } = await import('./describe-config.js');

    expect(JSON.stringify(reloaded)).toBe(before);
    expect(JSON.stringify(reloaded)).not.toContain(key);
    expect(JSON.stringify(reloaded)).not.toContain('environment-canary');
    expect(reloaded.appEnv).toBe('local');
    expect(reloaded.database).toBeUndefined();
  });

  it('holds no key material and no database', () => {
    expect(DESCRIBE_CONFIG.keys).toEqual({ custody: 'describe' });
    expect(DESCRIBE_CONFIG.database).toBeUndefined();
    expect(DESCRIBE_CONFIG.composition).toBe('describe');
  });

  // Break caught (S0.2 exit condition): production configuration accepting a describe adapter.
  it.each(['staging', 'production'] as const)(
    'is refused when it claims to be a %s environment',
    (appEnv) => {
      const problems = adapterRefusals({ ...DESCRIBE_CONFIG, appEnv, nodeEnv: 'production' });

      expect(problems.map((problem) => problem.key)).toEqual(
        expect.arrayContaining(['composition', 'KEY_CUSTODY']),
      );
    },
  );
});
