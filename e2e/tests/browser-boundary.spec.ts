import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { expect, test } from '../harness/playwright.ts';

/**
 * A server on this machine that the browser must never reach: another origin on the same host, which is the
 * nearest thing to the stack and so the easiest to let through by mistake. Every request it receives is a hole
 * in the sandbox, so the tests below read it, and do not only read what the sandbox says it blocked.
 */
interface Canary {
  readonly origin: string;
  readonly port: number;
  /** Everything that reached it: ordinary requests and upgrade requests (a WebSocket). */
  readonly reached: () => string[];
  readonly close: () => Promise<void>;
}

async function startCanary(): Promise<Canary> {
  const reached: string[] = [];
  const server = createServer((request, response) => {
    reached.push(`${request.method ?? '?'} ${request.url ?? '?'}`);
    response.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/html' });
    response.end('<!doctype html><title>canary</title>');
  });
  server.on('upgrade', (request, socket) => {
    reached.push(`UPGRADE ${request.url ?? '?'}`);
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    reached: () => [...reached],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Lets the browser finish what it was asked to do before the canary is read: a request that is going to arrive has. */
const settle = (milliseconds = 500) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

test.describe('the browser can reach the stack origin and nothing else (audit F06)', () => {
  let canary: Canary;
  test.beforeEach(async () => {
    canary = await startCanary();
  });
  test.afterEach(async () => {
    await canary.close();
  });

  // The other side of every test below: a boundary that blocks everything is also a boundary that passes them.
  test('still reaches the stack origin, exactly', async ({ page, stack, sandbox }) => {
    await page.goto('/');

    const answer = await page.evaluate(async (origin) => {
      const response = await fetch(
        `${origin}/api/v1/e2e/notes/00000000-0000-4000-8000-000000000000`,
      );
      return response.status;
    }, stack.origin);

    expect(answer).toBe(404);
    expect(sandbox.externalBrowserRequests()).toEqual([]);
  });

  test('still loads a popup and tries a WebSocket on the stack origin, recording neither', async ({
    page,
    stack,
    sandbox,
  }) => {
    await page.goto('/');

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate((url) => {
        window.open(url);
      }, `${stack.origin}/`),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    // Nothing on the stack speaks WebSocket, so the socket does not open: what matters is that the sandbox
    // let it try, and did not close it or record it.
    const closedBySandbox = await page.evaluate(
      async (url) => {
        const socket = new WebSocket(url);
        let closed = false;
        socket.onclose = () => {
          closed = true;
        };
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 500);
        });
        const wasClosed = closed;
        socket.close();
        return wasClosed;
      },
      `${stack.origin.replace('http:', 'ws:')}/socket`,
    );

    expect(popup.url()).toBe(`${stack.origin}/`);
    expect(closedBySandbox).toBe(false);
    expect(sandbox.externalBrowserRequests()).toEqual([]);
  });

  // Break caught: another port on the same host being let through. Which port a request goes to is part of
  // the origin; the canary stands for any other service on the machine.
  test('aborts a request to another port on the same host', async ({ page, sandbox }) => {
    await page.goto('/');
    const target = `${canary.origin}/v1/charge`;

    const outcome = await page.evaluate(async (url) => {
      try {
        await fetch(url, { mode: 'no-cors' });
        return 'reached';
      } catch {
        return 'blocked';
      }
    }, target);

    expect(outcome).toBe('blocked');
    expect(sandbox.externalBrowserRequests()).toEqual([target]);
    await settle();
    expect(canary.reached()).toEqual([]);
  });

  // Break caught: a URL being judged by how it begins. `http://127.0.0.1:<stack port>@host/` begins with the
  // stack's origin and is a request to `host`: what is before the @ is a username and password. (Chromium
  // refuses these itself for sub-resources, so the way in is a navigation.)
  test('aborts a navigation to a URL that begins like the stack origin and goes somewhere else', async ({
    page,
    stack,
    sandbox,
  }) => {
    const deceptive = `${stack.origin}@127.0.0.1:${String(canary.port)}/looks-like-the-stack`;

    await page.goto(deceptive).catch(() => undefined);
    await settle();

    expect(canary.reached()).toEqual([]);
    expect(sandbox.externalBrowserRequests()).toHaveLength(1);
    expect(sandbox.externalBrowserRequests()[0]).toContain(`127.0.0.1:${String(canary.port)}/`);
  });

  // Break caught: a page the test page opens being outside the boundary. A popup is a new page in the same
  // browser context; a rule set on one page does not follow it.
  test('aborts what a popup requests', async ({ page, sandbox }) => {
    await page.goto('/');
    const target = `${canary.origin}/from-a-popup`;

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.evaluate((url) => {
        window.open(url);
      }, target),
    ]);
    await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
    await settle();

    expect(canary.reached()).toEqual([]);
    expect(sandbox.externalBrowserRequests()).toContain(target);
  });

  // Break caught: a WebSocket reaching another origin. It is not a fetch, and a rule for fetches does not see it.
  test('closes a WebSocket to another origin without connecting it', async ({ page, sandbox }) => {
    await page.goto('/');
    const target = `ws://127.0.0.1:${String(canary.port)}/socket`;

    const outcome = await page.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const socket = new WebSocket(url);
          socket.onopen = () => {
            resolve('opened');
          };
          socket.onclose = () => {
            resolve('closed');
          };
          socket.onerror = () => {
            resolve('failed');
          };
        }),
      target,
    );

    expect(outcome).not.toBe('opened');
    await settle();
    expect(canary.reached()).toEqual([]);
    expect(sandbox.externalBrowserRequests()).toContain(target);
  });
});
