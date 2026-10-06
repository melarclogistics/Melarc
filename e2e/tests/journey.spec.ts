import { readFileSync } from 'node:fs';

import { readNotes } from '../harness/database.ts';
import { FIXED_INSTANT } from '../harness/fixtures.ts';
import { expect, freezeBrowserClock, test } from '../harness/playwright.ts';

interface Answer<T> {
  readonly status: number;
  readonly requestId: string | null;
  readonly body: T;
}

/** A request made by the page itself, to its own origin, as application code does. */
async function fromBrowser<T>(
  page: import('@playwright/test').Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer<T>> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: response.status,
        requestId: response.headers.get('x-request-id'),
        body: (await response.json()) as T,
      };
    },
    { method, path, body },
  );
}

test.describe('the technical journey: browser, Ops origin, API, database', () => {
  // Break caught: the integrated stack not being integrated. A real browser opens the real Ops build, makes a
  // request to its own origin, the proxy forwards it to the real API, and the API writes to the real database
  // as its runtime identity. The row is then read straight from the database, not through the API.
  test('a request from the browser is carried through the API into the database and back', async ({
    page,
    stack,
    fixtures,
    sandbox,
  }) => {
    await freezeBrowserClock(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();
    // The test clock: the page's own idea of the time is the agreed one, whatever the machine says.
    expect(await page.evaluate(() => new Date().toISOString())).toBe(FIXED_INSTANT);

    const note = { id: fixtures.id(), note: fixtures.text('first'), at: fixtures.instant(60_000) };
    const created = await fromBrowser<Record<string, unknown>>(
      page,
      'POST',
      '/api/v1/e2e/notes',
      note,
    );

    expect(created.status).toBe(201);
    // Written by the API's runtime identity: a non-owner role, which is the one an API is allowed to be.
    expect(created.body).toEqual({ ...note, written_by: 'melarc_api_runtime' });

    // The database itself, read by another connection and another identity.
    expect(await readNotes(stack.database)).toContainEqual({
      ...note,
      written_by: 'melarc_api_runtime',
    });

    const read = await fromBrowser<Record<string, unknown>>(
      page,
      'GET',
      `/api/v1/e2e/notes/${note.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body).toEqual(created.body);

    // The request really reached the API process: its log carries the id the answer was given.
    expect(created.requestId).toEqual(expect.any(String));
    expect(readFileSync(stack.logFiles[0]?.stdout ?? '', 'utf8')).toContain(
      created.requestId ?? 'missing',
    );

    // Nothing left the machine, from the browser or from the API.
    expect(sandbox.externalBrowserRequests()).toEqual([]);
    expect(sandbox.outboundAttempts()).toEqual([]);
  });

  // Break caught: errors that differ through the integrated stack from what the API says on its own: the
  // proxy rewriting them, or the platform's error handling not being the one that answers.
  test('answers an unknown record and an invalid request with the contract error shape', async ({
    page,
    fixtures,
  }) => {
    await page.goto('/');

    const missing = await fromBrowser<Record<string, unknown>>(
      page,
      'GET',
      `/api/v1/e2e/notes/${fixtures.id()}`,
    );
    const invalid = await fromBrowser<Record<string, unknown>>(page, 'POST', '/api/v1/e2e/notes', {
      id: 'not-a-uuid',
    });

    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Resource not found',
      request_id: missing.requestId,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      request_id: invalid.requestId,
    });
  });

  // Break caught: the API's technical probes becoming reachable from the browser's origin. The edge forwards
  // /api/v1 only (DEPLOYMENT_AND_ENVIRONMENTS.md 12.1); /readyz on the Ops origin is the application's own
  // page, not the API's answer.
  test('does not expose the API probes on the browser origin', async ({ page }) => {
    await page.goto('/');

    const probe = await page.evaluate(async () => {
      const response = await fetch('/readyz');
      return { type: response.headers.get('content-type'), text: await response.text() };
    });

    expect(probe.type).toContain('text/html');
    expect(probe.text).not.toContain('"status"');
  });

  // Break caught: the browser being able to talk to something other than the Ops origin during a test, which
  // would make a run depend on the network.
  test('aborts and records a browser request to any other origin', async ({ page, sandbox }) => {
    await page.goto('/');

    const outcome = await page.evaluate(async () => {
      try {
        await fetch('https://payments.provider.example/v1/charge', { mode: 'no-cors' });
        return 'reached';
      } catch {
        return 'blocked';
      }
    });

    expect(outcome).toBe('blocked');
    expect(sandbox.externalBrowserRequests()).toEqual([
      'https://payments.provider.example/v1/charge',
    ]);
  });
});
