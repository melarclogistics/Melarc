import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';

import { assertRoutesAreSound } from '../routes/route-inventory.js';
import { LifecycleService } from './lifecycle.service.js';

/**
 * Starts the application: initialises it, refuses to go on if its routes are not all declared
 * (SOLUTION_ARCHITECTURE.md §6), opens the listener, and only then declares the instance ready.
 * Production and tests start the application through this one function.
 *
 * Resolves to whether the instance is now serving. It is not when a stop signal arrived while it started: the
 * shutdown that signal began had no listener to close, so a listener opened afterwards would be one nobody
 * closes, and the process would sit draining for ever, answering 503 and ignoring a second signal. The start
 * gives up instead, and what the shutdown closed stays closed.
 */
export async function listenAndMarkReady(
  app: INestApplication,
  address: { readonly host: string; readonly port: number },
): Promise<boolean> {
  await app.init();
  assertRoutesAreSound(app);

  const lifecycle = app.get(LifecycleService);
  // A function, so that the state is read again after the listener has opened: it can change while it opens.
  const draining = (): boolean => lifecycle.state === 'draining';
  if (draining()) return false;

  await app.listen(address.port, address.host);
  if (draining()) {
    const server = app.getHttpServer() as Server;
    server.close();
    server.closeAllConnections();
    return false;
  }

  lifecycle.markReady();
  return true;
}
