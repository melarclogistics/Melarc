// Runs alone: the e2e-database tool it runs provisions the roles and creates and drops databases by name.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { readLocalPostgres } from '../../../src/tools/database/local-env.js';
import { buildDatabaseUrl } from '../../../src/tools/database/provisioning.js';
import { E2E_DATABASE, killAll, requireBuild, run } from '../../support/api-process.js';
import { scalar, withClient } from '../support/test-database.js';

/**
 * `e2e-database create` gives the integrated harness a database of its own, migrated. An API over a database the reference seed has not
 * filled is not ready (`reference_data_missing`, the owner's decision of 25 October 2026), so the harness asks for `create --seed`: the
 * same database with the reference data in it, written by the real seed as the provisioning login. Every database here is one the tool
 * made, and is dropped by the tool; no URL or password is printed.
 */
const settings = readLocalPostgres();
const TOOL_DEADLINE_MS = 90_000;
const TEST_TIMEOUT_MS = 150_000;

const toolEnv = (): Record<string, string> => ({
  MELARC_PG_HOST: settings.host,
  MELARC_PG_PORT: String(settings.port),
  MELARC_PG_ADMIN_PASSWORD: settings.adminPassword,
  MELARC_PG_MIGRATION_PASSWORD: settings.migrationPassword,
  MELARC_PG_RUNTIME_PASSWORD: settings.runtimePassword,
});

const tool = (args: string[]) => run(E2E_DATABASE, toolEnv(), args, TOOL_DEADLINE_MS);

const made: string[] = [];

beforeAll(requireBuild);

afterEach(async () => {
  await killAll();
  for (const name of made.splice(0)) await tool(['drop', name]);
});

interface Created {
  readonly database: string;
}

async function create(args: string[]): Promise<Created> {
  const finished = await tool(args);
  expect(finished.code, finished.stderr).toBe(0);
  const created = JSON.parse(finished.stdout.trim()) as Created;
  made.push(created.database);
  return created;
}

/**
 * The rows of a table, counted as the cluster administrator: the tables are forced to row-level security, so every other login that
 * connects with no context (the migration login included) sees none, and a count through one would be zero whatever was seeded.
 */
const countOf = (created: Created, table: string) =>
  withClient(
    buildDatabaseUrl({
      host: settings.host,
      port: settings.port,
      user: 'postgres',
      password: settings.adminPassword,
      database: created.database,
    }),
    async (client) => Number(await scalar<string>(client, `select count(*) from ${table}`)),
  );

describe('e2e-database create', () => {
  // Break caught: a flag that changes what `create` does for everyone, or a `create` that seeds when it was not asked to (the integration
  // kit and the scratch stacks seed for themselves, and the seed refuses to run twice).
  it(
    'makes a migrated database with no reference data unless it is asked to seed',
    async () => {
      const created = await create(['create']);

      expect(await countOf(created, 'role_bundle')).toBe(0);
      expect(await countOf(created, 'setting')).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: the harness's API starting over a database it cannot be ready over (the stack never becomes ready), or a seed that
  // is a copy of the reference data and not the real one.
  it(
    'with --seed makes the same database holding the reference data the real seed writes',
    async () => {
      const created = await create(['create', '--seed']);

      expect(await countOf(created, 'role_bundle')).toBeGreaterThan(0);
      expect(await countOf(created, 'permission')).toBeGreaterThan(0);
      expect(await countOf(created, 'setting')).toBeGreaterThan(0);
      expect(await countOf(created, 'staff_identity')).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a usage the tool guesses at, so that a misspelt flag creates a database nobody asked for.
  it('refuses any other argument, and creates nothing', async () => {
    const before = JSON.parse((await tool(['list'])).stdout.trim()) as { databases: string[] };

    const refused = await tool(['create', '--sed']);
    const twice = await tool(['create', '--seed', '--seed']);
    const dropWithFlag = await tool(['drop', '--seed']);

    expect(refused.code).not.toBe(0);
    expect(twice.code).not.toBe(0);
    expect(dropWithFlag.code).not.toBe(0);
    const after = JSON.parse((await tool(['list'])).stdout.trim()) as { databases: string[] };
    expect(after.databases.toSorted()).toEqual(before.databases.toSorted());
  });
});
