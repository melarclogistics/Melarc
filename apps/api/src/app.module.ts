import { Module, type DynamicModule } from '@nestjs/common';

import { SystemClock } from './platform/auth/clock/system.clock.adapter.js';
import { DESCRIBE_PORT_BINDINGS } from './platform/auth/describe/describe-ports.adapter.js';
import {
  assertNoDescribeAdapterWritten,
  portBindingCheck,
} from './platform/auth/describe/port-binding-check.js';
import { portProviders, type PortBindings } from './platform/auth/ports/port-bindings.js';
import { assertAdaptersAllowed } from './platform/config/adapter-refusals.js';
import { PlatformModule, type PlatformModuleOptions } from './platform/platform.module.js';

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
 * The real adapters the runtime composition binds itself, whatever the options say: the production `Clock` (S0.6), which the
 * deadline machinery of the database layer reads. Every other port is bound by the first task that consumes it (OB-38), by adding
 * its binding here. `options.ports` still replaces any of them, which is how a test supplies a clock it controls.
 */
const RUNTIME_PORT_BINDINGS: PortBindings = { clock: { useClass: SystemClock } };

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
 * database, provider or key. When it selects `runtime` only the production `Clock` is bound (`RUNTIME_PORT_BINDINGS`), and every
 * other port stays unbound until the first task that consumes it adds its real adapter. The configuration
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
      overlay(describing ? DESCRIBE_PORT_BINDINGS : RUNTIME_PORT_BINDINGS, options.ports),
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
