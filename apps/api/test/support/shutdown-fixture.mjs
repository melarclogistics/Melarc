// A test-only entry point for test/shutdown.process.test.ts. It is never built into dist and nothing in
// src/ refers to it, so production carries no switch for any of this.
//
// It starts the real application from the built output, composed the way src/main.ts composes it and
// with the same signal handling (installProcessShutdown), and adds what a test needs and production does
// not have:
//
//   clean              a resource that closes, and releases the handle that keeps the process alive
//   stalled            a resource whose close never finishes, and a handle that is never released
//   --signal-itself    sends itself a stop signal shortly after it is ready, so a test does not depend
//                      on the operating system delivering one (Windows does not deliver SIGTERM)
//   --slow-route       adds GET /api/v1/fixture/slow, which signals the process when it arrives and
//                      answers 400 ms later: a request that is in flight when shutdown begins
//
// usage: node shutdown-fixture.mjs <clean|stalled> [--signal-itself] [--slow-route]
import 'reflect-metadata';

import process from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

import { Controller, Get } from '@nestjs/common';

import { AppModule } from '../../dist/app.module.js';
import { createApp } from '../../dist/create-app.js';
import { loadConfig } from '../../dist/platform/config/load-config.js';
import { reportConfigProblems } from '../../dist/platform/config/report-config-problems.js';
import { installFaultHandlers } from '../../dist/platform/lifecycle/fault-handlers.js';
import { listenAndMarkReady } from '../../dist/platform/lifecycle/listen-and-mark-ready.js';
import { installProcessShutdown } from '../../dist/platform/lifecycle/shutdown-handlers.js';
import { ShutdownRegistry } from '../../dist/platform/lifecycle/shutdown.registry.js';
import { LOGGER } from '../../dist/platform/platform.tokens.js';
import { TechnicalEndpoint } from '../../dist/platform/routes/access-declaration.js';

const [mode, ...flags] = process.argv.slice(2);
if (mode !== 'clean' && mode !== 'stalled') {
  process.stderr.write(
    'usage: shutdown-fixture.mjs <clean|stalled> [--signal-itself] [--slow-route]\n',
  );
  process.exit(2);
}

const stopSignal = () => process.emit('SIGTERM', 'SIGTERM');

/** A route that exists only here. Decorators are applied by hand: this file is plain JavaScript. */
class SlowController {
  slow() {
    stopSignal();
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ finished: true });
      }, 400);
    });
  }
}
Controller('fixture')(SlowController);
const slow = Object.getOwnPropertyDescriptor(SlowController.prototype, 'slow');
Get('slow')(SlowController.prototype, 'slow', slow);
TechnicalEndpoint()(SlowController.prototype, 'slow', slow);

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(reportConfigProblems(loaded.problems));
  process.exit(1);
}
const { config } = loaded;

const app = await createApp({
  config,
  // The route is added to the application module's own dynamic metadata, so it is a Nest route like any
  // other and the startup check that every route is declared still runs.
  rootModule: (options) => {
    const root = AppModule.register(options);
    return flags.includes('--slow-route') ? { ...root, controllers: [SlowController] } : root;
  },
});
const logger = app.get(LOGGER);
installFaultHandlers(logger, {
  on: (event, listener) => process.on(event, listener),
  exit: (code) => process.exit(code),
});

// A handle that keeps the event loop alive, as an open connection to a database would.
const keepAlive = setInterval(() => undefined, 1_000);

app.get(ShutdownRegistry).register(
  mode === 'stalled'
    ? { name: 'stalled-pool', close: () => new Promise(() => undefined) }
    : {
        name: 'releasable-handle',
        close: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              clearInterval(keepAlive);
              resolve(undefined);
            }, 50);
          }),
      },
);

installProcessShutdown(app, { logger, shutdown: config.shutdown });
await listenAndMarkReady(app, config.http);
logger.info({ host: config.http.host, port: config.http.port }, 'api listening');

if (flags.includes('--signal-itself')) {
  setTimeout(stopSignal, 200);
}
