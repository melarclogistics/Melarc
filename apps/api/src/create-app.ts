import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DestinationStream } from 'pino';

import type { AppModuleOptions } from './app.module.js';
import type { AppConfig } from './platform/config/load-config.js';
import { AllExceptionsFilter } from './platform/http/all-exceptions.filter.js';
import { JSON_BODY_OPTIONS } from './platform/http/json-body.js';
import { API_PREFIX, TECHNICAL_ROUTE_PATHS } from './platform/http/routes.constants.js';
import { requireUtf8Json } from './platform/http/utf8-json.js';
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
    // Nest would register a JSON and a form-encoded parser when the application starts. Every request body in the
    // contract is application/json, and a form-encoded one is the kind a cross-site HTML form can send without a
    // preflight, so only JSON is parsed (below) and a form-encoded body reaches a handler as no body at all.
    { logger: new NestLoggerAdapter(logger), bodyParser: false },
  );

  app.disable('x-powered-by');
  // The contract's paths are exact: `/Orders` and `/orders/` are not `/orders`. Express matches without regard to
  // case or a trailing slash unless told otherwise, so an edge rule written against the contract's spelling (a deny
  // list, a rate limit, a different upstream) would not cover the spellings that still reach a handler.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  // Express reads those two settings when it first makes its router, which Nest has already caused by now, and the
  // router reads its own copy of them for every route that is registered after. The routes are registered when the
  // application is initialised, so setting the router's own is what takes effect for them.
  const { router } = app.getHttpAdapter().getInstance() as unknown as {
    router: { caseSensitive: boolean; strict: boolean };
  };
  router.caseSensitive = true;
  router.strict = true;
  // No automatic body-hash ETag: the contract uses ETag only as an explicit record version.
  app.set('etag', false);
  app.use(createRequestMiddleware(logger));
  // After the request middleware, so a body that cannot be parsed or is too large still answers with a request id.
  // A JSON body is UTF-8 or it is refused: the parser would decode UTF-7, UTF-16 and UTF-32 as well.
  app.use(requireUtf8Json(logger));
  app.useBodyParser('json', JSON_BODY_OPTIONS);
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.setGlobalPrefix(API_PREFIX, { exclude: [...TECHNICAL_ROUTE_PATHS] });
  return app;
}
