import net from 'node:net';

import { Global, Inject, Injectable, Module, Scope, type ModuleMetadata } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from './app.module.js';
import { SystemClock } from './platform/auth/clock/system.clock.adapter.js';
import { DescribeAdapterBoundError } from './platform/auth/describe/describe-adapter.js';
import { PortBindingError } from './platform/auth/describe/port-binding-check.js';
import { DescribeAdapterInvokedError } from './platform/auth/describe/describe-adapter-error.js';
import {
  DESCRIBE_PORT_BINDINGS,
  DescribeClock,
  DescribeHasher,
  DescribeMetrics,
} from './platform/auth/describe/describe-ports.adapter.js';
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
import { AdapterRefusedError } from './platform/config/adapter-refusals.js';
import { inertConfig } from './platform/config/inert-config.js';
import type { KeyPurpose, PurposeKeys } from './platform/config/key-material.js';
import type { AppConfig } from './platform/config/load-config.js';
import { Secret } from './platform/config/secret.js';
import { createLogger } from './platform/logging/create-logger.js';
import { APP_CONFIG } from './platform/platform.tokens.js';
import { randomKey } from './test-support/config-env.js';
import { startTestApp, TEST_CONFIG, type TestApp } from './test-support/test-app.js';

// Test-only compositions. Each adapter below is a small real implementation of its port, so what a booted application hands back
// is judged by identity and by what the container injected into it, not by the shape of an array or a mock cast to fit.
const INSTANT = new Date('2026-10-09T00:00:00.000Z');
const FIXED: Clock = { now: () => INSTANT, monotonicMilliseconds: () => 42 };

const built: string[] = [];

/** The test configuration composed for real, where no adapter is bound until a binding is given. */
const RUNTIME_CONFIG: AppConfig = { ...TEST_CONFIG, composition: 'runtime' };

/** The describe adapter class a port resolves to, read from the table the composition root binds. */
const DESCRIBE_CLASSES = Object.fromEntries(
  PORTS.map((entry) => {
    const key = entry.name.charAt(0).toLowerCase() + entry.name.slice(1);
    const binding = DESCRIBE_PORT_BINDINGS[key as keyof PortBindings];
    return [
      entry.name,
      binding !== undefined && 'useClass' in binding ? binding.useClass : undefined,
    ];
  }),
) as Record<string, new () => object>;

