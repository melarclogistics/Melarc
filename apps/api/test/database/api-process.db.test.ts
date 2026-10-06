import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { DEADLINES, freePort, killAll, MAIN, requireBuild, start } from '../support/api-process.js';
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * The built API, as a real process, against a real database. The process tests in test/ run it with a
 * database that is not there; these are the ones where it is.
 */
const TEST_TIMEOUT_MS = 45_000;
const databases: TestDatabase[] = [];

beforeAll(requireBuild);
afterEach(killAll);
afterAll(async () => {
  for (const database of databases) await database.drop();
});

async function launch(database: TestDatabase, extra: Record<string, string> = {}) {
  const port = await freePort();
  const running = start(MAIN, {
    NODE_ENV: 'production',
    APP_ENV: 'local',
    HTTP_PORT: String(port),
    DATABASE_URL: database.urlFor(API_RUNTIME_ROLE),
    DATABASE_POOL_MAX: '2',
    ...extra,
  });
  return { running, baseUrl: `http://127.0.0.1:${String(port)}` };
}

const probe = (baseUrl: string, path: '/livez' | '/readyz') =>
  fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(DEADLINES.request) });

/** Server-side sessions the API holds on this database. */
const apiSessions = (database: TestDatabase) =>
  withClient(database.urlFor('postgres'), async (client) =>
    Number(
      await scalar<string>(
        client,
        `select count(*) from pg_stat_activity
          where datname = $1 and usename = $2 and application_name = 'melarc-api'`,
        [database.name, API_RUNTIME_ROLE],
      ),
    ),
  );

describe('the API process with a real database', () => {
  // Break caught: an API that cannot connect as the runtime role, or one that reports ready without
  // having asked the database. Readiness here runs the role check against the real server, as the runtime
  // role; the session it opens is the runtime role's own, and no secret reaches the log.
  it(
    'starts as the runtime role, becomes ready, and writes no secret',
    async () => {
      const database = await createTestDatabase();
      databases.push(database);
      const { running, baseUrl } = await launch(database);

      await running.waitUntilReady(baseUrl);

      const response = await probe(baseUrl, '/readyz');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ready' });
      expect(await apiSessions(database)).toBeGreaterThanOrEqual(1);
      const output = `${running.stdout}${running.stderr}`;
      expect(output).not.toContain(database.settings.runtimePassword);
      expect(output).not.toContain('postgres://');
      expect(running.stderr).toBe('');
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: readiness that does not follow the database, so traffic keeps being sent to an instance
  // that can serve nothing; or liveness that does, so the platform kills an instance that is merely waiting
  // for its database to come back.
  it(
    'reports not ready, and stays live, when its database is taken away',
    async () => {
      const database = await createTestDatabase();
      databases.push(database);
      const { running, baseUrl } = await launch(database);
      await running.waitUntilReady(baseUrl);

      await database.drop();

      const deadline = Date.now() + DEADLINES.ready;
      let body: unknown;
      let status = 200;
      while (status === 200 && Date.now() < deadline) {
        const response = await probe(baseUrl, '/readyz');
        status = response.status;
        body = await response.json();
        if (status === 200) await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(status).toBe(503);
      expect(body).toEqual({ status: 'not_ready', reason: 'dependency_unavailable' });
      expect((await probe(baseUrl, '/livez')).status).toBe(200);
      expect(`${running.stdout}${running.stderr}`).not.toContain(database.settings.runtimePassword);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a shutdown that reports complete while the server still holds the API's connections.
  // Windows cannot deliver a graceful SIGTERM to a child process, so this runs on Linux and macOS and CI.
  it.skipIf(process.platform === 'win32')(
    'closes its connections to the server when it shuts down on SIGTERM',
    async () => {
      const database = await createTestDatabase();
      databases.push(database);
      const { running, baseUrl } = await launch(database, { SHUTDOWN_TIMEOUT_MS: '5000' });
      await running.waitUntilReady(baseUrl);
      expect(await apiSessions(database)).toBeGreaterThanOrEqual(1);

      const finished = await running.stop('SIGTERM');

      expect(finished.code).toBe(0);
      const deadline = Date.now() + 5_000;
      let remaining = await apiSessions(database);
      while (remaining > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remaining = await apiSessions(database);
      }
      expect(remaining).toBe(0);
      expect(finished.stdout).toContain('shutdown complete');
    },
    TEST_TIMEOUT_MS,
  );
});
