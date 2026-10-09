import { Global, Inject, Injectable, Module, type ModuleMetadata } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import {
  CLOCK,
  HASHER,
  METRICS,
  PORTS,
  portProviders,
  type Clock,
  type HashVerdict,
  type Hasher,
  type Metrics,
  type PortBindings,
} from './platform/auth/ports/index.js';
import type { AppConfig } from './platform/config/load-config.js';
import { createLogger } from './platform/logging/create-logger.js';
import { APP_CONFIG } from './platform/platform.tokens.js';
import { startTestApp, TEST_CONFIG, type TestApp } from './test-support/test-app.js';

// Test-only compositions. Each adapter below is a small real implementation of its port, so what a booted application hands back
// is judged by identity and by what the container injected into it, not by the shape of an array or a mock cast to fit.
const INSTANT = new Date('2026-10-09T00:00:00.000Z');
const FIXED: Clock = { now: () => INSTANT, monotonicMilliseconds: () => 42 };

const built: string[] = [];

/** Built by the container from the platform's validated configuration. */
@Injectable()
class ConfiguredClock implements Clock {
  constructor(@Inject(APP_CONFIG) readonly config: AppConfig) {
    built.push('ConfiguredClock');
  }

  now(): Date {
    return INSTANT;
  }

  monotonicMilliseconds(): number {
    return 7;
  }
}

class FakeHasher implements Hasher {
  constructor(
    readonly config: AppConfig,
    readonly clock: Clock,
  ) {
    built.push('FakeHasher');
  }

  hash(): Promise<string> {
    return Promise.resolve('hashed');
  }

  verify(): Promise<HashVerdict> {
    return Promise.resolve({ matches: true, needsRehash: false });
  }

  verifyAgainstDummy(): Promise<void> {
    return Promise.resolve();
  }
}

/** One adapter that a domain module would provide and the root binds to a token it did not create. */
@Injectable()
class SharedMetrics implements Metrics {
  readonly seen: string[] = [];

  constructor() {
    built.push('SharedMetrics');
  }

  increment(name: string): void {
    this.seen.push(name);
  }

  observe(name: string): void {
    this.seen.push(name);
  }
}

@Global()
@Module({ providers: [SharedMetrics], exports: [SharedMetrics] })
class SharedMetricsModule {}

/** A stand-in for a platform service: it asks for the clock by token and imports no adapter. */
@Injectable()
class NeedsAClock {
  constructor(@Inject(CLOCK) readonly clock: Clock) {}
}

@Module({ providers: [NeedsAClock], exports: [NeedsAClock] })
class NeedsAClockModule {}

@Module({})
class TestRootModule {}

let running: TestApp | undefined;

