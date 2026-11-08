// A test-only entry point for the integrated harness (e2e/). It is never built into dist and nothing in src/
// refers to it, so production carries no switch for any of this.
//
// It starts the real application from the built output, composed the way src/main.ts composes it and with
// the same signal handling, and adds three routes that exist only here, for the specs of the trusted HTTPS origin (S0.23). They
// need no session and carry no secret:
//
//   POST /api/v1/e2e/cookies/issue   sets the two session cookies of the identity slice, with the product's own cookie writer and
//                                    random values that protect nothing (it is the engine's handling of the attributes that is under test)
//   POST /api/v1/e2e/cookies/expire  expires them, as a sign-out does
//   GET and POST /api/v1/e2e/echo    says what the browser sent that the CSRF guard judges: the Origin, the Fetch Metadata headers,
//                                    the names (never the values) of the cookies, and whether the CSRF header equals the CSRF cookie
//
// The technical journey of the bootstrap (a notes table written through `/api/v1/e2e/notes`, and an outbound call) was retired by S0.45:
// the integrated journeys are the real screens and the real operations, and the harness reads the database through the database
// command's observations (`apps/api/src/tools/e2e/arrangements.ts`), not through a table of its own.
//
// usage: node --import <outbound-guard.mjs> e2e-main.mjs      (configuration comes from the environment)
import 'reflect-metadata';

import process from 'node:process';

import { randomBytes } from 'node:crypto';

import { Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';

import { AppModule } from '../../dist/app.module.js';
import {
  expireBrowserSessionCookies,
  issueBrowserSessionCookies,
} from '../../dist/platform/auth/cookies/cookie-writer.js';
import { createApp } from '../../dist/create-app.js';
import { loadConfig } from '../../dist/platform/config/load-config.js';
import { reportConfigProblems } from '../../dist/platform/config/report-config-problems.js';
import { installFaultHandlers } from '../../dist/platform/lifecycle/fault-handlers.js';
import { listenAndMarkReady } from '../../dist/platform/lifecycle/listen-and-mark-ready.js';
import { installProcessShutdown } from '../../dist/platform/lifecycle/shutdown-handlers.js';
import { LOGGER } from '../../dist/platform/platform.tokens.js';
import { TechnicalEndpoint } from '../../dist/platform/routes/access-declaration.js';

/** The routes that exist only here. Decorators are applied by hand: this file is plain JavaScript. */
class E2eController {
  /** The product's own writer sets the cookies, with random values: the browser's handling of the attributes is what is under test. */
  issueCookies(response) {
    issueBrowserSessionCookies(response, {
      session: randomBytes(32).toString('base64url'),
      csrf: randomBytes(32).toString('base64url'),
    });
    return { issued: true };
  }

  expireCookies(response) {
    expireBrowserSessionCookies(response);
    return { expired: true };
  }

  /** What the browser sent, as facts a spec can compare. No cookie value is returned: names, and one boolean about two of them. */
  echo(request) {
    const header = request.headers.cookie ?? '';
    const cookies = new Map(
      header
        .split(';')
        .map((each) => each.trim())
        .filter((each) => each !== '')
        .map((each) => {
          const at = each.indexOf('=');
          return at === -1 ? [each, ''] : [each.slice(0, at), each.slice(at + 1)];
        }),
    );
    const sent = request.headers['x-csrf-token'];
    return {
      method: request.method,
      origin: request.headers.origin ?? null,
      secFetchSite: request.headers['sec-fetch-site'] ?? null,
      secFetchMode: request.headers['sec-fetch-mode'] ?? null,
      secFetchDest: request.headers['sec-fetch-dest'] ?? null,
      cookieNames: [...cookies.keys()].toSorted(),
      csrfHeaderPresent: typeof sent === 'string' && sent !== '',
      csrfHeaderMatchesCookie:
        typeof sent === 'string' && sent !== '' && cookies.get('melarc_csrf') === sent,
    };
  }

  /** The same answer to a POST: a route is declared for one method, because the route inventory refuses a handler for every method. */
  echoPost(request) {
    return this.echo(request);
  }
}

Controller('e2e')(E2eController);

function route(name, decorators, parameters = []) {
  const descriptor = Object.getOwnPropertyDescriptor(E2eController.prototype, name);
  for (const decorate of decorators) decorate(E2eController.prototype, name, descriptor);
  parameters.forEach((decorate, index) => {
    decorate(E2eController.prototype, name, index);
  });
}
route(
  'issueCookies',
  [Post('cookies/issue'), HttpCode(200), TechnicalEndpoint()],
  [Res({ passthrough: true })],
);
route(
  'expireCookies',
  [Post('cookies/expire'), HttpCode(200), TechnicalEndpoint()],
  [Res({ passthrough: true })],
);
route('echo', [Get('echo'), TechnicalEndpoint()], [Req()]);
route('echoPost', [Post('echo'), HttpCode(200), TechnicalEndpoint()], [Req()]);

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(reportConfigProblems(loaded.problems));
  process.exit(1);
}
const { config } = loaded;

const app = await createApp({
  config,
  // Added to the application module's own metadata, so these are Nest routes like any other and the startup
  // check that every route is declared still runs.
  rootModule: (options) => {
    const root = AppModule.register(options);
    return { ...root, controllers: [E2eController] };
  },
});
const logger = app.get(LOGGER);
installFaultHandlers(logger, {
  on: (event, listener) => process.on(event, listener),
  exit: (code) => process.exit(code),
});
installProcessShutdown(app, { logger, shutdown: config.shutdown });
await listenAndMarkReady(app, config.http);
logger.info({ host: config.http.host, port: config.http.port }, 'api listening');
