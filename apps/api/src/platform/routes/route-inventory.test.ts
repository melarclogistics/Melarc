import { afterEach, describe, expect, it } from 'vitest';

import { AccessFixtureModule, FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';
import { assertRoutesAreSound, inspectRoutes } from './route-inventory.js';

let running: TestApp | undefined;

async function start(options?: Parameters<typeof startTestApp>[0]): Promise<TestApp> {
  running = await startTestApp(options);
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('the real application', () => {
  // Break caught: a business route appearing by accident, whether through a new controller or a raw
  // registration. Adding a route must change this list on purpose, in the same commit.
  it('answers exactly the two technical probes and declares nothing else', async () => {
    const { app } = await start();
    const inspection = inspectRoutes(app);

    expect(inspection.live).toEqual([
      { method: 'GET', path: '/livez' },
      { method: 'GET', path: '/readyz' },
    ]);
    expect(inspection.declared).toEqual([
      { method: 'GET', path: '/livez', access: 'technical' },
      { method: 'GET', path: '/readyz', access: 'technical' },
    ]);
    expect(inspection.undeclared).toEqual([]);
    expect(inspection.outsideNest).toEqual([]);
    expect(inspection.missingFromRouter).toEqual([]);
    expect(() => {
      assertRoutesAreSound(app);
    }).not.toThrow();
  });
});

describe('inspectRoutes', () => {
  // Break caught: the two enumerations drifting apart, for instance a prefix applied by one and not the
  // other, or path parameters rendered differently.
  it('finds the same routes from the router and from the decorators, parameters included', async () => {
    const { app } = await start({ rootModule: appWith(FixtureModule) });
    const inspection = inspectRoutes(app);

    expect(inspection.live.map((route) => `${route.method} ${route.path}`)).toEqual([
      'GET /api/v1/fixture/fails-after-answering',
      'GET /api/v1/fixture/orders/:id',
      'GET /api/v1/fixture/slow/:label',
      'GET /api/v1/fixture/throw-secret',
      'GET /livez',
      'GET /readyz',
    ]);
    expect(inspection.outsideNest).toEqual([]);
    expect(inspection.missingFromRouter).toEqual([]);
  });

  // Break caught: a controller route with no access declaration going unnoticed until a request is refused.
  it('names the controller routes that declare no access', async () => {
    const { app } = await start({
      rootModule: appWith(AccessFixtureModule),
      allowUnsoundRoutes: true,
    });

    expect(inspectRoutes(app).undeclared).toEqual([
      { method: 'GET', path: '/api/v1/fixture-partial/undeclared' },
      { method: 'GET', path: '/api/v1/fixture-undeclared/ping' },
    ]);
  });

  // Break caught: a route registered straight on the HTTP server. It never passes through a guard, so
  // the deny-by-default rule cannot see it; only comparing the router with Nest's controllers can.
  it('names a route registered outside Nest', async () => {
    const { app } = await start();
    const express = app.getHttpAdapter().getInstance() as {
      get: (path: string, handler: () => void) => void;
    };
    express.get('/raw-debug', () => undefined);

    expect(inspectRoutes(app).outsideNest).toEqual([{ method: 'GET', path: '/raw-debug' }]);
  });
});

describe('assertRoutesAreSound', () => {
  // Break caught: starting an API that carries an undeclared or foreign route.
  it('refuses an application with an undeclared route, naming it', async () => {
    const { app } = await start({
      rootModule: appWith(AccessFixtureModule),
      allowUnsoundRoutes: true,
    });
    expect(() => {
      assertRoutesAreSound(app);
    }).toThrow(/GET \/api\/v1\/fixture-undeclared\/ping/);
  });

  it('refuses an application with a route registered outside Nest, naming it', async () => {
    const { app } = await start();
    const express = app.getHttpAdapter().getInstance() as {
      get: (path: string, handler: () => void) => void;
    };
    express.get('/raw-debug', () => undefined);
    expect(() => {
      assertRoutesAreSound(app);
    }).toThrow(/GET \/raw-debug/);
  });
});
