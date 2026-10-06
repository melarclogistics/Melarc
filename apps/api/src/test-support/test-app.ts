import type { AddressInfo } from 'node:net';

import { Module, type ModuleMetadata } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from '../app.module.js';
import { createApp, type RootModuleFactory } from '../create-app.js';
import type { AppConfig } from '../platform/config/load-config.js';
import type { ContractSource } from '../platform/contract/contract-source.js';
import { LifecycleService } from '../platform/lifecycle/lifecycle.service.js';
import { listenAndMarkReady } from '../platform/lifecycle/listen-and-mark-ready.js';
import { CapturedLogs } from './captured-logs.js';
import { TEST_CONFIG } from './test-config.js';

export { TEST_CONFIG };

/** The real application module plus extra modules, for tests that need routes of their own. */
export function appWith(...extra: NonNullable<ModuleMetadata['imports']>): RootModuleFactory {
  @Module({})
  class TestRootModule {}
  return (options) => ({
    module: TestRootModule,
    imports: [AppModule.register(options), ...extra],
  });
}

export interface TestApp {
  readonly app: NestExpressApplication;
  readonly baseUrl: string;
  readonly logs: CapturedLogs;
  stop(): Promise<void>;
}

/** Starts the real application, wired exactly as in production, on an ephemeral port. */
export async function startTestApp(
  options: {
    config?: AppConfig;
    rootModule?: RootModuleFactory;
    /** Only for tests that exercise the refusal of undeclared routes at request time. */
    allowUnsoundRoutes?: boolean;
    /** The contract the runtime validates against, instead of the repository's file. */
    contractSource?: ContractSource;
  } = {},
): Promise<TestApp> {
  const logs = new CapturedLogs();
  const app = await createApp({
    config: options.config ?? TEST_CONFIG,
    logDestination: logs.stream,
    rootModule: (moduleOptions) =>
      (options.rootModule ?? ((resolved) => AppModule.register(resolved)))({
        ...moduleOptions,
        ...(options.contractSource === undefined ? {} : { contractSource: options.contractSource }),
      }),
  });
  if (options.allowUnsoundRoutes === true) {
    await app.listen(0, '127.0.0.1');
    app.get(LifecycleService).markReady();
  } else {
    await listenAndMarkReady(app, { host: '127.0.0.1', port: 0 });
  }
  const { port } = app.getHttpServer().address() as AddressInfo;
  let stopped = false;
  return {
    app,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    logs,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await app.close();
    },
  };
}
