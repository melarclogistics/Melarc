import { sql } from 'drizzle-orm';

import { serverErrorIn } from '../database-failures.js';
import type { DatabaseService, DatabaseTransaction } from '../database.service.js';
import { FIXED_POLICY_PRINCIPALS } from '../schema/reference-data.js';
import type { SecurityContext } from '../transaction-context.js';

/**
 * The seed helper (S0.9, corrected by F02; MIGRATION_AND_SEEDING.md section 4 and section 5.1; SECURITY_DESIGN.md sections 13.10a,
 * 14.1 and 14.4). It runs a plan as the `SYSTEM` principal under the `seed` task capability, in **one transaction**. The rules that
 * make an initialization happen once are the database's, not this file's (migration 0005):
 *
 * - **The provisioning login holds no privilege on the seven reference tables.** It cannot insert into one under the seed label or
 *   without it, before the seed or after: asserting the label reaches nothing, because there is no INSERT to assert it against.
 * - **The only ways in are two `SECURITY DEFINER` functions** that `melarc_provisioning` alone may execute:
 *   `melarc.initialize_reference_data` (the seven tables, in one statement) and `melarc.add_reason_fixtures` (reasons whose code
 *   starts with `FIXTURE_`, and nothing else). They name every table and column themselves, fix their `search_path`, and take the rows
 *   as one JSON document. This file calls them by those two names and by no other.
 * - **Once, atomically, serialized.** The initialization locks the seven tables in one order and refuses (SQLSTATE 55000) unless all
 *   seven are empty, so a second run changes nothing, a run that fails leaves nothing and can be run again, and two runs at once
 *   cannot both fill the tables. This file maps that refusal to `SeedRefusedError` and cannot weaken it.
 *
 * What stays here: the policy locks, taken by the primitive of the bundle-change task and not by this file (S0.27, migration 0017).
 * The seed that inserts the first bundles and the first fixed policy rows follows the one protocol (section 13.10a: "exclusive on each
 * key it creates; one protocol has no special case"), so a sign-in that holds a key shared is never interleaved with it. It names the
 * bundles and the fixed policies its rows depend on, and `melarc.lock_policy_keys` takes their exclusive locks in the one canonical
 * order, as the first statement after the context and before the function is called: the same SQL that a migration which changes a
 * bundle uses, so that exclusive acquisition has one implementation, held to the toolkit's keys by `policy-change.db.test.ts`. And a
 * short insert is checked once more on this side (`SeedIncompleteError`), though the function checks it first.
 *
 * The capability is a label and not an identity (`capability-access.ts`). The context is opened only over the provisioning login (the
 * service refuses `seed` over any other connection), and only that login may execute the functions. This file is one of the few places
 * that may open the capability (`CAPABILITY_ACCESS.seed.openedUnder`); the architecture test enforces it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A plan's keys as the two array literals `melarc.lock_policy_keys` takes. Each element is checked against its closed shape, so that
 * nothing of a plan is ever more than a uuid or one of the two audiences inside a literal that travels as a parameter.
 */
function lockArguments(keys: SeedPolicyKeys): { bundles: string; fixed: string } | undefined {
  for (const id of keys.bundleIds) {
    if (typeof id !== 'string' || !UUID.test(id)) {
      throw new RangeError('A seed plan names its bundles by their ids (UUIDs)');
    }
  }
  for (const type of keys.fixedPolicies) {
    if (!(FIXED_POLICY_PRINCIPALS as readonly string[]).includes(type)) {
      throw new RangeError('A seed plan names the fixed policies of the Vendor and the Rider only');
    }
  }
  if (keys.bundleIds.length === 0 && keys.fixedPolicies.length === 0) return undefined;
  return {
    bundles: `{${keys.bundleIds.map((id) => id.toLowerCase()).join(',')}}`,
    fixed: `{${keys.fixedPolicies.join(',')}}`,
  };
}

/** The technical identifier of the seed task as a `SYSTEM` principal: stable, and not the id of any business record. */
export const SEED_PRINCIPAL_ID = '5eed0000-0000-4000-8000-000000000001';

const SEED_CORRELATION_ID = 'reference-seed';

/** The database functions a plan can be applied by. A plan names one of these; it never names a function of its own. */
export type SeedEntryPoint = 'initialize_reference_data' | 'add_reason_fixtures';

/** The rows of a plan, by table: one array of objects whose keys are the table's column names. */
export type SeedPayload = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

/** The policy objects a plan's rows depend on: the bundles it creates and the fixed policies of the audiences it seeds. */
export interface SeedPolicyKeys {
  readonly bundleIds: readonly string[];
  readonly fixedPolicies: readonly (typeof FIXED_POLICY_PRINCIPALS)[number][];
}

