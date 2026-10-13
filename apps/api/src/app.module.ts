import { Module, type DynamicModule } from '@nestjs/common';

import { PostgresAuditWriter } from './platform/audit/postgres.audit-writer.adapter.js';
import { SystemClock } from './platform/auth/clock/system.clock.adapter.js';
import { DESCRIBE_PORT_BINDINGS } from './platform/auth/describe/describe-ports.adapter.js';
import {
  assertNoDescribeAdapterWritten,
  portBindingCheck,
} from './platform/auth/describe/port-binding-check.js';
import { LimiterDigest } from './platform/auth/crypto/limiter-digest.js';
import { Sha256TokenService } from './platform/auth/crypto/sha256.token-service.adapter.js';
import { CLOCK, type Clock } from './platform/auth/ports/clock.port.js';
import { portProviders, type PortBindings } from './platform/auth/ports/port-bindings.js';
import { PostgresSessionStore } from './platform/auth/sessions/postgres.session-store.adapter.js';
import { assertAdaptersAllowed } from './platform/config/adapter-refusals.js';
import type { AppConfig } from './platform/config/load-config.js';
import { DatabaseService } from './platform/database/database.service.js';
import { PostgresUnitOfWork } from './platform/database/postgres.unit-of-work.adapter.js';
import { SettingsBucketLimits } from './platform/limiter/bucket-limits.js';
import { PostgresRateLimiter } from './platform/limiter/postgres.rate-limiter.adapter.js';
import { PlatformModule, type PlatformModuleOptions } from './platform/platform.module.js';
import { SettingsReader } from './platform/settings/settings-reader.js';
import { PostgresStaffIdentityDirectory } from './staff/postgres.staff-identity-directory.adapter.js';

export interface AppModuleOptions extends PlatformModuleOptions {
  /**
   * The adapters bound to the ports of `platform/auth`, keyed by port. A binding here replaces the describe adapter of that
   * port when the application is composed to be described, and is the only binding there is in the runtime composition. The
   * task that builds an adapter adds its binding here, and no file outside the composition root listed in
   * `src/architecture.test.ts` imports the adapter (SOLUTION_ARCHITECTURE.md §5).
   */
  readonly ports?: PortBindings;
}

/**
 * The real adapters the runtime composition binds itself, whatever the options say. Every other port is bound by the first task
 * that consumes it (OB-38), by adding its binding here. `options.ports` still replaces any of them, which is how a test supplies a
 * clock it controls.
 *
 * - **Always:** the production `Clock` (S0.6), which the deadline machinery of the database layer reads, and the SHA-256
 *   `TokenService` (S0.24), which needs no key and no database.
 * - **With a database (S0.24):** the `UnitOfWork`, the `SessionStore`, the staff `IdentityDirectory` and the `AuditWriter`, which
 *   the authentication guard, the policy coordinator and the session-issue protocol are built from (`sessionProviders`). Without a
 *   database none is bound, and the services built from them are absent: a credential is then `503` and nobody can be signed in.
 * - **The limiter (S0.22) is bound only where it can be built and is the one the configuration asks for**: `RATE_LIMITER=postgres`,
 *   a database to decide in, and key material to digest the identifiers under (`limiter_digest`). `RATE_LIMITER=memory` is for a
 *   local run and for unit tests and is never bound by the composition itself (a test supplies it through `ports`): the in-memory
 *   limiter resets on restart and multiplies each bucket by the number of instances, so nothing falls back to it. Where no limiter is
 *   bound, a route that names a bucket fails closed (`rate-limit.guard.ts`) and so does an authenticated one
 *   (`authentication.guard.ts`). A key purpose that is missing stops the application at start.
 */
function runtimePortBindings(config: AppConfig): PortBindings {
  const bindings: PortBindings = {
    clock: { useClass: SystemClock },
    tokenService: { useClass: Sha256TokenService },
    ...(config.database === undefined
      ? {}
      : {
          unitOfWork: {
            useFactory: (database: DatabaseService) => new PostgresUnitOfWork(database),
            inject: [DatabaseService],
          },
          sessionStore: {
            useFactory: (clock: Clock) => new PostgresSessionStore(clock),
            inject: [CLOCK],
          },
          identityDirectory: { useClass: PostgresStaffIdentityDirectory },
          auditWriter: {
            useFactory: (clock: Clock) => new PostgresAuditWriter(clock),
            inject: [CLOCK],
          },
        }),
  };
  if (
    config.adapters.limiter !== 'postgres' ||
    config.database === undefined ||
    config.keys.custody !== 'local'
  ) {
    return bindings;
  }
  const { keys } = config;
  return {
    ...bindings,
    rateLimiter: {
      useFactory: (clock: Clock, database: DatabaseService) =>
        new PostgresRateLimiter({
          database,
          digest: new LimiterDigest(keys),
          limits: new SettingsBucketLimits(new SettingsReader()),
          clock,
        }),
      inject: [CLOCK, DatabaseService],
    },
  };
}

