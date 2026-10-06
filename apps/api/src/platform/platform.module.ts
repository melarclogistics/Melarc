import { Global, Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Logger } from 'pino';

import type { AppConfig } from './config/load-config.js';
import { ContractValidationModule } from './contract/contract-validation.module.js';
import { fileContractSource, type ContractSource } from './contract/contract-source.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { LifecycleService } from './lifecycle/lifecycle.service.js';
import { ShutdownRegistry } from './lifecycle/shutdown.registry.js';
import { APP_CONFIG, LOGGER } from './platform.tokens.js';
import { DenyByDefaultGuard } from './routes/deny-by-default.guard.js';

export interface PlatformModuleOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Where the contract is read from when a handler is bound to an operation. Defaults to the repository's file. */
  readonly contractSource?: ContractSource;
}

/**
 * Cross-cutting technical services every module may use. Nothing in platform/ may depend on a domain
 * module (SOLUTION_ARCHITECTURE.md §5); the direction is domain -> platform only.
 */
@Global()
@Module({})
export class PlatformModule {
  static register(options: PlatformModuleOptions): DynamicModule {
    const { database } = options.config;
    return {
      module: PlatformModule,
      imports: [
        HealthModule,
        ContractValidationModule.register({ source: options.contractSource ?? fileContractSource }),
        ...(database === undefined ? [] : [DatabaseModule.register(database)]),
      ],
      providers: [
        { provide: APP_CONFIG, useValue: options.config },
        { provide: LOGGER, useValue: options.logger },
        { provide: APP_GUARD, useClass: DenyByDefaultGuard },
        LifecycleService,
        ShutdownRegistry,
      ],
      exports: [APP_CONFIG, LOGGER, LifecycleService, ShutdownRegistry],
    };
  }
}
