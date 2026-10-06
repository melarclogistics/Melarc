import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DestinationStream } from 'pino';

import type { AppModuleOptions } from './app.module.js';
import type { AppConfig } from './platform/config/load-config.js';
import { AllExceptionsFilter } from './platform/http/all-exceptions.filter.js';
import { API_PREFIX, TECHNICAL_ROUTE_PATHS } from './platform/http/routes.constants.js';
import { createLogger } from './platform/logging/create-logger.js';
import { NestLoggerAdapter } from './platform/logging/nest-logger.js';
import { createRequestMiddleware } from './platform/logging/request-middleware.js';

export type RootModuleFactory = (options: AppModuleOptions) => Type<unknown> | DynamicModule;

export interface CreateAppOptions {
  readonly config: AppConfig;
  /** Builds the root module. Production passes AppModule; tests add routes of their own. */
  readonly rootModule: RootModuleFactory;
  /** Defaults to stdout. */
  readonly logDestination?: DestinationStream;
}

/**
 * The composition root. Production and tests build the application through this one function, so
 * what a test exercises is the wiring that ships.
 */
export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const logger = createLogger({ config: options.config, destination: options.logDestination });
  const app = await NestFactory.create<NestExpressApplication>(
    options.rootModule({ config: options.config, logger }),
    { logger: new NestLoggerAdapter(logger) },
  );

  app.disable('x-powered-by');
  // No automatic body-hash ETag: the contract uses ETag only as an explicit record version.
  app.set('etag', false);
  app.use(createRequestMiddleware(logger));
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.setGlobalPrefix(API_PREFIX, { exclude: [...TECHNICAL_ROUTE_PATHS] });
  return app;
}
