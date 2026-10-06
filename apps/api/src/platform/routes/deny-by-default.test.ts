import { afterEach, describe, expect, it } from 'vitest';

import { AccessFixtureModule, FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';

let running: TestApp | undefined;

async function start(): Promise<TestApp> {
  running = await startTestApp({
    rootModule: appWith(FixtureModule, AccessFixtureModule),
    allowUnsoundRoutes: true,
  });
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('deny by default', () => {
  // Break caught: a route added with no access declaration being served because the framework
  // permits by default. SOLUTION_ARCHITECTURE.md §6: such a route is refused.
  it('refuses a route that declares no access, with PERMISSION_DENIED', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/api/v1/fixture-undeclared/ping`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body).toEqual({
      code: 'PERMISSION_DENIED',
      message: 'Permission denied',
      request_id: response.headers.get('x-request-id'),
    });
  });

  // Break caught: a route that declares access being refused anyway.
  it('serves a route that declares access', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/api/v1/fixture/orders/42`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ found: true });
  });

  // Break caught: one declared route unlocking every other route in its controller.
  it('judges each route of a controller on its own declaration', async () => {
    const { baseUrl } = await start();
    const declared = await fetch(`${baseUrl}/api/v1/fixture-partial/declared`);
    const undeclared = await fetch(`${baseUrl}/api/v1/fixture-partial/undeclared`);
    await Promise.all([declared.text(), undeclared.text()]);

    expect(declared.status).toBe(200);
    expect(undeclared.status).toBe(403);
  });

  // Break caught: a declaration on the controller class being ignored for its routes.
  it('lets a declaration on the controller cover its routes', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/api/v1/fixture/slow/x?ms=1`);
    await response.text();
    expect(response.status).toBe(200);
  });
});
