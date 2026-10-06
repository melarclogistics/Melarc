import { describe, expect, it } from 'vitest';

import { AccessFixtureModule } from '../../test-support/fixtures.js';
import { appWith, TEST_CONFIG } from '../../test-support/test-app.js';
import { CapturedLogs } from '../../test-support/captured-logs.js';
import { AppModule } from '../../app.module.js';
import { createApp } from '../../create-app.js';
import { LifecycleService } from './lifecycle.service.js';
import { listenAndMarkReady } from './listen-and-mark-ready.js';

async function build(rootModule: Parameters<typeof createApp>[0]['rootModule']) {
  const logs = new CapturedLogs();
  return createApp({ config: TEST_CONFIG, logDestination: logs.stream, rootModule });
}

describe('listenAndMarkReady', () => {
  it('opens the listener and then marks the instance ready', async () => {
    const app = await build((options) => AppModule.register(options));
    try {
      await listenAndMarkReady(app, { host: '127.0.0.1', port: 0 });
      expect(app.getHttpServer().listening).toBe(true);
      expect(app.get(LifecycleService).state).toBe('ready');
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