/** `base` with every defined binding of `over` laid on it. An explicit `undefined` means no binding and replaces nothing. */
function overlay(base: PortBindings, over: PortBindings = {}): PortBindings {
  // What arrives may not be what the compiler promised, so each value is read as unknown before it is judged.
  const given: [string, unknown][] = Object.entries(over);
  const defined = given.filter(([, binding]) => binding !== undefined);
  return { ...base, ...(Object.fromEntries(defined) as PortBindings) };
}

/**
 * The root of the module graph and the composition root: the one place where adapters are bound to the injection tokens of the
 * ports. A platform service asks for a token and never imports an adapter; a domain module implements its persistence adapter
 * and the root binds it. Domain modules are imported here as product slices add them, as siblings of platform/
 * (SOLUTION_ARCHITECTURE.md §5). There are none yet, and so no business route.
 *
 * **Two compositions.** When the configuration selects `describe` (the OpenAPI generator, the contract check, the default test
 * application) every port resolves to an inert describe adapter, so the application can be built and described with no
 * database, provider or key. When it selects `runtime` the adapters of `runtimePortBindings` are bound (the production `Clock`, the
 * token service and, with a database, the unit of work, the session store, the staff identity directory, the audit writer and the
 * PostgreSQL rate limiter), and every other port stays unbound until the first task that consumes it adds its real adapter. The configuration
 * is checked first: an environment that refuses what the configuration selects (the describe composition outside a local
 * run, a test adapter in production) stops the application here, whichever way the configuration was made. **The bindings
 * are checked too, not only the mode:** the runtime composition refuses an inert describe adapter however it is supplied
 * (`useClass`, `useValue`, a factory, `useExisting`), the written forms here and every form again when the application
 * initialises (`port-binding-check.ts`). That keeps a mis-wired root from answering a request with a describe failure; it
 * is a wiring check, not a defence against code that is already running inside the application.
 *
 * **Every port binding is an application singleton, in both compositions.** A request or transient lifetime is refused when
 * the binding is registered, and what the container makes of a binding (a class whose metadata is request-scoped, an alias or
 * a factory that reaches a request-scoped provider, a constructor that injects one) is judged by the container's own record
 * of each port once it is built, before the application listens. The check injects no port, so a scoped binding cannot keep
 * it from judging another one.
 *
 * **It is global on purpose, and its reach is the port tokens and nothing else.** A platform service and a domain module both ask
 * for a port by its token, and neither may import the module that binds it, so the bound tokens have to be visible everywhere.
 * `exports` is exactly the tokens bound (an empty list when none is), and the platform it imports re-exports
 * nothing through it. `src/app.module.test.ts` pins that, so widening what this module offers every module is a visible change.
 * The module graph is otherwise unchanged: a domain module is imported here, exports its adapter, and the root binds it with
 * `useExisting`.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    assertAdaptersAllowed(options.config);
    const describing = options.config.composition === 'describe';
    const bound = portProviders(
      overlay(
        describing ? DESCRIBE_PORT_BINDINGS : runtimePortBindings(options.config),
        options.ports,
      ),
    );
    // The describe composition binds inert adapters on purpose; the runtime composition must not end up with one, so the
    // bindings it was given are judged here. Both compositions require every port to be an application singleton. What the
    // container made of the bindings (an alias, a factory, a dependency) is judged once it has built them, when the
    // application initialises and before it listens.
    if (!describing) assertNoDescribeAdapterWritten(bound);
    const check = portBindingCheck(bound, describing ? 'describe' : 'runtime');
    return {
      module: AppModule,
      global: true,
      imports: [PlatformModule.register(options)],
      providers: check === undefined ? bound : [...bound, check],
      exports: bound.map((provider) => provider.provide),
    };
  }
}