export interface SeedPlan {
  /** Every policy object the rows created depend on, each locked exclusively, in the canonical order, before anything is written. */
  readonly policyKeys: SeedPolicyKeys;
  /** The function that applies the plan. */
  readonly entryPoint: SeedEntryPoint;
  /** The rows to insert, by table. */
  readonly payload: SeedPayload;
  /** How a table is named in the report when it is not by its own name. */
  readonly labels?: Readonly<Record<string, string>>;
}

/** What a seed inserted: the rows added to each table, by table. */
export type SeedReport = Readonly<Record<string, number>>;

/** A table the seed would add to already has rows. Names the table and how many, never their content. */
export class SeedRefusedError extends Error {
  constructor(
    readonly table: string,
    readonly rows: number,
  ) {
    super(
      `The seed refuses to run: table ${table} is not empty (${String(rows)} ${rows === 1 ? 'row' : 'rows'}). A seed fills an empty database and nothing else.`,
    );
    this.name = 'SeedRefusedError';
  }
}

/** A table received fewer or more rows than the plan holds. The transaction is rolled back. */
export class SeedIncompleteError extends Error {
  constructor(
    readonly table: string,
    readonly planned: number,
    readonly inserted: number,
  ) {
    super(
      `The seed inserted ${String(inserted)} of ${String(planned)} planned rows into table ${table}; nothing was kept`,
    );
    this.name = 'SeedIncompleteError';
  }
}

function seedContext(): SecurityContext {
  return {
    principalType: 'SYSTEM',
    principalId: SEED_PRINCIPAL_ID,
    surface: 'SYSTEM',
    taskCapability: 'seed',
    correlationId: SEED_CORRELATION_ID,
  };
}

/** SQLSTATE `object_not_in_prerequisite_state`: what both functions raise when the tables are not empty (or the fixtures are there). */
const NOT_EMPTY = '55000';

/** The refusal the database raised, as `SeedRefusedError`; `undefined` for any other failure. */
function refusalFrom(error: unknown): SeedRefusedError | undefined {
  const server = serverErrorIn(error);
  if (server?.code !== NOT_EMPTY) return undefined;
  const rows = Number(/rows=(\d+)/.exec(server.detail ?? '')?.[1] ?? 0);
  return new SeedRefusedError(server.table ?? 'unknown', rows);
}

/** Applies the plan by the function it names. The statements are fixed text: nothing of the plan is part of a name. */
async function apply(
  tx: DatabaseTransaction,
  entryPoint: SeedEntryPoint,
  document: string,
): Promise<Readonly<Record<string, unknown>>> {
  let result;
  switch (entryPoint) {
    case 'initialize_reference_data':
      result = await tx.execute(
        sql`select melarc.initialize_reference_data(${document}::jsonb) as report`,
      );
      break;
    case 'add_reason_fixtures':
      result = await tx.execute(
        sql`select melarc.add_reason_fixtures(${document}::jsonb) as report`,
      );
      break;
    default:
      // A plan is data and can say anything; only these two functions are ever called.
      throw new RangeError('A seed plan names one of the two seed functions');
  }
  const report: unknown = result.rows[0]?.report;
  return typeof report === 'object' && report !== null ? (report as Record<string, unknown>) : {};
}

/**
 * Runs `plan` in one transaction over `database`, which must be connected as the provisioning login. Resolves with the rows
 * inserted into each table. Rejects, with nothing kept, when a table is not empty (`SeedRefusedError`), a table received a different
 * number of rows than the plan holds (`SeedIncompleteError`), the connection is not the provisioning login (the capability is
 * refused), or the database refuses.
 */
export async function runSeed(
  database: Pick<DatabaseService, 'transactionWithContext'>,
  plan: SeedPlan,
): Promise<SeedReport> {
  const tables = Object.keys(plan.payload);
  if (tables.length === 0) throw new RangeError('A seed plan with no table has nothing to seed');
  for (const table of tables) {
    if ((plan.payload[table] ?? []).length === 0) {
      throw new RangeError(
        `A seed plan carries at least one row for each table: ${table} has none`,
      );
    }
  }
  const locks = lockArguments(plan.policyKeys);
  const document = JSON.stringify(plan.payload);

  return database.transactionWithContext(seedContext(), async (tx) => {
    // The locks first, so that nothing below reads a table a sign-in could still be relying on. One statement, in the canonical order,
    // by the SQL that every writer of the policy tables uses; it refuses a transaction that is not at read committed.
    if (locks !== undefined) {
      await tx.execute(
        sql`select melarc.lock_policy_keys(${locks.bundles}::uuid[], ${locks.fixed}::text[])`,
      );
    }
    const received = await apply(tx, plan.entryPoint, document).catch((error: unknown) => {
      throw refusalFrom(error) ?? error;
    });
    const report: Record<string, number> = {};
    for (const table of tables) {
      const planned = (plan.payload[table] ?? []).length;
      const inserted = Number(received[table] ?? 0);
      if (inserted !== planned) throw new SeedIncompleteError(table, planned, inserted);
      report[plan.labels?.[table] ?? table] = inserted;
    }
    return report;
  });
}
