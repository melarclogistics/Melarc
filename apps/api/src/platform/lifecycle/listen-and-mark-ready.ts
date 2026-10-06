import type { INestApplication } from '@nestjs/common';

import { assertRoutesAreSound } from '../routes/route-inventory.js';
import { LifecycleService } from './lifecycle.service.js';

/**
 * Starts the application: initialises it, refuses to go on if its routes are not all declared
 * (SOLUTION_ARCHITECTURE.md §6), opens the listener, and only then declares the instance ready.
 * Production and tests start the application through this one function.
 */
export async function listenAndMarkReady(
  app: INestApplication,
  address: { readonly host: string; readonly port: number },
): Promise<void> {
  await app.init();
  assertRoutesAreSound(app);
  await app.listen(address.port, address.host);
  app.get(LifecycleService).markReady();
}