const runtimeKeys = (): Record<KeyPurpose, PurposeKeys> => {
  const one = (): PurposeKeys => ({ activeVersion: 1, versions: { 1: new Secret(randomKey()) } });
  return {
    totp_seed: one(),
    credential_delivery: one(),
    idempotent_replay: one(),
    limiter_digest: one(),
    password_pepper: one(),
  };
};

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
  // Break caught: a port that resolves to something nobody bound, so the first caller finds a half-wired application. The
  // runtime composition binds the production Clock (S0.6, which needs it for its deadlines) and nothing else: each other port is
  // bound by the first task that consumes it (OB-38). This pin changed deliberately at S0.6.
  it('binds only the production Clock in the runtime composition while no other real adapter is bound', async () => {
    running = await startTestApp({ config: RUNTIME_CONFIG });

    for (const entry of PORTS.filter((port) => port.name !== 'Clock')) {
      expect(() => resolve(entry.token), entry.name).toThrow();
    }
    const clock = resolve<Clock>(CLOCK);
    expect(clock).toBeInstanceOf(SystemClock);
    expect(Number.isFinite(clock.monotonicMilliseconds())).toBe(true);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(5_000);
    expect(portProviders()).toEqual([]);
    expect(portProviders({})).toEqual([]);
  });

  // Break caught: the production Clock reaching the describe composition, where every port must stay inert so that building the
  // application to describe it reads no time and does no work.
  it('keeps the describe Clock in the describe composition', async () => {
    running = await startTestApp();

    expect(resolve<Clock>(CLOCK)).toBeInstanceOf(DescribeClock);
  });

  // Break caught: the binding being a transient or a request-scoped one: it is the application's one clock, shared by every
  // deadline, and the container's own record says so.
  it('binds the production Clock as an application singleton', async () => {
    running = await startTestApp({ config: RUNTIME_CONFIG });

    expect(resolve<Clock>(CLOCK)).toBe(resolve<Clock>(CLOCK));
  });

  // The exit condition of S0.2: the default test application resolves every port.
  it('resolves every port, in the default test application, to its inert describe adapter', async () => {
    running = await startTestApp();

    for (const entry of PORTS) {
      const adapter = resolve<object>(entry.token);
      expect(adapter, entry.name).toBeInstanceOf(DESCRIBE_CLASSES[entry.name]);
    }
  });

  // Break caught: a describe adapter that does real work when the application merely uses the port it was bound to.
  it('has a resolved describe adapter fail by name when it is asked to run', async () => {
    running = await startTestApp();

    expect(() => resolve<Clock>(CLOCK).now()).toThrow(DescribeAdapterInvokedError);
    expect(() => resolve<Clock>(CLOCK).now()).toThrow(/Clock\.now/);
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
  it('replaces only the ports it is given, each by its own adapter, and leaves the rest on their describe adapters', async () => {
    running = await boot(
      { clock: { useValue: FIXED }, metrics: { useExisting: SharedMetrics } },
      SharedMetricsModule,
    );

    expect(resolve<Clock>(CLOCK)).toBe(FIXED);
    expect(resolve<Metrics>(METRICS)).toBe(resolve(SharedMetrics));
    expect(resolve<Hasher>(HASHER)).toBeInstanceOf(DescribeHasher);
  });

  // Break caught: an explicit undefined, which means "no binding", deleting the describe adapter it was laid over.
  it('keeps the describe adapter of a port whose binding is explicitly undefined', async () => {
    running = await boot({ clock: undefined });

    expect(resolve<Clock>(CLOCK)).toBeInstanceOf(DescribeClock);
  });

  it('binds only the ports it is given in the runtime composition', async () => {
    running = await startTestApp({
      config: RUNTIME_CONFIG,
      rootModule: (options) => ({
        module: TestRootModule,
        imports: [AppModule.register({ ...options, ports: { clock: { useValue: FIXED } } })],
      }),
    });

    expect(resolve<Clock>(CLOCK)).toBe(FIXED);
    expect(() => resolve(HASHER)).toThrow();
  });
});

describe('the root module exposes the port tokens and nothing else (S0.1)', () => {
  const options = { config: TEST_CONFIG, logger: createLogger({ config: TEST_CONFIG }) };
  const runtime = { config: RUNTIME_CONFIG, logger: options.logger };

  // Break caught: the global root re-exporting the platform's providers or anything but the tokens it bound, which would widen
  // what every module can reach without importing it.
  it('is global, exports exactly the tokens it bound, and imports only the platform', () => {
    const module = AppModule.register({
      ...runtime,
      ports: { clock: { useValue: FIXED }, metrics: { useExisting: SharedMetrics } },
    });

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([CLOCK, METRICS]);
    // The two bindings and the check that no inert describe adapter was bound; the check is not exported.
    expect(module.providers).toHaveLength(3);
    expect(module.imports).toHaveLength(1);
  });

  // Changed deliberately at S0.6: the runtime composition binds the production Clock itself, and exports that one token.
  it('exports the Clock token and nothing else in the runtime composition', () => {
    const module = AppModule.register(runtime);

    expect(module.global).toBe(true);
    expect(module.exports).toEqual([CLOCK]);
    expect(module.providers).toHaveLength(2);
  });

  // Break caught: the describe composition exporting more than the sixteen tokens, or fewer.
  it('exports the sixteen port tokens and nothing else in the describe composition', () => {
    const module = AppModule.register(options);

    expect(module.global).toBe(true);
    expect(module.exports).toEqual(PORTS.map((entry) => entry.token));
    // The sixteen bindings and the check that each is a singleton; the check is not exported.
    expect(module.providers).toHaveLength(PORTS.length + 1);
    expect(module.imports).toHaveLength(1);
  });
});

