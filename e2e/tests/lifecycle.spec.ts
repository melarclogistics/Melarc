import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import {
  createDatabase,
  dropDatabase,
  listDatabases,
  readNotes,
  withClient,
} from '../harness/database.ts';
import { repositoryPaths } from '../harness/paths.ts';
import { startStack } from '../harness/stack.ts';

/**
 * The harness proved against itself, with no browser: the guarantees that make it safe to run on a developer's
 * machine and in CI. Each test starts stacks of its own, in directories of their own. No stack removes a database
 * it did not make, however idle it looks: the shared stack's database has no connection open between tests, and
 * a developer's own stack, or another run, looks the same.
 */
const directory = (name: string) => join(repositoryPaths().testResults, name);

test.describe('the lifecycle of a stack', () => {
  test.describe.configure({ timeout: 180_000 });

  // Break caught: a start that fails halfway leaving a database, a process, or both behind. They accumulate
  // quietly, and a machine that has run the suite a hundred times is full of them.
  test('a stack that fails to start leaves nothing behind', async () => {
    const before = await listDatabases();

    await expect(
      // An invalid log level is refused by the API at start, after the database exists and was migrated.
      startStack({
        runDirectory: directory('stack-failing'),
        apiEnvironment: { LOG_LEVEL: 'not-a-level' },
      }),
    ).rejects.toThrow(/api exited before it was ready[\s\S]*LOG_LEVEL/);

    expect(await listDatabases()).toEqual(before);
  });

  // Break caught: a stop that returns while a process still runs or the database still exists. Stop is the
  // thing every run ends with, and it has to be complete, and safe to repeat.
  test('stopping ends both processes, removes the database, and can be done twice', async () => {
    const stack = await startStack({ runDirectory: directory('stack-stopping') });
    expect(await listDatabases()).toContain(stack.database.name);

    await stack.stop();

    expect(stack.api.exited).toBe(true);
    expect(stack.ops.exited).toBe(true);
    await expect(
      fetch(`${stack.origin}/`, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toBeDefined();
    await expect(
      fetch(`${stack.apiOrigin}/livez`, { signal: AbortSignal.timeout(2_000) }),
    ).rejects.toBeDefined();
    expect(await listDatabases()).not.toContain(stack.database.name);
    await expect(stack.stop()).resolves.toBeUndefined();
  });

  // Break caught (audit F07): a stack that starts, fails to start, or stops removing a database that is not its
  // own because nothing is connected to it. This one belongs to another run, between two of its steps; it must be
  // there after all three, and the stacks' own databases must be gone.
  test("another run's idle database is left alone by a stack that starts, fails, or stops", async () => {
    const someoneElses = await createDatabase();
    try {
      const stack = await startStack({ runDirectory: directory('stack-neighbour') });
      const own = stack.database.name;
      expect(await listDatabases()).toEqual(expect.arrayContaining([someoneElses.name, own]));

      await expect(
        startStack({
          runDirectory: directory('stack-neighbour-failing'),
          apiEnvironment: { LOG_LEVEL: 'not-a-level' },
        }),
      ).rejects.toThrow(/api exited before it was ready/);
      expect(await listDatabases()).toContain(someoneElses.name);

      await stack.stop();
      const after = await listDatabases();
      expect(after).toContain(someoneElses.name);
      expect(after).not.toContain(own);
    } finally {
      await dropDatabase(someoneElses.name);
    }
  });

  // Break caught: two stacks sharing a database or a port, so that parallel runs, or a run and a developer's
  // own stack, corrupt each other's data.
  test('two stacks at once share nothing', async () => {
    const [first, second] = await Promise.all([
      startStack({ runDirectory: directory('stack-first') }),
      startStack({ runDirectory: directory('stack-second') }),
    ]);
    try {
      expect(second.database.name).not.toBe(first.database.name);
      expect(second.origin).not.toBe(first.origin);
      expect(second.apiOrigin).not.toBe(first.apiOrigin);

      const note = {
        id: '11111111-1111-4111-8111-111111111111',
        note: 'only in the first',
        at: '2026-10-05T09:00:00.000Z',
      };
      const created = await fetch(`${first.origin}/api/v1/e2e/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(note),
      });

      expect(created.status).toBe(201);
      expect(await readNotes(first.database)).toHaveLength(1);
      expect(await readNotes(second.database)).toEqual([]);
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  // Break caught: the API holding the owner's powers. Whatever the API is given must not be able to change the
  // schema, whatever it writes through the technical route: the runtime role is not the owner.
  test('gives the API a database identity that cannot change the schema', async () => {
    const stack = await startStack({ runDirectory: directory('stack-identity') });
    try {
      const refusal = await withClient(stack.database.runtimeUrl, async (client) => {
        try {
          await client.query('create table e2e_harness.smuggled (id int)');
          return 'allowed';
        } catch (error) {
          return (error as { code?: string }).code;
        }
      });

      expect(refusal).toBe('42501');
    } finally {
      await stack.stop();
    }
  });
});
