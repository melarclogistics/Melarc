import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { DB_MIGRATE, killAll, requireBuild, run } from '../support/api-process.js';
import { builtBefore } from './support/history-before.js';

/**
 * `db:migrate` as a deployment runs it (run 7, Stage 3.2): the process reads `DATABASE_LOCK_TIMEOUT_MS` from its environment and hands it to the run, which keeps each wait for
 * the policy keys shorter than it. A tool that read the setting, printed it and did not pass it on would keep the run on the default of 2000 ms whatever the release step carried,
 * and an API set lower than that would find every attempt outlasting what queued behind it. The run's own account of itself says which value it worked to, so this proves the
 * hand-over and not only the reading.
 */
const FIRST_NEW = 74;

beforeAll(requireBuild);
afterEach(killAll);

describe('db-migrate with a migration URL', () => {
  // Break caught: db-migrate.ts reading the setting and no longer passing it to runMigrations. The run then works to the default (2.0 s) and says so in the line it prints at the end.
  it('works to the lock timeout its environment carries, and says so at the start and at the end', async () => {
    const built = await builtBefore(FIRST_NEW);
    try {
      const finished = await run(
        DB_MIGRATE,
        {
          DATABASE_MIGRATION_URL: built.target.urlFor(MIGRATION_ROLE),
          DATABASE_LOCK_TIMEOUT_MS: '1000',
        },
        [],
        90_000,
      );

      expect(finished.code, finished.stderr).toBe(0);
      expect(finished.stdout).toContain("the application's lock timeout of 1000 ms");
      expect(finished.stdout).toContain("after the application's lock timeout of 1.0 s");
      expect(finished.stdout).not.toContain('lock timeout of 2.0 s');
    } finally {
      await built.done();
    }
  }, 240_000);
});