describe('the composition root refuses what its environment refuses (S0.2)', () => {
  const refused = (config: AppConfig): AdapterRefusedError => {
    try {
      AppModule.register({ config, logger: createLogger({ config: TEST_CONFIG }) });
    } catch (error) {
      if (error instanceof AdapterRefusedError) return error;
      throw error;
    }
    throw new Error('expected the configuration to be refused');
  };

  // Break caught (S0.2 exit condition): a describe adapter reachable in production, or in an environment that is not a local run.
  it.each(['staging', 'production'] as const)(
    'refuses the describe composition when APP_ENV is %s, naming the setting and no value',
    (appEnv) => {
      const error = refused(inertConfig({ appEnv, nodeEnv: 'production' }));

      expect(error.problems.map((problem) => problem.key)).toContain('composition');
      expect(error.name).toBe('AdapterRefusedError');
      expect(error.message).toContain('composition');
    },
  );

  it('refuses the describe key custody outside a local run', () => {
    expect(
      refused(
        inertConfig({ appEnv: 'staging', nodeEnv: 'production', composition: 'runtime' }),
      ).problems.map((problem) => problem.key),
    ).toEqual(['KEY_CUSTODY']);
  });

  // Break caught: the guard applied to what the environment produced but not to a configuration built by hand, which is
  // the only way to ask for the describe composition.
  it('refuses a hand-built production configuration that selects a test adapter, however it was made', () => {
    const config = inertConfig({
      appEnv: 'production',
      nodeEnv: 'production',
      composition: 'runtime',
      keys: { custody: 'local', purposes: runtimeKeys() },
    });

    expect(
      refused(config)
        .problems.map((problem) => problem.key)
        .toSorted(),
    ).toEqual([
      'ATTESTATION_VERIFIER',
      'DELIVERY_EMAIL_ADAPTER',
      'DELIVERY_SMS_ADAPTER',
      'KEY_CUSTODY',
    ]);
  });

  // Break caught (OB-127, closed by the owner's decision of 11 October 2026): a local run, and CI, which runs as one, reaching a real
  // provider through a configuration built by hand, which the environment's loader refuses but a hand-built one would not. The API's
  // composition judges the built configuration: capture is the only delivery adapter there, in the API as in the worker.
  it('refuses a hand-built local configuration that selects a real delivery provider, whatever its endpoint', () => {
    const provider = (endpoint: string) =>
      ({
        kind: 'provider',
        endpoint,
        timeoutMs: 5_000,
      }) as AppConfig['adapters']['delivery']['email'];
    const adapters = (email: 'capture' | 'provider', sms: 'capture' | 'provider') =>
      Object.freeze({
        limiter: 'postgres',
        delivery: Object.freeze({
          email:
            email === 'provider'
              ? provider('http://127.0.0.1:9000/send')
              : Object.freeze({ kind: 'capture' }),
          sms:
            sms === 'provider'
              ? provider('https://sms.example.test/v1')
              : Object.freeze({ kind: 'capture' }),
        }),
        attestationVerifier: Object.freeze({ kind: 'substitute' }),
      }) as AppConfig['adapters'];

    expect(
      refused(inertConfig({ adapters: adapters('provider', 'capture') })).problems.map(
        (problem) => problem.key,
      ),
    ).toEqual(['DELIVERY_EMAIL_ADAPTER']);
    expect(
      refused(inertConfig({ adapters: adapters('capture', 'provider') })).problems.map(
        (problem) => problem.key,
      ),
    ).toEqual(['DELIVERY_SMS_ADAPTER']);
    expect(
      refused(inertConfig({ adapters: adapters('provider', 'provider') })).problems.map(
        (problem) => problem.key,
      ),
    ).toEqual(['DELIVERY_EMAIL_ADAPTER', 'DELIVERY_SMS_ADAPTER']);
  });

  it('accepts the describe composition in a local run', () => {
    const logger = createLogger({ config: TEST_CONFIG });

    expect(() => AppModule.register({ config: TEST_CONFIG, logger })).not.toThrow();
  });
});

