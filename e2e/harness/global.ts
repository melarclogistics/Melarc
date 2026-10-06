import { STACK_ENVIRONMENT_KEY, type StackConnection } from './connection.ts';

/**
 * Hands the running stack to the test workers, which Playwright starts after global setup and which inherit
 * this process's environment. It holds credentials of a database that exists for this run only.
 */
export function describeConnectionForWorkers(connection: StackConnection): void {
  process.env[STACK_ENVIRONMENT_KEY] = JSON.stringify(connection);
}
