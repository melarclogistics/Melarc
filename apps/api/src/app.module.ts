import { Module, type DynamicModule } from '@nestjs/common';

import { portProviders, type PortBindings } from './platform/auth/ports/port-bindings.js';
import { PlatformModule, type PlatformModuleOptions } from './platform/platform.module.js';

export interface AppModuleOptions extends PlatformModuleOptions {
  /**
   * The adapters bound to the ports of `platform/auth`, keyed by port. None exists yet, so none is passed; the task that
   * builds an adapter adds its binding here, and no file outside the composition root listed in `src/architecture.test.ts` imports
   * the adapter (SOLUTION_ARCHITECTURE.md §5).
   */
  readonly ports?: PortBindings;
}

/**
 * The root of the module graph and the composition root: the one place where adapters are bound to the injection tokens of the
 * ports. A platform service asks for a token and never imports an adapter; a domain module implements its persistence adapter
 * and the root binds it. Domain modules are imported here as product slices add them, as siblings of platform/
 * (SOLUTION_ARCHITECTURE.md §5). There are none yet, and so no business route.
 *
 * **It is global on purpose, and its reach is the port tokens and nothing else.** A platform service and a domain module both ask
 * for a port by its token, and neither may import the module that binds it, so the bound tokens have to be visible everywhere.
 * `exports` is exactly the tokens bound through `ports` (an empty list when none is), and the platform it imports re-exports
 * nothing through it. `src/app.module.test.ts` pins that, so widening what this module offers every module is a visible change.
 * The module graph is otherwise unchanged: a domain module is imported here, exports its adapter, and the root binds it with
 * `useExisting`.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    const bound = portProviders(options.ports);
    return {
      module: AppModule,
      global: true,
      imports: [PlatformModule.register(options)],
      providers: bound,
      exports: bound.map((provider) => provider.provide),
    };
  }
}