describe('the runtime composition refuses an inert describe adapter, however it is bound (S0.2)', () => {
  const logger = createLogger({ config: TEST_CONFIG });
  /** A subclass that overrides nothing: renaming or extending an inert adapter does not make it a real one. */
  class RenamedClock extends DescribeClock {}
  class RenamedHasher extends DescribeHasher {}
  const ALIAS = Symbol('ALIAS');

  @Global()
  @Module({ providers: [{ provide: ALIAS, useClass: DescribeMetrics }], exports: [ALIAS] })
  class AliasOfADescribeAdapterModule {}

  const ports = (error: unknown): readonly string[] => {
    if (error instanceof DescribeAdapterBoundError) return error.ports;
    throw error instanceof Error ? error : new Error('expected a refusal');
  };
  /** The ports the container found to be an inert describe adapter when the application initialised. */
  const resolvedToDescribe = (error: unknown): readonly string[] => {
    if (error instanceof PortBindingError) return error.describeAdapters;
    throw error instanceof Error ? error : new Error('expected a refusal');
  };
  const refusedAtRegister = (bindings: PortBindings): readonly string[] => {
    try {
      AppModule.register({ config: RUNTIME_CONFIG, logger, ports: bindings });
    } catch (error) {
      return ports(error);
    }
    throw new Error('expected the binding to be refused');
  };
  const bootRuntime = (bindings: PortBindings, ...extra: NonNullable<ModuleMetadata['imports']>) =>
    startTestApp({
      config: RUNTIME_CONFIG,
      rootModule: (options) => ({
        module: TestRootModule,
        imports: [AppModule.register({ ...options, ports: bindings }), ...extra],
      }),
    });

  // Break caught: the composition judged by its mode only, so a describe adapter bound by hand into a runtime composition was
  // accepted and answered a real request with its own failure.
  it.each([
    ['a class', { clock: { useClass: DescribeClock } }, ['Clock']],
    ['a class that extends one', { clock: { useClass: RenamedClock } }, ['Clock']],
    ['a ready instance', { hasher: { useValue: new DescribeHasher() } }, ['Hasher']],
    [
      'an instance of a class that extends one',
      { hasher: { useValue: new RenamedHasher() } },
      ['Hasher'],
    ],
    ['an alias of the class', { metrics: { useExisting: DescribeMetrics } }, ['Metrics']],
  ] as const)('refuses %s when the root is registered', (_form, bindings, expected) => {
    expect(refusedAtRegister(bindings as PortBindings)).toEqual(expected);
  });

  it('names every port it refuses, and only those', () => {
    expect(
      refusedAtRegister({
        clock: { useValue: FIXED },
        hasher: { useValue: new DescribeHasher() },
        metrics: { useClass: DescribeMetrics },
      }),
    ).toEqual(['Hasher', 'Metrics']);
  });

  it('says nothing about a value: the message names ports and the way out', () => {
    const message = new DescribeAdapterBoundError(['Clock']).message;

    expect(message).toContain('Clock');
    expect(message).toMatch(/bind the adapter that does the work/);
    expect(new DescribeAdapterBoundError(['Clock']).name).toBe('DescribeAdapterBoundError');
  });

  // Break caught: only the forms that can be read before the container runs were judged, so a factory or an alias carried an
  // inert adapter into a runtime application that then listened.
  describe('when the application initialises', () => {
    it('refuses a factory that returns one, before it listens', async () => {
      const listen = vi.spyOn(net.Server.prototype, 'listen');

      await expect(
        bootRuntime({ hasher: { useFactory: () => new DescribeHasher() } }),
      ).rejects.toSatisfy((error) => resolvedToDescribe(error).join() === 'Hasher');
      expect(listen).not.toHaveBeenCalled();
      listen.mockRestore();
    });

    it('refuses an asynchronous factory, a factory that extends one and a factory fed by another port', async () => {
      await expect(
        bootRuntime({ hasher: { useFactory: () => Promise.resolve(new RenamedHasher()) } }),
      ).rejects.toThrow(PortBindingError);
      await expect(
        bootRuntime({
          clock: { useValue: FIXED },
          hasher: {
            useFactory: (clock: Clock) => {
              // The factory did receive the other port's adapter, so the refusal below is of what it returned.
              expect(clock).toBe(FIXED);
              return new DescribeHasher();
            },
            inject: [CLOCK],
          },
        }),
      ).rejects.toSatisfy((error) => resolvedToDescribe(error).join() === 'Hasher');
    });

    it('refuses an alias of a token that another module provides as one', async () => {
      await expect(
        bootRuntime({ metrics: { useExisting: ALIAS } }, AliasOfADescribeAdapterModule),
      ).rejects.toSatisfy((error) => resolvedToDescribe(error).join() === 'Metrics');
    });

    it('names each port that resolved to one, and not the ports that did not', async () => {
      await expect(
        bootRuntime({
          clock: { useValue: FIXED },
          hasher: { useFactory: () => new DescribeHasher() },
          metrics: { useFactory: () => new DescribeMetrics() },
        }),
      ).rejects.toSatisfy((error) => resolvedToDescribe(error).join() === 'Hasher,Metrics');
    });
  });

  // Break caught: the guard refusing what a local test legitimately binds, so every test that needs a double stops working.
  describe('keeps legitimate local overrides working', () => {
    it('accepts a ready instance, a class with dependencies, a factory and an alias that are not describe adapters', async () => {
      running = await bootRuntime(
        {
          clock: { useClass: ConfiguredClock },
          hasher: {
            useFactory: (config: AppConfig, clock: Clock) => new FakeHasher(config, clock),
            inject: [APP_CONFIG, CLOCK],
          },
          metrics: { useExisting: SharedMetrics },
        },
        SharedMetricsModule,
      );

      expect(resolve<Clock>(CLOCK)).toBeInstanceOf(ConfiguredClock);
      expect(resolve<Hasher>(HASHER)).toBeInstanceOf(FakeHasher);
      expect(resolve<Metrics>(METRICS)).toBe(resolve(SharedMetrics));
    });

    it('accepts a test double in the runtime composition for one port while the rest stay unbound', async () => {
      running = await bootRuntime({ clock: { useValue: FIXED } });

      expect(resolve<Clock>(CLOCK)).toBe(FIXED);
      expect(() => resolve(HASHER)).toThrow();
    });

    it('leaves the describe composition free to bind describe adapters, by default and by name', async () => {
      expect(() =>
        AppModule.register({
          config: TEST_CONFIG,
          logger,
          ports: { clock: { useClass: DescribeClock }, hasher: { useValue: new DescribeHasher() } },
        }),
      ).not.toThrow();

      running = await boot({ metrics: { useFactory: () => new DescribeMetrics() } });
      expect(resolve<Metrics>(METRICS)).toBeInstanceOf(DescribeMetrics);
      expect(resolve<Clock>(CLOCK)).toBeInstanceOf(DescribeClock);
    });
  });
});

