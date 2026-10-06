import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../create-app.js';
import { AppModule } from '../../app.module.js';
import { startTestApp, TEST_CONFIG, type TestApp } from '../../test-support/test-app.js';
import { CapturedLogs } from '../../test-support/captured-logs.js';
import { LifecycleService } from '../lifecycle/lifecycle.service.js';
import { ReadinessRegistry } from './readiness.registry.js';

let running: TestApp | undefined;

async function start(): Promise<TestApp> {
  running = await startTestApp();
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function probe(baseUrl: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('GET /livez', () => {
  it('answers 200, uncacheable, with no credentials', async () => {
    const { baseUrl } = await start();
    expect(await probe(baseUrl, '/livez')).toEqual({
      status: 200,
      cacheControl: 'no-store',
      body: { status: 'ok' },
    });
  });
});

describe('GET /readyz', () => {
  it('answers 200 once the application has started', async () => {
    const { baseUrl } = await start();
    expect(await probe(baseUrl, '/readyz')).toEqual({
      status: 200,
      cacheControl: 'no-store',
      body: { status: 'ready' },
    });
  });

  // Break caught: reporting ready before startup has finished, so traffic reaches an unready instance.
  it('answers 503 while starting, then 200 once marked ready', async () => {
    const logs = new CapturedLogs();
    const app = await createApp({
      config: TEST_CONFIG,
      logDestination: logs.stream,
      rootModule: (options) => AppModule.register(options),
    });
    try {
      await app.listen(0, '127.0.0.1');
      const { port } = app.getHttpServer().address() as { port: number };
      const baseUrl = `http://127.0.0.1:${String(port)}`;

      expect((await probe(baseUrl, '/readyz')).body).toEqual({
        status: 'not_ready',
        reason: 'starting',
      });
      expect((await probe(baseUrl, '/readyz')).status).toBe(503);

      app.get(LifecycleService).markReady();
      expect((await probe(baseUrl, '/readyz')).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  // Break caught: readiness staying green while draining (traffic keeps arriving), or liveness failing
  // while draining (the orchestrator kills the instance mid-drain).
  it('answers 503 while draining but keeps /livez healthy', async () => {
    const { baseUrl, app } = await start();
    app.get(LifecycleService).beginDraining();

    const ready = await probe(baseUrl, '/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'not_ready', reason: 'shutting_down' });
    expect((await probe(baseUrl, '/livez')).status).toBe(200);
  });

  // Break caught: a failing dependency not taking the instance out of rotation, a probe body that leaks
  // the dependency's name or error, or a check that stays failed after the dependency recovers.
  it('answers 503 while a registered check fails, without leaking it, and recovers', async () => {
    const { baseUrl, app, logs } = await start();
    let down = true;
    app.get(ReadinessRegistry).register({
      name: 'fixture-database',
      check: () => {
        if (down)
          throw new Error('connect ECONNREFUSED postgres://melarc:hunter2@db.internal/melarc');
      },
    });

    const failing = await probe(baseUrl, '/readyz');
    expect(failing.status).toBe(503);
    expect(failing.body).toEqual({ status: 'not_ready', reason: 'dependency_unavailable' });
    expect(JSON.stringify(failing.body)).not.toContain('fixture-database');
    expect(logs.records().find((record) => record.msg === 'readiness check failing')).toMatchObject(
      {
        level: 'warn',
        checks: ['fixture-database'],
      },
    );
    expect(logs.text()).not.toContain('hunter2');

    down = false;
    expect((await probe(baseUrl, '/readyz')).status).toBe(200);
  });
});

describe('probe placement', () => {
  // Break caught: the probes reachable through the public /api proxy path, where a browser host would
  // expose them (DEPLOYMENT_AND_ENVIRONMENTS.md §12.1).
  it('are not served under the API prefix', async () => {
    const { baseUrl } = await start();
    for (const path of ['/api/v1/livez', '/api/v1/readyz']) {
      const response = await fetch(`${baseUrl}${path}`);
      await response.text();
      expect(response.status).toBe(404);
    }
  });
});
