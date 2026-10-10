// A test-only entry point for the integrated harness (e2e/). It is never built into dist and nothing in src/
// refers to it, so production carries no switch for any of this.
//
// It starts the real application from the built output, composed the way src/main.ts composes it and with
// the same signal handling, and adds three routes that exist only here, so that a real browser can take a
// technical journey through the real Ops origin, the real API and the real database without the API
// having a business route to do it with:
//
//   POST /api/v1/e2e/notes       writes one row as the API's runtime identity, in a table the harness made
//   GET  /api/v1/e2e/notes/:id   reads it back
//   POST /api/v1/e2e/outbound    tries to reach an external provider, to show the sandbox refuses it
//
// The notes routes use a pool of this file's own, connected as the same runtime identity from the same
// configuration. The API's database service offers no driver handle and no transaction without a security context
// (S0.4c), so the harness does not reach into it; the table has no row-level security and is retired with the
// technical journey.
//
// usage: node --import <outbound-guard.mjs> e2e-main.mjs      (configuration comes from the environment)
import 'reflect-metadata';

import process from 'node:process';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';

import { AppModule } from '../../dist/app.module.js';
import { createApp } from '../../dist/create-app.js';
import { loadConfig } from '../../dist/platform/config/load-config.js';
import { reportConfigProblems } from '../../dist/platform/config/report-config-problems.js';
import { createPool } from '../../dist/platform/database/database.module.js';
import { installFaultHandlers } from '../../dist/platform/lifecycle/fault-handlers.js';
import { listenAndMarkReady } from '../../dist/platform/lifecycle/listen-and-mark-ready.js';
import { ShutdownRegistry } from '../../dist/platform/lifecycle/shutdown.registry.js';
import { installProcessShutdown } from '../../dist/platform/lifecycle/shutdown-handlers.js';
import { LOGGER } from '../../dist/platform/platform.tokens.js';
import { TechnicalEndpoint } from '../../dist/platform/routes/access-declaration.js';

/** The token the notes pool is provided under. */
const E2E_POOL = Symbol('E2E_POOL');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const present = (row) => ({
  id: row.id,
  note: row.note,
  at: row.noted_at.toISOString(),
  written_by: row.written_by,
});

/** The routes that exist only here. Decorators are applied by hand: this file is plain JavaScript. */
class E2eController {
  constructor(pool) {
    this.pool = pool;
  }

  async create(body) {
    const { id, note, at } = body ?? {};
    if (typeof id !== 'string' || !UUID.test(id)) throw new BadRequestException();
    if (typeof note !== 'string' || note === '' || note.length > 200)
      throw new BadRequestException();
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) throw new BadRequestException();

    // A pool of this file's own, as the runtime identity the API connects as, so the row is written by it.
    const result = await this.pool.query(
      'insert into e2e_harness.notes (id, note, noted_at) values ($1, $2, $3) returning id, note, noted_at, written_by',
      [id, note, at],
    );
    return present(result.rows[0]);
  }

  async read(id) {
    if (!UUID.test(id)) throw new BadRequestException();
    const result = await this.pool.query(
      'select id, note, noted_at, written_by from e2e_harness.notes where id = $1',
      [id],
    );
    if (result.rows.length === 0) throw new NotFoundException();
    return present(result.rows[0]);
  }

  async outbound() {
    try {
      await globalThis.fetch('https://payments.provider.example/v1/charges', {
        method: 'POST',
        body: '{}',
      });
      return { reached: true };
    } catch (error) {
      return { reached: false, code: error?.cause?.code ?? error?.code ?? 'UNKNOWN' };
    }
  }
}

Controller('e2e')(E2eController);
Inject(E2E_POOL)(E2eController, undefined, 0);

function route(name, decorators, parameters = []) {
  const descriptor = Object.getOwnPropertyDescriptor(E2eController.prototype, name);
  for (const decorate of decorators) decorate(E2eController.prototype, name, descriptor);
  parameters.forEach((decorate, index) => {
    decorate(E2eController.prototype, name, index);
  });
}
route('create', [Post('notes'), HttpCode(201), TechnicalEndpoint()], [Body()]);
route('read', [Get('notes/:id'), TechnicalEndpoint()], [Param('id')]);
route('outbound', [Post('outbound'), HttpCode(200), TechnicalEndpoint()]);

const loaded = loadConfig(process.env);
if (!loaded.ok) {
  process.stderr.write(reportConfigProblems(loaded.problems));
  process.exit(1);
}
const { config } = loaded;
if (config.database === undefined) {
  process.stderr.write('the harness needs DATABASE_URL: the notes routes write to the database\n');
  process.exit(1);
}
// Connects lazily, on first use, like the API's own pool.
const notesPool = createPool(config.database);

const app = await createApp({
  config,
  // Added to the application module's own metadata, so these are Nest routes like any other and the startup
  // check that every route is declared still runs.
  rootModule: (options) => {
    const root = AppModule.register(options);
    return {
      ...root,
      controllers: [E2eController],
      providers: [...(root.providers ?? []), { provide: E2E_POOL, useValue: notesPool }],
    };
  },
});
// Closed with the rest on shutdown, so the pool does not outlive the process's clean exit.
app.get(ShutdownRegistry).register({ name: 'e2e-notes-pool', close: () => notesPool.end() });
const logger = app.get(LOGGER);
installFaultHandlers(logger, {
  on: (event, listener) => process.on(event, listener),
  exit: (code) => process.exit(code),
});
installProcessShutdown(app, { logger, shutdown: config.shutdown });
await listenAndMarkReady(app, config.http);
logger.info({ host: config.http.host, port: config.http.port }, 'api listening');