beforeEach(() => {
  built.length = 0;
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

const boot = (ports: PortBindings, ...extra: NonNullable<ModuleMetadata['imports']>) =>
  startTestApp({
    rootModule: (options) => ({
      module: TestRootModule,
      imports: [AppModule.register({ ...options, ports }), ...extra],
    }),
  });

const resolve = <T>(token: symbol | (new (...parameters: never[]) => T)): T => {
  if (running === undefined) throw new Error('no application is running');
  return running.app.get<T>(token, { strict: false });
};

describe('the composition root binds adapters to the port tokens (S0.1)', () => {
  // Break caught: a port that resolves to something nobody bound, so the first caller finds a half-wired application.
  it('binds no port while no adapter exists', async () => {
    running = await startTestApp();

    for (const entry of PORTS) {
      expect(() => resolve(entry.token), entry.name).toThrow();
    }
    expect(portProviders()).toEqual([]);
    expect(portProviders({})).toEqual([]);
  });

  // Break caught: a binding the root accepts but a platform service cannot reach, or one that needs the service to import it.
  it('gives a module the value bound to a token without that module importing anything', async () => {
    running = await boot({ clock: { useValue: FIXED } }, NeedsAClockModule);

    expect(resolve<Clock>(CLOCK)).toBe(FIXED);
    expect(resolve(NeedsAClock).clock).toBe(FIXED);
  });

  // Break caught: useClass that is accepted but not constructed by the container, so it never receives its dependencies, or
  // that makes a new instance for every caller.
  it('constructs a bound class once, with its dependencies injected', async () => {
    running = await boot({ clock: { useClass: ConfiguredClock } }, NeedsAClockModule);

    const first = resolve<Clock>(CLOCK);
    const second = resolve<Clock>(CLOCK);
    expect(first).toBeInstanceOf(ConfiguredClock);
    expect(second).toBe(first);
    expect(resolve(NeedsAClock).clock).toBe(first);
    expect((first as ConfiguredClock).config).toBe(TEST_CONFIG);
    expect(built.filter((name) => name === 'ConfiguredClock')).toHaveLength(1);
  });

  // Break caught: a factory called without its injected dependencies, called more than once, or unable to take another port
  // bound in the same composition.
  it('calls a bound factory once, with the dependencies it names, another port among them', async () => {
    const calls: { config: AppConfig; clock: Clock }[] = [];
    running = await boot({
      clock: { useValue: FIXED },
      hasher: {
        useFactory: (config: AppConfig, clock: Clock) => {
          calls.push({ config, clock });
          return new FakeHasher(config, clock);
        },
        inject: [APP_CONFIG, CLOCK],
      },
    });

    const hasher = resolve<Hasher>(HASHER);
    expect(resolve<Hasher>(HASHER)).toBe(hasher);
    expect(hasher).toBeInstanceOf(FakeHasher);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.config).toBe(TEST_CONFIG);
    expect(calls[0]?.clock).toBe(FIXED);
    expect((hasher as FakeHasher).clock).toBe(FIXED);
    await expect(hasher.hash('STAFF_PASSWORD', 'a-long-enough-secret')).resolves.toBe('hashed');
  });

  it('waits for an asynchronous factory and hands back what it resolved to', async () => {
    const made = new FakeHasher(TEST_CONFIG, FIXED);
    running = await boot({ hasher: { useFactory: () => Promise.resolve(made) } });

    expect(resolve<Hasher>(HASHER)).toBe(made);
  });

  // Break caught: useExisting that makes a second instance instead of pointing at the provider already in the graph, so the
  // domain's adapter and the port's adapter would be two objects with two sets of state.
  it('points a token at the one instance another module provides', async () => {
    running = await boot({ metrics: { useExisting: SharedMetrics } }, SharedMetricsModule);

    const shared = resolve(SharedMetrics);
    const bound = resolve<Metrics>(METRICS);
    expect(bound).toBe(shared);
    bound.increment('credential_recovery_requests_excluded_total');
    expect(shared.seen).toEqual(['credential_recovery_requests_excluded_total']);
    expect(built.filter((name) => name === 'SharedMetrics')).toHaveLength(1);
  });

  // Break caught: one binding leaking onto another port's token, or binding one port binding them all.
  it('binds only the ports it is given, each to its own adapter', async () => {
    running = await boot(
      { clock: { useValue: FIXED }, metrics: { useExisting: SharedMetrics } },
      SharedMetricsModule,
    );

    expect(resolve<Clock>(CLOCK)).toBe(FIXED);
    expect(resolve<Metrics>(METRICS)).toBe(resolve(SharedMetrics));
    expect(() => resolve(HASHER)).toThrow();
  });
});

describe('the root module exposes the port tokens and nothing else (S0.1)', () => {
  const options = { config: TEST_CONFIG, logger: createLogger({ config: TEST_CONFIG }) };

  // Break caught: the global root re-exporting the platform's providers or anything but the tokens it bound, which would widen
  // what every module can reach without importing it.
  it('is global, exports exactly the tokens it bound, and imports only the platform', () => {
    const module = AppModule.register({
      ...options,
      ports: { clock: { useValue: FIXED }, metrics: { useExisting: SharedMetrics } },
    });

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([CLOCK, METRICS]);
    expect(module.providers).toHaveLength(2);
    expect(module.imports).toHaveLength(1);
  });

  it('exports nothing and provides nothing while no port is bound', () => {
    const module = AppModule.register(options);

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([]);
    expect(module.providers).toEqual([]);
  });
});

describe('portProviders keeps the port its own token and refuses a malformed binding (S0.1)', () => {
  const malformed = (value: unknown): PortBindings => value as PortBindings;
  const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

  // Break caught: a binding's own `provide` replacing the port's token, so binding one port captures another's token.
  it('binds a provider to the registry token of every port', () => {
    const providers = portProviders({
      clock: { useExisting: 'X' },
      hasher: { useExisting: 'X' },
      secretCipher: { useExisting: 'X' },
      tokenService: { useExisting: 'X' },
      totpVerifier: { useExisting: 'X' },
      rateLimiter: { useExisting: 'X' },
      hashAdmission: { useExisting: 'X' },
      idempotencyStore: { useExisting: 'X' },
      auditWriter: { useExisting: 'X' },
      sessionStore: { useExisting: 'X' },
      identityDirectory: { useExisting: 'X' },
      unitOfWork: { useExisting: 'X' },
      deliveryQueue: { useExisting: 'X' },
      deliveryProvider: { useExisting: 'X' },
      attestationVerifier: { useExisting: 'X' },
      metrics: { useExisting: 'X' },
    });

    expect(providers.map((provider) => provider.provide)).toEqual(
      PORTS.map((entry) => entry.token),
    );
    expect(PORTS.map((entry) => lowerFirst(entry.name))).toHaveLength(providers.length);
  });

  // Break caught (the reproduced overwrite): `{ provide: HASHER, useValue }` given for the clock was spread over the clock's
  // token, so the root bound the clock's adapter to the hasher's token without complaint.
  it('refuses a binding that gives its own provide, whatever it names', () => {
    for (const provide of [HASHER, CLOCK, 'CLOCK', Symbol('CLOCK'), undefined]) {
      expect(
        () => portProviders(malformed({ clock: { useValue: FIXED, provide } })),
        String(provide),
      ).toThrow(
        /The binding for the port Clock must not give provide: the token is the port's own/,
      );
    }
    expect(() =>
      AppModule.register({
        config: TEST_CONFIG,
        logger: createLogger({ config: TEST_CONFIG }),
        ports: malformed({ clock: { useValue: FIXED, provide: HASHER } }),
      }),
    ).toThrow(/must not give provide/);
  });

  it('keeps the explicit undefined of an unbound port as no binding', () => {
    expect(portProviders({ clock: undefined })).toEqual([]);
  });

  it.each([
    ['null', null],
    ['a string', 'clock'],
    ['a number', 42],
    ['an array', [{ useValue: FIXED }]],
    ['a function', () => FIXED],
    ['a class instance', new ConfiguredClock(TEST_CONFIG)],
  ])('refuses %s as a binding', (_label, binding) => {
    expect(() => portProviders(malformed({ clock: binding }))).toThrow(
      /The binding for the port Clock must be an object that gives exactly one of useClass, useValue, useFactory or useExisting\./,
    );
  });

  it.each([
    ['no provider kind', {}],
    ['two provider kinds', { useValue: FIXED, useClass: ConfiguredClock }],
    [
      'all four kinds',
      { useValue: FIXED, useClass: ConfiguredClock, useFactory: () => FIXED, useExisting: 'X' },
    ],
  ])('refuses %s', (_label, binding) => {
    expect(() => portProviders(malformed({ clock: binding }))).toThrow(
      /The binding for the port Clock must give exactly one of useClass, useValue, useFactory or useExisting\./,
    );
  });

  it.each([
    ['a property that no binding takes', { useValue: FIXED, extra: 1 }, 'extra', 'useValue'],
    [
      'a symbol key',
      { useValue: FIXED, [Symbol('extra')]: 1 },
      String.raw`Symbol\(extra\)`,
      'useValue',
    ],
    [
      'inject on a class binding, where Nest takes none',
      { useClass: ConfiguredClock, inject: [APP_CONFIG] },
      'inject',
      'useClass',
    ],
    ['scope on a value binding', { useValue: FIXED, scope: 0 }, 'scope', 'useValue'],
    ['inject on an existing binding', { useExisting: 'X', inject: [] }, 'inject', 'useExisting'],
  ])('refuses %s', (_label, binding, key, kind) => {
    expect(() => portProviders(malformed({ clock: binding }))).toThrow(
      new RegExp(
        `The binding for the port Clock gives "${key}", which a ${kind} binding does not take\\.`,
      ),
    );
  });

  it.each([
    [
      'a useClass that is not a class',
      { useClass: 'ConfiguredClock' },
      'useClass that is not a class',
    ],
    ['a useFactory that is not a function', { useFactory: 1 }, 'useFactory that is not a function'],
    ['a useValue that is not an object', { useValue: 'clock' }, 'useValue that is not an object'],
    ['an undefined useValue', { useValue: undefined }, 'useValue that is not an object'],
    ['a null useValue', { useValue: null }, 'useValue that is not an object'],
    ['a useExisting that is not a token', { useExisting: 42 }, 'useExisting that is not a token'],
  ])('refuses %s', (_label, binding, said) => {
    expect(() => portProviders(malformed({ clock: binding }))).toThrow(
      new RegExp(`The binding for the port Clock gives a ${said}\\.`),
    );
  });

  it('refuses a key that is not a port, naming the ports', () => {
    expect(() => portProviders(malformed({ clok: { useValue: FIXED } }))).toThrow(
      /"clok" is not a port\. The ports are: clock, hasher, /,
    );
  });
});
