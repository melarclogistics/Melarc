import type { Server } from 'node:http';

import type { DynamicModule, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { DestinationStream } from 'pino';

import type { AppModuleOptions } from './app.module.js';
import { CLOCK, type Clock } from './platform/auth/ports/clock.port.js';
import type { AppConfig } from './platform/config/load-config.js';
import { DISPOSAL_BOUND_MS } from './platform/execution/execution-parameters.js';
import { AllExceptionsFilter } from './platform/http/all-exceptions.filter.js';
import { createCors } from './platform/http/cors.js';
import { AdmissionGate } from './platform/http/admission/admission-gate.js';
import { bodyErrors } from './platform/http/admission/body-errors.js';
import { createRequestBudget } from './platform/http/admission/request-budget.js';
import { RefusedBodyDrain, REFUSED_BODY_SETTING } from './platform/http/admission/refused-body.js';
import {
  createTransportAdmission,
  probeRequests,
} from './platform/http/admission/transport-admission.js';
import { JSON_BODY_OPTIONS } from './platform/http/json-body.js';
import { API_PREFIX, TECHNICAL_ROUTE_PATHS } from './platform/http/routes.constants.js';
import { createLogger } from './platform/logging/create-logger.js';
import { NestLoggerAdapter } from './platform/logging/nest-logger.js';
import { createRequestMiddleware } from './platform/logging/request-middleware.js';

/** How many times the body limit is read off after a refusal before the connection is closed. */
const REFUSED_BODY_ALLOWANCE = 16;

export type RootModuleFactory = (options: AppModuleOptions) => Type<unknown> | DynamicModule;

export interface CreateAppOptions {
  readonly config: AppConfig;
  /** Builds the root module. Production passes AppModule; tests add routes of their own. */
  readonly rootModule: RootModuleFactory;
  /** Defaults to stdout. */
  readonly logDestination?: DestinationStream;
}

/**
 * How often Node looks for connections whose head or request is past its deadline. Node checks the deadlines it is given only at
 * this interval (thirty seconds unless told otherwise: measured on Node 24.21.0, a header deadline of 500 ms ended a stalled head
 * after 30 s with the default and after 564 ms with an interval of 100 ms), so a header deadline of ten seconds would be enforced
 * anywhere from ten to forty seconds late. The property is read when the server starts listening and is not in the type
 * declarations of `http.Server`. A quarter of the shorter deadline, between a tenth of a second and a second, keeps the enforcement within a
 * quarter of what was asked. An engineering parameter, development-qualified (DEPLOYMENT_AND_ENVIRONMENTS.md §12.5).
 */
function connectionsCheckingInterval(headerTimeoutMs: number, bodyTimeoutMs: number): number {
  return Math.min(1_000, Math.max(100, Math.floor(Math.min(headerTimeoutMs, bodyTimeoutMs) / 4)));
}

/**
 * The composition root. Production and tests build the application through this one function, so
 * what a test exercises is the wiring that ships.
 */
export async function createApp(options: CreateAppOptions): Promise<NestExpressApplication> {
  const logger = createLogger({ config: options.config, destination: options.logDestination });
  const { http } = options.config;
  const app = await NestFactory.create<NestExpressApplication>(
    options.rootModule({ config: options.config, logger }),
    // Nest would register a JSON and a form-encoded parser when the application starts. Every request body in the
    // contract is application/json, and a form-encoded one is the kind a cross-site HTML form can send without a
    // preflight, so only JSON is parsed (below) and a form-encoded body is refused before it is read.
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
  // `HTTP_TRUST_PROXY` (DEPLOYMENT_AND_ENVIRONMENTS.md §12.2): no forwarded header is believed unless the hop that sent it was
  // named. An empty list is `off`, and Express is told `false`, not an empty list.
  app.set('trust proxy', http.trustProxy.length === 0 ? false : [...http.trustProxy]);

  // The receipt deadlines (S0.20). Node ends a connection whose head is not complete in `headersTimeout`, and one whose whole
  // request is not complete in `requestTimeout`; the body gets its own deadline from the moment it is being read
  // (transport admission), so the whole request may take the two together. None of them bounds a handler.
  const server = app.getHttpServer() as Server & { connectionsCheckingInterval: number };
  server.headersTimeout = http.headerTimeoutMs;
  server.requestTimeout = http.headerTimeoutMs + http.bodyTimeoutMs;
  server.connectionsCheckingInterval = connectionsCheckingInterval(
    http.headerTimeoutMs,
    http.bodyTimeoutMs,
  );

  // `Expect: 100-continue`. Node, when nothing listens for `checkContinue`, answers `100 Continue` the moment the head arrives, which
  // invites a body before anything has judged the head or given the request a slot. Listening takes that over: the request goes
  // to the application as any other (Node emits `request` for it only when nobody listens), and transport admission writes the
  // invitation once the head is accepted and a slot is held. A request that is refused is never invited.
  server.on('checkContinue', (request, response) => {
    server.emit('request', request, response);
  });

  app.use(createRequestMiddleware(logger));
  // Nothing this API answers may be kept by a browser or a proxy: authentication and recovery answers carry the TOTP
  // seed, an access token and session state (SECURITY_DESIGN: the application layer sends no-store, not only the edge).
  // A rule of the platform, so that no operation can forget it, and set before anything answers, errors included.
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Transport admission, in front of everything that routes or guards: the head of a body, the admission gate, the bytes and the
  // time of the body. After the request middleware, so a refused request still answers with a request id. The line of the gate is
  // as long as its concurrency: no more may wait than may be admitted.
  const gate = new AdmissionGate({
    concurrency: http.admissionConcurrency,
    maxWaiters: http.admissionConcurrency,
    waitMs: http.admissionTimeoutMs,
  });
  // A refusal that leaves the connection open reads off what the client is still sending, within bounds taken from the receipt
  // limits and the admission concurrency: no setting of its own (`refused-body.ts`). Sixteen times the body limit is room for a
  // client that sends a body several times too large and then reads its answer (a reset under a client that is still writing can
  // discard the answer it had not read), and still a bound.
  app.set(
    REFUSED_BODY_SETTING,
    new RefusedBodyDrain({
      maxBytes: REFUSED_BODY_ALLOWANCE * http.bodyLimitBytes,
      maxMs: http.bodyTimeoutMs,
      maxConcurrent: http.admissionConcurrency,
    }),
  );
  // The probes are exempt as probes: the exact path, by a method they answer, with no body (`probeRequests`).
  const isProbe = probeRequests(new Set(TECHNICAL_ROUTE_PATHS.map((path) => `/${path}`)));
  app.use(
    createTransportAdmission({
      limitBytes: http.bodyLimitBytes,
      bodyTimeoutMs: http.bodyTimeoutMs,
      gate,
      isExempt: isProbe,
    }),
  );
  // Credentialed CORS with the exact origins of the two surfaces, and the answer to a preflight (S0.25). After admission, so that a
  // preflight meets the gate and the head limits, and before the parser and the guards: a preflight carries no body and no
  // credentials, and is answered here and routed nowhere.
  app.use(createCors([options.config.origins.ops, options.config.origins.vendor]));
  // The parser inflates nothing (a compressed body is refused above, and the size limit counts the bytes received), and it is
  // given the same limit as the counter above: the counter answers first and promptly, the parser is the second line.
  app.useBodyParser('json', { ...JSON_BODY_OPTIONS, limit: http.bodyLimitBytes, inflate: false });
  // What the parser raised becomes a marker (a body that is not valid JSON), a transport refusal, or the failure it is.
  app.use(bodyErrors());
  // The request's execution budget, made once the request is admitted and received (S0.20). The describe composition (the tools
  // and the default test application) binds an inert clock that refuses to be read and serves nothing real, so it has none.
  // The clock is the one the application was given, asked for at the first request: resolving a port here, before the
  // application initialises, would let a binding that is not a singleton stop the process before the check that explains it.
  if (options.config.composition === 'runtime') {
    let clock: Clock | undefined;
    app.use(
      createRequestBudget({
        clock: {
          now: () => (clock ??= app.get<Clock>(CLOCK, { strict: false })).now(),
          monotonicMilliseconds: () =>
            (clock ??= app.get<Clock>(CLOCK, { strict: false })).monotonicMilliseconds(),
        },
        budgetMs: options.config.execution.requestBudgetMs,
        graceMs: DISPOSAL_BOUND_MS,
        isExempt: isProbe,
        logger,
      }),
    );
  }
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.setGlobalPrefix(API_PREFIX, { exclude: [...TECHNICAL_ROUTE_PATHS] });
  return app;
}
