import { describeConnectionForWorkers } from './harness/global.ts';
import { startStack } from './harness/stack.ts';

/**
 * Starts the one stack the run's specs share: a disposable database, the API and the Ops build. Playwright
 * calls the function this returns when the run ends, however it ended, and that is what stops everything and
 * drops the database. If starting fails, `startStack` has already cleaned up after itself.
 *
 * Nothing here removes another run's database. A run that was killed leaves its database behind; it is listed
 * and removed by name with `pnpm --filter @melarc/api db:orphans`, never on a guess that it looks idle.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack();
  describeConnectionForWorkers(stack.connection());
  return async () => {
    await stack.stop();
  };
}
