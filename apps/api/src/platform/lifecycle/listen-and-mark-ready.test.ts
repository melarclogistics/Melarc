import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AccessFixtureModule } from '../../test-support/fixtures.js';
import { appWith, TEST_CONFIG } from '../../test-support/test-app.js';
import { CapturedLogs } from '../../test-support/captured-logs.js';
import { AppModule } from '../../app.module.js';
import { createApp } from '../../create-app.js';
import { LifecycleService } from './lifecycle.service.js';
import { listenAndMarkReady } from './listen-and-mark-ready.js';

/** What a stop signal during start-up does: the instance begins draining while the application is initialised. */
@Injectable()
class DrainsWhileStarting implements OnModuleInit {
  constructor(private readonly lifecycle: LifecycleService) {}
  onModuleInit(): void {
    this.lifecycle.beginDraining();
  }
}

@Module({ providers: [DrainsWhileStarting] })
class DrainsWhileStartingModule {}

async function build(rootModule: Parameters<typeof createApp>[0]['rootModule']) {
  const logs = new CapturedLogs();
  return createApp({ config: TEST_CONFIG, logDestination: logs.stream, rootModule });
}

describe('listenAndMarkReady', () => {
  it('opens the listener and then marks the instance ready', async () => {
    const app = await build((options) => AppModule.register(options));
    try {
      const started = await listenAndMarkReady(app, { host: '127.0.0.1', port: 0 });
      expect(started).toBe(true);
      expect(app.getHttpServer().listening).toBe(true);
      expect(app.get(LifecycleService).state).toBe('ready');
    } finally {
      await app.close();
    }
  });

  // Break caught: readiness answering yes before the listener is open, so an instance is put in rotation that
  // cannot take a request.
  it('is not ready while the listener is still being opened', async () => {
    const app = await build((options) => AppModule.register(options));
    try {
      const server = app.getHttpServer();
      const listen = server.listen.bind(server) as (...args: unknown[]) => unknown;
      let stateWhileOpening: string | undefined;
      vi.spyOn(server, 'listen').mockImplementation(((...args: unknown[]) => {
        stateWhileOpening = app.get(LifecycleService).state;
        return listen(...args);
      }) as typeof server.listen);

      await listenAndMarkReady(app, { host: '127.0.0.1', port: 0 });

      expect(stateWhileOpening).toBe('starting');
      expect(app.get(LifecycleService).state).toBe('ready');
    } finally {
      await app.close();
    }
  });

  // Break caught: a stop signal that arrives while the application starts (its routes are still being
  // registered) being answered by a shutdown that finds nothing to close, after which the start went on and
  // opened a listener nobody would close. The process then served nothing, reported 503 for ever and ignored a
  // second signal.
  it('does not open a listener when the instance began draining while it was starting', async () => {
    const app = await build(appWith(DrainsWhileStartingModule));
    try {
      const listen = vi.spyOn(app.getHttpServer(), 'listen');
      const started = await listenAndMarkReady(app, { host: '127.0.0.1', port: 0 });

      expect(started).toBe(false);
      expect(listen).not.toHaveBeenCalled();
      expect(app.getHttpServer().listening).toBe(false);
      expect(app.get(LifecycleService).state).toBe('draining');
    } finally {
      await app.close();
    }
  });

  // Break caught: the same signal arriving while the listener opens: the listener that was opened stays.
  it('closes the listener again when the instance began draining while it was opening', async () => {
    const app = await build((options) => AppModule.register(options));
    try {
      app.getHttpServer().once('listening', () => {
        app.get(LifecycleService).beginDraining();
      });

      const started = await listenAndMarkReady(app, { host: '127.0.0.1', port: 0 });

      expect(started).toBe(false);
      expect(app.getHttpServer().listening).toBe(false);
      expect(app.get(LifecycleService).state).toBe('draining');
    } finally {
      await app.close();
    }
  });

  // Break caught: an API starting with a route that declares no access, or one registered outside
  // Nest. The architecture's route rule must hold in every process that starts, not only in CI.
  it('refuses to start an application whose routes are not all declared, and never listens', async () => {
    const app = await build(appWith(AccessFixtureModule));
    try {
      await expect(listenAndMarkReady(app, { host: '127.0.0.1', port: 0 })).rejects.toThrow(
        /GET \/api\/v1\/fixture-undeclared\/ping/,
      );
      expect(app.getHttpServer().listening).toBe(false);
      expect(app.get(LifecycleService).state).toBe('starting');
    } finally {
      await app.close();
    }
  });
});