describe('every port binding is an application singleton (S0.2)', () => {
  const SCOPED = Symbol('SCOPED');
  const TRANSIENT = Symbol('TRANSIENT');

  @Injectable({ scope: Scope.REQUEST })
  class PerRequest {
    readonly lifetime = 'request';
  }

  @Injectable({ scope: Scope.TRANSIENT })
  class PerInjection {
    readonly lifetime = 'transient';
  }

  /** A module that provides a request-scoped and a transient provider, visible everywhere like the other test modules. */
  @Global()
  @Module({
    providers: [
      { provide: SCOPED, useClass: PerRequest },
      { provide: TRANSIENT, useClass: PerInjection },
    ],
    exports: [SCOPED, TRANSIENT],
  })
  class LifetimesModule {}

  /** The request scope is in the class's metadata, and the binding says nothing about it. */
  @Injectable({ scope: Scope.REQUEST })
  class RequestScopedClock implements Clock {
    now(): Date {
      return INSTANT;
    }
    monotonicMilliseconds(): number {
      return 1;
    }
  }

  @Injectable({ scope: Scope.TRANSIENT })
  class TransientClock implements Clock {
    now(): Date {
      return INSTANT;
    }
    monotonicMilliseconds(): number {
      return 2;
    }
  }

  /** Declared a singleton, but it injects a request-scoped provider, which makes it request-scoped by propagation. */
  @Injectable()
  class ClockNeedingARequest implements Clock {
    constructor(@Inject(SCOPED) readonly request: unknown) {}
    now(): Date {
      return INSTANT;
    }
    monotonicMilliseconds(): number {
      return 3;
    }
  }

  /** A singleton that injects a transient provider: it is still one object for the whole application. */
  @Injectable()
  class ClockWithATransient implements Clock {
    constructor(@Inject(TRANSIENT) readonly transient: unknown) {
      built.push('ClockWithATransient');
    }
    now(): Date {
      return INSTANT;
    }
    monotonicMilliseconds(): number {
      return 4;
    }
  }

  const bootRuntime = (bindings: PortBindings, ...extra: NonNullable<ModuleMetadata['imports']>) =>
    startTestApp({
      config: RUNTIME_CONFIG,
      rootModule: (options) => ({
        module: TestRootModule,
        imports: [AppModule.register({ ...options, ports: bindings }), ...extra],
      }),
    });
  const notSingletons = (error: unknown): string => {
    if (error instanceof PortBindingError) return error.notSingletons.join();
    throw error instanceof Error ? error : new Error('expected a refusal');
  };

  // Break caught: a port bound with a lifetime of its own, which the check would then have had to skip, or which the root
  // would have carried to a request without anyone being told.
  describe('refuses a request or transient binding before it listens', () => {
    const cases: [label: string, bindings: PortBindings, port: string][] = [
      [
        'a class whose metadata is request-scoped',
        { clock: { useClass: RequestScopedClock } },
        'Clock',
      ],
      ['a class whose metadata is transient', { clock: { useClass: TransientClock } }, 'Clock'],
      [
        'a class that injects a request-scoped provider',
        { clock: { useClass: ClockNeedingARequest } },
        'Clock',
      ],
      ['an alias of a request-scoped provider', { metrics: { useExisting: SCOPED } }, 'Metrics'],
      [
        'a factory that injects a request-scoped provider',
        { hasher: { useFactory: () => new FakeHasher(TEST_CONFIG, FIXED), inject: [SCOPED] } },
        'Hasher',
      ],
    ];

    it.each(cases)('%s, in the runtime composition', async (_label, bindings, port) => {
      const listen = vi.spyOn(net.Server.prototype, 'listen');

      await expect(bootRuntime(bindings, LifetimesModule)).rejects.toSatisfy(
        (error) => notSingletons(error) === port,
      );
      expect(listen).not.toHaveBeenCalled();
      listen.mockRestore();
    });

    it.each(cases)('%s, in the describe composition', async (_label, bindings, port) => {
      const listen = vi.spyOn(net.Server.prototype, 'listen');

      await expect(boot(bindings, LifetimesModule)).rejects.toSatisfy(
        (error) => notSingletons(error) === port,
      );
      expect(listen).not.toHaveBeenCalled();
      listen.mockRestore();
    });
  });

  // Break caught: the check injecting the ports it judges, so that one port which is request-scoped by propagation made the
  // check itself request-scoped, never built at start, and let an inert adapter behind another port through.
  it('does not let a scoped port stop another port from being checked', async () => {
    await expect(
      bootRuntime(
        {
          clock: { useClass: ClockNeedingARequest },
          hasher: { useFactory: () => new DescribeHasher() },
        },
        LifetimesModule,
      ),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof PortBindingError &&
        error.notSingletons.join() === 'Clock' &&
        error.describeAdapters.join() === 'Hasher',
    );
  });

  it('still judges the other ports when a scoped one is an alias or a factory', async () => {
    await expect(
      bootRuntime(
        {
          metrics: { useExisting: SCOPED },
          hasher: { useFactory: () => new DescribeHasher(), inject: [] },
        },
        LifetimesModule,
      ),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof PortBindingError &&
        error.notSingletons.join() === 'Metrics' &&
        error.describeAdapters.join() === 'Hasher',
    );
  });

  it('says what is wrong in terms of ports and lifetimes, and names no value', async () => {
    const error = await bootRuntime({ clock: { useClass: RequestScopedClock } }).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(PortBindingError);
    const { message, name } = error as PortBindingError;
    expect(name).toBe('PortBindingError');
    expect(message).toContain('Clock');
    expect(message).toMatch(/not bound as application singletons/);
    expect(message).not.toMatch(/describe adapter/);
  });

  // Break caught: the singleton rule rejecting what it should allow, so a normal adapter cannot be bound.
  describe('still resolves the supported singleton bindings', () => {
    it('resolves a class, a factory, a ready value and an alias to the one instance each', async () => {
      running = await bootRuntime(
        {
          clock: { useClass: ConfiguredClock, scope: Scope.DEFAULT },
          hasher: {
            useFactory: (config: AppConfig, clock: Clock) => new FakeHasher(config, clock),
            inject: [APP_CONFIG, CLOCK],
            scope: Scope.DEFAULT,
          },
          metrics: { useExisting: SharedMetrics },
        },
        SharedMetricsModule,
      );

      expect(resolve<Clock>(CLOCK)).toBe(resolve<Clock>(CLOCK));
      expect(resolve<Hasher>(HASHER)).toBe(resolve<Hasher>(HASHER));
      expect(resolve<Metrics>(METRICS)).toBe(resolve(SharedMetrics));
    });

    it('allows a singleton to inject a transient provider and still be one object', async () => {
      running = await bootRuntime({ clock: { useClass: ClockWithATransient } }, LifetimesModule);

      expect(resolve<Clock>(CLOCK)).toBe(resolve<Clock>(CLOCK));
      expect(built.filter((name) => name === 'ClockWithATransient')).toHaveLength(1);
    });

    it('resolves the describe composition with every port a singleton', async () => {
      running = await startTestApp();

      for (const entry of PORTS) {
        expect(resolve<object>(entry.token), entry.name).toBe(resolve<object>(entry.token));
      }
    });
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

  // Break caught: a request or transient lifetime accepted for a security service that every request shares.
  it.each([
    ['a request-scoped class', { useClass: ConfiguredClock, scope: Scope.REQUEST }],
    ['a transient class', { useClass: ConfiguredClock, scope: Scope.TRANSIENT }],
    ['a request-scoped factory', { useFactory: () => FIXED, scope: Scope.REQUEST }],
    ['a transient factory', { useFactory: () => FIXED, scope: Scope.TRANSIENT }],
    ['a durable class', { useClass: ConfiguredClock, durable: true }],
    ['a durable factory', { useFactory: () => FIXED, durable: true }],
    ['a value that claims a request scope', { useValue: FIXED, scope: Scope.REQUEST }],
  ])('refuses %s as not an application singleton', (_label, binding) => {
    expect(() => portProviders(malformed({ clock: binding }))).toThrow(
      /The binding for the port Clock must be an application singleton/,
    );
  });

  it('accepts the default scope, spelled out, on a class and a factory', () => {
    expect(
      portProviders({
        clock: { useClass: ConfiguredClock, scope: Scope.DEFAULT },
        hasher: { useFactory: () => new FakeHasher(TEST_CONFIG, FIXED), scope: Scope.DEFAULT },
      }),
    ).toHaveLength(2);
  });

  it('refuses a key that is not a port, naming the ports', () => {
    expect(() => portProviders(malformed({ clok: { useValue: FIXED } }))).toThrow(
      /"clok" is not a port\. The ports are: clock, hasher, /,
    );
  });
});
