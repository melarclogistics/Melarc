import { Module, type DynamicModule } from '@nestjs/common';

import { PlatformModule, type PlatformModuleOptions } from './platform/platform.module.js';

export type AppModuleOptions = PlatformModuleOptions;

/**
 * The root of the module graph. Domain modules are imported here as product slices add them, as
 * siblings of platform/ (SOLUTION_ARCHITECTURE.md §5). There are none yet, and so no business route.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions): DynamicModule {
    return { module: AppModule, imports: [PlatformModule.register(options)] };
  }
}
