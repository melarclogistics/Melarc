import { sql } from 'drizzle-orm';

import { serverErrorIn } from '../database-failures.js';
import type { DatabaseService, DatabaseTransaction } from '../database.service.js';
import { acquirePolicyLocks } from '../policy-lock/acquire.js';
import { planPolicyLocks, type PolicyLockRequest } from '../policy-lock/plan.js';
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
 * What stays here: the policy locks. The seed that inserts the first bundles and the first fixed policy rows follows the one protocol
 * (section 13.10a: "exclusive on each key it creates; one protocol has no special case"), so a sign-in that holds a key shared is
 * never interleaved with it; the locks come before the function is called. And a short insert is checked once more on this side
 * (`SeedIncompleteError`), though the function checks it first.
 *
 * The capability is a label and not an identity (`capability-access.ts`). The context is opened only over the provisioning login (the
 * service refuses `seed` over any other connection), and only that login may execute the functions. This file is one of the few places
 * that may open the capability (`CAPABILITY_ACCESS.seed.openedUnder`); the architecture test enforces it.
 */

/** The technical identifier of the seed task as a `SYSTEM` principal: stable, and not the id of any business record. */
export const SEED_PRINCIPAL_ID = '5eed0000-0000-4000-8000-000000000001';

const SEED_CORRELATION_ID = 'reference-seed';

/** The database functions a plan can be applied by. A plan names one of these; it never names a function of its own. */
export type SeedEntryPoint = 'initialize_reference_data' | 'add_reason_fixtures';

/** The rows of a plan, by table: one array of objects whose keys are the table's column names. */
export type SeedPayload = Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;

export interface SeedPlan {
  /** Every policy key the rows created depend on, each taken exclusively. */
  readonly locks: readonly PolicyLockRequest[];
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
  const locks = planPolicyLocks(
    plan.locks.map((lock) => ({ ...lock, mode: 'exclusive' as const })),
  );
  const document = JSON.stringify(plan.payload);

  return database.transactionWithContext(seedContext(), async (tx) => {
    // The locks first, so that nothing below reads a table a sign-in could still be relying on.
    await acquirePolicyLocks(tx, locks);
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
